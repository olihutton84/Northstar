/**
 * One answer to "is the bot looking at real information?", for everyone.
 *
 * Two components used to decide this separately and disagreed. The autonomy
 * gate accepted operator-supplied X posts inside the experiment window; the
 * readiness report classified the same provider as a fixture and demanded an
 * X_BEARER_TOKEN that the experiment exists precisely to avoid paying for. Since
 * the gate requires a PASSING readiness verdict before it will let anything
 * execute, the two definitions did not merely disagree — they deadlocked, and
 * the manual experiment could never trade at all.
 *
 * So the decision lives here, once, as pure functions over what is actually
 * wired up. Readiness and the gate both read it. They can still weigh it
 * differently — readiness reports, the gate decides — but they can no longer
 * hold different beliefs about what the X provider IS.
 *
 * The categories are deliberately four, not two. Collapsing manual into "live"
 * would make a hand-transcribed post indistinguishable from an API response in
 * every log and every report, which is the one thing the provenance work exists
 * to prevent.
 */
import type { ProviderSummary } from '../app.js';

export type XPosture =
  /** The real X API, authenticated with a bearer token. */
  | 'API_LIVE'
  /** Real public posts, transcribed by an operator, inside an open window. */
  | 'MANUAL_EXPERIMENT'
  /** The manual provider, but the window is closed or expired. */
  | 'MANUAL_UNAVAILABLE'
  /** Invented data. Never acceptable against a real broker. */
  | 'FIXTURE';

export interface XPostureReport {
  posture: XPosture;
  /**
   * Whether this counts as real observed data for a real-data PAPER session.
   *
   * True for the API and for an open manual experiment. Never true for
   * fixtures, and never true for manual once the window has gone.
   */
  realData: boolean;
  /** Whether an X API bearer token is required for this posture. */
  credentialsRequired: boolean;
  /** What to show an operator. Never "LIVE" for manual. */
  label: string;
  detail: string;
}

/** The permission answer from the manual-X experiment, passed in rather than fetched. */
export interface ManualPermission {
  permitted: boolean;
  reason: string;
}

export function xPosture(providers: ProviderSummary, manual: ManualPermission): XPostureReport {
  if (providers.x === 'LIVE') {
    return {
      posture: 'API_LIVE',
      realData: true,
      credentialsRequired: true,
      label: 'X API LIVE',
      detail: 'The X provider is the real API.',
    };
  }

  if (providers.x === 'MANUAL') {
    if (manual.permitted) {
      return {
        posture: 'MANUAL_EXPERIMENT',
        realData: true,
        // The whole point of the experiment: real posts without paying for the
        // API, so requiring the API's token would defeat it.
        credentialsRequired: false,
        label: 'MANUAL REAL OBSERVED DATA',
        detail: `Operator-supplied real X posts. ${manual.reason}`,
      };
    }
    return {
      posture: 'MANUAL_UNAVAILABLE',
      realData: false,
      credentialsRequired: true,
      label: 'MANUAL (not usable)',
      detail: `Manual X posts are not usable: ${manual.reason}`,
    };
  }

  return {
    posture: 'FIXTURE',
    realData: false,
    credentialsRequired: true,
    label: 'FIXTURE (not real data)',
    detail: 'LIVE X DATA REQUIRED — the fixture social provider is active.',
  };
}

/**
 * Is every provider acceptable as real data for a PAPER session?
 *
 * Distinct from `ProviderSummary.allReal`, which asks the narrower question
 * "are all three the real vendor integrations" and is what the banner reports.
 * A manual experiment is real data without being the real vendor, and both
 * facts are worth keeping.
 */
export function realDataConfigured(providers: ProviderSummary, manual: ManualPermission): boolean {
  return (
    xPosture(providers, manual).realData &&
    providers.marketData === 'TIINGO' &&
    providers.broker.startsWith('ALPACA')
  );
}

/**
 * Providers that are still invented, for an operator to fix.
 *
 * A manual experiment is NOT listed: it is real data. A manual provider with no
 * open window IS listed, because in that state the bot has no usable source of
 * X information at all.
 */
export function unrealProviders(providers: ProviderSummary, manual: ManualPermission): string[] {
  const out: string[] = [];
  const x = xPosture(providers, manual);
  if (!x.realData) out.push(`X (${x.posture === 'FIXTURE' ? 'fixture provider' : x.detail})`);
  if (providers.marketData !== 'TIINGO') out.push('market data (fixture provider)');
  if (!providers.broker.startsWith('ALPACA')) out.push('broker (simulated)');
  return out;
}
