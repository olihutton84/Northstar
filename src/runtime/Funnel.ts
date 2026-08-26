/**
 * The day's funnel.
 *
 * One number per stage, from the request that started it to the trade that
 * ended it:
 *
 *   X requests → posts received → posts stored → posts accepted →
 *   material events → candidates → signals → proposals → risk-approved →
 *   orders → fills → positions opened → positions closed
 *
 * The point is diagnosis by subtraction. "Zero trades" is not one condition,
 * it is thirteen different ones, and the funnel says which: no posts at all is
 * a credential or query problem; posts but no accepted posts is a filter that
 * is too tight; signals but no proposals is a threshold; proposals but no
 * orders is risk. Without this the operator is left guessing at the end of a
 * quiet day.
 *
 * A funnel that narrows to zero is a NORMAL outcome, not a fault. Nothing here
 * is a target, and no stage of the bot reads these numbers back.
 */
import type { Clock } from '../core/index.js';
import type { Store } from '../persistence/store.js';
import type { ApiMeter } from './ApiMeter.js';

export interface FunnelStage {
  stage: string;
  count: number;
  /** What a drop to zero here would mean. */
  meaning: string;
}

export interface FunnelReport {
  fromIso: string;
  toIso: string;
  stages: FunnelStage[];
  /** The first stage that reached zero, if any. */
  stalledAt: string | null;
  /** Plain-language reading of where the day stopped. */
  narrative: string;
  api: {
    provider: string;
    requests: number;
    successes: number;
    rateLimited: number;
    errors: number;
  }[];
}

