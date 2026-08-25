#!/usr/bin/env node
/**
 * Northstar Trading Lab CLI.
 *
 *   northstar migrate            create/upgrade the database
 *   northstar seed               create the strategy, universe and $50 ledger
 *   northstar cycle              run one full pipeline cycle
 *   northstar paper [--interval] run the paper loop continuously
 *   northstar serve              start the Trading Lab dashboard
 *   northstar status             print strategy status and the ledger
 *   northstar report [horizon]   print the paper-qualification report
 *   northstar signals [n]        print recent signals with explanations
 *   northstar trace <id>         reconstruct one decision chain end to end
 *   northstar kill <reason>      engage the kill switch
 *   northstar resume <note>      clear a pause/kill
 *   northstar mode PAPER|LIVE    set the trading mode
 */
import { ConsoleLogger, formatSignedUsd, formatUsd, SystemClock } from '../core/index.js';
import { loadEnv } from '../config/env.js';
import { NorthstarApp } from '../app.js';
import { ApiServer } from '../api/server.js';
import type { ForwardHorizon, TradingMode } from '../domain/types.js';
import { openDatabase } from '../persistence/db.js';
import { runSimulation, summarise } from './simulation.js';

const env = loadEnv();
const logger = new ConsoleLogger(env.logLevel as 'info', 'cli');
const clock = new SystemClock();

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function heading(title: string): void {
  out();
  out(`\x1b[1m${title}\x1b[0m`);
  out('─'.repeat(Math.min(78, title.length + 12)));
}

function makeApp(mode?: TradingMode): NorthstarApp {
  return new NorthstarApp({ env, clock, logger, ...(mode ? { mode } : {}) });
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
      out(`Mode: ${strategy.mode} · broker: ${app.broker.brokerId} (${app.broker.mode})`);
      app.close();
      break;
    }

    case 'cycle': {
      const app = makeApp(modeArg(args));
      app.seed();
      const report = await app.runner.runCycle();
      heading('Cycle report');
      out(JSON.stringify(report, null, 2));
      app.close();
      break;
    }

    case 'paper': {
      const intervalMinutes = Number(flag(args, '--interval') ?? 15);
      const maxCycles = Number(flag(args, '--cycles') ?? Infinity);
      const app = makeApp('PAPER');
      app.seed();
      app.setMode('PAPER');
      out(`Paper loop started: one cycle every ${intervalMinutes} minute(s). Ctrl-C to stop.`);

      let cycles = 0;
      let stopping = false;
      process.on('SIGINT', () => {
        stopping = true;
        out('\nStopping after the current cycle…');
      });

      while (!stopping && cycles < maxCycles) {
        cycles += 1;
        try {
          const report = await app.runner.runCycle();
          out(
            `[${report.finishedAt}] cycle ${cycles}: ${report.signalsGenerated} signals, ` +
            `${report.proposalsCreated} proposals, ${report.riskRejected} risk-rejected, ` +
            `${report.ordersSubmitted} orders, ${report.exitsTriggered.length} exits, ` +
            `equity ${formatUsd(report.equityCents)}` +
            (report.halted ? ` — HALTED: ${report.haltReason}` : ''),
          );
        } catch (e) {
          logger.error('cycle failed', { detail: e instanceof Error ? e.message : String(e) });
        }
        if (stopping || cycles >= maxCycles) break;
        await sleep(intervalMinutes * 60_000);
      }
      app.close();
      break;
    }

    case 'serve': {
      const app = makeApp(modeArg(args));
      app.seed();
      const server = new ApiServer({ app, port: env.httpPort, logger, approverId: env.approverId });
      await server.listen();
      out(`Trading Lab: http://localhost:${env.httpPort}`);
      out(`Mode: ${app.store.strategies.byId(app.spec.strategyId)?.mode} · broker ${app.broker.brokerId} (${app.broker.mode})`);
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
      out(`Mode          ${strategy.mode} · broker ${app.broker.brokerId} (${app.broker.mode})`);

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
      const reason = args.join(' ') || 'Manual kill from CLI';
      const liquidate = args.includes('--liquidate');
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

    case 'resume': {
      const app = makeApp();
      app.seed();
      const strategy = app.health.resume(args.join(' ') || 'Resumed from CLI');
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
        out('LIVE mode: every order now requires explicit human approval in Trading Lab before submission.');
      }
      app.close();
      break;
    }

    default:
      printHelp();
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
  out(`Northstar Trading Lab — X Signal Bot

  migrate                  create or upgrade the database
  seed                     create the strategy, universe and $50 capital ledger
  cycle [--mode PAPER]     run one full pipeline cycle
  paper [--interval 15]    run the paper loop continuously (--cycles N to bound it)
  serve [--mode PAPER]     start the Trading Lab dashboard
  status                   strategy status and capital ledger
  simulate [--cycles 60]   offline paper simulation over the real pipeline
  report [1h|1d|1w|1m]     paper-qualification report
  signals [n]              recent signals with full explanations
  trace <id>               reconstruct a decision chain end to end
  kill <reason>            engage the kill switch (--liquidate to also sell)
  resume <note>            clear a pause or kill
  mode PAPER|LIVE          set the trading mode

Environment: see .env.example. Credentials are read from the environment only.`);
}

main().catch((e) => {
  logger.error('command failed', { detail: e instanceof Error ? e.message : String(e) });
  process.exitCode = 1;
});
