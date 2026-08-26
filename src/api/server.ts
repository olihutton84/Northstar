/**
 * X Bot Console HTTP surface.
 *
 * The local monitoring UI and JSON API for THIS bot. Distinct from the
 * Northstar Platform's own Trading Lab, which lives in the Platform repo.
 *
 * Serves the X Signal Bot dashboard and its JSON API. Built on node:http with
 * no framework so the whole system stays dependency-free.
 *
 * Security note: credentials are never read here and never serialised into any
 * response. The API exposes decisions and evidence, not keys.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../core/index.js';
import { formatSignedUsd, formatUsd } from '../core/index.js';
import type { NorthstarApp } from '../app.js';
import { buildDashboard } from './dashboard.js';
import { buildObservability } from './observability.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ApiServerOptions {
  app: NorthstarApp;
  port: number;
  /** Interface to bind. Defaults to loopback; containers pass 0.0.0.0. */
  host?: string;
  logger: Logger;
  /** Identity recorded against approvals made through this server. */
  approverId: string;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, params: string[], body: unknown) => Promise<void> | void;
}

export class ApiServer {
  private readonly app: NorthstarApp;
  private readonly port: number;
  private readonly host: string;
  private readonly log: Logger;
  private readonly approverId: string;
  private readonly routes: Route[] = [];
  /**
   * The port actually bound.
   *
   * Not the same as the requested port: port 0 asks the OS to choose one, and
   * the caller needs to know which. Null until `listen()` resolves.
   */
  private bound: number | null = null;
  private server: Server | null = null;
  private uiCache: { html: string; css: string; js: string } | null = null;

  constructor(opts: ApiServerOptions) {
    this.app = opts.app;
    this.port = opts.port;
    this.host = opts.host ?? '127.0.0.1';
    this.log = opts.logger.child('api');
    this.approverId = opts.approverId;
    this.registerRoutes();
  }

