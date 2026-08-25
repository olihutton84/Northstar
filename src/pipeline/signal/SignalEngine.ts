/**
 * XSignalEngine.
 *
 * Turns filtered, resolved SocialEvents into fully explained XSignals — one per
 * security per cycle. Reads market data through the Northstar market-data
 * provider only, for confirmation.
 *
 * Nothing here executes anything. The engine's entire output is evidence.
 */
import type { Clock, Logger } from '../../core/index.js';
import { clamp, deterministicId, mean } from '../../core/index.js';
import type { SignalEngineConfig } from '../../config/signalConfig.js';
import type {
  FilterResult,
  PriceBar,
  SignalComponents,
  SignalEvidence,
  SocialEvent,
  TickerResolution,
  XSignal,
} from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { MarketDataProvider } from '../../providers/marketdata/MarketDataProvider.js';
import { bandLabel, computeComposite, computeUncertainty } from './composite.js';
import { aggregateCredibility, scoreCredibility } from './credibility.js';
import { scoreCrossSourceConfirmation, scoreEngagementVelocity, scoreNovelty, scoreRecency } from './dynamics.js';
import { aggregateMateriality, scoreMateriality } from './materiality.js';
import { scorePriceConfirmation } from './priceConfirmation.js';
import { aggregateSentiment, scoreSentiment } from './sentiment.js';

export interface SignalEngineOptions {
  store: Store;
  marketData: MarketDataProvider;
  config: SignalEngineConfig;
  clock: Clock;
  logger: Logger;
  strategyId: string;
  strategyVersion: string;
  benchmarkTicker: string;
}

export interface SignalCandidate {
  securityId: string;
  ticker: string;
  events: SocialEvent[];
  filters: Map<string, FilterResult>;
  resolutions: Map<string, TickerResolution>;
}

/** Per-event scoring, retained so the UI can show why each post mattered. */
interface ScoredEvent {
  event: SocialEvent;
  filter: FilterResult;
  resolution: TickerResolution;
  weight: number;
  sentiment: number;
  sentimentTerms: { positive: string[]; negative: string[] };
  materiality: number;
  eventType: ReturnType<typeof scoreMateriality>['eventType'];
  materialityRationale: string;
  credibility: number;
  credibilityExplanation: string;
  engagement: number;
  engagementExplanation: string;
  novelty: number;
  noveltyExplanation: string;
}

export class XSignalEngine {
  private readonly store: Store;
  private readonly marketData: MarketDataProvider;
  private readonly config: SignalEngineConfig;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly strategyId: string;
  private readonly strategyVersion: string;
  private readonly benchmarkTicker: string;

  constructor(opts: SignalEngineOptions) {
    this.store = opts.store;
    this.marketData = opts.marketData;
    this.config = opts.config;
    this.clock = opts.clock;
    this.log = opts.logger.child('signal-engine');
    this.strategyId = opts.strategyId;
    this.strategyVersion = opts.strategyVersion;
    this.benchmarkTicker = opts.benchmarkTicker;
  }

  /**
   * Group scored events by security. Events rejected by the filter are dropped
   * here and never influence a signal.
   */
  buildCandidates(
    events: SocialEvent[],
    filters: FilterResult[],
    resolutions: TickerResolution[],
  ): SignalCandidate[] {
    const filterByEvent = new Map(filters.map((f) => [f.eventId, f]));
    const bySecurity = new Map<string, SignalCandidate>();

    for (const resolution of resolutions) {
      const event = events.find((e) => e.eventId === resolution.eventId);
      if (!event) continue;
      const filter = filterByEvent.get(event.eventId);
      if (!filter || filter.verdict === 'REJECT') continue;

      let candidate = bySecurity.get(resolution.securityId);
      if (!candidate) {
        candidate = {
          securityId: resolution.securityId,
          ticker: resolution.ticker,
          events: [],
          filters: new Map(),
          resolutions: new Map(),
        };
        bySecurity.set(resolution.securityId, candidate);
      }
      candidate.events.push(event);
      candidate.filters.set(event.eventId, filter);
      candidate.resolutions.set(event.eventId, resolution);
    }

    return [...bySecurity.values()];
  }

