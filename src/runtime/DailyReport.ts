/**
 * End-of-day report.
 *
 * Written for the person reading it after the close, who wants four answers:
 * what did the bot see, what did it do, what did it cost, and did anything go
 * wrong. It is a summary of the day's record, not a scorecard: on a day with
 * no trades it says so plainly and that is a complete, correct report.
 *
 * Nothing here feeds back into the strategy. It reads the database and prints.
 */
import type { Clock } from '../core/index.js';
import { formatSignedUsd, formatUsd } from '../core/index.js';
import type { Store } from '../persistence/store.js';
import type { CapitalLedgerService } from '../pipeline/ledger.js';
import type { ApiMeter } from './ApiMeter.js';
import type { FunnelReport, FunnelService } from './Funnel.js';
import type { HealthGuard } from './HealthGuard.js';

export interface ClosedTradeLine {
  ticker: string;
  openedAt: string;
  closedAt: string;
  holdMinutes: number;
  entryPrice: number;
  exitPrice: number | null;
  realisedPnlCents: number;
  exitReason: string | null;
  entrySignalScore: number | null;
}

export interface DailyReport {
  day: string;
  generatedAt: string;
  mode: string;
  strategyVersion: string;
  runState: string;
  haltReason: string | null;

  equityStartCents: number | null;
  equityEndCents: number;
  realisedPnlCents: number;
  unrealisedPnlCents: number;
  dayReturnPct: number | null;

  tradesOpened: number;
  tradesClosed: number;
  openPositions: { ticker: string; quantity: number; entryPrice: number; unrealisedPnlCents: number }[];
  closedTrades: ClosedTradeLine[];

  funnel: FunnelReport;
  apiUsage: { provider: string; requests: number; successes: number; rateLimited: number; errors: number }[];
  incidents: { at: string; fault: string; detail: string; paused: boolean }[];
  /** Reasons risk rejected proposals today, most frequent first. */
  topRiskRejections: { check: string; count: number }[];
}

export interface DailyReportOptions {
  store: Store;
  ledger: CapitalLedgerService;
  funnel: FunnelService;
  meter: ApiMeter;
  health: HealthGuard;
  clock: Clock;
  strategyId: string;
}

export class DailyReportService {
  constructor(private readonly o: DailyReportOptions) {}

  private dayBounds(day: string): { from: string; to: string } {
    return { from: `${day}T00:00:00.000Z`, to: `${day}T23:59:59.999Z` };
  }

