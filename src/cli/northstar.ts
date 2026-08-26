#!/usr/bin/env node
/**
 * Northstar X Trading Bot CLI.
 *
 *   northstar migrate            create/upgrade the database
 *   northstar seed               create the strategy, universe and $50 ledger
 *   northstar cycle              run one full pipeline cycle
 *   northstar paper [--interval] run the paper loop continuously
 *   northstar run                the deployable process: loops + console
 *   northstar serve              start the X Bot Console
 *   northstar status             print strategy status and the ledger
 *   northstar report [horizon]   print the paper-qualification report
 *   northstar funnel             print today's stage-by-stage funnel
 *   northstar eod [YYYY-MM-DD]   print the end-of-day report
 *   northstar api                print API usage and polling state
 *   northstar signals [n]        print recent signals with explanations
 *   northstar trace <id>         reconstruct one decision chain end to end
 *   northstar manual <cmd>       operator-supplied X posts (start|add|batch|list|stop)
 *   northstar incidents [resolve] inspect health incidents; close only stale ones
 *   northstar pause <reason>     stop new entries; exits keep running
 *   northstar kill <reason>      engage the kill switch
 *   northstar resume <note>      clear a pause/kill
 *   northstar mode PAPER|LIVE    set the trading mode
 */
import { readFileSync } from 'node:fs';
import { ConsoleLogger, formatSignedUsd, formatUsd, SystemClock } from '../core/index.js';
import { loadEnv } from '../config/env.js';
import { estimateDailyXRequests, type OperationsConfig } from '../config/operations.js';
import { ConfigurationError, NorthstarApp } from '../app.js';
import { ApiServer } from '../api/server.js';
import { startBotProcess } from '../runtime/BotProcess.js';
import { assessStorage, databaseDirectoryUsable, type StorageVerdict } from '../runtime/StorageCheck.js';
import { maxPositionCentsFor } from '../config/executionEpochs.js';
import type { ForwardHorizon, TradingMode } from '../domain/types.js';
import { openDatabase } from '../persistence/db.js';
import { runSimulation, summarise } from './simulation.js';
import { compareStrategyVersions, renderComparison } from '../replay/compare.js';
import { datasetStats, exportDatasetFromStore, readDataset, writeDataset } from '../replay/dataset.js';
import { runReplay, summariseReplay, type ReplayResult } from '../replay/ReplayEngine.js';
import { buildSampleDataset } from '../replay/sampleDataset.js';
import { getStrategyVersion, latestVersion, listStrategyVersions, X_STRATEGY_ID } from '../config/strategyRegistry.js';
import { randomId } from '../core/index.js';

const env = loadEnv();
const logger = new ConsoleLogger(env.logLevel as 'info', 'cli');
const clock = new SystemClock();

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Alias used where a local named `out` would shadow the helper. */
const out_ = out;

function listStrategyVersionsSafe(): string[] {
  try {
    return listStrategyVersions(X_STRATEGY_ID).map((v) => v.version);
  } catch {
    return [];
  }
}

function heading(title: string): void {
  out();
  out(`\x1b[1m${title}\x1b[0m`);
  out('─'.repeat(Math.min(78, title.length + 12)));
}

function makeApp(mode?: TradingMode, operations?: Partial<OperationsConfig>): NorthstarApp {
  return new NorthstarApp({
    env,
    clock,
    logger,
    ...(mode ? { mode } : {}),
    ...(operations ? { operations } : {}),
  });
}

const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** A one-word durability label for the database path. */
function storageTag(verdict: StorageVerdict): string {
  switch (verdict) {
    case 'PERSISTENT':
      return `${GREEN}PERSISTENT${RESET}`;
    case 'LOCAL':
      return `${DIM}local disk${RESET}`;
    case 'IN_MEMORY':
      return `${RED}IN MEMORY — NOTHING IS SAVED${RESET}`;
    case 'LIKELY_EPHEMERAL':
      return `${RED}LIKELY EPHEMERAL${RESET}`;
  }
}

/** One incident, with what is currently true about its cause. */
function printDiagnosis(d: import('../runtime/IncidentForensics.js').IncidentDiagnosis): void {
  const i = d.incident;
  out();
  out(`${BOLD}${i.fault}${RESET}  ${DIM}${i.incidentId}${RESET}`);
  out(`  Raised        ${i.at}`);
  out(`  Condition     ${i.detail}`);
  out(`  Epoch         ${d.attributedEpochId ?? '(none)'}  ${DIM}${d.attributionDetail}${RESET}`);
  out(`  Paused the bot ${i.paused ? 'yes' : 'no'}`);
  if (i.resolvedAt) {
    out(`  ${GREEN}Resolved      ${i.resolvedAt}${RESET}`);
    if (i.resolutionNote) out(`  Note          ${i.resolutionNote}`);
  }
  out(`  Still present ${d.stillPresent ? `${RED}YES${RESET}` : `${GREEN}no${RESET}`}`);
  out(`  ${d.stillPresent ? RED : DIM}${d.verdict}${RESET}`);
}

/** Read a pasted batch from stdin. Empty when nothing is piped in. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Report every submission individually.
 *
 * A batch that says only "7 accepted" leaves the operator to work out which
 * three were not, and why — so each duplicate and each rejection is named.
 */
function printSubmitReport(report: import('../ingest/ManualIngestService.js').SubmitReport): void {
  heading('MANUAL X SUBMISSION');
  out(`${GREEN}${report.accepted} accepted${RESET} · ` +
      `${report.duplicates ? YELLOW : DIM}${report.duplicates} duplicate${RESET} · ` +
      `${report.rejected ? RED : DIM}${report.rejected} rejected${RESET}`);
  out();

  for (const outcome of report.outcomes) {
    if (outcome.status === 'ACCEPTED') {
      out(`${GREEN}ACCEPTED${RESET}  @${outcome.observation.handle} · ${outcome.observation.postedAt}`);
      out(`${DIM}  ${outcome.observation.canonicalUrl}${RESET}`);
    } else if (outcome.status === 'DUPLICATE') {
      out(`${YELLOW}DUPLICATE${RESET} post ${outcome.postId} — already held since ${outcome.firstSeenAt}`);
      out(`${DIM}  ${outcome.url}${RESET}`);
      out(`${DIM}  Not stored again: one post is one observation, however many times it is pasted.${RESET}`);
    } else {
      out(`${RED}REJECTED${RESET}  ${outcome.url || '(no URL)'}`);
      for (const problem of outcome.problems) out(`${RED}  - ${problem}${RESET}`);
    }
  }

  if (report.windowClosed) {
    out();
    out(`${YELLOW}The manual-X experiment is not open, so these posts will NOT be traded.${RESET}`);
    out(`${DIM}  ${report.window.inactiveReason ?? ''}${RESET}`);
    out(`${DIM}  Open it with: northstar manual start "<note>"${RESET}`);
  }
}

