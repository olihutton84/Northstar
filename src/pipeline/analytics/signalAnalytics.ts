/**
 * Signal analytics.
 *
 * Answers the question the whole strategy exists to answer: does X contain
 * tradable information, and if so, which parts of it?
 *
 * Everything here is descriptive statistics over recorded outcomes. Nothing
 * feeds back into the live signal automatically — a discovered relationship is
 * a candidate for a NEW strategy version, reviewed by a human, not a weight the
 * bot silently rewrites for itself.
 */
import { mean, round, stdev } from '../../core/index.js';
import type {
  ForwardHorizon,
  SignalBand,
  SignalComponents,
  SignalOutcome,
  SourceTier,
  XSignal,
} from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';

export interface BucketPerformance {
  bucket: string;
  count: number;
  hitRatePct: number | null;
  meanReturnPct: number | null;
  meanExcessReturnPct: number | null;
  medianReturnPct: number | null;
}

export interface ComponentCorrelation {
  component: keyof SignalComponents;
  /** Pearson correlation of the component with forward excess return. */
  correlation: number | null;
  sampleSize: number;
  interpretation: string;
}

export interface SignalAnalyticsReport {
  strategyId: string;
  horizon: ForwardHorizon;
  measuredSignals: number;
  overallHitRatePct: number | null;
  meanReturnPct: number | null;
  meanExcessReturnPct: number | null;
  byBand: BucketPerformance[];
  byScoreBucket: BucketPerformance[];
  byStrength: BucketPerformance[];
  bySourceTier: BucketPerformance[];
  byEventType: BucketPerformance[];
  componentCorrelations: ComponentCorrelation[];
  /** Explicit caveat when the sample is too small to mean anything. */
  sampleAdequate: boolean;
  caveat: string;
}

const MIN_ADEQUATE_SAMPLE = 30;
const MIN_BUCKET_SAMPLE = 5;

export class SignalAnalyticsService {
  constructor(private readonly store: Store, private readonly strategyId: string) {}

  report(horizon: ForwardHorizon = '1d'): SignalAnalyticsReport {
    const outcomes = this.store.outcomes
      .measured(this.strategyId)
      .filter((o) => o.horizon === horizon && o.forwardReturnPct !== null);

    const signalsById = new Map(this.store.signals.all().map((s) => [s.signalId, s]));

    const report: SignalAnalyticsReport = {
      strategyId: this.strategyId,
      horizon,
      measuredSignals: outcomes.length,
      overallHitRatePct: hitRate(outcomes),
      meanReturnPct: avg(outcomes.map((o) => o.forwardReturnPct)),
      meanExcessReturnPct: avg(outcomes.map((o) => o.excessReturnPct)),
      byBand: this.bucketBy(outcomes, (o) => bandLabelOf(o.band)),
      byScoreBucket: this.bucketBy(outcomes, (o) => scoreBucket(o.signalScore)),
      byStrength: this.bucketBy(outcomes, (o) => (Math.abs(o.signalScore) >= 60 ? 'Strong (|score| >= 60)' : 'Weak (|score| < 60)')),
      bySourceTier: this.bucketBy(outcomes, (o) => {
        const signal = signalsById.get(o.signalId);
        return signal ? bestTierOf(signal) : 'Unknown';
      }),
      byEventType: this.bucketBy(outcomes, (o) => {
        const signal = signalsById.get(o.signalId);
        return signal ? signal.dominantEventType.replace(/_/g, ' ').toLowerCase() : 'unknown';
      }),
      componentCorrelations: this.correlations(outcomes, signalsById),
      sampleAdequate: outcomes.length >= MIN_ADEQUATE_SAMPLE,
      caveat: '',
    };

    report.caveat = report.sampleAdequate
      ? `Based on ${outcomes.length} measured signals at the ${horizon} horizon.`
      : `SAMPLE TOO SMALL: ${outcomes.length} measured signals at the ${horizon} horizon (${MIN_ADEQUATE_SAMPLE} needed ` +
        'before any of these figures should influence a decision). Treat every number below as noise.';

    return report;
  }

  /** Per-source-account performance, for deciding whom to keep listening to. */
  sourcePerformance(horizon: ForwardHorizon = '1d'): BucketPerformance[] {
    const outcomes = this.store.outcomes
      .measured(this.strategyId)
      .filter((o) => o.horizon === horizon && o.forwardReturnPct !== null);
    const signalsById = new Map(this.store.signals.all().map((s) => [s.signalId, s]));

    const byHandle = new Map<string, SignalOutcome[]>();
    for (const outcome of outcomes) {
      const signal = signalsById.get(outcome.signalId);
      if (!signal) continue;
      // Credit the highest-weighted piece of evidence behind the signal.
      const lead = [...signal.evidence].sort((a, b) => b.weight - a.weight)[0];
      if (!lead) continue;
      const key = `@${lead.authorHandle} (${lead.sourceTier.replace('_', ' ')})`;
      const list = byHandle.get(key) ?? [];
      list.push(outcome);
      byHandle.set(key, list);
    }

    return [...byHandle.entries()]
      .map(([bucket, list]) => this.summarise(bucket, list))
      .filter((b) => b.count >= 1)
      .sort((a, b) => (b.meanExcessReturnPct ?? -999) - (a.meanExcessReturnPct ?? -999));
  }