  async listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        void this.handle(req, res);
      });
      // The host is explicit. Omitting it makes Node bind every interface,
      // which would put the kill-switch and approval routes on the local
      // network from a developer's laptop.
      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address();
        this.bound = typeof addr === 'object' && addr !== null ? addr.port : this.port;
        this.log.info('X Bot Console listening', {
          host: this.host,
          port: this.bound,
          url: `http://${this.host === '0.0.0.0' ? 'localhost' : this.host}:${this.bound}`,
        });
        resolve();
      });
    });
  }

  /** The port actually bound, once listening. */
  get boundPort(): number | null {
    return this.bound;
  }

  /**
   * Close the console.
   *
   * `server.close()` alone waits for every open connection to end, and a
   * browser tab left on the dashboard holds a keep-alive socket indefinitely —
   * which would hang shutdown until the platform lost patience and killed the
   * container mid-task. Idle sockets are closed first, and anything still
   * hanging on after a short grace is closed outright.
   */
  async close(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.bound = null;

    server.closeIdleConnections();
    await new Promise<void>((resolve) => {
      const forced = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, 3000);
      forced.unref?.();
      server.close(() => {
        clearTimeout(forced);
        resolve();
      });
    });
  }

  /* ------------------------------------------------------------ routes */

  private registerRoutes(): void {
    const r = (method: string, pattern: RegExp, handler: Route['handler']): void => {
      this.routes.push({ method, pattern, handler });
    };

    /* --- UI ------------------------------------------------------------ */
    r('GET', /^\/$/, (_req, res) => this.sendHtml(res, this.ui().html));
    r('GET', /^\/app\.css$/, (_req, res) => this.sendText(res, this.ui().css, 'text/css'));
    r('GET', /^\/app\.js$/, (_req, res) => this.sendText(res, this.ui().js, 'text/javascript'));

    /* --- dashboard ------------------------------------------------------ */
    r('GET', /^\/api\/dashboard$/, async (_req, res) => {
      this.sendJson(res, 200, await buildDashboard(this.app));
    });

    /* --- observability --------------------------------------------------- */
    r('GET', /^\/api\/observability$/, (_req, res) => {
      this.sendJson(res, 200, buildObservability(this.app));
    });

    /* --- signal audit ----------------------------------------------------- */
    r('GET', /^\/api\/signals\/([\w-]+)\/audit$/, (_req, res, params) => {
      const view = this.app.audit.audit(params[0]!);
      if (!view) return this.sendJson(res, 404, { error: 'Signal not found' });
      this.sendJson(res, 200, view);
    });

    /* --- reconciliation (read-only) --------------------------------------- */
    r('GET', /^\/api\/reconcile$/, async (_req, res) => {
      this.sendJson(res, 200, await this.app.reconciliation.reconcile());
    });

    /* --- readiness (read-only; never submits an order) -------------------- */
    r('GET', /^\/api\/readiness$/, async (_req, res) => {
      const report = await this.app.readiness.run();
      this.sendJson(res, report.overall === 'PASS' ? 200 : 503, report);
    });

    r('GET', /^\/api\/health$/, (_req, res) => {
      const state = this.app.health.state();
      this.sendJson(res, 200, {
        ...state,
        ledgerIntegrity: this.app.ledger.verifyIntegrity(),
        stateIntegrity: this.app.health.verifyStateIntegrity(),
      });
    });

    /* --- signals -------------------------------------------------------- */
    r('GET', /^\/api\/signals$/, (req, res) => {
      const limit = Number(this.query(req).get('limit') ?? 50);
      this.sendJson(res, 200, this.app.store.signals.recent(limit));
    });

    r('GET', /^\/api\/signals\/([\w-]+)$/, (_req, res, params) => {
      const signal = this.app.store.signals.byId(params[0]!);
      if (!signal) return this.sendJson(res, 404, { error: 'Signal not found' });
      const events = this.app.store.events.byIds(signal.triggeringEventIds);
      this.sendJson(res, 200, { signal, events });
    });

    /* --- proposals & approvals ------------------------------------------ */
    r('GET', /^\/api\/proposals$/, (req, res) => {
      const limit = Number(this.query(req).get('limit') ?? 50);
      const proposals = this.app.store.proposals.recent(limit).map((p) => ({
        ...p,
        risk: p.riskDecisionId ? this.app.store.risk.byId(p.riskDecisionId) : null,
        approval: this.app.store.approvals.latestForProposal(p.proposalId),
      }));
      this.sendJson(res, 200, proposals);
    });

    r('GET', /^\/api\/proposals\/([\w-]+)\/approval$/, async (_req, res, params) => {
      const proposalId = params[0]!;
      const proposal = this.app.store.proposals.byId(proposalId);
      if (!proposal) return this.sendJson(res, 404, { error: 'Proposal not found' });
      const quote = await this.app.marketData.getQuote(proposal.ticker).catch(() => null);
      const presentation = this.app.approvals.present(proposalId, quote?.price ?? null);
      if (!presentation) return this.sendJson(res, 404, { error: 'Proposal not found' });
      this.sendJson(res, 200, presentation);
    });

    r('POST', /^\/api\/proposals\/([\w-]+)\/approve$/, async (_req, res, params, body) => {
      const b = (body ?? {}) as { approvalFingerprint?: string; note?: string; approverId?: string };
      if (!b.approvalFingerprint) {
        return this.sendJson(res, 400, {
          error: 'approvalFingerprint is required so the approval binds to the exact terms displayed',
        });
      }
      const result = await this.app.approvals.approve(
        params[0]!,
        b.approverId ?? this.approverId,
        b.approvalFingerprint,
        b.note ?? '',
      );
      this.sendJson(res, result.ok ? 200 : 409, result);
    });

    r('POST', /^\/api\/proposals\/([\w-]+)\/reject$/, (_req, res, params, body) => {
      const b = (body ?? {}) as { note?: string; approverId?: string };
      const result = this.app.approvals.reject(params[0]!, b.approverId ?? this.approverId, b.note ?? '');
      this.sendJson(res, result.ok ? 200 : 404, result);
    });

    /* --- positions, orders, ledger --------------------------------------- */
    r('GET', /^\/api\/positions$/, (_req, res) => {
      this.sendJson(res, 200, this.app.store.positions.all(this.app.spec.strategyId));
    });

    r('GET', /^\/api\/orders$/, (req, res) => {
      const limit = Number(this.query(req).get('limit') ?? 50);
      this.sendJson(res, 200, this.app.store.orders.recent(limit));
    });

    r('GET', /^\/api\/ledger$/, (_req, res) => {
      const ledger = this.app.ledger.get();
      this.sendJson(res, 200, {
        ledger,
        formatted: {
          startingCapital: formatUsd(ledger.startingCapitalCents),
          cash: formatUsd(ledger.cashCents),
          reserved: formatUsd(ledger.reservedCents),
          positions: formatUsd(ledger.positionsValueCents),
          unrealisedPnl: formatSignedUsd(ledger.unrealisedPnlCents),
          realisedPnl: formatSignedUsd(ledger.realisedPnlCents),
          equity: formatUsd(ledger.equityCents),
        },
        entries: this.app.ledger.entries(50),
        integrity: this.app.ledger.verifyIntegrity(),
      });
    });

    r('GET', /^\/api\/equity-curve$/, (_req, res) => {
      this.sendJson(res, 200, this.app.store.ledger.equityCurve(this.app.spec.strategyId));
    });

    /* --- analytics -------------------------------------------------------- */
    r('GET', /^\/api\/analytics$/, (req, res) => {
      const horizon = (this.query(req).get('horizon') ?? '1d') as '1h' | '1d' | '1w' | '1m';
      this.sendJson(res, 200, {
        signals: this.app.analytics.report(horizon),
        sources: this.app.analytics.sourcePerformance(horizon),
        survival: this.app.survival.compute(),
      });
    });

    r('GET', /^\/api\/decision-log$/, (req, res) => {
      const q = this.query(req);
      const correlationId = q.get('correlationId');
      this.sendJson(
        res,
        200,
        correlationId
          ? this.app.store.log.byCorrelation(correlationId)
          : this.app.store.log.recent(Number(q.get('limit') ?? 200)),
      );
    });

    /* --- feed ------------------------------------------------------------- */
    r('GET', /^\/api\/events$/, (req, res) => {
      const limit = Number(this.query(req).get('limit') ?? 50);
      const events = this.app.store.events.recent(limit).map((e) => ({
        ...e,
        filter: this.app.store.filters.byEvent(e.eventId),
        resolutions: this.app.store.resolutions.byEvent(e.eventId),
      }));
      this.sendJson(res, 200, events);
    });

    /* --- controls --------------------------------------------------------- */
    r('POST', /^\/api\/control\/cycle$/, async (_req, res) => {
      const report = await this.app.runner.runCycle();
      this.sendJson(res, 200, report);
    });

    r('POST', /^\/api\/control\/kill$/, async (_req, res, _params, body) => {
      const b = (body ?? {}) as { reason?: string; liquidate?: boolean };
      // Liquidation is a separate, explicit confirmation. Absent it, positions
      // are left alone and only new risk is stopped.
      const strategy = this.app.health.kill(b.reason ?? 'Manual KILL BOT from the X Bot Console', b.liquidate === true);
      const cancelled = await this.app.orderRouter.cancelOpenOrders(this.app.spec.strategyId);
      this.sendJson(res, 200, { strategy, cancelled, liquidate: b.liquidate === true });
    });

    /* --- manual X ingest (the temporary experiment) ---------------------- */

    r('GET', /^\/api\/manual$/, (_req, res) => {
      this.sendJson(res, 200, {
        window: this.app.manualWindow(),
        permission: this.app.manualIngestPermission(),
        counts: this.app.store.manual.counts(),
        observations: this.app.store.manual.recent(50),
      });
    });

    /*
     * Submit posts. Accepts one, several, or a pasted blob.
     *
     * This fills a queue; it does not start trading and it does not open the
     * experiment. Both of those are separate, explicit acts.
     */
    r('POST', /^\/api\/manual\/posts$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { post?: unknown; posts?: unknown[]; batch?: string };
      const by = this.approverId;

      if (typeof b.batch === 'string') {
        return this.sendJson(res, 200, this.app.manualIngest.submitBatch(b.batch, by));
      }
      if (Array.isArray(b.posts)) {
        return this.sendJson(res, 200, this.app.manualIngest.submitMany(b.posts as never[], by));
      }
      if (b.post && typeof b.post === 'object') {
        return this.sendJson(res, 200, this.app.manualIngest.submit(b.post as never, by));
      }
      return this.sendJson(res, 400, {
        error: 'Send { post }, { posts: [...] } or { batch: "<pasted text>" }.',
      });
    });

    r('POST', /^\/api\/manual\/start$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { note?: string };
      const result = this.app.manualIngest.startExperiment(this.approverId, b.note ?? '');
      this.sendJson(res, result.started ? 200 : 409, {
        ...result,
        // Said explicitly, because opening a window and starting a bot are
        // easy to conflate and only one of them places orders.
        tradingStarted: false,
      });
    });

    r('POST', /^\/api\/manual\/stop$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { reason?: string };
      const result = this.app.manualIngest.stopExperiment(b.reason ?? 'Stopped from the X Bot Console');
      this.sendJson(res, result.stopped ? 200 : 409, result);
    });

    /*
     * PAUSE NEW ENTRIES. Not a stop.
     *
     * Open orders are deliberately NOT cancelled and positions are deliberately
     * NOT closed: an order already working and a position already held keep
     * being managed, exits included. This closes the front door only. The
     * emergency controls are `kill` above.
     */
    r('POST', /^\/api\/control\/pause$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { reason?: string };
      const strategy = this.app.health.pauseByOperator(
        b.reason ?? 'Manual pause from the X Bot Console');
      this.sendJson(res, 200, {
        strategy,
        entriesBlocked: true,
        exitsStillRunning: true,
        note: 'New entries are blocked. Exits, fills and reconciliation continue.',
      });
    });

    r('POST', /^\/api\/control\/resume$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { note?: string };
      this.sendJson(res, 200, this.app.health.resume(b.note ?? 'Resumed from the X Bot Console'));
    });

    r('POST', /^\/api\/control\/mode$/, (_req, res, _params, body) => {
      const b = (body ?? {}) as { mode?: string };
      if (b.mode !== 'PAPER' && b.mode !== 'LIVE') {
        return this.sendJson(res, 400, { error: "mode must be 'PAPER' or 'LIVE'" });
      }
      if (b.mode === 'LIVE' && this.app.broker.mode !== 'LIVE') {
        return this.sendJson(res, 409, {
          error:
            'The running broker is in PAPER mode. Restart Northstar with NORTHSTAR_LIVE_TRADING_ENABLED=true and ' +
            'LIVE credentials to trade live; the mode flag alone does not switch broker credentials.',
        });
      }
      this.sendJson(res, 200, this.app.setMode(b.mode));
    });
  }

  /* --------------------------------------------------------- plumbing */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${this.port}`);
    const method = req.method ?? 'GET';

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      try {
        const body = method === 'POST' ? await this.readBody(req) : null;
        await route.handler(req, res, match.slice(1), body);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        this.log.error('request failed', { path: url.pathname, detail });
        if (!res.headersSent) this.sendJson(res, 500, { error: detail });
      }
      return;
    }

    this.sendJson(res, 404, { error: `No route for ${method} ${url.pathname}` });
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 1_000_000) throw new Error('Request body too large');
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('Request body is not valid JSON');
    }
  }

  private query(req: IncomingMessage): URLSearchParams {
    return new URL(req.url ?? '/', `http://localhost:${this.port}`).searchParams;
  }

  private sendJson(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  private sendHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  private sendText(res: ServerResponse, text: string, contentType: string): void {
    res.writeHead(200, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
    res.end(text);
  }

  private ui(): { html: string; css: string; js: string } {
    if (this.uiCache) return this.uiCache;
    // dist/src/api -> ../../../src/ui keeps the assets readable as source.
    const uiDir = join(here, '..', '..', '..', 'src', 'ui');
    this.uiCache = {
      html: readFileSync(join(uiDir, 'index.html'), 'utf8'),
      css: readFileSync(join(uiDir, 'app.css'), 'utf8'),
      js: readFileSync(join(uiDir, 'app.js'), 'utf8'),
    };
    return this.uiCache;
  }
}
