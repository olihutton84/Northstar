/**
 * Parsing and validating an operator-supplied X post.
 *
 * The whole value of manual ingestion is that it is traceable back to a real,
 * public post. That makes the URL the load-bearing field: it is the identity,
 * the deduplication key and the audit anchor all at once. So it is parsed
 * strictly rather than stored as typed — a URL that cannot be resolved to a
 * canonical post id cannot be deduplicated, and an observation that cannot be
 * deduplicated will eventually be counted twice as independent corroboration
 * of itself.
 *
 * Everything else is validated for the same reason the pipeline validates
 * vendor data: hand-typed input is not more trustworthy than an API, it is
 * less.
 */
import { deterministicId } from '../core/index.js';

/** Hosts that serve X posts. Anything else is not an X post. */
const X_HOSTS = new Set([
  'x.com', 'www.x.com', 'mobile.x.com',
  'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com',
  'fxtwitter.com', 'vxtwitter.com', 'nitter.net',
]);

export interface ManualPostInput {
  /** The X post URL. Required: it is the identity and the audit anchor. */
  url: string;
  text: string;
  /** Author handle, with or without a leading @. */
  handle?: string;
  displayName?: string;
  /** When the post was published. */
  postedAt?: string;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  impressions?: number;
  followerCount?: number;
  verified?: boolean;
  note?: string;
}

export interface ParsedManualPost {
  /** Stable id, derived from the canonical post id so re-pasting collides. */
  observationId: string;
  /** The numeric X status id. The deduplication key. */
  postId: string;
  /** The URL rebuilt in canonical form, so two spellings compare equal. */
  canonicalUrl: string;
  /** Exactly what the operator supplied, kept for the audit trail. */
  submittedUrl: string;
  handle: string;
  displayName: string;
  text: string;
  postedAt: string;
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  impressions: number;
  followerCount: number | null;
  verified: boolean;
  note: string;
}

export type ParseResult =
  | { ok: true; post: ParsedManualPost }
  | { ok: false; problems: string[]; submittedUrl: string };

/**
 * Pull the canonical status id and handle out of an X URL.
 *
 * Tolerant about the things that do not change which post it is — scheme, www,
 * mobile subdomain, tracking parameters, a `/photo/1` suffix, a mirror host —
 * and strict about everything else.
 */
export function parseXUrl(raw: string): { postId: string; handle: string | null } | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;

  // /<handle>/status/<id>  — also /statuses/, and possibly /photo/1 after it.
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const statusAt = segments.findIndex((s) => s === 'status' || s === 'statuses');
  if (statusAt === -1) return null;

  const postId = segments[statusAt + 1];
  if (postId === undefined || !/^\d+$/.test(postId)) return null;

  const handle = statusAt > 0 ? (segments[statusAt - 1] ?? null) : null;
  return { postId, handle: handle === null ? null : handle.replace(/^@/, '') };
}

/** The one spelling of a post's URL that everything else compares against. */
export function canonicalXUrl(handle: string, postId: string): string {
  return `https://x.com/${handle}/status/${postId}`;
}

/**
 * Validate one operator-supplied post.
 *
 * Reports EVERY problem rather than the first, because the input arrives in
 * batches and fixing them one round-trip at a time is how a ten-post paste
 * becomes ten pastes.
 */
