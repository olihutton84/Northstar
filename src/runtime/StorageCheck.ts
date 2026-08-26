/**
 * Is the database somewhere that survives a restart?
 *
 * This is the highest-risk deployment mistake available. A container's
 * filesystem is ephemeral: the bot would start, trade, record everything
 * correctly, and lose the ledger, the positions and the polling cursors on the
 * next deploy — while looking perfectly healthy the whole time. Restart
 * recovery is thoroughly tested and completely useless against it, because
 * there is nothing left to recover.
 *
 * It cannot be detected with certainty from inside the container, so this does
 * not pretend to: it reports what it can see and says plainly how confident it
 * is. A warning an operator can act on beats a guess presented as fact.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type StorageVerdict = 'PERSISTENT' | 'LIKELY_EPHEMERAL' | 'LOCAL' | 'IN_MEMORY';

export interface StorageAssessment {
  verdict: StorageVerdict;
  path: string;
  /** True when the process looks like it is running on a hosting platform. */
  containerised: boolean;
  detail: string;
  remedy: string | null;
}

/**
 * Directories a platform mount typically lives under. A database inside one is
 * taken as deliberate; a database outside one, in a container, is the
 * dangerous case.
 */
const MOUNT_HINTS = ['/data', '/mnt', '/var/lib', '/app/data', '/storage', '/persist'];

export function assessStorage(databasePath: string, env: NodeJS.ProcessEnv = process.env): StorageAssessment {
  // A platform that injects PORT is hosting us; that is the signal that the
  // filesystem is probably not ours to keep.
  const containerised = typeof env['PORT'] === 'string' && env['PORT'].trim() !== '';

  if (databasePath === ':memory:') {
    return {
      verdict: 'IN_MEMORY',
      path: databasePath,
      containerised,
      detail: 'The database is in memory and is discarded when the process exits.',
      remedy: containerised
        ? 'Set NORTHSTAR_DB_PATH to a file on a mounted volume before trading.'
        : null,
    };
  }

  // Normalised, not merely made absolute: `/data/../app/db.sqlite` starts with
  // `/data/` textually but is nowhere near the volume, and a prefix test on the
  // raw string would call it persistent.
  const absolute = resolve(databasePath);
  const onKnownMount = MOUNT_HINTS.some((hint) => absolute === hint || absolute.startsWith(`${hint}/`));

  // An explicit volume declaration is the strongest signal available.
  const declared = (env['RAILWAY_VOLUME_MOUNT_PATH'] ?? '').trim();
  const declaredMount = declared === '' ? '' : resolve(declared);
  const onDeclaredMount =
    declaredMount !== '' && (absolute === declaredMount || absolute.startsWith(`${declaredMount}/`));

  if (!containerised) {
    return {
      verdict: 'LOCAL',
      path: absolute,
      containerised,
      detail: `Running locally; the database lives at ${absolute}.`,
      remedy: null,
    };
  }

  if (onDeclaredMount) {
    return {
      verdict: 'PERSISTENT',
      path: absolute,
      containerised,
      detail: `The database is on the declared volume mount ${declaredMount}.`,
      remedy: null,
    };
  }

  if (onKnownMount) {
    return {
      verdict: 'PERSISTENT',
      path: absolute,
      containerised,
      detail:
        `The database is under ${absolute}, which looks like a mounted volume. ` +
        'Confirm the volume is actually attached — this is inferred from the path, not verified.',
      remedy: null,
    };
  }

  return {
    verdict: 'LIKELY_EPHEMERAL',
    path: absolute,
    containerised,
    detail:
      `The database is at ${absolute}, which is inside the container image rather than on a ` +
      'mounted volume. If that is right, the ledger, open positions and polling cursors are ' +
      'DESTROYED on every redeploy and restart recovery has nothing to recover.',
    remedy:
      'Attach a volume and point NORTHSTAR_DB_PATH at it, e.g. ' +
      'NORTHSTAR_DB_PATH=/data/northstar.sqlite with a volume mounted at /data.',
  };
}

/** True when the database is writable, checked rather than assumed. */
export function databaseDirectoryUsable(databasePath: string): { ok: boolean; detail: string } {
  if (databasePath === ':memory:') return { ok: true, detail: 'in-memory database' };
  const absolute = resolve(databasePath);
  const dir = dirname(absolute);
  try {
    if (!existsSync(dir)) {
      // openDatabase creates it; say so rather than reporting a false problem.
      return { ok: true, detail: `${dir} does not exist yet and will be created` };
    }
    if (!statSync(dir).isDirectory()) return { ok: false, detail: `${dir} exists but is not a directory` };
    return { ok: true, detail: `${dir} exists` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
