/**
 * Forward-return measurement.
 *
 * Every signal is eventually graded, whether or not it was traded. That is the
 * point of the whole exercise: Northstar needs to learn whether X actually
 * contains tradable information, and signals that were rejected by risk are
 * just as informative as the ones that produced trades.
 *
 * Horizons: 1h (only where intraday data exists), 1d, 1w, 1m. Each is measured
 * against the benchmark over the same window, so the recorded excess return is
 * what the strategy would have added over simply holding the index.
 */
import type { Clock, Logger } from '../../core/index.js';
import { deterministicId } from '../../core/index.js';
import type { ForwardHorizon, PriceBar, SignalOutcome, XSignal } from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { MarketDataProvider } from '../../providers/marketdata/MarketDataProvider.js';

export const HORIZON_MS: Record<ForwardHorizon, number> = {
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 7 * 86_400_000,
  '1m': 30 * 86_400_000,
};

export const ALL_HORIZONS: ForwardHorizon[] = ['1h', '1d', '1w', '1m'];

export interface ForwardReturnOptions {
  store: Store;
  marketData: MarketDataProvider;
  clock: Clock;
  logger: Logger;
  strategyId: string;
  benchmarkTicker: string;
  /** Score magnitude at/above which a signal is directional enough to grade. */
  minDirectionalScore?: number;
}

export interface MeasurementRun {
  created: number;
  measured: number;
  stillPending: number;
  unmeasurable: number;
}

export class ForwardReturnService {
  private readonly store: Store;
  private readonly marketData: MarketDataProvider;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly strategyId: string;
  private readonly benchmarkTicker: string;
  private readonly minDirectionalScore: number;

  constructor(opts: ForwardReturnOptions) {
    this.store = opts.store;
    this.marketData = opts.marketData;
    this.clock = opts.clock;
    this.log = opts.logger.child('forward-returns');
    this.strategyId = opts.strategyId;
    this.benchmarkTicker = opts.benchmarkTicker;
    this.minDirectionalScore = opts.minDirectionalScore ?? 10;
  }

  /**
   * Register the four pending outcome rows for a signal at generation time,
   * capturing the reference price *then* rather than reconstructing it later.
   */
  register(signal: XSignal, referencePrice: number): void {
    if (Math.abs(signal.score) < this.minDirectionalScore) return;
    if (referencePrice <= 0) return;

    for (const horizon of ALL_HORIZONS) {
      const outcome: SignalOutcome = {
        outcomeId: deterministicId('out', signal.signalId, horizon),
        signalId: signal.signalId,
        strategyId: signal.strategyId,
        securityId: signal.securityId,
        ticker: signal.ticker,
        signalScore: signal.score,
        band: signal.band,
        generatedAt: signal.generatedAt,
        entryReferencePrice: referencePrice,
        horizon,
        forwardReturnPct: null,
        benchmarkReturnPct: null,
        excessReturnPct: null,
        measuredAt: null,
        hit: null,
      };
      this.store.outcomes.upsert(outcome);
    }
  }

  /** Measure every pending outcome whose horizon has now elapsed. */
  async measurePending(): Promise<MeasurementRun> {
    const pending = this.store.outcomes.pending(this.strategyId);
    const run: MeasurementRun = { created: 0, measured: 0, stillPending: 0, unmeasurable: 0 };
    const nowMs = this.clock.nowMs();

    // Cache bars per ticker so a hundred pending outcomes on one name make one
    // vendor call, not a hundred.
    const barsCache = new Map<string, PriceBar[]>();

    for (const outcome of pending) {
      const dueMs = new Date(outcome.generatedAt).getTime() + HORIZON_MS[outcome.horizon];
      if (dueMs > nowMs) {
        run.stillPending += 1;
        continue;
      }

      const targetIso = new Date(dueMs).toISOString();
      const price = await this.priceAt(outcome.ticker, outcome.generatedAt, targetIso, barsCache);
      const benchPrice = await this.priceAt(this.benchmarkTicker, outcome.generatedAt, targetIso, barsCache);
      const benchStart = await this.priceAt(this.benchmarkTicker, outcome.generatedAt, outcome.generatedAt, barsCache);

      if (price === null) {
        // 1h outcomes are routinely unmeasurable without an intraday data plan.
        run.unmeasurable += 1;
        continue;
      }

      const forwardReturnPct = ((price - outcome.entryReferencePrice) / outcome.entryReferencePrice) * 100;
      const benchmarkReturnPct =
        benchPrice !== null && benchStart !== null && benchStart > 0
          ? ((benchPrice - benchStart) / benchStart) * 100
          : null;
      const excess = benchmarkReturnPct === null ? null : forwardReturnPct - benchmarkReturnPct;

      // A "hit" means the realised move agreed with the signal's direction,
      // measured against the benchmark where possible so a market-wide rally
      // does not flatter every bullish signal.
      const basis = excess ?? forwardReturnPct;
      const hit = Math.sign(basis) === Math.sign(outcome.signalScore) && Math.abs(basis) > 0;

      this.store.outcomes.upsert({
        ...outcome,
        forwardReturnPct: Number(forwardReturnPct.toFixed(4)),
        benchmarkReturnPct: benchmarkReturnPct === null ? null : Number(benchmarkReturnPct.toFixed(4)),
        excessReturnPct: excess === null ? null : Number(excess.toFixed(4)),
        measuredAt: this.clock.nowIso(),
        hit,
      });
      run.measured += 1;
    }

    if (run.measured > 0 || run.unmeasurable > 0) {
      this.log.info('forward returns measured', run as unknown as Record<string, unknown>);
    }
    return run;
  }

  /**
   * Price at (or immediately before) an instant.
   *
   * Falls back to the local bar cache when the vendor has nothing, and returns
   * null rather than inventing a price — an unmeasured outcome is honest, a
   * guessed one is not.
   */
  private async priceAt(
    ticker: string,
    fromIso: string,
    atIso: string,
    cache: Map<string, PriceBar[]>,
  ): Promise<number | null> {
    const key = ticker.toUpperCase();
    let bars = cache.get(key);
    if (!bars) {
      const from = new Date(new Date(fromIso).getTime() - 5 * 86_400_000).toISOString();
      const to = new Date(this.clock.nowMs()).toISOString();
      try {
        bars = await this.marketData.getDailyBars(key, from, to);
      } catch {
        bars = [];
      }
      if (bars.length === 0) bars = this.store.bars.range(key, from, to);
      cache.set(key, bars);
    }

    const eligible = bars.filter((b) => b.at <= atIso);
    const bar = eligible[eligible.length - 1];
    if (bar) return bar.close;

    const cached = this.store.bars.asOf(key, atIso);
    return cached ? cached.close : null;
  }
}
