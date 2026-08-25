/**
 * The strategy capital ledger.
 *
 * The X strategy has its own $50 virtual allocation. That number is NOT the
 * Alpaca account balance: the account may hold thousands of dollars this
 * strategy is not allowed to touch. Every order is sized against
 * `availableCents()` here, and the risk engine re-checks it.
 *
 * All arithmetic is in integer cents. Every movement is appended to
 * ledger_entries so cash can be reconstructed from first principles, which is
 * what `verifyIntegrity()` does.
 */
import type { Clock, Logger } from '../core/index.js';
import type { Cents } from '../core/index.js';
import { deterministicId, positionValueCents } from '../core/index.js';
import type { CapitalLedger, LedgerEntry, Position } from '../domain/types.js';
import type { Store } from '../persistence/store.js';

export interface LedgerIntegrityReport {
  ok: boolean;
  expectedCashCents: Cents;
  actualCashCents: Cents;
  differenceCents: Cents;
  detail: string;
}

export class CapitalLedgerService {
  private readonly log: Logger;
  /** Monotonic per-append counter: a FixedClock can stamp two entries with the
   *  same instant, and the entry id must still be unique. */
  private seq = 0;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    logger: Logger,
    private readonly strategyId: string,
  ) {
    this.log = logger.child('ledger');
  }

  init(startingCapitalCents: Cents): CapitalLedger {
    return this.store.ledger.init(this.strategyId, startingCapitalCents, this.clock.nowIso());
  }

  get(): CapitalLedger {
    const ledger = this.store.ledger.get(this.strategyId);
    if (!ledger) throw new Error(`No capital ledger for strategy ${this.strategyId}. Run seed/init first.`);
    return ledger;
  }

  /**
   * Cash actually deployable right now: cash minus anything already committed
   * to unfilled orders. Reserving is what stops two proposals in the same cycle
   * from each spending the same dollar.
   */
  availableCents(): Cents {
    const l = this.get();
    return Math.max(0, l.cashCents - l.reservedCents);
  }

  reserve(amountCents: Cents, reference: string, note = ''): boolean {
    const ledger = this.get();
    if (amountCents <= 0) return false;
    if (ledger.cashCents - ledger.reservedCents < amountCents) {
      this.log.warn('reservation refused: insufficient strategy cash', {
        requested: amountCents,
        available: ledger.cashCents - ledger.reservedCents,
      });
      return false;
    }
    const updated: CapitalLedger = {
      ...ledger,
      reservedCents: ledger.reservedCents + amountCents,
      updatedAt: this.clock.nowIso(),
    };
    this.store.ledger.save(updated);
    this.append('RESERVE', amountCents, updated.cashCents, reference, note || 'Reserved for pending order');
    return true;
  }

  /**
   * How much of the strategy's reserved cash is committed to one reference.
   *
   * Derived from the append-only entry log rather than tracked separately, so
   * it cannot drift away from the audit trail.
   */
  reservedFor(reference: string): Cents {
    let total = 0;
    for (const e of this.store.ledger.entries(this.strategyId, 100_000)) {
      if (e.reference !== reference) continue;
      if (e.kind === 'RESERVE') total += e.amountCents;
      else if (e.kind === 'RELEASE_RESERVE') total -= Math.abs(e.amountCents);
    }
    return Math.max(0, total);
  }

  /**
   * Move a reference's reservation to exactly `stillCommittedCents`.
   *
   * This is the only correct way to retire a reservation. Releasing just the
   * UNSPENT part leaves the spent part reserved forever, so `reserved` climbs
   * above `cash` over a long run and the strategy eventually refuses to trade
   * (and trips its own state-integrity check).
   */
  settleReservation(reference: string, stillCommittedCents: Cents, note = ''): void {
    const held = this.reservedFor(reference);
    const target = Math.max(0, stillCommittedCents);
    if (held <= target) return;
    this.releaseReservation(held - target, reference, note || 'Reservation settled against fills');
  }

  releaseReservation(amountCents: Cents, reference: string, note = ''): void {
    const ledger = this.get();
    const release = Math.min(ledger.reservedCents, Math.max(0, amountCents));
    if (release === 0) return;
    const updated: CapitalLedger = {
      ...ledger,
      reservedCents: ledger.reservedCents - release,
      updatedAt: this.clock.nowIso(),
    };
    this.store.ledger.save(updated);
    this.append('RELEASE_RESERVE', -release, updated.cashCents, reference, note || 'Released unused reservation');
  }

  /** Record a buy fill: cash out, position on. */
  recordBuy(costCents: Cents, feesCents: Cents, reference: string, note = ''): void {
    const ledger = this.get();
    const updated: CapitalLedger = {
      ...ledger,
      cashCents: ledger.cashCents - costCents - feesCents,
      feesPaidCents: ledger.feesPaidCents + feesCents,
      updatedAt: this.clock.nowIso(),
    };
    this.store.ledger.save(updated);
    this.append('BUY', -costCents, updated.cashCents, reference, note);
    if (feesCents !== 0) this.append('FEE', -feesCents, updated.cashCents, reference, 'Entry fees');
  }

  /** Record a sell fill: cash in, realised P&L booked. */
  recordSell(proceedsCents: Cents, realisedPnlCents: Cents, feesCents: Cents, reference: string, note = ''): void {
    const ledger = this.get();
    const updated: CapitalLedger = {
      ...ledger,
      cashCents: ledger.cashCents + proceedsCents - feesCents,
      realisedPnlCents: ledger.realisedPnlCents + realisedPnlCents,
      feesPaidCents: ledger.feesPaidCents + feesCents,
      updatedAt: this.clock.nowIso(),
    };
    this.store.ledger.save(updated);
    this.append('SELL', proceedsCents, updated.cashCents, reference, note);
    if (feesCents !== 0) this.append('FEE', -feesCents, updated.cashCents, reference, 'Exit fees');
  }

  /**
   * Mark open positions to market and recompute equity.
   *
   *   equity = cash + market value of open positions
   *
   * `marks` maps ticker -> last price. A position with no mark keeps its
   * previous mark rather than silently dropping out of equity.
   */
  mark(marks: Map<string, number>): CapitalLedger {
    const ledger = this.get();
    const open = this.store.positions.open(this.strategyId);
    const at = this.clock.nowIso();

    let positionsValue = 0;
    let unrealised = 0;

    for (const position of open) {
      const price = marks.get(position.ticker) ?? position.lastMarkPrice;
      const value = positionValueCents(position.quantity, price);
      const pnl = value - position.entryCostCents;
      positionsValue += value;
      unrealised += pnl;

      const updated: Position = {
        ...position,
        lastMarkPrice: price,
        lastMarkAt: at,
        highWaterPrice: Math.max(position.highWaterPrice, price),
        unrealisedPnlCents: pnl,
      };
      this.store.positions.save(updated);
    }

    const equity = ledger.cashCents + positionsValue;
    const updated: CapitalLedger = {
      ...ledger,
      positionsValueCents: positionsValue,
      unrealisedPnlCents: unrealised,
      equityCents: equity,
      highWaterEquityCents: Math.max(ledger.highWaterEquityCents, equity),
      updatedAt: at,
    };
    this.store.ledger.save(updated);
    return updated;
  }

  snapshot(benchmarkPrice: number | null): void {
    const l = this.get();
    this.store.ledger.snapshotEquity(
      this.strategyId,
      this.clock.nowIso(),
      l.equityCents,
      l.cashCents,
      l.positionsValueCents,
      benchmarkPrice,
    );
  }

  /* ------------------------------------------------------------ metrics */

  /** Drawdown from the equity high-water mark, in percent. */
  drawdownPct(): number {
    const l = this.get();
    if (l.highWaterEquityCents <= 0) return 0;
    return Math.max(0, ((l.highWaterEquityCents - l.equityCents) / l.highWaterEquityCents) * 100);
  }

  /**
   * Loss since the start of the current UTC day, in percent of that day's
   * opening equity. Falls back to starting capital when no snapshot exists yet.
   */
  dailyLossPct(): number {
    const l = this.get();
    const dayStart = `${this.clock.nowIso().slice(0, 10)}T00:00:00.000Z`;
    const curve = this.store.ledger.equityCurve(this.strategyId);
    const opening = curve.find((p) => p.at >= dayStart)?.equityCents
      ?? curve.filter((p) => p.at < dayStart).at(-1)?.equityCents
      ?? l.startingCapitalCents;
    if (opening <= 0) return 0;
    return Math.max(0, ((opening - l.equityCents) / opening) * 100);
  }

  totalReturnPct(): number {
    const l = this.get();
    if (l.startingCapitalCents <= 0) return 0;
    return ((l.equityCents - l.startingCapitalCents) / l.startingCapitalCents) * 100;
  }

  /* -------------------------------------------------------- integrity */

  /**
   * Recompute cash from the append-only entry log and compare it with the
   * stored balance. A mismatch means the ledger is corrupt, which is a
   * pause-the-strategy event, not a warning.
   */
  verifyIntegrity(): LedgerIntegrityReport {
    const ledger = this.get();
    const entries = this.store.ledger.entries(this.strategyId, 100_000);

    let expected = 0;
    for (const e of entries) {
      // Reservations move committed capital, not cash.
      if (e.kind === 'RESERVE' || e.kind === 'RELEASE_RESERVE' || e.kind === 'MARK') continue;
      expected += e.amountCents;
    }

    const difference = ledger.cashCents - expected;
    const ok = Math.abs(difference) <= 1; // tolerate a single cent of rounding
    return {
      ok,
      expectedCashCents: expected,
      actualCashCents: ledger.cashCents,
      differenceCents: difference,
      detail: ok
        ? 'Ledger cash reconciles with the entry log'
        : `Ledger cash ${ledger.cashCents} does not match the sum of entries ${expected} (difference ${difference})`,
    };
  }

  entries(limit = 100): LedgerEntry[] {
    return this.store.ledger.entries(this.strategyId, limit);
  }

  private append(kind: LedgerEntry['kind'], amountCents: Cents, cashAfter: Cents, reference: string, note: string): void {
    const at = this.clock.nowIso();
    this.store.ledger.appendEntry({
      entryId: deterministicId('led', this.strategyId, kind, reference, at, String(amountCents), String(this.seq += 1)),
      strategyId: this.strategyId,
      at,
      kind,
      amountCents,
      cashAfterCents: cashAfter,
      reference,
      note,
    });
  }
}
