/**
 * What a health incident was about, and whether it is still true.
 *
 * An unresolved incident is a claim that something was wrong at a moment in the
 * past. Two questions follow, and they have different answers: is the condition
 * that raised it STILL happening, and which run does it belong to? Neither can
 * be answered by looking at the incident row — it records a fault, a time and a
 * sentence, and after the execution-epoch change a bot can have several ledgers
 * at once.
 *
 * So this recomputes the condition from live state, per epoch, and reports what
 * it finds. It never resolves anything on its own. Closing an incident whose
 * cause is still present would replace a loud problem with a silent one, and
 * the ledger is not a good place for silent problems.
 */
import type { Clock } from '../core/index.js';
import { formatUsd } from '../core/index.js';
import type { ExecutionEpoch, HealthIncident } from '../domain/types.js';
import type { Store } from '../persistence/store.js';

export interface EpochIntegrity {
  epochId: string;
  label: string;
  status: 'ACTIVE' | 'CLOSED';
  startedAt: string;
  endedAt: string | null;
  ok: boolean;
  cashCents: number;
  expectedCashCents: number;
  differenceCents: number;
  entryCount: number;
  openPositions: number;
  openOrders: number;
  detail: string;
}

export interface IncidentDiagnosis {
  incident: HealthIncident;
  /** The epoch whose lifetime contains the incident, when one does. */
  attributedEpochId: string | null;
  attributionDetail: string;
  /** Integrity of every epoch, right now. */
  epochs: EpochIntegrity[];
  /** True when the condition that raised the incident is still present. */
  stillPresent: boolean;
  /** Whether it is safe to close, and why or why not. */
  resolvable: boolean;
  verdict: string;
}

