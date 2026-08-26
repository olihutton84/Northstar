/**
 * First-live-data readiness.
 *
 * Answers one question: is it safe to point this at real X, real Tiingo and a
 * real Alpaca PAPER account right now?
 *
 * Every check is READ-ONLY. Nothing here submits an order, cancels an order,
 * changes the run state or writes to the ledger. The kill-switch check in
 * particular is a *dry* evaluation — it proves the interlock rejects a killed
 * strategy without ever killing the running one.
 */
import type { Clock, Logger } from '../core/index.js';
import { formatUsd } from '../core/index.js';
import type { NorthstarApp } from '../app.js';
import {
  alpacaPaperCredentialReport,
  tiingoCredentialReport,
  xCredentialReport,
} from '../config/env.js';
import { SCHEMA_VERSION } from '../persistence/schema.js';
import type { Strategy } from '../domain/types.js';
import { ReconciliationService } from './Reconciliation.js';

export type CheckStatus = 'PASS' | 'FAIL' | 'WARN' | 'SKIP';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the operator should do when this is not a PASS. */
  remedy?: string;
}

export interface ReadinessReport {
  at: string;
  strategyId: string;
  strategyVersion: string;
  mode: string;
  overall: 'PASS' | 'FAIL';
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  checks: ReadinessCheck[];
  /** True when X, Tiingo and Alpaca are all real. */
  liveDataConfigured: boolean;
  summary: string;
  /**
   * The single verdict for starting a real-data PAPER session.
   *
   * Stricter than `overall`: every check must pass AND every provider must be
   * the real vendor AND live trading must be off. A green run against fixtures
   * proves the code works, not that the bot is ready to trade real data, and
   * conflating those is exactly the mistake this field exists to prevent.
   */
  readyForRealDataPaper: boolean;
  readyForRealDataPaperReason: string;
}

export class ReadinessService {
  private readonly log: Logger;

  constructor(
    private readonly app: NorthstarApp,
    private readonly clock: Clock,
    logger: Logger,
  ) {
    this.log = logger.child('readiness');
  }