  async generate(candidate: SignalCandidate): Promise<XSignal | null> {
    const nowMs = this.clock.nowMs();
    const maxAgeMs = this.config.maxEventAgeHours * 3_600_000;

    const eligible = candidate.events.filter((e) => nowMs - new Date(e.postedAt).getTime() <= maxAgeMs);
    if (eligible.length === 0) {
      this.log.debug('no eligible events for candidate', { ticker: candidate.ticker });
      return null;
    }

    const scored = eligible.map((event) => this.scoreEvent(event, candidate, nowMs)).filter((s): s is ScoredEvent => s !== null);
    if (scored.length === 0) return null;

    // Do not re-emit a signal for a security when nothing new has arrived and
    // the previous signal is still fresh. See `resignalIntervalMinutes`.
    if (!this.shouldEmit(candidate.securityId, scored.map((s) => s.event.eventId), nowMs)) {
      this.log.debug('skipping re-signal: no new evidence', { ticker: candidate.ticker });
      return null;
    }

    /* -------------------------------------------------- aggregate the X side */
    const sentimentAgg = aggregateSentiment(scored.map((s) => ({ sentiment: s.sentiment, weight: s.weight })));
    const materialityAgg = aggregateMateriality(
      scored.map((s) => ({ materiality: s.materiality, eventType: s.eventType, weight: s.weight })),
    );
    const credibility = aggregateCredibility(
      scored.map((s) => ({ credibility: s.credibility, tier: s.event.sourceTier, weight: s.weight })),
    );

    const crossSource = scoreCrossSourceConfirmation({
      sources: scored.map((s) => ({ authorId: s.event.authorId, tier: s.event.sourceTier, weight: s.weight })),
      config: this.config,
    });

    // Novelty and engagement describe the *leading* post — the one that broke
    // the story — not the average of the crowd repeating it.
    const leading = scored.reduce((a, b) => (b.materiality * b.weight > a.materiality * a.weight ? b : a));
    const novelty = Math.round(mean(scored.map((s) => s.novelty)) * 0.4 + leading.novelty * 0.6);
    const engagementVelocity = Math.round(Math.max(...scored.map((s) => s.engagement)));

    const newestPostedAt = Math.max(...scored.map((s) => new Date(s.event.postedAt).getTime()));
    const recency = scoreRecency(newestPostedAt, nowMs, this.config.recencyHalfLifeHours);

    /* --------------------------------------------------- price confirmation */
    const price = await this.priceConfirmation(candidate.ticker);

    const components: SignalComponents = {
      sentiment: sentimentAgg.score,
      materiality: materialityAgg.score,
      credibility,
      novelty,
      engagementVelocity,
      crossSourceConfirmation: crossSource.score,
      priceConfirmation: price?.score ?? 0,
      recency: recency.score,
    };

    const composite = computeComposite({ components, config: this.config });

    const resolutionConfidence = Math.min(...scored.map((s) => s.resolution.confidence));
    const uncertainty = computeUncertainty({
      independentSourceCount: crossSource.independentSourceCount,
      resolutionConfidence,
      sentimentDisagreement: sentimentAgg.disagreement,
      priceDataAvailable: price !== null,
      materiality: materialityAgg.score,
      config: this.config,
    });

    /* --------------------------------------------------------- evidence */
    const evidence: SignalEvidence[] = scored
      .sort((a, b) => b.weight * Math.abs(b.sentiment) - a.weight * Math.abs(a.sentiment))
      .map((s) => ({
        eventId: s.event.eventId,
        postId: s.event.postId,
        authorHandle: s.event.authorHandle,
        sourceTier: s.event.sourceTier,
        postedAt: s.event.postedAt,
        excerpt: s.event.text.length > 220 ? `${s.event.text.slice(0, 217)}...` : s.event.text,
        url: s.event.url,
        weight: s.weight,
        sentiment: s.sentiment,
        eventType: s.eventType,
      }));

    const direction = Math.sign(composite.score);
    const supporting: string[] = [];
    const contradictory: string[] = [];

    for (const s of scored) {
      const agrees = direction === 0 || Math.sign(s.sentiment) === direction || s.sentiment === 0;
      const line =
        `@${s.event.authorHandle} (${s.event.sourceTier.replace('_', ' ')}, ${s.eventType.replace(/_/g, ' ').toLowerCase()}): ` +
        `sentiment ${s.sentiment >= 0 ? '+' : ''}${s.sentiment}, materiality ${s.materiality}/100 — ` +
        `"${s.event.text.slice(0, 120)}${s.event.text.length > 120 ? '...' : ''}"`;
      if (agrees && Math.abs(s.sentiment) >= 5) supporting.push(line);
      else if (!agrees) contradictory.push(line);
    }

    if (price) {
      const priceLine = `Market data: ${price.explanation}`;
      const priceAgrees = direction === 0 || Math.sign(price.score) === direction || price.score === 0;
      if (priceAgrees) supporting.push(priceLine);
      else contradictory.push(priceLine);
    }

    if (crossSource.distinctAuthors <= 1) {
      contradictory.push('Only one distinct source: no independent confirmation of this claim.');
    }
    if (resolutionConfidence < 0.8) {
      contradictory.push(
        `Entity resolution is only ${(resolutionConfidence * 100).toFixed(0)}% confident that these posts refer to ${candidate.ticker}.`,
      );
    }

    const generatedAt = this.clock.nowIso();
    const signalId = deterministicId(
      'sig',
      this.strategyId,
      this.strategyVersion,
      candidate.securityId,
      generatedAt,
      scored.map((s) => s.event.eventId).sort().join(','),
    );

    const signal: XSignal = {
      signalId,
      strategyId: this.strategyId,
      strategyVersion: this.strategyVersion,
      securityId: candidate.securityId,
      ticker: candidate.ticker,
      score: composite.score,
      band: composite.band,
      uncertainty: uncertainty.value,
      generatedAt,
      components,
      contributions: composite.contributions,
      signalConfigId: this.config.signalConfigId,
      triggeringEventIds: scored.map((s) => s.event.eventId),
      evidence,
      supportingEvidence: supporting,
      contradictoryEvidence: contradictory,
      dominantEventType: materialityAgg.dominantEventType,
      priceConfirmationDetail: price?.detail ?? null,
      explanation: this.explain({
        ticker: candidate.ticker,
        composite,
        components,
        crossSource,
        recency,
        uncertainty,
        leading,
        materialityAgg,
        priceExplanation: price?.explanation ?? null,
        sentimentDisagreement: sentimentAgg.disagreement,
      }),
      sourceCount: scored.length,
      independentSourceCount: crossSource.independentSourceCount,
      resolutionConfidence,
    };

    return signal;
  }