export class IncidentForensics {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly strategyId: string,
  ) {}

  /**
   * Recompute ledger integrity for one epoch, from its own entries.
   *
   * The same arithmetic `CapitalLedgerService.verifyIntegrity` performs, but for
   * an arbitrary epoch rather than only the active one — a historical mismatch
   * lives in a ledger the running service no longer reads.
   */
  epochIntegrity(epoch: ExecutionEpoch): EpochIntegrity {
    const ledger = this.store.ledger.get(this.strategyId, epoch.epochId);
    const entries = this.store.ledger.entries(this.strategyId, epoch.epochId, 100_000);

    let expected = 0;
    for (const e of entries) {
      // Reservations move committed capital, not cash.
      if (e.kind === 'RESERVE' || e.kind === 'RELEASE_RESERVE' || e.kind === 'MARK') continue;
      expected += e.amountCents;
    }

    const cash = ledger?.cashCents ?? 0;
    const difference = cash - expected;
    const ok = ledger !== null && Math.abs(difference) <= 1;

    const positions = this.store.positions.open(this.strategyId).filter((p) => p.epochId === epoch.epochId);
    const orders = this.store.orders.open(this.strategyId).filter((o) => o.epochId === epoch.epochId);

    return {
      epochId: epoch.epochId,
      label: epoch.label,
      status: epoch.status,
      startedAt: epoch.startedAt,
      endedAt: epoch.endedAt,
      ok,
      cashCents: cash,
      expectedCashCents: expected,
      differenceCents: difference,
      entryCount: entries.length,
      openPositions: positions.length,
      openOrders: orders.length,
      detail:
        ledger === null
          ? 'No ledger exists for this epoch.'
          : ok
            ? `Cash ${formatUsd(cash)} matches the sum of ${entries.length} entries.`
            : `Cash ${formatUsd(cash)} does not match the sum of entries ${formatUsd(expected)} ` +
              `(difference ${formatUsd(difference)}).`,
    };
  }

  /** Integrity of every epoch this strategy has ever run. */
  allEpochIntegrity(): EpochIntegrity[] {
    return this.store.epochs.all(this.strategyId).map((e) => this.epochIntegrity(e));
  }

  diagnose(incident: HealthIncident): IncidentDiagnosis {
    const epochs = this.allEpochIntegrity();
    const at = new Date(incident.at).getTime();

    /*
     * Attribute by lifetime.
     *
     * Incidents predate execution epochs and carry no epoch of their own, so
     * the honest answer comes from asking which epoch was running when it was
     * raised. Where nothing was, the incident predates epochs entirely — which
     * is itself informative: it belongs to the original $50 run.
     */
    const containing = epochs.find((e) => {
      const start = new Date(e.startedAt).getTime();
      const end = e.endedAt === null ? Number.POSITIVE_INFINITY : new Date(e.endedAt).getTime();
      return at >= start && at <= end;
    });

    const earliest = epochs.length > 0
      ? epochs.reduce((a, b) => (new Date(a.startedAt) <= new Date(b.startedAt) ? a : b))
      : null;

    const attributed = containing ?? (earliest && at < new Date(earliest.startedAt).getTime() ? earliest : null);
    const attributionDetail = containing
      ? `Raised while ${containing.epochId} was running.`
      : attributed
        ? `Raised before any epoch was recorded (${incident.at}); it belongs to the run that ` +
          `${attributed.epochId} now represents.`
        : 'No epoch covers this incident, and none is recorded.';

    /*
     * "Still present" is recomputed, never inferred from the incident text.
     *
     * For a ledger mismatch the condition is arithmetic: does cash still
     * disagree with the entries? Any epoch failing counts, not only the
     * attributed one — a mismatch elsewhere is still a mismatch, and closing
     * this incident while one exists would be closing the wrong thing.
     */
    const brokenEpochs = epochs.filter((e) => !e.ok);
    const isLedgerFault = incident.fault === 'LEDGER_MISMATCH';
    const stillPresent = isLedgerFault ? brokenEpochs.length > 0 : false;

    const resolvable = incident.resolvedAt === null && !stillPresent;
    const verdict = incident.resolvedAt !== null
      ? `Already resolved at ${incident.resolvedAt}.`
      : stillPresent
        ? `STILL PRESENT — ${brokenEpochs.map((e) => `${e.epochId}: ${e.detail}`).join(' ')} ` +
          'Do not resolve this incident and do not resume the strategy.'
        : isLedgerFault
          ? 'The ledger reconciles in every epoch. The condition that raised this incident is gone.'
          : `This is a ${incident.fault} incident; its condition is not recomputable here. ` +
            'Resolve it only if you have independently confirmed it is historical.';

    return {
      incident,
      attributedEpochId: attributed?.epochId ?? null,
      attributionDetail,
      epochs,
      stillPresent,
      resolvable,
      verdict,
    };
  }

  /** Diagnose every unresolved incident. */
  diagnoseOpen(): IncidentDiagnosis[] {
    return this.store.incidents.open(this.strategyId).map((i) => this.diagnose(i));
  }

  /**
   * Close one incident, but only if its cause is genuinely gone.
   *
   * The refusal is the feature. An operator resolving an incident is asserting
   * that a past problem is past, and the system is in a position to check that
   * assertion — so it does, every time, rather than trusting it.
   */
  resolve(incidentId: string, note: string): { resolved: boolean; detail: string; diagnosis: IncidentDiagnosis | null } {
    const incident = this.store.incidents.byId(incidentId);
    if (!incident) return { resolved: false, detail: `No incident ${incidentId}.`, diagnosis: null };
    if (incident.resolvedAt !== null) {
      return {
        resolved: false,
        detail: `Incident ${incidentId} was already resolved at ${incident.resolvedAt}.`,
        diagnosis: this.diagnose(incident),
      };
    }

    const diagnosis = this.diagnose(incident);
    if (diagnosis.stillPresent) {
      return {
        resolved: false,
        detail: `REFUSED: ${diagnosis.verdict}`,
        diagnosis,
      };
    }
    if (note.trim() === '') {
      return { resolved: false, detail: 'A resolution note is required.', diagnosis };
    }

    const at = this.clock.nowIso();
    this.store.incidents.resolveOne(incidentId, at, note.trim());

    // Recorded in the append-only decision log too, so the resolution is part
    // of the same audit trail as everything else the bot did.
    this.store.log.append({
      correlationId: `incident-resolve-${incidentId}`,
      strategyId: this.strategyId,
      stage: 'HEALTH',
      subjectId: incidentId,
      summary: `Incident ${incident.fault} resolved by operator`,
      payload: {
        incidentId,
        fault: incident.fault,
        raisedAt: incident.at,
        raisedDetail: incident.detail,
        attributedEpochId: diagnosis.attributedEpochId,
        note: note.trim(),
        resolvedAt: at,
        epochIntegrityAtResolution: diagnosis.epochs.map((e) => ({
          epochId: e.epochId, ok: e.ok, cashCents: e.cashCents, expectedCashCents: e.expectedCashCents,
        })),
      },
    });

    return {
      resolved: true,
      detail: `Incident ${incidentId} resolved at ${at}.`,
      diagnosis: this.diagnose({ ...incident, resolvedAt: at, resolutionNote: note.trim() }),
    };
  }
}