/** The experiment's state, and what it does and does not permit. */
function printManualStatus(app: NorthstarApp): void {
  const w = app.manualWindow();
  const permission = app.manualIngestPermission();
  const counts = app.store.manual.counts();

  heading('MANUAL X INGEST');
  out(`Experiment       ${w.active ? `${GREEN}OPEN${RESET}` : `${YELLOW}CLOSED${RESET}`}`);
  if (w.startedAt) {
    out(`Started          ${w.startedAt}${w.startedBy ? ` by ${w.startedBy}` : ''}`);
    out(`Expires          ${w.expiresAt}${w.hoursRemaining !== null ? `  ${DIM}(${w.hoursRemaining}h left)${RESET}` : ''}`);
  }
  if (!w.active && w.inactiveReason) out(`${DIM}${w.inactiveReason}${RESET}`);
  out(`Observations     ${counts.total} held · ${counts.pending} pending · ${counts.ingested} ingested`);
  out(`Counts as real   ${permission.permitted ? `${GREEN}YES${RESET}` : `${RED}NO${RESET}`}  ${DIM}${permission.reason}${RESET}`);
  out();
  out(`${DIM}Add one:   northstar manual add --url <url> --at <ISO> --text "..."${RESET}`);
  out(`${DIM}Add many:  pbpaste | northstar manual batch    (or --file posts.txt)${RESET}`);
  out(`${DIM}           one per line:  <url> | <ISO timestamp> | <text>${RESET}`);
}

/**
 * State the capital behind the run, and whether it may act on its own.
 *
 * Both are printed before the first scan because both are things an operator
 * would otherwise assume: that the allocation is what they last configured, and
 * that a running bot is a trading bot. A bot that is up, healthy and silently
 * unable to execute looks identical to one that simply found nothing to trade.
 */
function printCapitalAndAutonomy(app: NorthstarApp): void {
  const limits = app.spec.riskLimits;
  const maxPosition = maxPositionCentsFor(app.epoch.capitalCents, limits.maxPositionPctOfEquity);
  const ledger = app.ledger.get();

  out(`${BOLD}Capital${RESET}`);
  out(`  Epoch              ${app.epoch.epochId}  ${DIM}${app.epoch.label}${RESET}`);
  out(`  Allocation         ${formatUsd(app.epoch.capitalCents)}  ` +
      `${DIM}strategy version declares ${formatUsd(app.spec.allocatedCapitalCents)}; capital is an execution setting${RESET}`);
  out(`  Max position       ${formatUsd(maxPosition)}  ${DIM}${limits.maxPositionPctOfEquity}% of equity${RESET}`);
  out(`  Max holdings       ${limits.maxConcurrentPositions}`);
  out(`  Cash / reserved    ${formatUsd(ledger.cashCents)} / ${formatUsd(ledger.reservedCents)}`);
  out(`  Equity             ${formatUsd(ledger.equityCents)}`);
  out();

  const verdict = app.autonomy.evaluate();
  out(`${BOLD}Execution${RESET}`);
  out(`  Tier               ${verdict.tier}`);
  if (verdict.autonomous) {
    out(`  Autonomous         ${GREEN}ENABLED${RESET}  ${DIM}qualifying proposals route without human approval${RESET}`);
  } else {
    out(`  Autonomous         ${RED}BLOCKED${RESET}`);
    for (const check of verdict.checks.filter((c) => !c.passed)) {
      out(`${YELLOW}    - ${check.detail}${RESET}`);
    }
    if (verdict.requiresHumanApproval) {
      out(`${DIM}    LIVE always requires a human. This is not a fault.${RESET}`);
    }
  }
  out();
}

/**
 * Positively state which providers are live.
 *
 * The old behaviour announced only the FALLBACKS, as warnings, which scroll
 * past in a long run — so "the bot is quietly on fixtures" looked identical to
 * "the bot is live" once the first screen had passed. This states the actual
 * wiring every time, read from the constructed providers rather than from the
 * environment, so it cannot disagree with reality.
 *
 * It never prints a credential, only which provider was selected.
 */