  build(day = this.o.clock.nowIso().slice(0, 10)): DailyReport {
    const { from, to } = this.dayBounds(day);
    const strategy = this.o.store.strategies.byId(this.o.strategyId);
    const ledger = this.o.ledger.get();

    // The day's opening equity is the first snapshot taken today. Absent on a
    // day the bot never ran, which is reported as "unknown" rather than zero.
    const snapshots = this.o.store.ledger
      .equityCurve(this.o.strategyId)
      .filter((s) => s.at >= from && s.at <= to);
    const equityStartCents = snapshots[0]?.equityCents ?? null;

    const closed = this.o.store.positions
      .closed(this.o.strategyId)
      .filter((p) => p.closedAt !== null && p.closedAt >= from && p.closedAt <= to);

    const open = this.o.store.positions.open(this.o.strategyId);

    const closedTrades: ClosedTradeLine[] = closed.map((p) => {
      const signal = this.o.store.signals.byId(p.entrySignalId);
      return {
        ticker: p.ticker,
        openedAt: p.openedAt,
        closedAt: p.closedAt!,
        holdMinutes: Number(((new Date(p.closedAt!).getTime() - new Date(p.openedAt).getTime()) / 60_000).toFixed(1)),
        entryPrice: p.entryPrice,
        exitPrice: p.exitPrice ?? null,
        realisedPnlCents: p.realisedPnlCents ?? 0,
        exitReason: p.exitReason ?? null,
        entrySignalScore: signal?.score ?? null,
      };
    });

    const realisedPnlCents = closedTrades.reduce((sum, t) => sum + t.realisedPnlCents, 0);
    const unrealisedPnlCents = open.reduce((sum, p) => sum + (p.unrealisedPnlCents ?? 0), 0);

    // Failed checks across today's rejections, ranked. This is the single most
    // useful line on a zero-trade day: it names the gate that held.
    const rejectionCounts = new Map<string, number>();
    for (const decision of this.o.store.risk.recent(500)) {
      if (decision.decidedAt < from || decision.decidedAt > to) continue;
      if (decision.approved) continue;
      for (const check of decision.failedChecks) {
        rejectionCounts.set(check, (rejectionCounts.get(check) ?? 0) + 1);
      }
    }

    const funnel = this.o.funnel.report(from, to);

    return {
      day,
      generatedAt: this.o.clock.nowIso(),
      mode: strategy?.mode ?? 'PAPER',
      strategyVersion: strategy?.version ?? 'unknown',
      runState: strategy?.runState ?? 'unknown',
      haltReason: strategy?.haltReason ?? null,

      equityStartCents,
      equityEndCents: ledger.equityCents,
      realisedPnlCents,
      unrealisedPnlCents,
      dayReturnPct:
        equityStartCents && equityStartCents > 0
          ? Number((((ledger.equityCents - equityStartCents) / equityStartCents) * 100).toFixed(3))
          : null,

      tradesOpened: closed.length + open.filter((p) => p.openedAt >= from && p.openedAt <= to).length,
      tradesClosed: closed.length,
      openPositions: open.map((p) => ({
        ticker: p.ticker,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
        unrealisedPnlCents: p.unrealisedPnlCents ?? 0,
      })),
      closedTrades,

      funnel,
      apiUsage: funnel.api,
      incidents: this.o.store.incidents
        .recent(this.o.strategyId, 50)
        .filter((i) => i.at >= from && i.at <= to)
        .map((i) => ({ at: i.at, fault: i.fault, detail: i.detail, paused: i.paused })),
      topRiskRejections: [...rejectionCounts.entries()]
        .map(([check, count]) => ({ check, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  render(report: DailyReport): string {
    const lines: string[] = [];
    const push = (line = ''): void => {
      lines.push(line);
    };

    push(`END-OF-DAY REPORT — ${report.day}`);
    push('='.repeat(60));
    push(`Mode              ${report.mode}   Strategy ${report.strategyVersion}   State ${report.runState}`);
    if (report.haltReason) push(`Halt reason       ${report.haltReason}`);
    push();

    push('CAPITAL');
    push(`  Equity at close ${formatUsd(report.equityEndCents)}` +
      (report.equityStartCents === null ? '' : ` (opened ${formatUsd(report.equityStartCents)})`));
    push(`  Realised P&L    ${formatSignedUsd(report.realisedPnlCents)}`);
    push(`  Unrealised P&L  ${formatSignedUsd(report.unrealisedPnlCents)}`);
    if (report.dayReturnPct !== null) push(`  Day return      ${report.dayReturnPct >= 0 ? '+' : ''}${report.dayReturnPct}%`);
    push();

    push('TRADING');
    if (report.tradesClosed === 0 && report.openPositions.length === 0) {
      push('  No trades today, and no open positions.');
      push('  Zero trades is a valid outcome: the bot acts only on new, material,');
      push('  corroborated evidence, and there was none that cleared every gate.');
    } else {
      push(`  Closed ${report.tradesClosed}, currently open ${report.openPositions.length}`);
      for (const t of report.closedTrades) {
        push(
          `    ${t.ticker.padEnd(6)} ${formatSignedUsd(t.realisedPnlCents).padStart(9)}  ` +
          `held ${String(t.holdMinutes).padStart(6)}m  exit: ${t.exitReason ?? 'unknown'}` +
          (t.entrySignalScore === null ? '' : `  (entry signal ${t.entrySignalScore})`),
        );
      }
      for (const p of report.openPositions) {
        push(`    ${p.ticker.padEnd(6)} ${formatSignedUsd(p.unrealisedPnlCents).padStart(9)}  OPEN  ${p.quantity} @ ${p.entryPrice.toFixed(2)}`);
      }
    }
    push();

    push('FUNNEL');
    for (const stage of report.funnel.stages) {
      push(`  ${stage.stage.padEnd(20)} ${String(stage.count).padStart(6)}`);
    }
    push(`  ${report.funnel.narrative}`);
    push();

    if (report.topRiskRejections.length > 0) {
      push('WHY PROPOSALS WERE REJECTED');
      for (const r of report.topRiskRejections) push(`  ${r.check.padEnd(26)} ${String(r.count).padStart(4)}`);
      push();
    }

    push('API USAGE');
    for (const a of report.apiUsage) {
      push(
        `  ${a.provider.padEnd(8)} ${String(a.requests).padStart(6)} requests  ` +
        `${String(a.successes).padStart(6)} ok  ${String(a.rateLimited).padStart(4)} rate-limited  ` +
        `${String(a.errors).padStart(4)} errors`,
      );
    }
    push();

    push('INCIDENTS');
    if (report.incidents.length === 0) push('  None.');
    for (const i of report.incidents) {
      push(`  ${i.at.slice(11, 19)}  ${i.fault}${i.paused ? ' (PAUSED)' : ''}: ${i.detail}`);
    }

    return lines.join('\n');
  }
}