  private bucketBy(outcomes: SignalOutcome[], keyFn: (o: SignalOutcome) => string): BucketPerformance[] {
    const groups = new Map<string, SignalOutcome[]>();
    for (const o of outcomes) {
      const key = keyFn(o);
      const list = groups.get(key) ?? [];
      list.push(o);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([bucket, list]) => this.summarise(bucket, list))
      .sort((a, b) => b.count - a.count);
  }

  private summarise(bucket: string, list: SignalOutcome[]): BucketPerformance {
    const returns = list.map((o) => o.forwardReturnPct).filter((v): v is number => v !== null);
    return {
      bucket,
      count: list.length,
      hitRatePct: list.length >= MIN_BUCKET_SAMPLE ? hitRate(list) : null,
      meanReturnPct: avg(list.map((o) => o.forwardReturnPct)),
      meanExcessReturnPct: avg(list.map((o) => o.excessReturnPct)),
      medianReturnPct: returns.length > 0 ? round(median(returns), 4) : null,
    };
  }

  /**
   * Correlation of each signal component with realised excess return.
   *
   * This is where "does materiality actually matter?" gets answered with data
   * rather than with the weight someone picked in the config.
   */
  private correlations(outcomes: SignalOutcome[], signals: Map<string, XSignal>): ComponentCorrelation[] {
    const components: (keyof SignalComponents)[] = [
      'sentiment', 'materiality', 'credibility', 'novelty',
      'engagementVelocity', 'crossSourceConfirmation', 'priceConfirmation', 'recency',
    ];

    return components.map((component) => {
      const pairs: [number, number][] = [];
      for (const o of outcomes) {
        const signal = signals.get(o.signalId);
        const y = o.excessReturnPct ?? o.forwardReturnPct;
        if (!signal || y === null) continue;
        pairs.push([signal.components[component], y]);
      }

      const r = pairs.length >= MIN_BUCKET_SAMPLE ? pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1])) : null;
      return {
        component,
        correlation: r === null ? null : round(r, 4),
        sampleSize: pairs.length,
        interpretation:
          r === null
            ? `Insufficient data (${pairs.length} points)`
            : Math.abs(r) < 0.1
              ? 'No usable relationship with forward return'
              : `${r > 0 ? 'Positive' : 'Negative'} relationship (r=${r.toFixed(2)}) — ${Math.abs(r) < 0.3 ? 'weak' : Math.abs(r) < 0.5 ? 'moderate' : 'strong'}`,
      };
    });
  }
}

/* ------------------------------------------------------------ statistics */

function hitRate(outcomes: SignalOutcome[]): number | null {
  const graded = outcomes.filter((o) => o.hit !== null);
  if (graded.length === 0) return null;
  return round((graded.filter((o) => o.hit).length / graded.length) * 100, 2);
}

function avg(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : round(mean(present), 4);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : sorted[mid] ?? 0;
}

export function pearson(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  const sx = stdev(xs);
  const sy = stdev(ys);
  if (sx === 0 || sy === 0) return null;
  let cov = 0;
  for (let i = 0; i < xs.length; i += 1) cov += (xs[i]! - mx) * (ys[i]! - my);
  cov /= xs.length - 1;
  return cov / (sx * sy);
}

function scoreBucket(score: number): string {
  const abs = Math.abs(score);
  const sign = score >= 0 ? '+' : '-';
  if (abs >= 80) return `${sign}80 to ${sign}100`;
  if (abs >= 60) return `${sign}60 to ${sign}79`;
  if (abs >= 40) return `${sign}40 to ${sign}59`;
  if (abs >= 25) return `${sign}25 to ${sign}39`;
  return '-24 to +24';
}

function bandLabelOf(band: SignalBand): string {
  return band.replace(/_/g, ' ').toLowerCase();
}

function bestTierOf(signal: XSignal): string {
  const order: SourceTier[] = ['TIER_1', 'TIER_2', 'TIER_3', 'TIER_4'];
  for (const tier of order) {
    if (signal.evidence.some((e) => e.sourceTier === tier)) return tier.replace('_', ' ');
  }
  return 'Unknown';
}