export class FunnelService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly strategyId: string,
    private readonly meter: ApiMeter,
  ) {}

  /** Start of the current UTC day. */
  private dayStart(): string {
    return `${this.clock.nowIso().slice(0, 10)}T00:00:00.000Z`;
  }

  private count(sql: string, ...params: (string | number)[]): number {
    const row = this.store.db.get(sql, ...params);
    const value = row?.['n'];
    return typeof value === 'number' ? value : Number(value ?? 0);
  }

  report(fromIso = this.dayStart(), toIso = this.clock.nowIso()): FunnelReport {
    const api = this.meter.today();
    const xRequests = api.find((a) => a.provider === 'x')?.requests ?? 0;

    // Posts received includes duplicates the vendor returned again; posts
    // stored is what was new. The gap between them is what the cursor saves.
    const postsReceived = this.store.log
      .byStage(this.strategyId, 'INGEST', 500)
      .filter((e) => e.at >= fromIso && e.at <= toIso)
      .reduce((sum, e) => sum + Number((e.payload as Record<string, unknown>)['fetched'] ?? 0), 0);

    const postsStored = this.count(
      'SELECT COUNT(*) AS n FROM social_events WHERE captured_at >= ? AND captured_at <= ?',
      fromIso, toIso,
    );

    const postsAccepted = this.count(
      `SELECT COUNT(*) AS n FROM filter_results
        WHERE created_at >= ? AND created_at <= ? AND verdict IN ('ACCEPT','DOWNWEIGHT')`,
      fromIso, toIso,
    );

    // "Material" here means it survived filtering AND resolved to a security
    // with enough confidence to be tradable evidence.
    const materialEvents = this.count(
      `SELECT COUNT(DISTINCT r.event_id) AS n FROM ticker_resolutions r
         JOIN filter_results f ON f.event_id = r.event_id
        WHERE r.created_at >= ? AND r.created_at <= ?
          AND f.verdict IN ('ACCEPT','DOWNWEIGHT')`,
      fromIso, toIso,
    );

    const signals = this.count(
      'SELECT COUNT(*) AS n FROM signals WHERE strategy_id = ? AND generated_at >= ? AND generated_at <= ?',
      this.strategyId, fromIso, toIso,
    );

    const proposals = this.count(
      'SELECT COUNT(*) AS n FROM trade_proposals WHERE strategy_id = ? AND created_at >= ? AND created_at <= ?',
      this.strategyId, fromIso, toIso,
    );

    const riskApproved = this.count(
      `SELECT COUNT(*) AS n FROM risk_decisions
        WHERE strategy_id = ? AND approved = 1 AND decided_at >= ? AND decided_at <= ?`,
      this.strategyId, fromIso, toIso,
    );

    const orders = this.count(
      `SELECT COUNT(*) AS n FROM orders
        WHERE strategy_id = ? AND intent = 'ENTRY' AND submitted_at >= ? AND submitted_at <= ?`,
      this.strategyId, fromIso, toIso,
    );

    const fills = this.count(
      `SELECT COUNT(*) AS n FROM fills f JOIN orders o ON o.order_id = f.order_id
        WHERE o.strategy_id = ? AND f.filled_at >= ? AND f.filled_at <= ?`,
      this.strategyId, fromIso, toIso,
    );

    const opened = this.count(
      'SELECT COUNT(*) AS n FROM positions WHERE strategy_id = ? AND opened_at >= ? AND opened_at <= ?',
      this.strategyId, fromIso, toIso,
    );

    const closed = this.count(
      `SELECT COUNT(*) AS n FROM positions
        WHERE strategy_id = ? AND closed_at IS NOT NULL AND closed_at >= ? AND closed_at <= ?`,
      this.strategyId, fromIso, toIso,
    );

    const stages: FunnelStage[] = [
      { stage: 'X requests', count: xRequests, meaning: 'the bot never reached X — credentials, network or a halted loop' },
      { stage: 'Posts received', count: postsReceived, meaning: 'X returned nothing — the query matched no posts in the window' },
      { stage: 'Posts stored (new)', count: postsStored, meaning: 'every post was already seen — the cursor is working and nothing is new' },
      { stage: 'Posts accepted', count: postsAccepted, meaning: 'every post was filtered out as noise, off-universe or unusable' },
      { stage: 'Material events', count: materialEvents, meaning: 'nothing resolved to a security in the permitted universe' },
      { stage: 'Signals generated', count: signals, meaning: 'evidence existed but never cleared the bar to be scored as a signal' },
      { stage: 'Proposals built', count: proposals, meaning: 'signals were too weak, not long, or not sizeable with available cash' },
      { stage: 'Risk approved', count: riskApproved, meaning: 'the risk engine rejected every proposal — read the failed checks' },
      { stage: 'Entry orders', count: orders, meaning: 'approved proposals never reached the broker — market closed, or awaiting LIVE approval' },
      { stage: 'Fills', count: fills, meaning: 'orders were submitted but nothing filled' },
      { stage: 'Positions opened', count: opened, meaning: 'fills were not turned into positions — check reconciliation' },
      { stage: 'Positions closed', count: closed, meaning: 'nothing exited today' },
    ];

    const stalled = stages.find((s) => s.count === 0) ?? null;

    return {
      fromIso,
      toIso,
      stages,
      stalledAt: stalled?.stage ?? null,
      narrative: stalled
        ? `The funnel reached zero at "${stalled.stage}": ${stalled.meaning}.`
        : 'Every stage produced at least one item.',
      api: api.map((a) => ({
        provider: a.provider,
        requests: a.requests,
        successes: a.successes,
        rateLimited: a.rateLimited,
        errors: a.unauthorized + a.forbidden + a.timeouts + a.serverErrors + a.otherErrors,
      })),
    };
  }

  /** Fixed-width text rendering for the CLI and the end-of-day report. */
  render(report: FunnelReport): string {
    const width = Math.max(...report.stages.map((s) => s.stage.length));
    const lines = report.stages.map((s) => `  ${s.stage.padEnd(width)}  ${String(s.count).padStart(6)}`);
    return [
      `Funnel ${report.fromIso.slice(0, 16).replace('T', ' ')} → ${report.toIso.slice(0, 16).replace('T', ' ')} UTC`,
      ...lines,
      '',
      `  ${report.narrative}`,
    ].join('\n');
  }
}
