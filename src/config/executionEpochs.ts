/**
 * Execution epochs — operational capital, deliberately outside the strategy.
 *
 * `x-signal-v1` declares a $50 allocation, and that number is inside its
 * fingerprint. It stays there: it is the historical record of what the
 * published version said, and rewriting it would falsify every signal, trade
 * and comparison that references the version.
 *
 * But how much capital an operator chooses to put behind a strategy is not a
 * belief about the market — it is an execution decision, in the same family as
 * scan cadence and rate limits. Raising it does not change a single score,
 * threshold or weight. So capital lives here, in an epoch, and the strategy
 * version stays frozen.
 *
 * An epoch is a clean run of capital: it starts at a stated amount, owns its
 * own ledger, and every order and position taken under it points back at it.
 * Starting a new epoch does not touch the old one — the $50 run remains exactly
 * as it was traded, reconstructable, with its own ledger and its own history.
 *
 * Epochs are declared here rather than read from the environment on purpose.
 * A typo in a deployment variable must not be able to silently change how much
 * money the bot deploys.
 */
import { dollarsToCents } from '../core/index.js';
import { X_STRATEGY_ID } from './strategyRegistry.js';

export interface ExecutionEpochSpec {
  epochId: string;
  strategyId: string;
  /** What an operator would call this run. */
  label: string;
  /** Capital this epoch deploys. The ledger starts here. */
  capitalCents: number;
  /** When the epoch was declared, not when it first traded. */
  declaredAt: string;
  /** Why it exists, for whoever reads the record later. */
  rationale: string;
}

/**
 * The original $50 run.
 *
 * Retained so the history it produced keeps a home. Never active again: an
 * epoch is closed by being superseded, not by being edited.
 */
export const EPOCH_PAPER_50: ExecutionEpochSpec = {
  epochId: 'paper-50-v1',
  strategyId: X_STRATEGY_ID,
  label: 'PAPER $50',
  capitalCents: dollarsToCents(50),
  declaredAt: '2026-01-01T00:00:00.000Z',
  rationale:
    'The initial virtual allocation published with x-signal-v1. Preserved so the ' +
    'run it produced stays reconstructable.',
};

/**
 * The current run: $1,000 of virtual capital.
 *
 * The strategy is unchanged. Only the size of the pot is different, and every
 * proportional risk rule follows from it automatically — a 20% position cap
 * against $1,000 of equity is $200, computed rather than restated, so the two
 * numbers cannot drift apart.
 */
export const EPOCH_PAPER_1000: ExecutionEpochSpec = {
  epochId: 'paper-1000-v1',
  strategyId: X_STRATEGY_ID,
  label: 'PAPER $1,000',
  capitalCents: dollarsToCents(1000),
  declaredAt: '2026-08-26T00:00:00.000Z',
  rationale:
    'Operational scale-up of the paper allocation ahead of autonomous PAPER ' +
    'execution. x-signal-v1 is unchanged and its fingerprint is unmoved; capital ' +
    'is an execution setting, not a belief about the market.',
};

/**
 * Every epoch ever declared, oldest first.
 *
 * Append only. Removing one would orphan the ledger, orders and positions that
 * point at it.
 */
export const EXECUTION_EPOCHS: readonly ExecutionEpochSpec[] = [EPOCH_PAPER_50, EPOCH_PAPER_1000];

/** The epoch new work runs under: the last one declared. */
export const ACTIVE_EPOCH: ExecutionEpochSpec = EXECUTION_EPOCHS[EXECUTION_EPOCHS.length - 1]!;

export function epochById(epochId: string): ExecutionEpochSpec | null {
  return EXECUTION_EPOCHS.find((e) => e.epochId === epochId) ?? null;
}

/**
 * The largest single position this epoch permits, from its own capital and the
 * strategy's position cap.
 *
 * Derived, never stated twice. The risk engine computes the same figure from
 * live equity at decision time; this is the headline number for an operator
 * reading a banner, and it agrees with the engine because both come from the
 * same percentage.
 */
export function maxPositionCentsFor(capitalCents: number, maxPositionPctOfEquity: number): number {
  return Math.floor((capitalCents * maxPositionPctOfEquity) / 100);
}