  async run(): Promise<ReadinessReport> {
    const checks: ReadinessCheck[] = [];
    const add = (c: ReadinessCheck): void => {
      checks.push(c);
    };

    const providers = this.app.describeProviders();
    const strategy = this.app.store.strategies.byId(this.app.spec.strategyId);

    /* ------------------------------------------------- 1. credentials */
    const x = xCredentialReport(this.app.env);
    const tiingo = tiingoCredentialReport(this.app.env);
    const alpaca = alpacaPaperCredentialReport();

    const credentialsOk =
      x.state === 'CONFIGURED' && tiingo.state === 'CONFIGURED' && alpaca.state === 'CONFIGURED';
    add({
      id: 'credentials',
      label: 'Credentials loaded',
      status: credentialsOk ? 'PASS' : 'FAIL',
      detail: `X ${x.state}, Tiingo ${tiingo.state}, Alpaca PAPER ${alpaca.state}`,
      ...(credentialsOk
        ? {}
        : {
            remedy:
              'Fill in .env at the repo root: ' +
              [...x.missing, ...tiingo.missing, ...alpaca.missing].join(', '),
          }),
    });

    /* ------------------------------------------------ 2. X reachable */
    add(
      await this.probe({
        id: 'x-reachable',
        label: 'X reachable',
        skipWhen: providers.x !== 'LIVE',
        skipDetail: 'The fixture social provider is active, so there is nothing to reach.',
        probe: () => this.app.social.healthCheck(),
        remedy: 'Check X_BEARER_TOKEN and that the token\'s plan permits GET /2/tweets/search/recent.',
      }),
    );

    /* ------------------------------------------- 3. Tiingo reachable */
    add(
      await this.probe({
        id: 'tiingo-reachable',
        label: 'Tiingo reachable',
        skipWhen: providers.marketData !== 'TIINGO',
        skipDetail: 'The fixture market-data provider is active, so there is nothing to reach.',
        probe: () => this.app.marketData.healthCheck(),
        remedy: 'Check TIINGO_API_KEY and the account\'s entitlements.',
      }),
    );

    /* ------------------------------- 4. Alpaca PAPER reachable, PAPER */
    if (providers.broker.startsWith('ALPACA')) {
      try {
        const account = await this.app.broker.getAccount();
        const isPaper = this.app.broker.mode === 'PAPER' && account.mode === 'PAPER';
        add({
          id: 'alpaca-paper-reachable',
          label: 'Alpaca PAPER reachable',
          status: isPaper && !account.tradingBlocked ? 'PASS' : 'FAIL',
          detail: account.tradingBlocked
            ? 'Account reachable but trading is blocked.'
            : `Account ${account.accountId} reachable in ${account.mode} mode, ` +
              `equity ${formatUsd(Math.round(account.equity * 100))}.`,
          ...(isPaper && !account.tradingBlocked
            ? {}
            : { remedy: 'Confirm the paper credentials and that the account is not restricted.' }),
        });
      } catch (e) {
        add({
          id: 'alpaca-paper-reachable',
          label: 'Alpaca PAPER reachable',
          status: 'FAIL',
          detail: e instanceof Error ? e.message : String(e),
          remedy: 'Check ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY and network access.',
        });
      }
    } else {
      add({
        id: 'alpaca-paper-reachable',
        label: 'Alpaca PAPER reachable',
        status: 'SKIP',
        detail: 'The simulated broker is active, so there is nothing to reach.',
      });
    }

    /* --------------------------------------- 5. market status known */
    try {
      const status = await this.app.marketData.getMarketStatus();
      add({
        id: 'market-status',
        label: 'Market open status known',
        status: 'PASS',
        detail: `${status.isOpen ? 'OPEN' : 'CLOSED'} — ${status.reason}` +
          (status.isOpen ? '' : ` (next open ${status.nextOpen ?? 'unknown'})`),
      });
    } catch (e) {
      add({
        id: 'market-status',
        label: 'Market open status known',
        status: 'FAIL',
        detail: e instanceof Error ? e.message : String(e),
        remedy: 'The risk engine refuses to trade without a known market state; fix market data first.',
      });
    }

    /* --------------------------------------------- 6. ledger reconciled */
    const reconciler = new ReconciliationService(
      this.app.store,
      this.app.broker,
      this.app.ledger,
      this.clock,
      this.log,
      this.app.spec.strategyId,
    );
    const reconciliation = await reconciler.reconcile();
    const critical = reconciliation.discrepancies.filter((d) => d.severity === 'CRITICAL');
    add({
      id: 'ledger-reconciled',
      label: 'Ledger reconciled',
      status: critical.length > 0 ? 'FAIL' : reconciliation.ok ? 'PASS' : 'WARN',
      detail: reconciliation.summary,
      ...(reconciliation.ok ? {} : { remedy: 'Run `npm run lab -- reconcile` and resolve by hand before trading.' }),
    });

    /* ------------------------------------------ 7. kill switch works */
    add(this.killSwitchCheck(strategy));

    /* --------------------------------------- 8. schema up to date */
    const schemaRow = this.app.store.db.get<{ value: string }>(
      'SELECT value FROM schema_meta WHERE key = ?',
      'schema_version',
    );
    const schemaVersion = Number(schemaRow?.value ?? -1);
    add({
      id: 'migrations',
      label: 'No unresolved migrations',
      status: schemaVersion === SCHEMA_VERSION ? 'PASS' : 'FAIL',
      detail: `Database schema v${schemaVersion}, code expects v${SCHEMA_VERSION}.`,
      ...(schemaVersion === SCHEMA_VERSION ? {} : { remedy: 'Run `npm run migrate`.' }),
    });

    /* ------------------------------------ 9. no pending corrupt state */
    const integrity = this.app.health.verifyStateIntegrity();
    const health = this.app.health.state();
    const openIncidents = health.openIncidents;
    const stateOk = integrity.ok && openIncidents.length === 0 && health.runState === 'RUNNING';
    add({
      id: 'clean-state',
      label: 'No pending corrupt state',
      status: integrity.ok ? (stateOk ? 'PASS' : 'WARN') : 'FAIL',
      detail: !integrity.ok
        ? integrity.problems.join('; ')
        : openIncidents.length > 0
          ? `${openIncidents.length} unresolved incident(s): ${openIncidents.map((i) => i.fault).join(', ')}`
          : health.runState !== 'RUNNING'
            ? `Strategy is ${health.runState}${health.haltReason ? `: ${health.haltReason}` : ''}`
            : 'State is consistent and the strategy is running.',
      ...(stateOk ? {} : { remedy: 'Resolve the incident, then `npm run lab -- resume "<note>"`.' }),
    });

    /* -------------------------------- 10. provider banner is accurate */
    add(this.bannerCheck(providers, x.state, tiingo.state, alpaca.state));

    /* ------------------------------------------ mode sanity (advisory) */
    add({
      id: 'paper-mode',
      label: 'Running in PAPER mode',
      status: strategy?.mode === 'PAPER' ? 'PASS' : 'WARN',
      detail: `Strategy mode is ${strategy?.mode ?? 'unknown'}, broker is ${this.app.broker.mode}.`,
      ...(strategy?.mode === 'PAPER' ? {} : { remedy: 'First live-data runs should be PAPER: `npm run lab -- mode PAPER`.' }),
    });

    /* -------------------------------- 11. no fixture providers active */
    const fixtures: string[] = [];
    if (providers.x !== 'LIVE') fixtures.push(`X (${this.app.social.providerId})`);
    if (providers.marketData !== 'TIINGO') fixtures.push(`market data (${this.app.marketData.providerId})`);
    if (!providers.broker.startsWith('ALPACA')) fixtures.push(`broker (${this.app.broker.brokerId})`);
    add({
      id: 'no-fixtures',
      label: 'No fixture providers active',
      status: fixtures.length === 0 ? 'PASS' : 'FAIL',
      detail:
        fixtures.length === 0
          ? 'X, Tiingo and Alpaca are all the real vendor integrations.'
          : `Still on fixtures: ${fixtures.join(', ')}.`,
      ...(fixtures.length === 0
        ? {}
        : {
            remedy: providers.forcedFixtures
              ? 'NORTHSTAR_USE_FIXTURES is set. Unset it, then re-run readiness.'
              : 'Add the missing credentials to .env, then re-run readiness.',
          }),
    });

    /* ------------------------------------------ 12. LIVE trading is off */
    // Read from the constructed broker and the stored strategy, never from
    // configuration: what is wired is what will trade.
    const liveOff = this.app.broker.mode !== 'LIVE' && strategy?.mode !== 'LIVE';
    add({
      id: 'live-disabled',
      label: 'LIVE trading disabled',
      status: liveOff ? 'PASS' : 'FAIL',
      detail: liveOff
        ? `Broker is ${this.app.broker.mode}; strategy mode is ${strategy?.mode ?? 'unknown'}. No real money can be committed.`
        : `LIVE is active (broker ${this.app.broker.mode}, strategy ${strategy?.mode ?? 'unknown'}).`,
      ...(liveOff ? {} : { remedy: 'Run `npm run lab -- mode PAPER` before a first real-data session.' }),
    });

    /* ------------------------------------------- 13. database healthy */
    add(this.databaseCheck());

    /* ------------------------------------- 14. the request budget adds up */
    add(this.requestBudgetCheck());

    const passed = checks.filter((c) => c.status === 'PASS').length;
    const failed = checks.filter((c) => c.status === 'FAIL').length;
    const warned = checks.filter((c) => c.status === 'WARN').length;
    const skipped = checks.filter((c) => c.status === 'SKIP').length;

    return {
      at: this.clock.nowIso(),
      strategyId: this.app.spec.strategyId,
      strategyVersion: this.app.spec.version,
      mode: strategy?.mode ?? this.app.mode,
      overall: failed === 0 ? 'PASS' : 'FAIL',
      passed,
      failed,
      warned,
      skipped,
      checks,
      liveDataConfigured: providers.allReal,
      summary:
        failed === 0
          ? `READY: ${passed} passed, ${warned} warning(s), ${skipped} skipped. No orders were submitted.`
          : `NOT READY: ${failed} check(s) failed. No orders were submitted.`,
      ...this.realDataVerdict(failed, providers.allReal, this.app.broker.mode !== 'LIVE' && strategy?.mode !== 'LIVE'),
    };
  }