export function parseManualPost(input: ManualPostInput, capturedAt: string): ParseResult {
  const problems: string[] = [];
  const submittedUrl = (input.url ?? '').trim();

  const parsed = parseXUrl(submittedUrl);
  if (!parsed) {
    problems.push(
      submittedUrl === ''
        ? 'A post URL is required: it is how the observation is deduplicated and audited.'
        : `Not a recognisable X post URL: ${submittedUrl}. Expected https://x.com/<handle>/status/<id>.`,
    );
  }

  const text = (input.text ?? '').trim();
  if (text === '') problems.push('The post text is required.');
  else if (text.length > 4000) problems.push(`The post text is ${text.length} characters; 4000 is the ceiling.`);

  const handle = (input.handle ?? parsed?.handle ?? '').trim().replace(/^@/, '');
  if (handle === '') {
    problems.push('An author handle is required, either supplied or present in the URL.');
  } else if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    problems.push(`"${handle}" is not a valid X handle.`);
  }

  // A missing timestamp is NOT defaulted to now: the difference between a post
  // from two minutes ago and one from two days ago is most of its signal, and
  // guessing it would silently manufacture urgency the operator never claimed.
  const postedAtRaw = (input.postedAt ?? '').trim();
  let postedAt = '';
  if (postedAtRaw === '') {
    problems.push('A published timestamp is required; it is not defaulted, because post age drives the signal.');
  } else {
    const t = new Date(postedAtRaw);
    if (Number.isNaN(t.getTime())) {
      problems.push(`"${postedAtRaw}" is not a parsable timestamp. Use ISO 8601, e.g. 2026-08-26T14:03:00Z.`);
    } else if (t.getTime() > new Date(capturedAt).getTime() + 60_000) {
      problems.push(`The post is dated ${t.toISOString()}, which is in the future.`);
    } else {
      postedAt = t.toISOString();
    }
  }

  const metric = (value: number | undefined, name: string): number => {
    if (value === undefined) return 0;
    if (!Number.isFinite(value) || value < 0) {
      problems.push(`${name} must be a non-negative number.`);
      return 0;
    }
    return Math.floor(value);
  };
  const likes = metric(input.likes, 'likes');
  const reposts = metric(input.reposts, 'reposts');
  const replies = metric(input.replies, 'replies');
  const quotes = metric(input.quotes, 'quotes');
  const impressions = metric(input.impressions, 'impressions');
  const followerCount = input.followerCount === undefined ? null : metric(input.followerCount, 'followerCount');

  if (problems.length > 0 || !parsed) return { ok: false, problems, submittedUrl };

  const canonicalUrl = canonicalXUrl(handle, parsed.postId);
  return {
    ok: true,
    post: {
      // Derived from the post id alone, so the same post pasted in two
      // different URL spellings produces the same observation.
      observationId: deterministicId('mobs', parsed.postId),
      postId: parsed.postId,
      canonicalUrl,
      submittedUrl,
      handle,
      displayName: (input.displayName ?? '').trim() || handle,
      text,
      postedAt,
      likes,
      reposts,
      replies,
      quotes,
      impressions,
      followerCount,
      verified: input.verified === true,
      note: (input.note ?? '').trim(),
    },
  };
}

/**
 * Parse a pasted batch.
 *
 * Accepts either JSON (an array of objects) or the line-oriented form a person
 * actually produces when copying from a browser:
 *
 *   <url> | <ISO timestamp> | <text>
 *
 * A bare URL on its own line is accepted too and reported as incomplete rather
 * than silently dropped, so a paste that is half-finished says so.
 */
export function parseManualBatch(raw: string, capturedAt: string): ParseResult[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return [{
        ok: false,
        problems: [`The batch looks like JSON but did not parse: ${e instanceof Error ? e.message : String(e)}`],
        submittedUrl: '',
      }];
    }
    if (!Array.isArray(parsed)) {
      return [{ ok: false, problems: ['A JSON batch must be an array of posts.'], submittedUrl: '' }];
    }
    return parsed.map((entry) => parseManualPost((entry ?? {}) as ManualPostInput, capturedAt));
  }

  const results: ParseResult[] = [];
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    // Blank lines and # comments let an operator annotate a paste.
    if (row === '' || row.startsWith('#')) continue;

    const parts = row.split('|').map((p) => p.trim());
    const [url, postedAt, ...rest] = parts;
    results.push(
      parseManualPost(
        {
          url: url ?? '',
          postedAt: postedAt ?? '',
          text: rest.join(' | '),
        },
        capturedAt,
      ),
    );
  }
  return results;
}