function printProviderBanner(app: NorthstarApp): void {
  const p = app.describeProviders();
  const tag = (value: string, real: boolean): string =>
    `${real ? GREEN : YELLOW}${value}${RESET}`;

  out();
  out(`X:            ${tag(p.x, p.x === 'LIVE')}`);
  out(`Market Data:  ${tag(p.marketData, p.marketData === 'TIINGO')}`);
  out(`Broker:       ${tag(p.broker, p.broker.startsWith('ALPACA'))}`);
  out(`Mode:         ${p.mode}`);

  // Never let fallback data read as live Platform state.
  const u = p.universe;
  const universeColour = u.origin === 'PLATFORM' ? GREEN : YELLOW;
  out(`Universe:     ${universeColour}${u.origin === 'PLATFORM' ? 'PLATFORM' : 'BOT FALLBACK'}${RESET}  ` +
      `${DIM}${u.version} · ${u.securityCount} securities · fingerprint ${u.fingerprint}${RESET}`);
  if (u.rejection) {
    out(`${RED}  Platform universe REJECTED from ${u.rejection.source}:${RESET}`);
    for (const problem of u.rejection.problems.slice(0, 5)) out(`${RED}    - ${problem}${RESET}`);
    if (u.rejection.problems.length > 5) out(`${DIM}    ...and ${u.rejection.problems.length - 5} more${RESET}`);
  } else if (u.origin === 'BOT_FALLBACK') {
    out(`${DIM}  This is the bot's own list, not live Northstar Platform membership.${RESET}`);
  }

  if (p.forcedFixtures) {
    out(`${YELLOW}NORTHSTAR_USE_FIXTURES=true — fixtures are forced, any real credentials are ignored.${RESET}`);
  } else if (!p.allReal) {
    const missing: string[] = [];
    if (p.x === 'FIXTURE') missing.push('X_BEARER_TOKEN');
    if (p.marketData === 'FIXTURE') missing.push('TIINGO_API_KEY');
    if (!p.broker.startsWith('ALPACA')) missing.push('ALPACA_PAPER_KEY_ID + ALPACA_PAPER_SECRET_KEY');
    out(`${YELLOW}Running on fixtures. No live data or orders. Set: ${missing.join(', ')}${RESET}`);
    out(`${DIM}Put them in .env at the repo root; npm scripts load it automatically.${RESET}`);
  }
  out();
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);

  switch (command) {
    case 'migrate': {
      const db = openDatabase(env.databasePath);
      db.close();
      out(`Database ready at ${env.databasePath}`);
      break;
    }

    case 'seed': {
      const app = makeApp();
      const strategy = app.seed();
      out(`Seeded ${strategy.displayName} (${strategy.strategyId} v${strategy.version})`);
      out(`Universe: ${app.universe.active().length} securities`);
      out(`Allocation: ${formatUsd(strategy.allocatedCapitalCents)}`);
      printProviderBanner(app);
      app.close();
      break;
    }

    case 'cycle': {
      const app = makeApp(modeArg(args));
      app.seed();
      printProviderBanner(app);
      // A one-off cycle is as much a part of the record as a full session.
      app.recordRunConfiguration('cycle');
      const report = await app.runner.runCycle();
      heading('Cycle report');
      out(JSON.stringify(report, null, 2));
      app.close();
      break;
    }

    case 'paper': {
      // --interval is the X SCAN cadence in SECONDS and nothing else.
      // Position monitoring and reconciliation run on their own cadences from
      // the operations config: hiding three unrelated jobs behind one interval
      // is how a bot ends up either burning its X quota or checking a
      // stop-loss every fifteen minutes.
      const intervalFlag = flag(args, '--interval');
      const cyclesFlag = flag(args, '--cycles');
      const maxScans = cyclesFlag === undefined ? undefined : Number(cyclesFlag);
      const app = makeApp('PAPER', intervalFlag === undefined ? {} : { xScanIntervalSeconds: Number(intervalFlag) });
      app.seed();
      app.setMode('PAPER');
      printProviderBanner(app);

      const ops = app.ops;
      const perScan = app.requestsPerScan();
      const estimate = app.estimateDailyRequests();
      out();
      out(`${BOLD}Cadences${RESET}`);
      out(`  X scan             every ${ops.xScanIntervalSeconds}s  (${ops.xEventWatchIntervalSeconds}s on event watch, ${ops.xApiPressureIntervalSeconds}s under API pressure)`);
      out(`  Position monitor   every ${ops.positionMonitorIntervalSeconds}s  (marks, exits, fills — no X requests)`);
      out(`  Reconciliation     every ${ops.reconciliationIntervalSeconds}s  (plus immediately after any order event)`);
      out(`  ${DIM}${perScan} batched quer${perScan === 1 ? 'y' : 'ies'} per scan · ` +
        `~${estimate.requests} X requests for a 6.5h trading day · ` +
        `soft cap ${ops.xDailyRequestSoftCap}${RESET}`);
      if (estimate.requests > ops.xDailyRequestSoftCap) {
        out(`  ${YELLOW}WARNING: the projected day exceeds the soft cap, so polling will throttle ` +
          `itself to ${ops.xApiPressureIntervalSeconds}s partway through. Raise ` +
          `NORTHSTAR_X_DAILY_SOFT_CAP or slow the scan cadence.${RESET}`);
      }
      out();
      out('Paper loop started. Ctrl-C to stop.');

      let stopping = false;
      process.on('SIGINT', () => {
        if (stopping) process.exit(130);
        stopping = true;
        out('\nStopping after the current task…');
        app.scheduler.stop();
      });

      if (maxScans !== undefined) out(`Bounded run: stopping after ${maxScans} X scan(s).`);

      app.scheduler.startSupportLoops();
      await app.scheduler.start(maxScans === undefined ? {} : { maxScans });

      out();
      out(app.dailyReport.render(app.dailyReport.build()));
      app.close();
      break;
    }

    /*
     * The deployable entrypoint. `npm start` runs this.
     *
     * One process: the trading loops and the console together, because they
     * share one SQLite file and the scheduler assumes a single writer. It
     * blocks until a signal or the scan bound, so a platform supervising it
     * sees a long-running service rather than a command that exits.
     */
    case 'run': {
      const app = makeApp('PAPER');
      app.seed();
      app.setMode('PAPER');
      printProviderBanner(app);

      const runTrading = env.runnerEnabled;

      /*
       * State the durability of the database before the first scan, not after
       * the first lost ledger. On an ephemeral container filesystem every
       * guarantee in this system is discarded on the next deploy, and nothing
       * else in the banner would look any different.
       */
      const storage = assessStorage(env.databasePath);
      const usable = databaseDirectoryUsable(env.databasePath);

      const perScan = app.requestsPerScan();
      const estimate = app.estimateDailyRequests();

      out();
      out(`${BOLD}Process${RESET}`);
      out(`  Console            ${env.httpHost}:${env.httpPort === 0 ? '(assigned at bind)' : env.httpPort}`);
      out(`  Trading loops      ${runTrading ? 'ENABLED' : `${YELLOW}DISABLED${RESET} (NORTHSTAR_RUNNER_ENABLED=false)`}`);
      out(`  Database           ${env.databasePath}  ${storageTag(storage.verdict)}`);
      if (storage.verdict === 'LIKELY_EPHEMERAL' || storage.verdict === 'IN_MEMORY') {
        out(`${RED}    ${storage.detail}${RESET}`);
        if (storage.remedy) out(`${YELLOW}    Fix: ${storage.remedy}${RESET}`);
      }
      if (!usable.ok) out(`${RED}    Database directory unusable: ${usable.detail}${RESET}`);
      out(`  X scan             every ${app.ops.xScanIntervalSeconds}s · ${perScan} batched quer${perScan === 1 ? 'y' : 'ies'} · ~${estimate.requests}/day`);
      out(`  Position monitor   every ${app.ops.positionMonitorIntervalSeconds}s`);
      out(`  Reconciliation     every ${app.ops.reconciliationIntervalSeconds}s`);
      out();
      printCapitalAndAutonomy(app);

      const maxScans = flag(args, '--cycles');
      const handle = await startBotProcess({
        app,
        logger,
        serveConsole: true,
        port: env.httpPort,
        host: env.httpHost,
        approverId: env.approverId,
        runTrading,
        ...(maxScans === undefined ? {} : { maxScans: Number(maxScans) }),
      });

      if (handle.address) out(`Console: http://${handle.address.host === '0.0.0.0' ? 'localhost' : handle.address.host}:${handle.address.port}`);
      out('Running. SIGTERM or Ctrl-C stops it gracefully.');
      await handle.done;

      // The loops have stopped but the database is still open, so the day can
      // still be summarised before the process lets go of it.
      out();
      out(app.dailyReport.render(app.dailyReport.build()));
      app.close();

      // A graceful stop is a SUCCESS. Exiting non-zero here would read as a
      // crash to a platform supervisor and trigger a restart loop.
      process.exitCode = 0;
      break;
    }

    case 'serve': {
      const app = makeApp(modeArg(args));
      app.seed();
      const server = new ApiServer({
        app,
        port: env.httpPort,
        host: env.httpHost,
        logger,
        approverId: env.approverId,
      });
      await server.listen();
      printProviderBanner(app);
      out(`X Bot Console: http://${env.httpHost === '0.0.0.0' ? 'localhost' : env.httpHost}:${server.boundPort ?? env.httpPort}`);
      break;
    }

    case 'status': {
      const app = makeApp();
      app.seed();
      const strategy = app.store.strategies.byId(app.spec.strategyId)!;
      const ledger = app.ledger.get();
      const survival = app.survival.compute();

      heading(`${strategy.displayName} — ${strategy.strategyId} v${strategy.version}`);
      out(`Status        ${survival.status} (${survival.statusRationale})`);
      out(`Run state     ${strategy.runState}${strategy.haltReason ? ` — ${strategy.haltReason}` : ''}`);
      printProviderBanner(app);

      heading('Capital ledger');
      out(`Starting Capital  ${formatUsd(ledger.startingCapitalCents)}`);
      out(`Cash              ${formatUsd(ledger.cashCents)}`);
      out(`Reserved          ${formatUsd(ledger.reservedCents)}`);
      out(`Positions         ${formatUsd(ledger.positionsValueCents)}`);
      out(`Unrealised P&L    ${formatSignedUsd(ledger.unrealisedPnlCents)}`);
      out(`Realised P&L      ${formatSignedUsd(ledger.realisedPnlCents)}`);
      out(`Equity            ${formatUsd(ledger.equityCents)}`);
      const integrity = app.ledger.verifyIntegrity();
      out(`Integrity         ${integrity.ok ? 'OK' : `MISMATCH — ${integrity.detail}`}`);

      heading('Open positions');
      const open = app.store.positions.open(app.spec.strategyId);
      if (open.length === 0) out('(none)');
      for (const p of open) {
        out(`${p.ticker.padEnd(6)} ${p.quantity.toFixed(6).padStart(12)} @ ${p.entryPrice.toFixed(2).padStart(9)} ` +
            `last ${p.lastMarkPrice.toFixed(2).padStart(9)}  ${formatSignedUsd(p.unrealisedPnlCents)}`);
      }
      app.close();
      break;
    }

    case 'simulate': {
      const cycles = Number(flag(args, '--cycles') ?? 60);
      const seed = Number(flag(args, '--seed') ?? 20260310);
      out(`Running ${cycles} paper cycles against the offline fixture stream (seed ${seed})...`);
      out();
      const result = await runSimulation({ cycles, seed, verbose: !args.includes('--quiet') });
      out();
      out(summarise(result));
      printQualificationReport(result.app, '1d');
      out();
      out('NOTE: prices in this simulation are synthetic. These figures qualify the machinery');
      out('and the risk controls. They are NOT evidence about whether X contains alpha.');
      result.app.close();
      break;
    }

    case 'replay': {
      const sub = args[0];

      if (sub === 'sample') {
        const out = flag(args, '--out') ?? './data/replay/sample.json';
        const dataset = buildSampleDataset({
          seed: Number(flag(args, '--seed') ?? 424242),
          hours: Number(flag(args, '--hours') ?? 24),
        });
        writeDataset(out, dataset);
        const stats = datasetStats(dataset);
        out_(`Wrote sample dataset to ${out}`);
        out_(`  ${stats.events} events · ${stats.authors} authors · ${stats.bars} bars · ` +
             `${stats.tickers.length} tickers · ${stats.windowHours}h window`);
        out_('  Prices are synthetic: this validates the machinery, not the edge.');
        break;
      }

      if (sub === 'export') {
        const app = makeApp();
        app.seed();
        const days = Number(flag(args, '--days') ?? 7);
        const to = clock.nowIso();
        const from = new Date(clock.nowMs() - days * 86_400_000).toISOString();
        const outPath = flag(args, '--out') ?? `./data/replay/export-${to.slice(0, 10)}.json`;
        const dataset = exportDatasetFromStore(app.store, {
          from,
          to,
          benchmarkTicker: app.spec.benchmarkTicker,
          datasetId: randomId('ds'),
          createdAt: to,
        });
        writeDataset(outPath, dataset);
        const stats = datasetStats(dataset);
        out_(`Exported ${stats.events} events and ${stats.bars} bars to ${outPath}`);
        app.close();
        break;
      }

      if (sub === 'run') {
        const file = args[1];
        if (!file) { out_('Usage: northstar replay run <dataset.json> [--version 1.0.0] [--step 30]'); break; }
        const dataset = readDataset(file);
        const version = flag(args, '--version');
        const spec = version ? getStrategyVersion(X_STRATEGY_ID, version) : latestVersion(X_STRATEGY_ID);

        out_(`Replaying ${dataset.datasetId} against ${spec.strategyId}@${spec.version}...`);
        const result = await runReplay({
          dataset,
          spec,
          stepMinutes: Number(flag(args, '--step') ?? 30),
        });
        printReplayReport(result);
        break;
      }

      out_('Usage: northstar replay <sample|export|run> ...');
      break;
    }

    case 'compare': {
      const file = args[0];
      if (!file) { out_('Usage: northstar compare <dataset.json> --versions 1.0.0,1.1.0'); break; }
      const versions = (flag(args, '--versions') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
      if (versions.length < 2) {
        out_('Give at least two versions: --versions 1.0.0,1.1.0');
        out_(`Registered: ${listStrategyVersionsSafe().join(', ')}`);
        break;
      }
      const dataset = readDataset(file);
      const specs = versions.map((v) => getStrategyVersion(X_STRATEGY_ID, v));
      out_(`Comparing ${versions.join(' vs ')} on ${dataset.datasetId}...`);
      out_();
      const comparison = await compareStrategyVersions({
        dataset,
        specs,
        stepMinutes: Number(flag(args, '--step') ?? 30),
      });
      out_(renderComparison(comparison));
      break;
    }

    case 'reconcile': {
      const app = makeApp(modeArg(args));
      app.seed();
      printProviderBanner(app);
      const report = await app.reconciliation.reconcile();

      heading('RECONCILIATION (read-only)');
      out_(`Broker        ${report.brokerId} (${report.brokerMode})${report.reachedBroker ? '' : ' — UNREACHABLE'}`);
      out_(`Checked       ${report.checked.ledgerEntries} ledger entries · ${report.checked.openOrders} open orders · ` +
           `${report.checked.openPositions} positions vs ${report.checked.brokerOpenOrders} broker orders / ` +
           `${report.checked.brokerPositions} broker positions`);
      out_(`Ledger        cash ${formatUsd(report.ledger.cashCents)} · reserved ${formatUsd(report.ledger.reservedCents)} · ` +
           `positions ${formatUsd(report.ledger.positionsValueCents)} · equity ${formatUsd(report.ledger.equityCents)}`);
      out_(`Integrity     ${report.ledger.integrityOk ? 'OK' : 'MISMATCH'}`);

      if (report.discrepancies.length === 0) {
        out_();
        out_(`${GREEN}No discrepancies. Nothing was modified.${RESET}`);
      } else {
        heading(`DISCREPANCIES (${report.discrepancies.length})`);
        for (const d of report.discrepancies) {
          const colour = d.severity === 'CRITICAL' ? RED : d.severity === 'WARNING' ? YELLOW : DIM;
          out_(`${colour}[${d.severity}]${RESET} ${d.area} · ${d.subject}`);
          out_(`   ${d.detail}`);
          out_(`   northstar: ${d.northstar}`);
          out_(`   broker:    ${d.broker}`);
        }
        out_();
        out_(`${DIM}Nothing was modified. Reconciliation is read-only by design: when the two sides disagree,${RESET}`);
        out_(`${DIM}an automated repair has even odds of destroying the evidence needed to work out which is right.${RESET}`);
      }
      process.exitCode = report.ok ? 0 : 1;
      app.close();
      break;
    }

    case 'readiness': {
      const app = makeApp(modeArg(args));
      app.seed();
      const report = await app.readiness.run();

      heading('FIRST-LIVE-DATA READINESS');
      out_(`Strategy   ${report.strategyId} v${report.strategyVersion} · mode ${report.mode}`);
      out_(`Generated  ${report.at}`);
      out_();

      for (const check of report.checks) {
        const colour = check.status === 'PASS' ? GREEN
          : check.status === 'FAIL' ? RED
          : check.status === 'WARN' ? YELLOW : DIM;
        out_(`${colour}${check.status.padEnd(4)}${RESET}  ${check.label.padEnd(30)} ${check.detail}`);
        if (check.remedy) out_(`        ${DIM}-> ${check.remedy}${RESET}`);
      }

      out_();
      const banner = report.overall === 'PASS' ? `${GREEN}READY${RESET}` : `${RED}NOT READY${RESET}`;
      out_(`${banner}  ${report.passed} passed · ${report.failed} failed · ${report.warned} warning(s) · ${report.skipped} skipped`);
      out_(`${DIM}No orders were submitted by this command.${RESET}`);
      if (!report.liveDataConfigured) {
        out_(`${YELLOW}Note: not all providers are live, so the reachability checks that matter most were skipped.${RESET}`);
      }

      out_();
      const verdict = report.readyForRealDataPaper ? `${GREEN}YES${RESET}` : `${RED}NO${RESET}`;
      out_(`READY FOR REAL-DATA PAPER: ${verdict}`);
      out_(`${DIM}${report.readyForRealDataPaperReason}${RESET}`);

      // Exit code follows the real-data verdict, so CI or a shell guard can
      // gate a start on it rather than on the softer overall PASS.
      process.exitCode = report.readyForRealDataPaper ? 0 : 1;
      app.close();
      break;
    }

    case 'funnel': {
      const app = makeApp();
      heading('DAY FUNNEL');
      out_(app.funnel.render(app.funnel.report()));
      out_();
      out_(`${DIM}A funnel that narrows to zero is a normal outcome. Nothing here is a target.${RESET}`);
      app.close();
      break;
    }

    case 'eod': {
      const day = args[0];
      const app = makeApp();
      out_(app.dailyReport.render(app.dailyReport.build(day)));
      app.close();
      break;
    }

    case 'api': {
      const app = makeApp();
      heading('API USAGE TODAY');
      for (const usage of app.apiMeter.today()) {
        out_(`${BOLD}${usage.provider.toUpperCase()}${RESET}`);
        out_(`  requests ${usage.requests}  ok ${usage.successes}  rate-limited ${usage.rateLimited}  ` +
          `auth ${usage.unauthorized + usage.forbidden}  timeouts ${usage.timeouts}  ` +
          `server ${usage.serverErrors}  other ${usage.otherErrors}`);
        out_(`  last success ${usage.lastSuccessAt ?? 'never'}` +
          (usage.minutesSinceSuccess === null ? '' : ` (${usage.minutesSinceSuccess}m ago)`));
        if (usage.lastErrorAt) out_(`  last error   ${usage.lastErrorAt} ${usage.lastErrorKind}: ${usage.lastErrorDetail ?? ''}`);
        if (usage.rateLimitRemaining !== null) {
          out_(`  headroom     ${usage.rateLimitRemaining}/${usage.rateLimitLimit ?? '?'} until ${usage.rateLimitResetAt ?? '?'}`);
        }
        if (usage.softCapUsedPct !== null) out_(`  daily budget ${usage.softCapUsedPct}% of the soft cap`);
        const pressure = app.apiMeter.underPressure(usage.provider as 'x');
        out_(`  pressure     ${pressure.pressured ? `${YELLOW}YES${RESET}` : 'no'} — ${pressure.reason}`);
        out_();
      }
      out_(`${BOLD}Polling${RESET}`);
      const polling = app.polling.status();
      out_(`  state ${polling.state} · next scan in ${polling.intervalSeconds}s · ${polling.reason}`);
      app.close();
      break;
    }

    case 'audit': {
      const signalId = args[0];
      const app = makeApp();
      const target = signalId ?? app.store.signals.recent(1)[0]?.signalId;
      if (!target) { out_('No signals stored yet. Run `npm run cycle` first.'); app.close(); break; }

      const view = app.audit.audit(target);
      if (!view) { out_(`Signal ${target} not found.`); app.close(); break; }

      const s = view.signal;
      heading(`AUDIT ${s.ticker} — ${s.band} ${s.score >= 0 ? '+' : ''}${s.score}`);
      out_(`Signal     ${s.signalId}`);
      out_(`Generated  ${s.generatedAt} · config ${s.signalConfigId} · strategy v${s.strategyVersion}`);
      out_();
      out_(`${GREEN}Outcome: ${view.outcome.disposition}${RESET}`);
      out_(`  ${view.outcome.detail}`);
      for (const line of view.outcome.narrative) out_(`  - ${line}`);

      heading('SCORE COMPOSITION');
      for (const c of view.components) {
        out_(`  ${c.name.padEnd(26)} ${String(c.value).padStart(5)}  ` +
             `${(c.contributionPoints >= 0 ? '+' : '') + c.contributionPoints.toFixed(1)} pts`);
      }
      out_(`  ${'uncertainty'.padEnd(26)} ${(view.uncertainty * 100).toFixed(0)}%`);

      heading(`ENTITY RESOLUTION (min ${(view.resolution.minConfidence * 100).toFixed(0)}%, ` +
              `threshold ${(view.resolution.tradableThreshold * 100).toFixed(0)}%)`);
      out_(`  ${view.resolution.passesThreshold ? 'USABLE' : 'TOO AMBIGUOUS TO TRADE'}`);
      for (const r of view.resolution.perEvent) {
        out_(`  ${r.ticker} via ${r.method} @ ${(r.confidence * 100).toFixed(0)}% on "${r.matchedText}"`);
      }

      heading(`SOURCE POSTS (${view.sources.length})`);
      for (const src of view.sources) {
        out_(`  @${src.handle} [${src.sourceTier}] weight ${src.weight} · sentiment ${src.sentiment >= 0 ? '+' : ''}${src.sentiment} · ${src.eventType}`);
        out_(`     ${src.text.slice(0, 150)}${src.text.length > 150 ? '...' : ''}`);
        if (src.filterVerdict && src.filterVerdict !== 'ACCEPT') {
          out_(`     filter: ${src.filterVerdict} (${src.filterReasons.join(', ')})`);
        }
      }

      if (view.contradictoryEvidence.length > 0) {
        heading('EVIDENCE AGAINST');
        for (const c of view.contradictoryEvidence) out_(`  - ${c}`);
      }
      app.close();
      break;
    }

    case 'report': {
      const horizon = (args[0] ?? '1d') as ForwardHorizon;
      const app = makeApp();
      app.seed();
      printQualificationReport(app, horizon);
      app.close();
      break;
    }

    case 'signals': {
      const limit = Number(args[0] ?? 10);
      const app = makeApp();
      for (const s of app.store.signals.recent(limit)) {
        heading(`${s.ticker} — ${s.band} ${s.score >= 0 ? '+' : ''}${s.score} (${s.generatedAt})`);
        out(s.explanation);
        out();
        out(`Components: ${Object.entries(s.components).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
        out(`Uncertainty ${(s.uncertainty * 100).toFixed(0)}% · ${s.sourceCount} posts · ` +
            `${s.independentSourceCount.toFixed(2)} independent sources · resolution ${(s.resolutionConfidence * 100).toFixed(0)}%`);
        if (s.contradictoryEvidence.length > 0) {
          out();
          out('Against:');
          for (const c of s.contradictoryEvidence) out(`  - ${c}`);
        }
      }
      app.close();
      break;
    }

    case 'trace': {
      const id = args[0];
      if (!id) {
        out('Usage: northstar trace <correlationId|proposalId|positionId>');
        break;
      }
      const app = makeApp();
      let correlationId = id;
      const proposal = app.store.proposals.byId(id);
      if (proposal) correlationId = proposal.correlationId;
      const position = app.store.positions.byId(id);
      if (position) {
        const p = app.store.proposals.byId(position.entryProposalId);
        if (p) correlationId = p.correlationId;
      }

      const entries = app.store.log.byCorrelation(correlationId);
      heading(`Decision chain ${correlationId} (${entries.length} entries)`);
      for (const e of entries) {
        out(`${e.at}  ${e.stage.padEnd(9)} ${e.summary}`);
      }
      app.close();
      break;
    }

    case 'kill': {
      // Flags are stripped from the reason. The halt reason is a permanent
      // forensic record of WHY the bot was stopped; "market gap --liquidate"
      // reads as though the flag were part of the operator's reasoning.
      const liquidate = args.includes('--liquidate');
      const reason = args.filter((a) => !a.startsWith('--')).join(' ') || 'Manual kill from CLI';
      const app = makeApp();
      app.seed();
      app.health.kill(reason, liquidate);
      const cancelled = await app.orderRouter.cancelOpenOrders(app.spec.strategyId);
      out(`KILL BOT engaged: ${reason}`);
      out(`Cancelled ${cancelled.cancelled.length} order(s)${cancelled.failed.length ? `, ${cancelled.failed.length} failed` : ''}`);
      out(liquidate ? 'Liquidation was explicitly selected: positions will be closed on the next cycle.'
                    : 'Positions left untouched (liquidation not selected).');
      app.close();
      break;
    }

    /*
     * Manual X ingest — the temporary experiment.
     *
     * Reading from stdin as well as argv is what makes a paste workable: an
     * operator copying several posts out of a browser should not have to shell-
     * escape them.
     */
    case 'manual': {
      const sub = args[0] ?? 'status';
      const app = makeApp('PAPER');
      app.seed();

      switch (sub) {
        case 'start': {
          const note = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
          const result = app.manualIngest.startExperiment(env.approverId, note);
          out(result.detail);
          if (result.started) {
            out();
            out(`${YELLOW}Trading has NOT been started. Run "npm start" when you want the bot to act.${RESET}`);
          }
          break;
        }

        case 'stop': {
          const reason = args.slice(1).filter((a) => !a.startsWith('--')).join(' ') || 'Stopped from CLI';
          const result = app.manualIngest.stopExperiment(reason);
          out(result.stopped
            ? 'Manual-X experiment closed. Operator-supplied posts no longer count as real data.'
            : `No manual-X experiment is running. ${result.window.inactiveReason ?? ''}`);
          break;
        }

        case 'add': {
          const report = app.manualIngest.submit(
            {
              url: flag(args, '--url') ?? '',
              text: flag(args, '--text') ?? '',
              postedAt: flag(args, '--at') ?? '',
              ...(flag(args, '--handle') ? { handle: flag(args, '--handle')! } : {}),
              ...(flag(args, '--name') ? { displayName: flag(args, '--name')! } : {}),
              ...(flag(args, '--likes') ? { likes: Number(flag(args, '--likes')) } : {}),
              ...(flag(args, '--reposts') ? { reposts: Number(flag(args, '--reposts')) } : {}),
              ...(flag(args, '--replies') ? { replies: Number(flag(args, '--replies')) } : {}),
              ...(flag(args, '--quotes') ? { quotes: Number(flag(args, '--quotes')) } : {}),
              ...(flag(args, '--impressions') ? { impressions: Number(flag(args, '--impressions')) } : {}),
              ...(flag(args, '--followers') ? { followerCount: Number(flag(args, '--followers')) } : {}),
            },
            env.approverId,
          );
          printSubmitReport(report);
          break;
        }

        case 'batch': {
          const file = flag(args, '--file');
          const raw = file ? readFileSync(file, 'utf8') : await readStdin();
          if (raw.trim() === '') {
            out('Nothing to read. Pipe posts in, or pass --file <path>.');
            out('Each line: <url> | <ISO timestamp> | <text>   (or a JSON array)');
            process.exitCode = 1;
            break;
          }
          printSubmitReport(app.manualIngest.submitBatch(raw, env.approverId));
          break;
        }

        case 'list': {
          const observations = app.store.manual.recent(Number(args[1] ?? 25));
          const counts = app.store.manual.counts();
          heading('MANUAL X OBSERVATIONS');
          out(`${counts.total} held · ${counts.pending} pending · ${counts.ingested} ingested`);
          out();
          for (const o of observations) {
            out(`${o.status === 'PENDING' ? YELLOW : GREEN}${o.status.padEnd(8)}${RESET} ` +
                `@${o.handle.padEnd(16)} ${o.postedAt}`);
            out(`${DIM}  ${o.canonicalUrl}${RESET}`);
            out(`  ${o.text.slice(0, 100)}${o.text.length > 100 ? '…' : ''}`);
            if (o.eventId) out(`${DIM}  event ${o.eventId}${RESET}`);
            out();
          }
          break;
        }

        default:
          printManualStatus(app);
      }

      app.close();
      break;
    }

    /*
     * Health incidents — inspect, and close only what is genuinely over.
     *
     * Read-only by default. Resolution recomputes the fault's condition from
     * live state and refuses if it still holds, because an incident closed over
     * a live problem turns a loud fault into a silent one.
     */
    case 'incidents': {
      const app = makeApp('PAPER');
      app.seed();
      const sub = args[0] ?? 'list';

      if (sub === 'resolve') {
        const id = args[1];
        const note = args.slice(2).filter((a) => !a.startsWith('--')).join(' ');
        if (!id) {
          out('Usage: northstar incidents resolve <incidentId> "<why it is historical>"');
          process.exitCode = 1;
          app.close();
          break;
        }
        const result = app.forensics.resolve(id, note);
        out(result.detail);
        if (result.diagnosis) printDiagnosis(result.diagnosis);
        if (!result.resolved) process.exitCode = 1;
        app.close();
        break;
      }

      const open = app.forensics.diagnoseOpen();
      heading('HEALTH INCIDENTS');
      if (open.length === 0) {
        out(`${GREEN}No unresolved incidents.${RESET}`);
      } else {
        out(`${open.length} unresolved incident(s).`);
        for (const d of open) printDiagnosis(d);
      }

      heading('LEDGER INTEGRITY BY EPOCH');
      for (const e of app.forensics.allEpochIntegrity()) {
        out(`${e.ok ? GREEN + 'OK  ' : RED + 'FAIL'}${RESET} ${e.epochId.padEnd(16)} ${e.status.padEnd(7)} ` +
            `${e.detail}`);
        out(`${DIM}     ${e.entryCount} entries · ${e.openPositions} open position(s) · ` +
            `${e.openOrders} open order(s)${RESET}`);
      }
      app.close();
      break;
    }

    /*
     * PAUSE NEW ENTRIES — deliberately not a stop.
     *
     * Exits, fills and reconciliation keep running. A position nobody is
     * watching is worse than one still being managed, so pausing closes the
     * front door and nothing else. `kill` is the emergency control.
     */
    case 'pause': {
      const reason = args.filter((a) => !a.startsWith('--')).join(' ') || 'Manual pause from CLI';
      const app = makeApp();
      app.seed();
      const strategy = app.health.pauseByOperator(reason);
      out(`New entries PAUSED: ${reason}`);
      out(`Run state: ${strategy.runState}`);
      out('Exits, stop-losses, fills and reconciliation continue. Open positions are still managed.');
      out('Use `northstar resume <note>` to allow new entries again.');
      app.close();
      break;
    }

    case 'resume': {
      const app = makeApp();
      app.seed();
      const strategy = app.health.resume(
        args.filter((a) => !a.startsWith('--')).join(' ') || 'Resumed from CLI',
      );
      out(`Strategy resumed: ${strategy.runState}`);
      app.close();
      break;
    }

    case 'mode': {
      const mode = args[0]?.toUpperCase();
      if (mode !== 'PAPER' && mode !== 'LIVE') {
        out('Usage: northstar mode PAPER|LIVE');
        process.exitCode = 1;
        break;
      }
      const app = makeApp(mode);
      app.seed();
      const strategy = app.setMode(mode);
      out(`Mode set to ${strategy.mode}. Broker is ${app.broker.brokerId} (${app.broker.mode}).`);
      if (mode === 'LIVE') {
        out('LIVE mode: every order now requires explicit human approval in the X Bot Console before submission.');
      }
      app.close();
      break;
    }

    default:
      printHelp();
  }
}

/* --------------------------------------------------------------- replay */

function printReplayReport(r: ReplayResult): void {
  out();
  out(summariseReplay(r));

  heading('REPLAY RESULT');
  out(`Dataset      ${r.datasetId}`);
  out(`Strategy     ${r.strategyId} v${r.strategyVersion} (config ${r.signalConfigId})`);
  out(`Window       ${r.window.from} .. ${r.window.to}`);
  out(`Cycles       ${r.cycles.length}`);
  out(`Look-ahead   ${r.lookAheadClean ? 'CLEAN — no event or bar was revealed before its timestamp' : 'CHECK FAILED'}`);

  heading('PERFORMANCE');
  out(`Return                ${r.returnPct.toFixed(3)}%`);
  out(`Benchmark             ${r.benchmarkReturnPct.toFixed(3)}%`);
  out(`Alpha                 ${r.alphaPct.toFixed(3)}%`);
  out(`Maximum drawdown      ${r.maxDrawdownPct.toFixed(3)}%`);
  out(`Win rate              ${r.winRatePct.toFixed(1)}% (${r.tradeCount} closed trades)`);
  out(`Turnover              ${r.turnover.toFixed(3)}x allocation`);
  out(`Costs                 ${formatUsd(r.totalCostsCents)}`);
  out(`Sharpe                ${r.sharpe === null ? 'n/a (curve too short)' : r.sharpe.toFixed(3)}`);
  out(`Equity                ${formatUsd(r.finalEquityCents)} from ${formatUsd(r.startingCapitalCents)}`);
  out(`Open at end           ${r.openPositionsAtEnd}`);

  heading('SIGNAL QUALITY');
  out(`Signals generated     ${r.signalsGenerated}`);
  out(`Measured              ${r.measuredSignals}`);
  out(`Hit rate              ${r.hitRatePct === null ? 'n/a' : `${r.hitRatePct.toFixed(1)}%`}`);
  out(`Mean excess return    ${r.meanExcessReturnPct === null ? 'n/a' : `${r.meanExcessReturnPct.toFixed(3)}%`}`);
  for (const tier of r.sourceTierPerformance) {
    out(`  ${tier.bucket.padEnd(10)} n=${String(tier.count).padStart(4)}  ` +
        `hit ${tier.hitRatePct === null ? 'n/a' : `${tier.hitRatePct.toFixed(0)}%`}`);
  }

  heading('RISK INTERVENTIONS');
  out(`Total                 ${r.riskInterventions}`);
  for (const [check, n] of Object.entries(r.riskInterventionsByCheck).sort((a, b) => b[1] - a[1])) {
    out(`  ${check.padEnd(28)} ${n}`);
  }
  out(`Filter verdicts       ${Object.entries(r.filterVerdicts).map(([k, v]) => `${k}=${v}`).join(' · ') || 'none'}`);
  out(`Health incidents      ${r.healthIncidents.length}`);
  out(`Errors                ${r.errors.length}`);

  if (r.trades.length > 0) {
    heading(`TRADES (${r.trades.length})`);
    for (const t of r.trades) {
      out(`  ${t.ticker.padEnd(6)} ${t.openedAt.slice(5, 16)} -> ${(t.closedAt ?? 'open').slice(5, 16)}  ` +
          `${t.entryPrice.toFixed(2)} -> ${t.exitPrice?.toFixed(2) ?? '   —'}  ` +
          `${formatSignedUsd(t.realisedPnlCents)} (${t.realisedPct === null ? 'n/a' : `${t.realisedPct.toFixed(2)}%`})  ` +
          `${t.exitReason ?? ''}`);
    }
  }
}

/* --------------------------------------------------- paper qualification */

function printQualificationReport(app: NorthstarApp, horizon: ForwardHorizon): void {
  const strategyId = app.spec.strategyId;
  const ledger = app.ledger.get();
  const survival = app.survival.compute();
  const analytics = app.analytics.report(horizon);
  const closed = app.store.positions.closed(strategyId);
  const allProposals = app.store.proposals.recent(10_000);
  const rejections = app.store.risk.recent(10_000).filter((r) => !r.approved);
  const incidents = app.store.incidents.recent(strategyId, 500);
  const signals = app.store.signals.all();

  heading('PAPER QUALIFICATION REPORT');
  out(`Strategy      ${app.spec.strategyId} v${app.spec.version}`);
  out(`Signal config ${app.spec.signalConfigId}`);
  out(`Generated     ${clock.nowIso()}`);

  heading('Activity');
  out(`Signals generated        ${signals.length}`);
  out(`Trade proposals          ${allProposals.length}`);
  out(`Orders submitted         ${app.store.orders.all().length}`);
  out(`Trades closed            ${closed.length}`);
  out(`Open positions           ${app.store.positions.open(strategyId).length}`);

  heading('Performance');
  out(`Return                   ${survival.strategyReturnPct.toFixed(3)}%`);
  out(`Benchmark (${app.spec.benchmarkTicker})          ${survival.benchmarkReturnPct.toFixed(3)}%`);
  out(`Alpha                    ${survival.alphaPct.toFixed(3)}%`);
  out(`Maximum drawdown         ${survival.maxDrawdownPct.toFixed(3)}%`);
  out(`Win rate                 ${survival.winRatePct.toFixed(1)}% (${closed.length} trades)`);
  out(`Average winner           ${formatSignedUsd(survival.averageWinnerCents)}`);
  out(`Average loser            ${formatSignedUsd(survival.averageLoserCents)}`);
  out(`Sharpe                   ${survival.sharpe === null ? 'n/a (curve too short)' : survival.sharpe.toFixed(3)}`);
  out(`Turnover                 ${survival.turnover.toFixed(3)}x allocation`);
  out(`Costs                    ${formatUsd(survival.totalCostsCents)}`);
  out(`Equity                   ${formatUsd(ledger.equityCents)} from ${formatUsd(ledger.startingCapitalCents)}`);

  heading('Signal quality');
  out(`Measured at ${horizon}          ${analytics.measuredSignals}`);
  out(`Hit rate                 ${analytics.overallHitRatePct === null ? 'n/a' : `${analytics.overallHitRatePct.toFixed(1)}%`}`);
  out(`Mean forward return      ${analytics.meanReturnPct === null ? 'n/a' : `${analytics.meanReturnPct.toFixed(3)}%`}`);
  out(`Mean excess return       ${analytics.meanExcessReturnPct === null ? 'n/a' : `${analytics.meanExcessReturnPct.toFixed(3)}%`}`);

  heading('Rejected signals and risk interventions');
  out(`Risk rejections          ${rejections.length}`);
  const byCheck = new Map<string, number>();
  for (const r of rejections) for (const c of r.failedChecks) byCheck.set(c, (byCheck.get(c) ?? 0) + 1);
  for (const [check, n] of [...byCheck.entries()].sort((a, b) => b[1] - a[1])) {
    out(`  ${check.padEnd(28)} ${n}`);
  }
  const filterStats = app.store.filters.countByVerdictSince('1970-01-01T00:00:00.000Z');
  out(`Posts rejected by filter ${filterStats['REJECT'] ?? 0}`);
  out(`Posts downweighted       ${filterStats['DOWNWEIGHT'] ?? 0}`);
  out(`Posts accepted           ${filterStats['ACCEPT'] ?? 0}`);

  heading('Errors and incidents');
  out(`Health incidents         ${incidents.length}`);
  for (const i of incidents.slice(0, 10)) out(`  ${i.at}  ${i.fault}: ${i.detail}`);
  if (incidents.length === 0) out('  (none)');

  heading('Verdict');
  out(`Status label             ${survival.status}`);
  out(`Rationale                ${survival.statusRationale}`);
  out(`Sample adequate          ${survival.sampleAdequate ? 'yes' : 'NO'}`);
  if (!survival.sampleAdequate || !analytics.sampleAdequate) {
    out();
    out('DO NOT treat these figures as evidence of profitability. The sample is too small to');
    out('distinguish skill from luck, and no live capital decision should rest on it.');
  }
}

/* ------------------------------------------------------------- helpers */

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function modeArg(args: string[]): TradingMode | undefined {
  const value = flag(args, '--mode')?.toUpperCase();
  return value === 'LIVE' || value === 'PAPER' ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  out(`Northstar X Trading Bot — X Bot Console

  migrate                  create or upgrade the database
  seed                     create the strategy, universe and $50 capital ledger
  cycle [--mode PAPER]     run one full pipeline cycle
  paper [--interval 120]   run the paper loop; --interval is the X SCAN cadence
                           in SECONDS. Position monitoring (60s) and
                           reconciliation (180s) run on their own cadences.
                           --cycles N bounds the number of X scans.
  run                      the deployable process: trading loops + console
                           (this is what "npm start" runs)
  serve [--mode PAPER]     start the X Bot Console only
  manual status            the manual-X experiment and what it permits
  manual start "<note>"    OPEN the 7-day manual-X experiment (does not trade)
  manual add --url U --at T --text "..."   submit one real X post
  manual batch [--file f]  submit a pasted batch (stdin if no file)
  manual list [n]          recent operator-supplied observations
  manual stop "<reason>"   close the experiment early
  incidents                open incidents, diagnosed, plus ledger integrity per epoch
  incidents resolve <id> "<note>"   close one, refused while its cause is live
  pause <reason>           PAUSE NEW ENTRIES; exits and reconciliation continue
  resume <note>            allow new entries again
  kill <reason>            EMERGENCY STOP; cancels open orders, keeps positions
  kill <reason> --liquidate  EMERGENCY LIQUIDATE; also closes positions
  status                   strategy status and capital ledger
  simulate [--cycles 60]   offline paper simulation over the real pipeline
  replay sample            write a deterministic sample replay dataset
  replay export --days 7   freeze what a live run saw, for reproducible replay
  replay run <file>        replay a dataset through the real pipeline
  compare <file> --versions a,b   run two strategy versions over one dataset
  reconcile                compare the ledger with the broker (read-only)
  readiness                PASS/FAIL gates before the first real-credential run
  funnel                   today's stage-by-stage funnel, X request to trade
  eod [YYYY-MM-DD]         end-of-day report
  api                      API usage, rate-limit headroom and polling state
  audit [signalId]         full evidential trail behind one signal
  report [1h|1d|1w|1m]     paper-qualification report
  signals [n]              recent signals with full explanations
  trace <id>               reconstruct a decision chain end to end
  kill <reason>            engage the kill switch (--liquidate to also sell)
  resume <note>            clear a pause or kill
  mode PAPER|LIVE          set the trading mode

Environment: see .env.example. Credentials are read from the environment only.`);
}

main().catch((e) => {
  // A misconfiguration is the operator's to fix, not a crash to debug: print it
  // plainly rather than burying it in a stack trace or a JSON log line.
  if (e instanceof ConfigurationError) {
    out();
    out(`${RED}Configuration error${RESET}`);
    out(e.message);
    out();
    out(`${DIM}Fix .env at the repo root, or unset those variables to run on fixtures.${RESET}`);
    process.exitCode = 1;
    return;
  }
  logger.error('command failed', { detail: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});
