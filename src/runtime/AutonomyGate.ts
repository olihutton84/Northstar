/**
 * May the bot place an order without a human looking at it?
 *
 * The bot runs in one of three tiers, and the tier is DERIVED from what is
 * actually wired up rather than declared by a flag. A flag can be set wrongly;
 * the providers cannot lie about what they are.
 *
 *   SIMULATION  fixture data, simulated broker.   Nothing real is touched, so
 *               orders route automatically.
 *   PAPER       real data, Alpaca PAPER account.  Orders route automatically
 *               only when every gate below passes.
 *   LIVE        real data, Alpaca LIVE account.   NEVER routes automatically.
 *               A human approves every order, always.
 *
 * The rule that matters most is the one in the middle. Alpaca PAPER is a real
 * account: it has an account number, a balance, a fill history and an audit
 * trail. Sending it orders derived from FIXTURE posts and FIXTURE prices would
 * write a fictional trading record into a real account and call it a paper
 * track record. Nothing else in the pipeline notices — the fixtures produce
 * plausible signals, risk approves them, and the broker accepts them.
 *
 * So the tier requires COHERENCE: fixture data may only reach a simulated
 * broker, and a real broker may only be reached by real data. A mixed
 * configuration is not "mostly paper" — it is blocked.
 *
 * There is deliberately no override. A test seam that permitted fixtures to
 * reach a real broker would be the exact bug this file exists to prevent, and
 * the fact that it was only meant for tests would not make the orders less
 * real. Tests get automatic routing by being genuinely in SIMULATION.
 */
import type { NorthstarApp } from '../app.js';
import type { ProviderSummary } from '../app.js';
import { xPosture } from './dataPosture.js';

export type ExecutionTier = 'SIMULATION' | 'PAPER' | 'LIVE' | 'INCOHERENT';

export interface AutonomyCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface AutonomyVerdict {
  tier: ExecutionTier;
  /** True when an order may be submitted with no human in the loop. */
  autonomous: boolean;
  /** Why not, in one line an operator can act on. Null when autonomous. */
  blockReason: string | null;
  /** Every gate evaluated, passing and failing, for the console. */
  checks: AutonomyCheck[];
  /** True when a human must approve each order. Always true in LIVE. */
  requiresHumanApproval: boolean;
}

/**
 * What a readiness run concluded, and when.
 *
 * Readiness makes network calls, so it is not re-run per proposal. The
 * scheduler refreshes it; the gate reads the recorded verdict and treats a
 * missing or stale one as a block rather than as a pass.
 */
export interface ReadinessStamp {
  passed: boolean;
  at: string;
  summary: string;
}

export interface AutonomyGateOptions {
  /** How long a readiness verdict stays usable. */
  readinessTtlMinutes?: number;
}

export class AutonomyGate {
  private readonly readinessTtlMs: number;
  private readiness: ReadinessStamp | null = null;

  constructor(private readonly app: NorthstarApp, opts: AutonomyGateOptions = {}) {
    this.readinessTtlMs = (opts.readinessTtlMinutes ?? 60) * 60_000;
  }

  /** Record the outcome of a readiness run. */
  noteReadiness(stamp: ReadinessStamp): void {
    this.readiness = stamp;
  }

  /** The readiness verdict currently in force, if any is still fresh. */
  currentReadiness(): ReadinessStamp | null {
    if (!this.readiness) return null;
    const age = this.app.clock.nowMs() - new Date(this.readiness.at).getTime();
    return age <= this.readinessTtlMs ? this.readiness : null;
  }

  /**
   * Which tier the wiring puts us in.
   *
   * Read from the live provider objects, so it cannot disagree with what the
   * bot is really using.
   */
  tier(providers: ProviderSummary = this.app.describeProviders()): ExecutionTier {
    /*
     * LIVE is decided FIRST, and by either witness.
     *
     * The broker's own mode and the operator's strategy mode are separate
     * facts, and LIVE from either is LIVE: a simulated broker running in LIVE
     * mode is a rehearsal of live trading, and a rehearsal that auto-submits
     * teaches the system the wrong reflex — the one place it must never be
     * learnt. Checking the broker implementation first would classify exactly
     * that case as harmless simulation.
     */
    if (this.app.broker.mode === 'LIVE' || providers.mode === 'LIVE') return 'LIVE';

    const simulatedBroker = !providers.broker.startsWith('ALPACA');

    /*
     * What counts as real X data.
     *
     * The API is real. An operator-supplied post is ALSO real — it is a public
     * post that exists, transcribed rather than fetched — but only inside the
     * temporary experiment window, and never in LIVE. That is an additional
     * bounded acceptance, not a relaxation of the rule: fixtures remain
     * categorically refused, the window expires on its own, and LIVE is
     * refused twice over (here, and at provider construction).
     */
    const manual = this.app.manualIngestPermission();
    // The same function readiness uses, so the two cannot form different
    // beliefs about what the X provider is.
    const realData = xPosture(providers, manual).realData && providers.marketData === 'TIINGO';

    if (simulatedBroker) {
      // Real data into a simulated broker is still simulation: nothing real is
      // touched, so it is safe, whatever the data behind it.
      return 'SIMULATION';
    }
    if (!realData) {
      // A real account reached by fixture data. This is the dangerous one.
      return 'INCOHERENT';
    }
    return 'PAPER';
  }

