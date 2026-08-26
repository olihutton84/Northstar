/**
 * Deployability.
 *
 * The bot is correct in a terminal and correct in a container for different
 * reasons. In a container the questions are: does it bind where the platform's
 * health check can reach it, does it stop when the platform says stop, does it
 * exit 0 when it did so on purpose, and does what it wrote still exist after a
 * redeploy. None of those are exercised by the pipeline tests, and getting any
 * of them wrong looks like a healthy deployment right up until it does not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createHarness, testEnv } from '../fixtures/harness.js';
import { NullLogger } from '../../src/core/index.js';
import { startBotProcess } from '../../src/runtime/BotProcess.js';
import { assessStorage, databaseDirectoryUsable } from '../../src/runtime/StorageCheck.js';
import { loadEnv } from '../../src/config/env.js';

/** GET a path off the running console. */
function get(host: string, port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------ port and host ----- */

describe('port and host resolution', () => {
  /**
   * loadEnv reads process.env directly, so these tests swap it and put it back
   * rather than constructing a config object that could drift from the real
   * resolution order.
   */
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it('prefers the platform-injected PORT over the built-in default', () => {
    const env = withEnv({ PORT: '8080', NORTHSTAR_PORT: undefined }, () => loadEnv());
    assert.equal(env.httpPort, 8080);
  });

  it('falls back to 3737 when no platform injects a port', () => {
    const env = withEnv({ PORT: undefined, NORTHSTAR_PORT: undefined }, () => loadEnv());
    assert.equal(env.httpPort, 3737);
  });

  it('lets an explicit NORTHSTAR_PORT win over the injected one', () => {
    const env = withEnv({ PORT: '8080', NORTHSTAR_PORT: '4141' }, () => loadEnv());
    assert.equal(env.httpPort, 4141);
  });

  it('binds all interfaces when a platform is hosting it', () => {
    // A health check cannot reach loopback from outside the container, so a
    // deployment that bound 127.0.0.1 would be restarted forever.
    const env = withEnv({ PORT: '8080', NORTHSTAR_HOST: undefined }, () => loadEnv());
    assert.equal(env.httpHost, '0.0.0.0');
  });

  it('binds loopback only when running locally', () => {
    const env = withEnv({ PORT: undefined, NORTHSTAR_HOST: undefined }, () => loadEnv());
    assert.equal(env.httpHost, '127.0.0.1');
  });

  it('lets NORTHSTAR_HOST override either default', () => {
    const env = withEnv({ PORT: '8080', NORTHSTAR_HOST: '127.0.0.1' }, () => loadEnv());
    assert.equal(env.httpHost, '127.0.0.1');
  });
});

/* --------------------------------------------------------- the process ---- */

describe('the deployable process', () => {
  it('serves a health endpoint the platform can probe', async () => {
    const h = createHarness();
    const handle = await startBotProcess({
      app: h.app,
      logger: new NullLogger(),
      serveConsole: true,
      port: 0,
      host: '127.0.0.1',
      approverId: 'test-operator',
      runTrading: false,
    });

    assert.ok(handle.address, 'a console-serving process must report an address');
    assert.notEqual(handle.address.port, 0, 'the reported port must be the one actually bound');
    const res = await get('127.0.0.1', handle.address.port, '/api/health');
    assert.equal(res.status, 200);

    handle.stop('test');
    await handle.done;
    h.close();
  });

  it('stops on request and leaves the app open for the caller to close', async () => {
    // The caller still has the end-of-day report to build from the database, so
    // the supervisor must stop the WORK without closing what it does not own.
    const h = createHarness();
    const handle = await startBotProcess({
      app: h.app,
      logger: new NullLogger(),
      serveConsole: false,
      port: 0,
      host: '127.0.0.1',
      approverId: 'test-operator',
      runTrading: false,
    });

    handle.stop('test');
    await handle.done;

    // Would throw "database is not open" if the supervisor had closed it.
    assert.doesNotThrow(() => h.app.dailyReport.build());
    h.close();
  });

  it('is safe to stop more than once', async () => {
    const h = createHarness();
    const handle = await startBotProcess({
      app: h.app,
      logger: new NullLogger(),
      serveConsole: false,
      port: 0,
      host: '127.0.0.1',
      approverId: 'test-operator',
      runTrading: false,
    });

    handle.stop('first');
    handle.stop('second');
    handle.stop('third');
    await handle.done;
    h.close();
  });

  it('finishes on its own when the scheduler runs out of scans', async () => {
    const h = createHarness();
    const handle = await startBotProcess({
      app: h.app,
      logger: new NullLogger(),
      serveConsole: false,
      port: 0,
      host: '127.0.0.1',
      approverId: 'test-operator',
      runTrading: true,
      maxScans: 1,
    });

    await handle.done;
    assert.doesNotThrow(() => h.app.dailyReport.build());
    h.close();
  });

  it('records what configuration actually ran, before the first scan', async () => {
    const h = createHarness();
    const handle = await startBotProcess({
      app: h.app,
      logger: new NullLogger(),
      serveConsole: false,
      port: 0,
      host: '127.0.0.1',
      approverId: 'test-operator',
      runTrading: false,
    });
    handle.stop('test');
    await handle.done;

    const entries = h.app.store.log.recent(200);
    assert.ok(
      entries.some((e: { stage: string }) => e.stage === 'SYSTEM'),
      'the process must record its run configuration so a session is explainable',
    );
    h.close();
  });
});

/* ------------------------------------------------------------- storage ---- */

describe('database durability assessment', () => {
  it('calls a local run local, and asks for nothing', () => {
    const a = assessStorage('./data/northstar.sqlite', {});
    assert.equal(a.verdict, 'LOCAL');
    assert.equal(a.containerised, false);
    assert.equal(a.remedy, null);
  });

  it('flags a container-image path as likely ephemeral', () => {
    // The dangerous case: healthy, writable, and destroyed on next deploy.
    const a = assessStorage('/app/northstar.sqlite', { PORT: '8080' });
    assert.equal(a.verdict, 'LIKELY_EPHEMERAL');
    assert.ok(a.remedy, 'an ephemeral verdict must tell the operator what to do');
    assert.match(a.detail, /DESTROYED/);
  });

  it('does not let path traversal masquerade as a mounted volume', () => {
    // Textually this starts with /data/; it resolves to /app, which is the
    // container image.
    const a = assessStorage('/data/../app/northstar.sqlite', { PORT: '8080' });
    assert.equal(a.verdict, 'LIKELY_EPHEMERAL');
  });

  it('accepts a path inside a declared volume mount', () => {
    const a = assessStorage('/var/data/northstar.sqlite', {
      PORT: '8080',
      RAILWAY_VOLUME_MOUNT_PATH: '/var/data',
    });
    assert.equal(a.verdict, 'PERSISTENT');
    assert.equal(a.remedy, null);
  });

  it('does not accept a path that merely looks like the declared mount', () => {
    // /var/database is not inside /var/data, however similar the prefix.
    const a = assessStorage('/var/database/northstar.sqlite', {
      PORT: '8080',
      RAILWAY_VOLUME_MOUNT_PATH: '/var/data',
    });
    assert.equal(a.verdict, 'LIKELY_EPHEMERAL');
  });

  it('treats a conventional mount path as persistent but says it is inferred', () => {
    const a = assessStorage('/data/northstar.sqlite', { PORT: '8080' });
    assert.equal(a.verdict, 'PERSISTENT');
    assert.match(a.detail, /inferred/);
  });

  it('calls an in-memory database what it is', () => {
    const a = assessStorage(':memory:', { PORT: '8080' });
    assert.equal(a.verdict, 'IN_MEMORY');
    assert.ok(a.remedy);
  });

  it('ignores an empty PORT rather than reading it as a container', () => {
    const a = assessStorage('./data/northstar.sqlite', { PORT: '  ' });
    assert.equal(a.containerised, false);
  });

  it('reports a directory that will be created rather than a false problem', () => {
    const u = databaseDirectoryUsable('/tmp/northstar-does-not-exist-yet/db.sqlite');
    assert.equal(u.ok, true);
    assert.match(u.detail, /will be created/);
  });

  it('reports an existing directory as usable', () => {
    const u = databaseDirectoryUsable('/tmp/northstar-db.sqlite');
    assert.equal(u.ok, true);
  });
});

/* ----------------------------------------------------------- readiness ---- */

describe('readiness reports storage durability', () => {
  it('includes the durability gate', async () => {
    const h = createHarness();
    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'storage-durable');
    assert.ok(check, 'readiness must state whether the database survives a restart');
    h.close();
  });

  it('warns rather than fails, because it cannot be proven from inside', async () => {
    // A false FAIL on a correctly mounted volume would train an operator to
    // ignore the one check that matters most.
    const h = createHarness();
    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'storage-durable');
    assert.notEqual(check?.status, 'FAIL');
    h.close();
  });
});

