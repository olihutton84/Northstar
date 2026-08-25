/**
 * Exit engine.
 *
 * A bot that only knows how to buy is not a strategy. Every open position is
 * evaluated against an explicit, ordered rule set on every cycle, and the
 * reason for every exit is recorded.
 *
 * Rules are evaluated in severity order: capital-preserving rules fire before
 * thesis-based ones, so a stop-loss always wins over "hold until the thesis
 * expires".
 */
import type { Clock, Logger } from '../../core/index.js';
import type { ExitRuleConfig } from '../../config/strategyRegistry.js';
import type { ExitReason, Position, Quote } from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';

export interface ExitDecision {
  positionId: string;
  ticker: string;
  shouldExit: boolean;
  reason: ExitReason | null;
  note: string;
  /** Every rule evaluated, so a hold is as explainable as an exit. */
  evaluations: { rule: ExitReason | 'HOLD'; triggered: boolean; detail: string }[];
}

export interface ExitContext {
  /** Latest price per ticker. */
  quotes: Map<string, Quote>;
  /** True when the strategy has breached a strategy-level risk limit. */
  strategyRiskShutdown: boolean;
  strategyRiskDetail: string;
  /** True when the kill switch has been engaged WITH liquidation selected. */
  killSwitchLiquidate: boolean;
}