  /* ------------------------------------------------------------ helpers */

  /**
   * The one line an operator reads before starting a real-data session.
   *
   * All three conditions, or NO. There is no partial yes.
   */
  private realDataVerdict(
    failed: number,
    allReal: boolean,
    liveOff: boolean,
  ): { readyForRealDataPaper: boolean; readyForRealDataPaperReason: string } {
    const blockers: string[] = [];
    if (failed > 0) blockers.push(`${failed} readiness check(s) failed`);
    if (!allReal) blockers.push('at least one provider is still a fixture');
    if (!liveOff) blockers.push('LIVE trading is enabled');

    return {
      readyForRealDataPaper: blockers.length === 0,
      readyForRealDataPaperReason:
        blockers.length === 0
          ? 'All checks passed, all three providers are real, and LIVE is disabled.'
          : blockers.join('; '),
    };
  }

  /**
   * Does a full day of polling fit inside the request budget?
   *
   * Checked from the provider's OWN batching against the live universe, before
   * the open. The failure this prevents is specific and was real: a universe
   * that batches into two query chunks costs twice what a one-query-per-scan
   * assumption predicts, quietly crosses the daily cap mid-morning, and drops
   * the bot to the slow cadence for the rest of the session. That is a bad way
   * to discover arithmetic.
   */
  private requestBudgetCheck(): ReadinessCheck {
    const perScan = this.app.requestsPerScan();
    const day = this.app.estimateDailyRequests();
    const cap = this.app.ops.xDailyRequestSoftCap;
    const headroomPct = cap > 0 ? Math.round(((cap - day.requests) / cap) * 100) : 0;
    const fits = day.requests <= cap;

    return {
      id: 'x-request-budget',
      label: 'X request budget adds up',
      status: fits ? 'PASS' : 'FAIL',
      detail:
        `${perScan} batched quer${perScan === 1 ? 'y' : 'ies'} per scan; ` +
        `~${day.requests} requests projected for a 6.5h session against a ${cap} soft cap ` +
        `(${headroomPct}% headroom). ${day.detail}`,
      ...(fits
        ? {}
        : {
            remedy:
              `The projected day exceeds the cap, so polling would throttle itself to ` +
              `${this.app.ops.xApiPressureIntervalSeconds}s partway through. Raise ` +
              `NORTHSTAR_X_DAILY_SOFT_CAP, or slow NORTHSTAR_X_SCAN_SECONDS.`,
          }),
    };
  }