/* ------------------------------------------------ deployment manifests ---- */

describe('deployment manifests', () => {
  it('keeps the environment template honest about the deployment variables', () => {
    // Covered generally by the env-template test; named here because these
    // three are the ones a deployment gets wrong.
    const env = testEnv();
    assert.equal(typeof env.httpHost, 'string');
    assert.equal(typeof env.httpPort, 'number');
    assert.equal(typeof env.runnerEnabled, 'boolean');
  });
});

/* ---------------------------------------------------- SIGTERM, for real --- */

describe('SIGTERM, as a platform actually sends it', () => {
  /**
   * A real child process, not a simulated signal.
   *
   * The in-process tests above prove the supervisor's logic. They cannot prove
   * the thing that actually breaks a deployment: that the built entrypoint
   * installs the handler, shuts down inside the platform's grace window, and
   * exits ZERO. A non-zero exit on a deliberate stop reads as a crash to a
   * supervisor and produces a restart loop out of a clean shutdown.
   */
  const root = (() => {
    let dir = fileURLToPath(new URL('.', import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
    throw new Error('could not locate the repository root from the test file');
  })();
  const entry = join(root, 'dist', 'src', 'cli', 'northstar.js');

  it('shuts down gracefully and exits 0', async (t) => {
    if (!existsSync(entry)) return t.skip('built entrypoint not present');

    const dir = mkdtempSync(join(tmpdir(), 'northstar-sigterm-'));
    try {
      const child = spawn(process.execPath, [entry, 'run'], {
        env: {
          ...process.env,
          NORTHSTAR_USE_FIXTURES: 'true',
          NORTHSTAR_DB_PATH: join(dir, 'db.sqlite'),
          // Port 0 lets the OS choose, so a busy port cannot make this flaky.
          NORTHSTAR_PORT: '0',
          NORTHSTAR_HOST: '127.0.0.1',
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        output += c;
      });
      child.stderr.on('data', (c: string) => {
        output += c;
      });

      // Wait for it to be genuinely up before stopping it, so this tests
      // shutdown rather than a race against startup.
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`never started:\n${output}`)), 30_000);
        const poll = setInterval(() => {
          if (output.includes('X Bot Console listening')) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
          }
        }, 50);
      });

      const exited = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code));
      });
      child.kill('SIGTERM');

      const code = await Promise.race([
        exited,
        new Promise<number | null>((_r, reject) =>
          setTimeout(() => reject(new Error(`did not exit within the grace window:\n${output}`)), 30_000),
        ),
      ]);

      assert.equal(code, 0, `a deliberate stop must exit 0, not look like a crash:\n${output}`);
      assert.match(output, /END OF DAY|END-OF-DAY|End of day/i);
      // The supervisor must not close the database out from under the report.
      assert.doesNotMatch(output, /database is not open/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
