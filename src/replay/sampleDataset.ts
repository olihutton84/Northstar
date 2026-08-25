/**
 * Deterministic sample dataset.
 *
 * Lets replay and version comparison be exercised before any real data exists.
 * It is generated from a seed, so the same seed always yields byte-identical
 * output and two replays of it are directly comparable.
 *
 * The prices are synthetic. A sample replay therefore validates the MACHINERY —
 * that the stages connect, that no look-ahead is possible, that risk binds —
 * and says nothing whatever about whether X contains alpha. Use an exported
 * real dataset for that.
 */
import { deterministicId } from '../core/index.js';
import type { PriceBar, SocialAuthor, SocialEvent } from '../domain/types.js';
import { SourceRegistry, normaliseHandle } from '../providers/social/sourceRegistry.js';
import { DATASET_FORMAT_VERSION, validateDataset, type ReplayDataset } from './dataset.js';

const TICKERS = ['NVDA', 'AAPL', 'TSLA', 'AMD', 'PFE'] as const;
const START_PRICES: Record<string, number> = { NVDA: 120, AAPL: 200, TSLA: 250, AMD: 150, PFE: 30, SPY: 500 };

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export interface SampleDatasetOptions {
  /** Replay window start. Should be a weekday morning for the market to be open. */
  from?: string;
  /** How many trading hours the window spans. */
  hours?: number;
  seed?: number;
  benchmarkTicker?: string;
}

