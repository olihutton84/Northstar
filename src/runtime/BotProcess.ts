/**
 * The deployable process.
 *
 * One process runs BOTH the trading loops and the X Bot Console, deliberately.
 * Splitting them across two containers would put two writers on one SQLite
 * file, and the scheduler's single-lock design assumes exactly one — the
 * ledger, reservations and position bookkeeping are not safe against a second
 * writer. Keeping them together also gives the platform a health endpoint to
 * probe, which a worker-only deployment would not have.
 *
 * Shutdown is the part that matters in a container. A platform stops a service
 * with SIGTERM and then kills it; a bot that ignores SIGTERM is killed
 * mid-task, potentially between submitting an order and recording it. So the
 * signal is handled: the scheduler stops accepting new work, the task already
 * running is allowed to finish, the console closes, and only then does the
 * process finish.
 *
 * A second signal exits immediately — if the operator asks twice, they mean it.
 *
 * This supervisor stops the WORK. It does not close the app: the caller
 * constructed it, and still needs it afterwards to write the day's report.
 */
import type { Logger } from '../core/index.js';
import type { NorthstarApp } from '../app.js';
import { ApiServer } from '../api/server.js';

export interface BotProcessOptions {
  app: NorthstarApp;
  logger: Logger;
  /** Serve the console. Off makes this a worker with no health endpoint. */
  serveConsole: boolean;
  port: number;
  host: string;
  approverId: string;
  /**
   * Run the trading loops.
   *
   * Off leaves a read-only console over existing state — useful for inspecting
   * a deployment without it acting.
   */
  runTrading: boolean;
  /** Stop after this many X scans. Used by tests; unbounded in production. */
  maxScans?: number;
  /** Seconds to let an in-flight task finish before forcing exit. */
  shutdownGraceSeconds?: number;
}

export interface BotProcessHandle {
  /** Resolves once the process has fully stopped. */
  done: Promise<void>;
  /** Begin a graceful shutdown. Safe to call more than once. */
  stop(reason: string): void;
  /**
   * The console's address, when one is being served.
   *
   * The port is the one actually bound, which differs from the one requested
   * when port 0 was used to let the OS choose.
   */
  address: { host: string; port: number } | null;
}

export async function startBotProcess(opts: BotProcessOptions): Promise<BotProcessHandle> {
  const log = opts.logger.child('process');
  const grace = (opts.shutdownGraceSeconds ?? 25) * 1000;

  let server: ApiServer | null = null;
  let stopping = false;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async (reason: string): Promise<void> => {
    log.info('shutting down', { reason, graceSeconds: grace / 1000 });

    // Ask the scheduler to stop; it finishes the task already past its lock.
    opts.app.scheduler.stop();

    // A task that hangs must not hold the container open until the platform
    // kills it — that is the case where work is lost.
    const timer = setTimeout(() => {
      log.error('shutdown grace expired; exiting with work possibly in flight', { reason });
      finish();
    }, grace);
    timer.unref?.();

    try {
      if (server) await server.close();
    } catch (e) {
      log.warn('console did not close cleanly', { detail: e instanceof Error ? e.message : String(e) });
    }

    clearTimeout(timer);
    finish();
  };

  /*
   * Work stops here; the app is NOT closed.
   *
   * The caller constructed the app and owns its lifetime, and it still has
   * reading to do after the loops stop — the end-of-day report is built from
   * the database. Closing it here left the caller reading a closed handle.
   */
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    log.info('stopped');
    resolveDone();
  };

  const onSignal = (signal: string): void => {
    if (stopping) {
      // Asked twice: the operator means now.
      log.warn('second signal received; exiting immediately', { signal });
      process.exit(130);
    }
    stopping = true;
    void shutdown(signal);
  };

  /*
   * Handlers first, before anything is started.
   *
   * Node's default disposition for SIGTERM is to terminate, so any window
   * before these are installed is a window in which a platform stopping the
   * service kills the process outright — during migration, during seeding, or
   * between the console accepting its first health check and the loops
   * starting. Small, but a container is exactly where it gets hit: deploys are
   * cancelled and replicas are drained seconds after they come up.
   */
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  if (opts.serveConsole) {
    server = new ApiServer({
      app: opts.app,
      port: opts.port,
      host: opts.host,
      logger: opts.logger,
      approverId: opts.approverId,
    });
    await server.listen();

    // A signal that arrived during startup found no server to close. Close it
    // now, rather than leaving the socket holding the process open.
    if (stopping) {
      await server.close();
      finish();
      return { done, stop: () => {}, address: null };
    }
  }

  // Written before the first scan, so whatever follows is explainable.
  opts.app.recordRunConfiguration(opts.runTrading ? 'process' : 'process (console only)');

  if (stopping) {
    // Stopped before the loops ever started; nothing to wind down.
    finish();
    return { done, stop: () => {}, address: null };
  }

  if (opts.runTrading) {
    opts.app.scheduler.startSupportLoops();
    // The scheduler owns the run; when its X-scan loop ends, so does the
    // process. Errors inside a task are handled per-task and never reach here.
    void opts.app.scheduler
      .start(opts.maxScans === undefined ? {} : { maxScans: opts.maxScans })
      .then(
        () => {
          if (!stopping) {
            stopping = true;
            void shutdown('scheduler finished');
          }
        },
        (e: unknown) => {
          log.error('scheduler failed', { detail: e instanceof Error ? e.message : String(e) });
          if (!stopping) {
            stopping = true;
            void shutdown('scheduler error');
          }
        },
      );
  } else {
    log.warn('trading loops are DISABLED for this process; the console is read-only');
  }

  return {
    done,
    stop: (reason: string) => {
      if (stopping) return;
      stopping = true;
      void shutdown(reason);
    },
    address: server ? { host: opts.host, port: server.boundPort ?? opts.port } : null,
  };
}
