/**
 * Strategy version registry.
 *
 * Strategy versions are immutable. A material change to signal logic, risk
 * limits, universe or capital allocation must be published as a NEW version
 * with a new id string, so that historical signals, proposals and trades keep
 * pointing at the behaviour that actually produced them. Rewriting a published
 * version in place would silently falsify every backtest that references it.
 */
import { dollarsToCents } from '../core/index.js';
import type { RiskLimits, UniverseSource } from '../domain/types.js';
import { SIGNAL_CONFIG_V1 } from './signalConfig.js';

export const X_STRATEGY_ID = 'x-signal-v1';
export const X_STRATEGY_DISPLAY_NAME = 'X Signal';

export interface StrategyVersionSpec {
  strategyId: string;
  displayName: string;
  version: string;
  publishedAt: string;
  signalConfigId: string;
  allocatedCapitalCents: number;
  benchmarkTicker: string;
  universeSources: UniverseSource[];
  riskLimits: RiskLimits;
  exitRules: ExitRuleConfig;
  description: string;
  changelog: string;
}

export interface ExitRuleConfig {
  /** Close when the live signal falls to or below this score. */
  signalReversalBelow: number;
  /** Hard cap on how long any position may be held. */
  maxHoldingHours: number;
  /** The event thesis is considered spent after this long. */
  thesisExpiryHours: number;
  stopLossPct: number;
  trailingStopPct: number;
  takeProfitPct: number | null;
  /** Exit everything when the strategy trips its own daily/drawdown limits. */
  exitOnStrategyRiskShutdown: boolean;
}

/**
 * v1 risk limits — the initial configuration required by the spec.
 *
 * The four "allow*" flags are typed as literal `false` in RiskLimits, so a
 * future version physically cannot enable leverage, margin, options or
 * shorting without a type-level change and therefore a code review.
 */
const RISK_LIMITS_V1: RiskLimits = {
  startingCapitalCents: dollarsToCents(50),
  maxPositionPctOfEquity: 20,
  maxConcurrentPositions: 5,
  maxDailyLossPct: 4,
  maxDrawdownPct: 12,
  minOrderCents: dollarsToCents(1),
  allowLeverage: false,
  allowMargin: false,
  allowOptions: false,
  allowShorting: false,
  minSignalScore: 35,
  maxSignalUncertainty: 0.6,
  minResolutionConfidence: 0.75,
  minIndependentSources: 1,
  maxMarketDataAgeMinutes: 30,
  requireMarketOpen: true,
};

const EXIT_RULES_V1: ExitRuleConfig = {
  signalReversalBelow: 0,
  maxHoldingHours: 72,
  thesisExpiryHours: 48,
  stopLossPct: 8,
  trailingStopPct: 6,
  takeProfitPct: 12,
  exitOnStrategyRiskShutdown: true,
};

export const X_SIGNAL_V1: StrategyVersionSpec = {
  strategyId: X_STRATEGY_ID,
  displayName: X_STRATEGY_DISPLAY_NAME,
  version: '1.0.0',
  publishedAt: '2026-01-01T00:00:00.000Z',
  signalConfigId: SIGNAL_CONFIG_V1.signalConfigId,
  allocatedCapitalCents: dollarsToCents(50),
  benchmarkTicker: 'SPY',
  universeSources: [
    'ALPACA_US_EQUITY',
    'NORTHSTAR_WATCHLIST',
    'NORTHSTAR_RESEARCH',
    'NORTHSTAR_PORTFOLIO',
    'TRADING_LAB_UNIVERSE',
  ],
  riskLimits: RISK_LIMITS_V1,
  exitRules: EXIT_RULES_V1,
  description:
    'Long-only US equity strategy that trades explainable, corroborated, material information observed on X, ' +
    'confirmed (not driven) by Northstar market data, against a $50 virtual allocation.',
  changelog: 'Initial version.',
};

const VERSIONS = new Map<string, StrategyVersionSpec>([
  [`${X_SIGNAL_V1.strategyId}@${X_SIGNAL_V1.version}`, X_SIGNAL_V1],
]);

export function versionKey(strategyId: string, version: string): string {
  return `${strategyId}@${version}`;
}

export function getStrategyVersion(strategyId: string, version: string): StrategyVersionSpec {
  const spec = VERSIONS.get(versionKey(strategyId, version));
  if (!spec) throw new Error(`Unknown strategy version: ${versionKey(strategyId, version)}`);
  return spec;
}

export function latestVersion(strategyId: string): StrategyVersionSpec {
  const all = [...VERSIONS.values()].filter((v) => v.strategyId === strategyId);
  if (all.length === 0) throw new Error(`Unknown strategy: ${strategyId}`);
  all.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  return all[all.length - 1]!;
}

export function publishStrategyVersion(spec: StrategyVersionSpec): void {
  const key = versionKey(spec.strategyId, spec.version);
  if (VERSIONS.has(key)) {
    throw new Error(`Strategy version ${key} already published; strategy versions are immutable.`);
  }
  VERSIONS.set(key, spec);
}

export function listStrategyVersions(strategyId?: string): StrategyVersionSpec[] {
  const all = [...VERSIONS.values()];
  return strategyId ? all.filter((v) => v.strategyId === strategyId) : all;
}