  /* ------------------------------------------------------- per-event work */

  private scoreEvent(event: SocialEvent, candidate: SignalCandidate, nowMs: number): ScoredEvent | null {
    const filter = candidate.filters.get(event.eventId);
    const resolution = candidate.resolutions.get(event.eventId);
    if (!filter || !resolution || filter.verdict === 'REJECT') return null;

    const sentiment = scoreSentiment(event.text);
    const materiality = scoreMateriality(event.text);

    const author = this.store.authors.byId(event.authorId);
    const credibility = scoreCredibility({
      sourceTier: event.sourceTier,
      sourceClass: event.sourceClass,
      verified: author?.verified ?? false,
      followerCount: author?.followerCount ?? 0,
      ...(author?.accountCreatedAt ? { accountCreatedAt: author.accountCreatedAt } : {}),
      isOfficialForSecurity: author?.officialForSecurityId === candidate.securityId,
      nowMs,
    });

    const ageMinutes = Math.max(0, (nowMs - new Date(event.postedAt).getTime()) / 60_000);
    const engagement = scoreEngagementVelocity({
      engagement: event.engagement,
      authorBaseline: event.authorBaselineEngagement ?? author?.baselineEngagement ?? 0,
      ageMinutes,
      saturationMultiple: this.config.engagementSaturationMultiple,
      tier: event.sourceTier,
    });

    // Novelty needs the story's history: how long the cluster has existed and
    // how many posts already belong to it.
    const clusterEventIds = this.store.filters.clusterEventIds(filter.dedupKey);
    const priorIds = clusterEventIds.filter((id) => id !== event.eventId);
    const clusterEvents = this.store.events.byIds(priorIds);
    const firstSeenMs = clusterEvents.length > 0
      ? Math.min(...clusterEvents.map((e) => new Date(e.postedAt).getTime()))
      : new Date(event.postedAt).getTime();
    const alreadySignalled = priorIds.length > 0 && this.clusterAlreadySignalled(priorIds);

    const novelty = scoreNovelty({
      postedAtMs: new Date(event.postedAt).getTime(),
      clusterFirstSeenMs: Math.min(firstSeenMs, new Date(event.postedAt).getTime()),
      priorClusterSize: priorIds.length,
      alreadySignalled,
      halfLifeHours: this.config.noveltyHalfLifeHours,
    });

    return {
      event,
      filter,
      resolution,
      weight: filter.weight,
      sentiment: sentiment.score,
      sentimentTerms: { positive: sentiment.positiveTerms, negative: sentiment.negativeTerms },
      materiality: materiality.score,
      eventType: materiality.eventType,
      materialityRationale: materiality.rationale,
      credibility: credibility.score,
      credibilityExplanation: credibility.explanation,
      engagement: engagement.score,
      engagementExplanation: engagement.explanation,
      novelty: novelty.score,
      noveltyExplanation: novelty.explanation,
    };
  }

