/**
 * Accepting operator-supplied X posts, and running the experiment window.
 *
 * Every submission is validated, canonicalised and deduplicated before it is
 * stored, and each outcome is reported individually — a ten-post paste with one
 * bad line should store nine and say precisely what was wrong with the tenth,
 * not reject the batch or, worse, silently keep eight.
 *
 * Submission is deliberately separate from trading. Pasting posts fills a
 * queue; it does not start the bot, and it does not open the experiment window.
 * Both of those are explicit acts.
 */
import type { Clock, Logger } from '../core/index.js';
import type { ManualObservation } from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import {
  MANUAL_INGEST_MAX_DAYS,
  expiryFor,
  resolveWindow,
  type ManualIngestWindow,
} from '../config/manualIngest.js';
import { parseManualBatch, parseManualPost, type ManualPostInput } from './manualX.js';

export type SubmitOutcome =
  | { status: 'ACCEPTED'; observation: ManualObservation }
  | { status: 'DUPLICATE'; postId: string; url: string; firstSeenAt: string }
  | { status: 'REJECTED'; url: string; problems: string[] };

export interface SubmitReport {
  accepted: number;
  duplicates: number;
  rejected: number;
  outcomes: SubmitOutcome[];
  /** True when the window is closed; submissions are stored but unusable. */
  windowClosed: boolean;
  window: ManualIngestWindow;
}

export class ManualIngestService {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    logger: Logger,
    private readonly strategyId: string,
  ) {
    this.log = logger.child('manual-ingest');
  }

  window(): ManualIngestWindow {
    return resolveWindow(this.store.manualWindows.latest(this.strategyId), this.clock);
  }

  /**
   * Open the experiment.
   *
   * Explicit by design (nothing starts it implicitly, and pasting posts does
   * not), and it does NOT start trading — the runner is started separately.
   * Opening the window only makes manual posts count as real data.
   */
  startExperiment(startedBy: string, note: string): { started: boolean; window: ManualIngestWindow; detail: string } {
    const current = this.window();
    if (current.active) {
      return {
        started: false,
        window: current,
        detail: `A manual-X experiment is already running until ${current.expiresAt}.`,
      };
    }

    const at = this.clock.nowIso();
    this.store.manualWindows.start(this.strategyId, at, startedBy, note);
    const window = this.window();

    this.store.log.append({
      correlationId: `manual-window-${at}`,
      strategyId: this.strategyId,
      stage: 'SYSTEM',
      subjectId: this.strategyId,
      summary: `Manual-X experiment opened for ${MANUAL_INGEST_MAX_DAYS} days`,
      payload: { startedBy, note, startedAt: at, expiresAt: expiryFor(at) },
    });
    this.log.warn('manual-X experiment opened', {
      startedBy, expiresAt: window.expiresAt, days: MANUAL_INGEST_MAX_DAYS,
    });

    return {
      started: true,
      window,
      detail:
        `Manual-X experiment open until ${window.expiresAt}. Operator-supplied posts now count as ` +
        'real data in PAPER. Trading is NOT started by this; start the runner separately.',
    };
  }

  /** Close the experiment early. Expiry needs no action; this is for stopping sooner. */
  stopExperiment(reason: string): { stopped: boolean; window: ManualIngestWindow } {
    const current = this.window();
    if (!current.active) return { stopped: false, window: current };

    const at = this.clock.nowIso();
    this.store.manualWindows.stop(this.strategyId, at, reason);
    this.store.log.append({
      correlationId: `manual-window-${at}`,
      strategyId: this.strategyId,
      stage: 'SYSTEM',
      subjectId: this.strategyId,
      summary: 'Manual-X experiment closed',
      payload: { reason, at },
    });
    this.log.warn('manual-X experiment closed', { reason });
    return { stopped: true, window: this.window() };
  }

  /** Submit one post. */
  submit(input: ManualPostInput, submittedBy: string): SubmitReport {
    return this.submitMany([input], submittedBy);
  }

  /** Submit several posts at once. */
  submitMany(inputs: ManualPostInput[], submittedBy: string): SubmitReport {
    const capturedAt = this.clock.nowIso();
    return this.record(inputs.map((i) => parseManualPost(i, capturedAt)), submittedBy, capturedAt);
  }

  /** Submit a pasted batch: JSON array, or `url | timestamp | text` per line. */
  submitBatch(raw: string, submittedBy: string): SubmitReport {
    const capturedAt = this.clock.nowIso();
    return this.record(parseManualBatch(raw, capturedAt), submittedBy, capturedAt);
  }

  private record(
    parsed: ReturnType<typeof parseManualPost>[],
    submittedBy: string,
    capturedAt: string,
  ): SubmitReport {
    const outcomes: SubmitOutcome[] = [];

    for (const result of parsed) {
      if (!result.ok) {
        outcomes.push({ status: 'REJECTED', url: result.submittedUrl, problems: result.problems });
        continue;
      }
      const post = result.post;
      const observation: ManualObservation = {
        observationId: post.observationId,
        postId: post.postId,
        canonicalUrl: post.canonicalUrl,
        submittedUrl: post.submittedUrl,
        handle: post.handle,
        displayName: post.displayName,
        text: post.text,
        postedAt: post.postedAt,
        capturedAt,
        submittedBy,
        source: 'X_MANUAL',
        provenance: 'MANUAL_OPERATOR_SUPPLIED',
        engagement: {
          likes: post.likes,
          reposts: post.reposts,
          replies: post.replies,
          quotes: post.quotes,
          impressions: post.impressions,
        },
        followerCount: post.followerCount,
        verified: post.verified,
        note: post.note,
        status: 'PENDING',
        ingestedAt: null,
        eventId: null,
      };

      const added = this.store.manual.add(observation);
      if (added.existing) {
        // Reported, not silently swallowed: an operator who pastes the same
        // post twice should be told, or they will assume it counted twice.
        outcomes.push({
          status: 'DUPLICATE',
          postId: post.postId,
          url: post.canonicalUrl,
          firstSeenAt: added.existing.capturedAt,
        });
        continue;
      }
      outcomes.push({ status: 'ACCEPTED', observation });
    }

    const window = this.window();
    const report: SubmitReport = {
      accepted: outcomes.filter((o) => o.status === 'ACCEPTED').length,
      duplicates: outcomes.filter((o) => o.status === 'DUPLICATE').length,
      rejected: outcomes.filter((o) => o.status === 'REJECTED').length,
      outcomes,
      windowClosed: !window.active,
      window,
    };

    this.log.info('manual posts submitted', {
      submittedBy,
      accepted: report.accepted,
      duplicates: report.duplicates,
      rejected: report.rejected,
      windowActive: window.active,
    });
    return report;
  }
}
