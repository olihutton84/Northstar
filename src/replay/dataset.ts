/**
 * Replay datasets.
 *
 * A dataset is a frozen record of what the world looked like over a window:
 * the X events Northstar observed and the price bars available to it. Replaying
 * one runs the real pipeline over it, so a historical decision can be
 * reproduced or a new strategy version can be judged against exactly the same
 * evidence.
 *
 * Everything needed for reproduction is in the file. Nothing is fetched at
 * replay time, which is what makes a replay deterministic.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PriceBar, SocialAuthor, SocialEvent } from '../domain/types.js';
import type { Store } from '../persistence/store.js';

export const DATASET_FORMAT_VERSION = 1;

export interface ReplayDataset {
  formatVersion: number;
  datasetId: string;
  description: string;
  createdAt: string;
  /** The replay window. Cycles run from `from` to `to`. */
  window: { from: string; to: string };
  benchmarkTicker: string;
  /** Observed X events, each carrying its own postedAt and capturedAt. */
  events: SocialEvent[];
  /** Author records as they stood, so tier and baseline are reproduced. */
  authors: (SocialAuthor & { baselineEngagement: number })[];
  /** Price history. Bars are revealed to the replay only as time passes. */
  bars: PriceBar[];
}

export interface DatasetStats {
  events: number;
  authors: number;
  bars: number;
  tickers: string[];
  windowHours: number;
}

export function datasetStats(dataset: ReplayDataset): DatasetStats {
  const tickers = [...new Set(dataset.bars.map((b) => b.ticker))].sort();
  const from = new Date(dataset.window.from).getTime();
  const to = new Date(dataset.window.to).getTime();
  return {
    events: dataset.events.length,
    authors: dataset.authors.length,
    bars: dataset.bars.length,
    tickers,
    windowHours: Number(((to - from) / 3_600_000).toFixed(2)),
  };
}

export function writeDataset(path: string, dataset: ReplayDataset): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(dataset, null, 2), 'utf8');
}

export function readDataset(path: string): ReplayDataset {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ReplayDataset;
  return validateDataset(parsed);
}

/**
 * Reject a dataset that cannot produce an honest replay.
 *
 * The ordering checks matter: an event whose `capturedAt` precedes its
 * `postedAt` would let the replay see a post before it was written, which is
 * look-ahead smuggled in through the data rather than through the code.
 */
export function validateDataset(dataset: ReplayDataset): ReplayDataset {
  const problems: string[] = [];

  if (dataset.formatVersion !== DATASET_FORMAT_VERSION) {
    problems.push(`Unsupported dataset format ${dataset.formatVersion} (expected ${DATASET_FORMAT_VERSION})`);
  }
  if (!dataset.window?.from || !dataset.window?.to) {
    problems.push('Dataset window is missing');
  } else if (new Date(dataset.window.from).getTime() >= new Date(dataset.window.to).getTime()) {
    problems.push('Dataset window ends at or before it starts');
  }

  for (const event of dataset.events ?? []) {
    if (new Date(event.capturedAt).getTime() < new Date(event.postedAt).getTime()) {
      problems.push(`Event ${event.eventId} was captured before it was posted`);
    }
  }

  const seenPostIds = new Set<string>();
  for (const event of dataset.events ?? []) {
    if (seenPostIds.has(event.postId)) problems.push(`Duplicate post id in dataset: ${event.postId}`);
    seenPostIds.add(event.postId);
  }

  if ((dataset.bars ?? []).length === 0) {
    problems.push(
      'Dataset contains no price bars. A replay cannot price anything without history — check that the run ' +
      'that produced it had a market-data provider writing through to the local bar cache.',
    );
  }

  if (problems.length > 0) {
    throw new Error(`Invalid replay dataset:\n  - ${problems.join('\n  - ')}`);
  }

  return {
    ...dataset,
    events: [...dataset.events].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
    bars: [...dataset.bars].sort((a, b) => a.at.localeCompare(b.at) || a.ticker.localeCompare(b.ticker)),
  };
}

/**
 * Export what a live run actually saw, so it can be replayed later.
 *
 * This is the reproducibility path: after a real paper run, freeze the window
 * and every future replay of it sees precisely the same evidence.
 */
export function exportDatasetFromStore(
  store: Store,
  opts: { from: string; to: string; benchmarkTicker: string; datasetId: string; description?: string; createdAt: string },
): ReplayDataset {
  const events = store.events.since(opts.from, 100_000).filter((e) => e.capturedAt <= opts.to);
  const tickers = new Set<string>([opts.benchmarkTicker.toUpperCase()]);
  for (const resolution of store.resolutions.byEvents(events.map((e) => e.eventId))) {
    tickers.add(resolution.ticker.toUpperCase());
  }

  const bars: PriceBar[] = [];
  for (const ticker of tickers) {
    // Reach back before the window so momentum and volatility features have the
    // history they need on the very first cycle.
    const warmupFrom = new Date(new Date(opts.from).getTime() - 60 * 86_400_000).toISOString();
    bars.push(...store.bars.range(ticker, warmupFrom, opts.to));
  }

  return validateDataset({
    formatVersion: DATASET_FORMAT_VERSION,
    datasetId: opts.datasetId,
    description: opts.description ?? `Exported from the Northstar store for ${opts.from} .. ${opts.to}`,
    createdAt: opts.createdAt,
    window: { from: opts.from, to: opts.to },
    benchmarkTicker: opts.benchmarkTicker.toUpperCase(),
    events,
    authors: events
      .map((e) => store.authors.byId(e.authorId))
      .filter((a): a is NonNullable<typeof a> => a !== null)
      .filter((a, i, all) => all.findIndex((x) => x.authorId === a.authorId) === i),
    bars,
  });
}
