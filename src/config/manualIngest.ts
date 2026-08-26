/**
 * The temporary manual-X experiment.
 *
 * The X API costs money. For a bounded experiment the operator supplies real,
 * public X posts by hand instead — the same posts the API would have returned,
 * transcribed rather than fetched.
 *
 * Two things make that acceptable rather than reckless:
 *
 *   PROVENANCE. A manual observation is not a fixture and is never presented as
 *   API data. It carries the URL it came from, who supplied it and when, and
 *   every trade taken because of it can be traced back to that URL. The
 *   dashboard says MANUAL REAL OBSERVED DATA, never X API LIVE.
 *
 *   AN EXPIRY THAT IS NOT NEGOTIABLE. The window is at most seven days, and the
 *   maximum lives HERE, in code, not in the record the operator creates. An
 *   experiment that can be extended by editing a row is not a temporary
 *   experiment; it is a permanent mode with a hopeful name. When the window
 *   closes the bot stops accepting manual data and stops trading on it, with no
 *   further action required from anyone.
 *
 * It is PAPER-only, and that is enforced in more than one place — see
 * `manualIngestPermitted` and the provider construction in app.ts.
 */
import type { Clock } from '../core/index.js';

/**
 * The hard ceiling on the experiment.
 *
 * Deliberately a constant and deliberately not configurable. Raising it is a
 * code change and therefore a review.
 */
export const MANUAL_INGEST_MAX_DAYS = 7;

export const MANUAL_INGEST_SOURCE = 'X_MANUAL' as const;
export const MANUAL_INGEST_PROVENANCE = 'MANUAL_OPERATOR_SUPPLIED' as const;

export interface ManualIngestWindow {
  /** True only while the experiment is running AND unexpired. */
  active: boolean;
  startedAt: string | null;
  /** Never more than MANUAL_INGEST_MAX_DAYS after `startedAt`. */
  expiresAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  startedBy: string | null;
  note: string | null;
  /** Whole hours left, or null when no window is open. */
  hoursRemaining: number | null;
  /** Why it is not active, when it is not. */
  inactiveReason: string | null;
}

export const NO_MANUAL_WINDOW: ManualIngestWindow = {
  active: false,
  startedAt: null,
  expiresAt: null,
  endedAt: null,
  endedReason: null,
  startedBy: null,
  note: null,
  hoursRemaining: null,
  inactiveReason: 'The manual-X experiment has never been started.',
};

/**
 * The expiry for a window started at `startedAt`.
 *
 * Computed from the ceiling rather than read back from storage, so a stored
 * expiry cannot outlive what the code permits even if the row is edited.
 */
export function expiryFor(startedAt: string): string {
  return new Date(new Date(startedAt).getTime() + MANUAL_INGEST_MAX_DAYS * 86_400_000).toISOString();
}

export interface StoredManualWindow {
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  startedBy: string;
  note: string;
}

/** Resolve a stored record into the window as it stands right now. */
export function resolveWindow(stored: StoredManualWindow | null, clock: Clock): ManualIngestWindow {
  if (!stored) return NO_MANUAL_WINDOW;

  const expiresAt = expiryFor(stored.startedAt);
  const nowMs = clock.nowMs();
  const expired = nowMs >= new Date(expiresAt).getTime();
  const stopped = stored.endedAt !== null;

  const base = {
    startedAt: stored.startedAt,
    expiresAt,
    endedAt: stored.endedAt,
    endedReason: stored.endedReason,
    startedBy: stored.startedBy,
    note: stored.note,
  };

  if (stopped) {
    return {
      ...base,
      active: false,
      hoursRemaining: null,
      inactiveReason: `The manual-X experiment was stopped at ${stored.endedAt}` +
        `${stored.endedReason ? `: ${stored.endedReason}` : '.'}`,
    };
  }

  if (expired) {
    return {
      ...base,
      active: false,
      hoursRemaining: 0,
      inactiveReason:
        `The ${MANUAL_INGEST_MAX_DAYS}-day manual-X experiment expired at ${expiresAt}. ` +
        'Manual posts are no longer accepted and no longer count as real data.',
    };
  }

  return {
    ...base,
    active: true,
    hoursRemaining: Math.floor((new Date(expiresAt).getTime() - nowMs) / 3_600_000),
    inactiveReason: null,
  };
}

/**
 * May manual observations be treated as real observed data right now?
 *
 * Both conditions, always. PAPER is not a detail here: Alpaca LIVE commits real
 * money, and hand-typed evidence — however honestly transcribed — is not a
 * basis on which to do that without a human reading it first. The experiment
 * exists to test a strategy on real posts, not to shorten the path to money.
 */
export function manualIngestPermitted(
  window: ManualIngestWindow,
  brokerMode: 'PAPER' | 'LIVE',
  strategyMode: 'PAPER' | 'LIVE',
): { permitted: boolean; reason: string } {
  if (brokerMode === 'LIVE' || strategyMode === 'LIVE') {
    return {
      permitted: false,
      reason: 'LIVE never accepts operator-supplied X posts, in or out of the experiment window.',
    };
  }
  if (!window.active) {
    return { permitted: false, reason: window.inactiveReason ?? 'The manual-X experiment is not active.' };
  }
  return {
    permitted: true,
    reason: `Manual-X experiment active until ${window.expiresAt} (${window.hoursRemaining}h remaining).`,
  };
}
