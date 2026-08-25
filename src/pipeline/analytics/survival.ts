/**
 * Bot survival metrics — the fields the wider Northstar Bot Arena will consume.
 *
 * Computes strategy return, benchmark return, alpha, drawdown, win rate,
 * average winner/loser, a risk-adjusted metric, turnover, trade count and
 * costs, then assigns a status label.
 *
 * The label is descriptive only. `sampleAdequate` gates promotion, and nothing
 * in Northstar increases real capital because a label changed — that is a
 * human decision, deliberately not automated.
 */
import type { Cents } from '../../core/index.js';
import { mean, round, stdev } from '../../core/index.js';
import type { Clock } from '../../core/index.js';
import type { Position, StrategyStatus, SurvivalMetrics } from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { CapitalLedgerService } from '../ledger.js';

export interface SurvivalOptions {
  store: Store;
  ledger: CapitalLedgerService;
  clock: Clock;
  strategyId: string;
  strategyVersion: string;
  benchmarkTicker: string;
  /** Closed trades required before a status above TESTING may be assigned. */
  minTradesForStatus?: number;
}

export class SurvivalService {
  private readonly store: Store;
  private readonly ledger: CapitalLedgerService;
  private readonly clock: Clock;
  private readonly strategyId: string;
  private readonly strategyVersion: string;
  private readonly benchmarkTicker: string;
  private readonly minTrades: number;

  constructor(opts: SurvivalOptions) {
    this.store = opts.store;
    this.ledger = opts.ledger;
    this.clock = opts.clock;
    this.strategyId = opts.strategyId;
    this.strategyVersion = opts.strategyVersion;
    this.benchmarkTicker = opts.benchmarkTicker;
    this.minTrades = opts.minTradesForStatus ?? 20;
  }

  compute(): SurvivalMetrics {
    const ledger = this.ledger.get();
    const closed = this.store.positions.closed(this.strategyId);
    const curve = this.store.ledger.equityCurve(this.strategyId);

    const strategyReturnPct = this.ledger.totalReturnPct();
    const benchmarkReturnPct = this.benchmarkReturnPct(curve);
    const alphaPct = benchmarkReturnPct === null ? 0 : strategyReturnPct - benchmarkReturnPct;

    const wins = closed.filter((p) => (p.realisedPnlCents ?? 0) > 0);
    const losses = closed.filter((p) => (p.realisedPnlCents ?? 0) < 0);

    const winRatePct = closed.length === 0 ? 0 : round((wins.length / closed.length) * 100, 2);
    const averageWinnerCents: Cents = wins.length === 0 ? 0 : Math.round(mean(wins.map((p) => p.realisedPnlCents ?? 0)));
    const averageLoserCents: Cents = losses.length === 0 ? 0 : Math.round(mean(losses.map((p) => p.realisedPnlCents ?? 0)));

    const status = this.classify({
      alphaPct,
      strategyReturnPct,
      maxDrawdownPct: this.maxDrawdownPct(curve),
      tradeCount: closed.length,
      winRatePct,
    });

    const metrics: SurvivalMetrics = {
      strategyId: this.strategyId,
      strategyVersion: this.strategyVersion,
      asOf: this.clock.nowIso(),
      strategyReturnPct: round(strategyReturnPct, 4),
      benchmarkReturnPct: benchmarkReturnPct === null ? 0 : round(benchmarkReturnPct, 4),
      alphaPct: round(alphaPct, 4),
      maxDrawdownPct: round(this.maxDrawdownPct(curve), 4),
      winRatePct,
      averageWinnerCents,
      averageLoserCents,
      sharpe: this.sharpe(curve),
      turnover: this.turnover(closed, ledger.startingCapitalCents),
      tradeCount: closed.length,
      totalCostsCents: closed.reduce((a, p) => a + p.feesCents, 0) + ledger.feesPaidCents,
      status: status.status,
      statusRationale: status.rationale,
      sampleAdequate: closed.length >= this.minTrades,
    };

    return metrics;
  }