export function buildSampleDataset(opts: SampleDatasetOptions = {}): ReplayDataset {
  const from = opts.from ?? '2026-03-02T14:35:00.000Z'; // Monday 09:35 New York
  const hours = opts.hours ?? 24;
  const seed = opts.seed ?? 424242;
  const benchmarkTicker = (opts.benchmarkTicker ?? 'SPY').toUpperCase();

  const random = rng(seed);
  const registry = new SourceRegistry();
  const fromMs = new Date(from).getTime();
  const toMs = fromMs + hours * 3_600_000;

  /* ------------------------------------------------------------- bars --- */
  // 45 days of daily warm-up history so momentum and volatility features have
  // something to work with on the very first cycle, then hourly bars across the
  // window itself.
  const bars: PriceBar[] = [];
  const prices: Record<string, number> = { ...START_PRICES };

  for (const ticker of [...TICKERS, benchmarkTicker]) {
    let price = prices[ticker] ?? 100;
    for (let day = 45; day >= 1; day -= 1) {
      const at = new Date(fromMs - day * 86_400_000).toISOString();
      const move = (random() - 0.49) * 1.4;
      price *= 1 + move / 100;
      bars.push(barAt(ticker, at, price, random));
    }
    prices[ticker] = price;
  }

  /* ------------------------------------------------------------ events --- */
  const events: SocialEvent[] = [];
  const authors = new Map<string, SocialAuthor & { baselineEngagement: number }>();

  const push = (spec: {
    postId: string;
    handle: string;
    text: string;
    atMs: number;
    likes: number;
    reposts?: number;
    baseline: number;
  }): void => {
    const author = registry.classify({
      authorId: deterministicId('author', normaliseHandle(spec.handle)),
      handle: spec.handle,
      displayName: spec.handle,
      verified: true,
      followerCount: 100_000,
    });
    authors.set(author.authorId, { ...author, baselineEngagement: spec.baseline });

    const postedAt = new Date(spec.atMs).toISOString();
    events.push({
      eventId: deterministicId('evt', 'X', spec.postId),
      platform: 'X',
      postId: spec.postId,
      authorId: author.authorId,
      authorHandle: author.handle,
      authorDisplayName: author.displayName,
      sourceClass: author.sourceClass,
      sourceTier: author.sourceTier,
      postedAt,
      // Observed a minute after publication, as a live poller would.
      capturedAt: new Date(spec.atMs + 60_000).toISOString(),
      text: spec.text,
      url: `https://x.com/${author.handle}/status/${spec.postId}`,
      lang: 'en',
      kind: 'ORIGINAL',
      mentionedCashtags: [...spec.text.matchAll(/\$([A-Z]{1,5})\b/g)].map((m) => m[1]!),
      mentionedCompanies: [],
      resolvedSecurityIds: [],
      engagement: { likes: spec.likes, reposts: spec.reposts ?? Math.floor(spec.likes / 3), replies: 40, quotes: 25 },
      authorBaselineEngagement: spec.baseline,
      ingestBatchId: 'sample',
    });
  };

  // One genuine, corroborated story every few hours, with noise between.
  const storyPrices = new Map<string, number>();
  let storyIndex = 0;
  for (let hour = 1; hour < hours; hour += 3) {
    const atMs = fromMs + hour * 3_600_000;
    const ticker = TICKERS[storyIndex % TICKERS.length]!;
    storyIndex += 1;
    const bullish = random() < 0.6;
    const amount = (15 + random() * 30).toFixed(1);

    const headline = bullish
      ? `${ticker} raises full-year guidance to $${amount}B on accelerating demand. $${ticker}`
      : `${ticker} cuts full-year guidance to $${amount}B, citing weaker demand. $${ticker}`;

    push({ postId: `s${storyIndex}-t1`, handle: 'reuters', text: headline, atMs, likes: 3200, baseline: 800 });
    push({
      postId: `s${storyIndex}-t2`,
      handle: 'cnbc',
      text: `${headline} Shares in focus at the open.`,
      atMs: atMs + 120_000,
      likes: 1900,
      baseline: 700,
    });
    // Noise arriving alongside real news, as it does in reality.
    push({
      postId: `s${storyIndex}-noise`,
      handle: 'moonboy420',
      text: `GIVEAWAY! Free shares of $${ticker} to 10 lucky followers, enter to win now!`,
      atMs: atMs + 180_000,
      likes: 26_000,
      baseline: 500,
    });
    push({
      postId: `s${storyIndex}-echo`,
      handle: 'apeinvestor',
      text: `$${ticker} STONKS ONLY GO UP, diamond hands, apes together strong here`,
      atMs: atMs + 240_000,
      likes: 8_000,
      baseline: 900,
    });

    storyPrices.set(ticker, bullish ? 6 + random() * 6 : -(6 + random() * 6));
  }

  /* ------------------------------------- hourly bars across the window --- */
  for (const ticker of [...TICKERS, benchmarkTicker]) {
    let price = prices[ticker] ?? 100;
    const drift = ticker === benchmarkTicker ? 0.05 : (storyPrices.get(ticker) ?? 0) / Math.max(1, hours);
    for (let hour = 0; hour <= hours; hour += 1) {
      const at = new Date(fromMs + hour * 3_600_000).toISOString();
      const noise = (random() - 0.5) * 0.5;
      price *= 1 + (drift + noise) / 100;
      bars.push(barAt(ticker, at, price, random));
    }
  }

  return validateDataset({
    formatVersion: DATASET_FORMAT_VERSION,
    datasetId: `sample-${seed}-${hours}h`,
    description:
      'Deterministic SAMPLE dataset with synthetic prices. Validates the replay machinery and the risk ' +
      'controls; it is not evidence about the strategy edge.',
    createdAt: new Date(fromMs).toISOString(),
    window: { from, to: new Date(toMs).toISOString() },
    benchmarkTicker,
    events,
    authors: [...authors.values()],
    bars,
  });
}

function barAt(ticker: string, at: string, close: number, random: () => number): PriceBar {
  return {
    ticker: ticker.toUpperCase(),
    at,
    open: close * (1 - random() * 0.004),
    high: close * (1 + random() * 0.006),
    low: close * (1 - random() * 0.006),
    close,
    volume: 500_000 + Math.floor(random() * 400_000),
  };
}
