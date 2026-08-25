/**
 * Strategy-version comparison.
 *
 * Runs two or more immutable strategy versions over the SAME dataset and puts
 * their results side by side. Because the dataset is frozen and every replay
 * gets its own in-memory database, the only difference between runs is the
 * strategy version itself — which is what makes the comparison mean anything.
 *
 * Nothing here mutates a registered version or config. A candidate is published
 * as a new id (see `deriveStrategyVersion`) before it can be compared, so the
 * baseline it is measured against cannot drift underneath it.
 */
import { formatUsd, round } from '../core/index.js';
import type { StrategyVersionSpec } from '../config/strategyRegistry.js';
import type { ForwardHorizon } from '../domain/types.js';
import type { ReplayDataset } from './dataset.js';
import { runReplay, type ReplayResult } from './ReplayEngine.js';

export interface ComparisonOptions {
  dataset: ReplayDataset;
  specs: StrategyVersionSpec[];
  stepMinutes?: number;
  horizon?: ForwardHorizon;
}

export interface ComparisonRow {
  label: string;
  strategyId: string;
  version: string;
  signalConfigId: string;
  returnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  turnover: number;
  hitRatePct: number | null;
  tradeCount: number;
  signalsGenerated: number;
  riskInterventions: number;
  finalEquityCents: number;
  sourceTierPerformance: ReplayResult['sourceTierPerformance'];
}

export interface ComparisonResult {
  datasetId: string;
  window: { from: string; to: string };
  rows: ComparisonRow[];
  /** Version with the highest alpha, or null when the field is a tie/empty. */
  bestByAlpha: string | null;
  /** Version with the smallest maximum drawdown. */
  bestByDrawdown: string | null;
  /**
   * True when the sample is large enough for the comparison to mean anything.
   * A version "winning" on four trades has not won.
   */
  sampleAdequate: boolean;
  caveat: string;
  results: ReplayResult[];
}

const MIN_TRADES_FOR_COMPARISON = 20;

export async function compareStrategyVersions(opts: ComparisonOptions): Promise<ComparisonResult> {
  if (opts.specs.length < 2) {
    throw new Error('Comparing strategy versions needs at least two specs.');
  }

  const results: ReplayResult[] = [];
  for (const spec of opts.specs) {
    results.push(
      await runReplay({
        dataset: opts.dataset,
        spec,
        ...(opts.stepMinutes !== undefined ? { stepMinutes: opts.stepMinutes } : {}),
        ...(opts.horizon !== undefined ? { horizon: opts.horizon } : {}),
      }),
    );
  }

  const rows: ComparisonRow[] = results.map((r) => ({
    label: `${r.strategyId}@${r.strategyVersion}`,
    strategyId: r.strategyId,
    version: r.strategyVersion,
    signalConfigId: r.signalConfigId,
    returnPct: r.returnPct,
    benchmarkReturnPct: r.benchmarkReturnPct,
    alphaPct: r.alphaPct,
    maxDrawdownPct: r.maxDrawdownPct,
    turnover: r.turnover,
    hitRatePct: r.hitRatePct,
    tradeCount: r.tradeCount,
    signalsGenerated: r.signalsGenerated,
    riskInterventions: r.riskInterventions,
    finalEquityCents: r.finalEquityCents,
    sourceTierPerformance: r.sourceTierPerformance,
  }));

  const minTrades = Math.min(...rows.map((r) => r.tradeCount));
  const sampleAdequate = minTrades >= MIN_TRADES_FOR_COMPARISON;

  const byAlpha = [...rows].sort((a, b) => b.alphaPct - a.alphaPct);
  const byDrawdown = [...rows].sort((a, b) => a.maxDrawdownPct - b.maxDrawdownPct);

  return {
    datasetId: opts.dataset.datasetId,
    window: opts.dataset.window,
    rows,
    bestByAlpha: byAlpha[0]?.label ?? null,
    bestByDrawdown: byDrawdown[0]?.label ?? null,
    sampleAdequate,
    caveat: sampleAdequate
      ? `Every version closed at least ${minTrades} trades on this dataset.`
      : `SAMPLE TOO SMALL: the thinnest version closed ${minTrades} trade(s) against a ` +
        `${MIN_TRADES_FOR_COMPARISON}-trade minimum. Ranking these versions is not yet meaningful — ` +
        'a difference this size is noise, and picking a winner from it would be overfitting to one window.',
    results,
  };
}

/** Fixed-width table for the terminal. */
export function renderComparison(comparison: ComparisonResult): string {
  const headers = ['version', 'return', 'bench', 'alpha', 'maxDD', 'turn', 'hit', 'trades', 'signals', 'riskRej', 'equity'];
  const rows = comparison.rows.map((r) => [
    r.label,
    `${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(2)}%`,
    `${r.benchmarkReturnPct >= 0 ? '+' : ''}${r.benchmarkReturnPct.toFixed(2)}%`,
    `${r.alphaPct >= 0 ? '+' : ''}${r.alphaPct.toFixed(2)}%`,
    `${r.maxDrawdownPct.toFixed(2)}%`,
    `${round(r.turnover, 2)}x`,
    r.hitRatePct === null ? 'n/a' : `${r.hitRatePct.toFixed(1)}%`,
    String(r.tradeCount),
    String(r.signalsGenerated),
    String(r.riskInterventions),
    formatUsd(r.finalEquityCents),
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');

  const out = [line(headers), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.map(line)];

  out.push('');
  out.push(`Best alpha:     ${comparison.bestByAlpha ?? 'n/a'}`);
  out.push(`Best drawdown:  ${comparison.bestByDrawdown ?? 'n/a'}`);
  out.push('');
  out.push(comparison.caveat);

  // Source-tier breakdown, which is where a version change usually shows up
  // first: a weighting tweak changes WHICH sources drive trades before it
  // changes the headline return.
  for (const row of comparison.rows) {
    if (row.sourceTierPerformance.length === 0) continue;
    out.push('');
    out.push(`${row.label} — source-tier performance`);
    for (const tier of row.sourceTierPerformance) {
      out.push(
        `  ${tier.bucket.padEnd(10)} n=${String(tier.count).padStart(4)}  ` +
        `hit ${tier.hitRatePct === null ? '  n/a' : `${tier.hitRatePct.toFixed(0).padStart(4)}%`}  ` +
        `excess ${tier.meanExcessReturnPct === null ? 'n/a' : `${tier.meanExcessReturnPct >= 0 ? '+' : ''}${tier.meanExcessReturnPct.toFixed(2)}%`}`,
      );
    }
  }

  return out.join('\n');
}