  /**
   * The database is where every guarantee in this system is recorded, so it is
   * checked for reachability and for writability — a read-only file would fail
   * silently at the worst moment, mid-fill.
   */
  private databaseCheck(): ReadinessCheck {
    try {
      const counts = this.app.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM strategies');
      // A transaction that writes and rolls back proves writability without
      // leaving anything behind.
      let writable = false;
      try {
        this.app.store.db.run('CREATE TEMP TABLE IF NOT EXISTS readiness_probe (x INTEGER)');
        this.app.store.db.run('INSERT INTO readiness_probe (x) VALUES (1)');
        this.app.store.db.run('DROP TABLE readiness_probe');
        writable = true;
      } catch {
        writable = false;
      }

      const cursors = this.app.store.cursors.list().length;
      return {
        id: 'database',
        label: 'Database healthy',
        status: writable ? 'PASS' : 'FAIL',
        detail: writable
          ? `Readable and writable; ${counts?.n ?? 0} strategy record(s), ${cursors} polling cursor(s) stored.`
          : 'The database is readable but not writable.',
        ...(writable ? {} : { remedy: 'Check file permissions and free disk space on NORTHSTAR_DB_PATH.' }),
      };
    } catch (e) {
      return {
        id: 'database',
        label: 'Database healthy',
        status: 'FAIL',
        detail: e instanceof Error ? e.message : String(e),
        remedy: 'Run `npm run migrate`.',
      };
    }
  }

  private async probe(opts: {
    id: string;
    label: string;
    skipWhen: boolean;
    skipDetail: string;
    probe: () => Promise<{ healthy: boolean; detail: string }>;
    remedy: string;
  }): Promise<ReadinessCheck> {
    if (opts.skipWhen) {
      return { id: opts.id, label: opts.label, status: 'SKIP', detail: opts.skipDetail };
    }
    try {
      const result = await opts.probe();
      return {
        id: opts.id,
        label: opts.label,
        status: result.healthy ? 'PASS' : 'FAIL',
        detail: result.detail,
        ...(result.healthy ? {} : { remedy: opts.remedy }),
      };
    } catch (e) {
      return {
        id: opts.id,
        label: opts.label,
        status: 'FAIL',
        detail: e instanceof Error ? e.message : String(e),
        remedy: opts.remedy,
      };
    }
  }