export class ExitEngine {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly rules: ExitRuleConfig,
    private readonly clock: Clock,
    logger: Logger,
    private readonly strategyId: string,
  ) {
    this.log = logger.child('exit-engine');
  }

  /** Evaluate one position against every rule. */
  evaluate(position: Position, ctx: ExitContext): ExitDecision {
    const evaluations: ExitDecision['evaluations'] = [];
    const quote = ctx.quotes.get(position.ticker);
    const price = quote?.price ?? position.lastMarkPrice;
    const nowMs = this.clock.nowMs();

    const openedMs = new Date(position.openedAt).getTime();
    const heldHours = (nowMs - openedMs) / 3_600_000;
    const returnPct = position.entryPrice > 0 ? ((price - position.entryPrice) / position.entryPrice) * 100 : 0;
    const highWater = Math.max(position.highWaterPrice, price);
    const drawdownFromHighPct = highWater > 0 ? ((highWater - price) / highWater) * 100 : 0;

    let decision: { reason: ExitReason; note: string } | null = null;

    const check = (rule: ExitReason, triggered: boolean, detail: string): void => {
      evaluations.push({ rule, triggered, detail });
      if (triggered && !decision) decision = { reason: rule, note: detail };
    };

    /* --- 1. explicit liquidation --------------------------------------- */
    check(
      'KILL_SWITCH_LIQUIDATION',
      ctx.killSwitchLiquidate,
      ctx.killSwitchLiquidate
        ? 'Kill switch engaged with liquidation explicitly selected'
        : 'Kill-switch liquidation not selected',
    );

    /* --- 2. strategy-level risk shutdown -------------------------------- */
    check(
      'STRATEGY_RISK_SHUTDOWN',
      ctx.strategyRiskShutdown && this.rules.exitOnStrategyRiskShutdown,
      ctx.strategyRiskShutdown
        ? `Strategy risk limit breached: ${ctx.strategyRiskDetail}`
        : 'No strategy-level risk breach',
    );

    /* --- 3. stop loss ---------------------------------------------------- */
    const stopHit = returnPct <= -this.rules.stopLossPct;
    check(
      'STOP_LOSS',
      stopHit,
      stopHit
        ? `Down ${returnPct.toFixed(2)}% from entry, at or beyond the ${this.rules.stopLossPct}% stop`
        : `Down/up ${returnPct.toFixed(2)}% from entry, stop is ${this.rules.stopLossPct}%`,
    );

    /* --- 4. trailing stop ------------------------------------------------ */
    // Only meaningful once the position has actually been in profit; otherwise
    // it is just a tighter stop-loss and would fire on entry noise.
    const inProfitOnce = highWater > position.entryPrice;
    const trailHit = inProfitOnce && drawdownFromHighPct >= this.rules.trailingStopPct;
    check(
      'TRAILING_STOP',
      trailHit,
      trailHit
        ? `Given back ${drawdownFromHighPct.toFixed(2)}% from the ${highWater.toFixed(2)} high, trailing limit ${this.rules.trailingStopPct}%`
        : inProfitOnce
          ? `${drawdownFromHighPct.toFixed(2)}% off the high, trailing limit ${this.rules.trailingStopPct}%`
          : 'Position has not traded above entry, trailing stop inactive',
    );

    /* --- 5. take profit -------------------------------------------------- */
    const takeProfitHit = this.rules.takeProfitPct !== null && returnPct >= this.rules.takeProfitPct;
    check(
      'TAKE_PROFIT',
      takeProfitHit,
      this.rules.takeProfitPct === null
        ? 'No take-profit configured'
        : takeProfitHit
          ? `Up ${returnPct.toFixed(2)}%, at or beyond the ${this.rules.takeProfitPct}% target`
          : `Up ${returnPct.toFixed(2)}%, target is ${this.rules.takeProfitPct}%`,
    );

    /* --- 6. signal reversal ---------------------------------------------- */
    const latest = this.store.signals.latestForSecurity(this.strategyId, position.securityId);
    // Only a signal generated AFTER entry can reverse the thesis.
    const fresherSignal = latest && new Date(latest.generatedAt).getTime() > openedMs ? latest : null;
    const reversed = fresherSignal !== null && fresherSignal.score <= this.rules.signalReversalBelow;
    check(
      'SIGNAL_REVERSAL',
      reversed,
      fresherSignal
        ? reversed
          ? `Live signal has fallen to ${fresherSignal.score}, at or below the ${this.rules.signalReversalBelow} reversal level`
          : `Live signal is ${fresherSignal.score}, reversal level is ${this.rules.signalReversalBelow}`
        : 'No newer signal since entry',
    );

    /* --- 7. thesis expiry ------------------------------------------------ */
    const thesisExpired = heldHours >= (position.invalidationCondition.thesisExpiryHours || this.rules.thesisExpiryHours);
    check(
      'THESIS_EXPIRY',
      thesisExpired,
      thesisExpired
        ? `Held ${heldHours.toFixed(1)}h; the event thesis expires after ${position.invalidationCondition.thesisExpiryHours}h`
        : `Held ${heldHours.toFixed(1)}h of a ${position.invalidationCondition.thesisExpiryHours}h thesis window`,
    );

    /* --- 8. maximum holding period --------------------------------------- */
    const maxHold = position.invalidationCondition.maxHoldingHours || this.rules.maxHoldingHours;
    const maxHoldHit = heldHours >= maxHold;
    check(
      'MAX_HOLDING_PERIOD',
      maxHoldHit,
      maxHoldHit
        ? `Held ${heldHours.toFixed(1)}h, at or beyond the ${maxHold}h maximum`
        : `Held ${heldHours.toFixed(1)}h of a ${maxHold}h maximum`,
    );

    if (!decision) {
      evaluations.push({ rule: 'HOLD', triggered: true, detail: 'No exit rule triggered' });
      return {
        positionId: position.positionId,
        ticker: position.ticker,
        shouldExit: false,
        reason: null,
        note: `Holding: ${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}% after ${heldHours.toFixed(1)}h`,
        evaluations,
      };
    }

    const chosen = decision as { reason: ExitReason; note: string };
    this.log.info('exit triggered', {
      positionId: position.positionId,
      ticker: position.ticker,
      reason: chosen.reason,
      returnPct: Number(returnPct.toFixed(2)),
    });

    return {
      positionId: position.positionId,
      ticker: position.ticker,
      shouldExit: true,
      reason: chosen.reason,
      note: chosen.note,
      evaluations,
    };
  }

  evaluateAll(positions: Position[], ctx: ExitContext): ExitDecision[] {
    return positions.map((p) => this.evaluate(p, ctx));
  }
}