  persist(): SurvivalMetrics {
    const metrics = this.compute();
    this.store.survival.save(metrics);
    return metrics;
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * Benchmark return over the same window as the strategy's own equity curve,
   * using the benchmark price recorded alongside each equity snapshot.
   */
  private benchmarkReturnPct(curve: { at: string; benchmarkPrice: number | null }[]): number | null {
    const withPrice = curve.filter((p) => p.benchmarkPrice !== null && p.benchmarkPrice > 0);
    const first = withPrice[0];
    const last = withPrice[withPrice.length - 1];
    if (!first || !last || first === last) return null;
    return ((last.benchmarkPrice! - first.benchmarkPrice!) / first.benchmarkPrice!) * 100;
  }

  private maxDrawdownPct(curve: { equityCents: number }[]): number {
    let peak = 0;
    let maxDd = 0;
    for (const point of curve) {
      peak = Math.max(peak, point.equityCents);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - point.equityCents) / peak) * 100);
    }
    // Include the live ledger drawdown so an open loss is not hidden by a
    // curve that has not been snapshotted since.
    return Math.max(maxDd, this.ledger.drawdownPct());
  }

  /**
   * Sharpe over the equity curve's own sampling interval, annualised on a
   * 252-day basis. Returns null on a curve too short to say anything, rather
   * than an impressive-looking number computed from three points.
   */
  private sharpe(curve: { equityCents: number }[]): number | null {
    if (curve.length < 10) return null;
    const rets: number[] = [];
    for (let i = 1; i < curve.length; i += 1) {
      const prev = curve[i - 1]!.equityCents;
      if (prev > 0) rets.push((curve[i]!.equityCents - prev) / prev);
    }
    if (rets.length < 8) return null;
    const sd = stdev(rets);
    if (sd === 0) return null;
    return round((mean(rets) / sd) * Math.sqrt(252), 4);
  }

  /** Traded notional as a multiple of allocated capital. */
  private turnover(closed: Position[], startingCapitalCents: number): number {
    if (startingCapitalCents <= 0) return 0;
    const traded = closed.reduce((a, p) => a + p.entryCostCents + (p.exitProceedsCents ?? 0), 0);
    return round(traded / startingCapitalCents, 4);
  }

  /**
   * Status classification.
   *
   * THRIVING  positive alpha, contained drawdown, adequate sample
   * ALIVE     not losing money against the benchmark, contained drawdown
   * PROBATION losing to the benchmark or drawdown above half the limit
   * RETIRED   never assigned automatically — a human retires a strategy
   * TESTING   the default until the sample is adequate
   */
  private classify(input: {
    alphaPct: number;
    strategyReturnPct: number;
    maxDrawdownPct: number;
    tradeCount: number;
    winRatePct: number;
  }): { status: StrategyStatus; rationale: string } {
    if (input.tradeCount < this.minTrades) {
      return {
        status: 'TESTING',
        rationale:
          `${input.tradeCount} closed trades against a ${this.minTrades}-trade minimum. ` +
          'Status stays TESTING regardless of performance: a handful of trades cannot distinguish skill from luck.',
      };
    }

    if (input.maxDrawdownPct >= 10) {
      return {
        status: 'PROBATION',
        rationale: `Maximum drawdown ${input.maxDrawdownPct.toFixed(2)}% is close to the strategy's 12% limit.`,
      };
    }
    if (input.alphaPct < 0) {
      return {
        status: 'PROBATION',
        rationale: `Underperforming the benchmark by ${Math.abs(input.alphaPct).toFixed(2)}% over ${input.tradeCount} trades.`,
      };
    }
    if (input.alphaPct > 2 && input.winRatePct >= 50) {
      return {
        status: 'THRIVING',
        rationale:
          `+${input.alphaPct.toFixed(2)}% alpha with a ${input.winRatePct.toFixed(0)}% win rate over ` +
          `${input.tradeCount} trades and ${input.maxDrawdownPct.toFixed(2)}% maximum drawdown.`,
      };
    }
    return {
      status: 'ALIVE',
      rationale:
        `+${input.alphaPct.toFixed(2)}% alpha over ${input.tradeCount} trades with ` +
        `${input.maxDrawdownPct.toFixed(2)}% maximum drawdown — performing, not yet outperforming.`,
    };
  }

  get benchmark(): string {
    return this.benchmarkTicker;
  }
}