  /**
   * The full verdict.
   *
   * Every gate is evaluated even after one fails, so the console can show an
   * operator everything that is wrong at once rather than one thing per fix.
   */
  evaluate(): AutonomyVerdict {
    const providers = this.app.describeProviders();
    const tier = this.tier(providers);
    const checks: AutonomyCheck[] = [];
    const add = (id: string, label: string, passed: boolean, detail: string): void => {
      checks.push({ id, label, passed, detail });
    };

    /* ------------------------------------------------------- 1. the tier */
    add(
      'tier',
      'Execution tier is coherent',
      tier !== 'INCOHERENT',
      tier === 'INCOHERENT'
        ? `${providers.broker} is a real account but the data is fixture ` +
          `(X ${providers.x}, market data ${providers.marketData}).`
        : `${tier}: ${providers.x} / ${providers.marketData} / ${providers.broker}.`,
    );

    /* ---------------------------------------------- 2. LIVE is never auto */
    add(
      'not-live',
      'Not LIVE',
      tier !== 'LIVE',
      tier === 'LIVE'
        ? `LIVE orders always require explicit human approval; there is no autonomous LIVE ` +
          `(broker ${this.app.broker.mode}, strategy ${providers.mode}).`
        : `Broker is ${providers.broker} in ${this.app.broker.mode}; no real money can be committed.`,
    );

    /* ------------------------------------------------- 3. real X data */
    // Only meaningful once a real broker is involved. In SIMULATION the whole
    // point is that the data is not real.
    const needsRealData = tier === 'PAPER' || tier === 'LIVE' || tier === 'INCOHERENT';
    const manualPermission = this.app.manualIngestPermission();
    const posture = xPosture(providers, manualPermission);
    add(
      'live-x',
      'X data is real',
      !needsRealData || posture.realData,
      posture.detail,
    );

    /*
     * An open window that this process cannot use.
     *
     * The social provider is chosen once, at construction, from the credentials
     * and the window as they stood then. Opening the experiment while the bot is
     * already running therefore changes nothing until it restarts — and without
     * saying so, an operator would paste posts into a queue nobody is reading
     * and watch nothing happen.
     */
    const windowOpenButUnused = providers.manual.active && providers.x === 'FIXTURE';
    add(
      'manual-provider-current',
      'The running process is using the open manual window',
      !windowOpenButUnused,
      windowOpenButUnused
        ? 'The manual-X experiment is open but this process started on fixtures and will not read the ' +
          'queue. Restart the bot to pick it up.'
        : 'Not applicable.',
    );

    /*
     * Manual data must never reach LIVE.
     *
     * The tier check already blocks LIVE from acting alone, but this states the
     * rule in its own right so it appears as its own failing gate rather than
     * being inferred from another one. A rule an operator cannot see is a rule
     * they cannot trust.
     */
    add(
      'manual-not-live',
      'Manual posts are not reaching LIVE',
      !(providers.x === 'MANUAL' && tier === 'LIVE'),
      providers.x === 'MANUAL' && tier === 'LIVE'
        ? 'LIVE never accepts operator-supplied X posts. Refused outright, not held for approval.'
        : 'Not applicable.',
    );
    add(
      'real-market-data',
      'Market data is real',
      !needsRealData || providers.marketData === 'TIINGO',
      providers.marketData === 'TIINGO'
        ? 'Prices come from Tiingo.'
        : 'REAL MARKET DATA REQUIRED — the fixture market-data provider is active.',
    );

    /* ------------------------------------------------ 4. forced fixtures */
    add(
      'not-forced-fixtures',
      'Fixtures are not forced',
      !(providers.forcedFixtures && tier !== 'SIMULATION'),
      providers.forcedFixtures
        ? 'NORTHSTAR_USE_FIXTURES=true is overriding real credentials.'
        : 'Providers are selected from credentials, not overridden.',
    );

    /* ----------------------------------------------------- 5. kill switch */
    const health = this.app.health.state();
    add(
      'kill-switch',
      'Kill switch is off',
      health.runState === 'RUNNING',
      health.runState === 'RUNNING'
        ? 'Run state is RUNNING.'
        : `Run state is ${health.runState}${health.haltReason ? `: ${health.haltReason}` : ''}.`,
    );

    /* -------------------------------------------------------- 6. readiness */
    // Skipped in SIMULATION: readiness asks whether it is safe to point at real
    // vendors, which is not a question a fixture run needs to answer.
    const readiness = this.currentReadiness();
    add(
      'readiness',
      'Readiness passed recently',
      tier === 'SIMULATION' || (readiness !== null && readiness.passed),
      tier === 'SIMULATION'
        ? 'Not required in simulation.'
        : readiness === null
          ? 'No readiness verdict is in force; run readiness before trading.'
          : readiness.passed
            ? `Readiness passed at ${readiness.at}.`
            : `Readiness FAILED at ${readiness.at}: ${readiness.summary}`,
    );

    /* --------------------------------------------------------- 7. storage */
    const storage = this.app.storage();
    const storageOk = storage.verdict === 'PERSISTENT' || storage.verdict === 'LOCAL';
    add(
      'storage',
      'Storage is durable',
      tier === 'SIMULATION' || storageOk,
      storageOk
        ? storage.detail
        : `${storage.verdict}: ${storage.detail}`,
    );

    /* ---------------------------------------------------------- 8. ledger */
    const integrity = this.app.ledger.verifyIntegrity();
    add(
      'ledger',
      'Ledger reconciles',
      integrity.ok,
      integrity.ok ? 'Cash matches the append-only entry log.' : integrity.detail,
    );

    const failed = checks.filter((c) => !c.passed);
    const autonomous = failed.length === 0;

    return {
      tier,
      autonomous,
      blockReason: autonomous ? null : (failed[0]?.detail ?? 'blocked'),
      checks,
      // LIVE always needs a human; so does anything that is not cleared to run
      // on its own.
      requiresHumanApproval: tier === 'LIVE',
    };
  }
}