  /**
   * True when this candidate deserves a new signal record.
   *
   * New evidence always qualifies. Otherwise the previous signal must be older
   * than the re-signal interval, so that price confirmation and recency get
   * refreshed for the exit engine without emitting a signal every cycle.
   */
  private shouldEmit(securityId: string, eventIds: string[], nowMs: number): boolean {
    const previous = this.store.signals.latestForSecurity(this.strategyId, securityId);
    if (!previous) return true;

    const seen = new Set(previous.triggeringEventIds);
    const hasNewEvidence = eventIds.some((id) => !seen.has(id));
    if (hasNewEvidence) return true;

    const ageMinutes = (nowMs - new Date(previous.generatedAt).getTime()) / 60_000;
    return ageMinutes >= this.config.resignalIntervalMinutes;
  }

  private clusterAlreadySignalled(eventIds: string[]): boolean {
    const set = new Set(eventIds);
    // Look only at recent signals: a story from last month re-emerging is novel
    // again in practice.
    const since = new Date(this.clock.nowMs() - this.config.maxEventAgeHours * 3_600_000).toISOString();
    return this.store.signals.since(since).some((s) => s.triggeringEventIds.some((id) => set.has(id)));
  }

  /* ------------------------------------------------------- price context */

  private async priceConfirmation(ticker: string): Promise<ReturnType<typeof scorePriceConfirmation> | null> {
    try {
      const quote = await this.marketData.getQuote(ticker);
      const lookbackDays = Math.max(this.config.priceLookbackDays * 3, 20);
      const from = new Date(this.clock.nowMs() - lookbackDays * 86_400_000).toISOString();
      const to = this.clock.nowIso();

      const [bars, benchmarkBars] = await Promise.all([
        this.safeBars(ticker, from, to),
        this.safeBars(this.benchmarkTicker, from, to),
      ]);

      if (bars.length === 0) return null;

      return scorePriceConfirmation({
        ticker,
        bars,
        benchmarkBars,
        lastPrice: quote.price,
        asOf: quote.asOf,
        dataAgeMinutes: quote.ageMinutes,
        stale: quote.stale,
        config: this.config,
      });
    } catch (e) {
      // Missing market data must not block a signal — it raises uncertainty and
      // removes the price adjustment, which is the honest outcome.
      this.log.warn('price confirmation unavailable', { ticker, detail: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  private async safeBars(ticker: string, from: string, to: string): Promise<PriceBar[]> {
    try {
      const bars = await this.marketData.getDailyBars(ticker, from, to);
      if (bars.length > 0) return bars;
    } catch {
      /* fall through to the local cache */
    }
    return this.store.bars.range(ticker, from, to);
  }

  /* -------------------------------------------------------- explanation */

  private explain(input: {
    ticker: string;
    composite: ReturnType<typeof computeComposite>;
    components: SignalComponents;
    crossSource: ReturnType<typeof scoreCrossSourceConfirmation>;
    recency: ReturnType<typeof scoreRecency>;
    uncertainty: ReturnType<typeof computeUncertainty>;
    leading: ScoredEvent;
    materialityAgg: ReturnType<typeof aggregateMateriality>;
    priceExplanation: string | null;
    sentimentDisagreement: number;
  }): string {
    const { composite, components, crossSource, recency, uncertainty, leading, materialityAgg } = input;
    const eventLabel = materialityAgg.dominantEventType.replace(/_/g, ' ').toLowerCase();

    const parts: string[] = [];

    parts.push(
      `${bandLabel(composite.band)} ${composite.score >= 0 ? '+' : ''}${composite.score} on ${input.ticker}: ` +
      `X is reporting a ${eventLabel} led by @${leading.event.authorHandle} ` +
      `(${leading.event.sourceTier.replace('_', ' ')}).`,
    );

    parts.push(
      `Direction comes from sentiment ${components.sentiment >= 0 ? '+' : ''}${components.sentiment}, ` +
      `scaled by ${(composite.conviction * 100).toFixed(0)}% conviction ` +
      `(materiality ${components.materiality}, credibility ${components.credibility}, novelty ${components.novelty}, ` +
      `engagement ${components.engagementVelocity}, confirmation ${components.crossSourceConfirmation}, ` +
      `recency ${components.recency}) to give a base of ${composite.base.toFixed(1)}.`,
    );

    if (composite.priceGateBlocked) {
      parts.push(
        `Price confirmation was withheld: the base did not clear the ${this.config.priceGateMinAbsBase}-point gate, ` +
        `so market data alone cannot manufacture a signal here.`,
      );
    } else {
      parts.push(
        `Market data adjusted the score by ${composite.priceAdjustment >= 0 ? '+' : ''}${composite.priceAdjustment.toFixed(1)} ` +
        `points (hard cap ±${this.config.maxPriceContribution}). ${input.priceExplanation ?? 'No price detail available.'}`,
      );
    }

    parts.push(crossSource.explanation + '. ' + recency.explanation + '.');

    const topDrivers = [...uncertainty.drivers].sort((a, b) => b.contribution - a.contribution).slice(0, 2);
    parts.push(
      `Uncertainty ${(uncertainty.value * 100).toFixed(0)}%, driven mainly by ` +
      topDrivers.map((d) => d.note.toLowerCase()).join(' and ') + '.',
    );

    if (input.sentimentDisagreement > 0.3) {
      parts.push(`Note: sources disagree on direction (${(input.sentimentDisagreement * 100).toFixed(0)}% split).`);
    }

    return parts.join(' ');
  }
}

/** Convenience for analytics: how far a score is into its band. */
export function bandStrength(score: number): number {
  return clamp(Math.abs(score) / 100, 0, 1);
}