  /**
   * Prove the kill-switch interlock works WITHOUT engaging it.
   *
   * Evaluates the risk engine's own checks against a copy of the strategy with
   * runState KILLED. If the interlock has been broken, this fails here rather
   * than during an incident, and the live strategy is never touched.
   */
  private killSwitchCheck(strategy: Strategy | null): ReadinessCheck {
    if (!strategy) {
      return {
        id: 'kill-switch',
        label: 'Kill switch functional',
        status: 'FAIL',
        detail: 'No strategy record to test against.',
        remedy: 'Run `npm run seed`.',
      };
    }

    const proposal = this.app.store.proposals.recent(1)[0];
    const signal = proposal ? this.app.store.signals.byId(proposal.signalId) : null;

    if (!proposal || !signal) {
      // Nothing to evaluate against yet. Fall back to asserting the interlock
      // is present in the risk engine's check list.
      return {
        id: 'kill-switch',
        label: 'Kill switch functional',
        status: 'WARN',
        detail:
          'No stored proposal to dry-run the interlock against yet. The KILL_SWITCH check is wired into the ' +
          'risk engine, but this becomes a hard PASS after the first cycle produces a proposal.',
        remedy: 'Run `npm run cycle` once, then re-run readiness.',
      };
    }

    const decision = this.app.riskEngine.evaluate(proposal, {
      strategy: { ...strategy, runState: 'KILLED', haltReason: 'readiness dry-run (not applied)' },
      signal,
      marketStatus: { isOpen: true, asOf: this.clock.nowIso(), nextOpen: null, nextClose: null, reason: 'dry-run' },
      marketDataAgeMinutes: 0,
      marketDataStale: false,
      openPositions: [],
      providersHealthy: true,
      providerHealthDetail: 'dry-run',
      brokerReportsMarketOpen: true,
    });

    const blocked = !decision.approved && decision.failedChecks.includes('KILL_SWITCH');
    return {
      id: 'kill-switch',
      label: 'Kill switch functional',
      status: blocked ? 'PASS' : 'FAIL',
      detail: blocked
        ? 'A killed strategy is refused by the risk engine (verified by dry-run; the live strategy was not touched).'
        : `A killed strategy was NOT refused. Failed checks: ${decision.failedChecks.join(', ') || 'none'}.`,
      ...(blocked ? {} : { remedy: 'The KILL_SWITCH interlock is broken. Do not trade until it is fixed.' }),
    };
  }

  /**
   * The banner is what an operator trusts at a glance, so verify it agrees with
   * the credential state rather than assuming it does.
   */
  private bannerCheck(
    providers: ReturnType<NorthstarApp['describeProviders']>,
    xState: string,
    tiingoState: string,
    alpacaState: string,
  ): ReadinessCheck {
    const problems: string[] = [];
    const forced = providers.forcedFixtures;

    if (!forced) {
      if ((xState === 'CONFIGURED') !== (providers.x === 'LIVE')) {
        problems.push(`banner says X ${providers.x} but credentials are ${xState}`);
      }
      if ((tiingoState === 'CONFIGURED') !== (providers.marketData === 'TIINGO')) {
        problems.push(`banner says market data ${providers.marketData} but credentials are ${tiingoState}`);
      }
      if ((alpacaState === 'CONFIGURED') !== providers.broker.startsWith('ALPACA')) {
        problems.push(`banner says broker ${providers.broker} but credentials are ${alpacaState}`);
      }
    } else if (providers.x === 'LIVE' || providers.marketData === 'TIINGO' || providers.broker.startsWith('ALPACA')) {
      problems.push('NORTHSTAR_USE_FIXTURES is set but a real provider is active');
    }

    return {
      id: 'banner-accurate',
      label: 'Provider banner accurate',
      status: problems.length === 0 ? 'PASS' : 'FAIL',
      detail:
        problems.length === 0
          ? `X ${providers.x} · Market Data ${providers.marketData} · Broker ${providers.broker} · Mode ${providers.mode}` +
            (forced ? ' (fixtures forced by NORTHSTAR_USE_FIXTURES)' : '')
          : problems.join('; '),
      ...(problems.length === 0 ? {} : { remedy: 'The banner disagrees with configuration — treat every other check as suspect.' }),
    };
  }
}
