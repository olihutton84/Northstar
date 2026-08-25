# Risk and safety

## The risk engine is independent

`RiskEngine` never reads the signal engine's internals — only the proposal and
the numbers recorded on the signal. That separation is the point: if the signal
engine has a bug, risk still holds. A +100 signal with a failing check produces
no order, and the rejection is as explainable as a signal: every check that ran
is recorded with its observed value and limit, passed or failed.

Risk may permit **less** capital than proposed. It can never permit more.

## v1 limits

| Limit | Value |
|---|---|
| Starting virtual allocation | $50.00 |
| Maximum individual position | 20% of equity |
| Maximum concurrent positions | 5 |
| Maximum daily strategy loss | 4% |
| Maximum strategy drawdown | 12% |
| Leverage / margin / options / shorting | disabled |
| Minimum signal score | 35 |
| Maximum signal uncertainty | 0.60 |
| Minimum resolution confidence | 0.75 |
| Minimum independent sources | 1.0 tier-weighted |
| Maximum market-data age | 30 minutes |
| Market must be open | yes |

The four `allow*` flags are typed as literal `false` in `RiskLimits`, so a
future version physically cannot enable leverage, margin, options or shorting
without a type-level change — and therefore a code review.

## The checks

`KILL_SWITCH` · `STRATEGY_STATUS` · `PROVIDER_HEALTH` · `UNIVERSE_MEMBERSHIP` ·
`ALPACA_TRADABLE` · `DIRECTION_ALLOWED` · `NO_LEVERAGE` · `SIGNAL_THRESHOLD` ·
`SIGNAL_UNCERTAINTY` · `RESOLUTION_CONFIDENCE` · `INDEPENDENT_SOURCES` ·
`MARKET_DATA_FRESHNESS` · `MARKET_HOURS` · `DUPLICATE_EXPOSURE` ·
`DUPLICATE_ORDER` · `MAX_CONCURRENT_POSITIONS` · `MAX_POSITION_SIZE` ·
`AVAILABLE_CASH` · `MIN_ORDER_SIZE` · `DAILY_LOSS_LIMIT` · `MAX_DRAWDOWN` ·
`LEDGER_INTEGRITY`

Universe membership is checked at risk time as well as at ingestion, so a
security removed from the universe *between* signal and order is stopped at the
gate.

## The live approval gate

`OrderRouter` is the only code path in Northstar that reaches a `BrokerProvider`.
Nothing else may call `broker.submitOrder`. Before an order is submitted it
enforces, in order:

1. a risk decision exists, is approved, and belongs to **this** proposal
2. the proposal has not expired (15-minute TTL)
3. the current price is within 1% of the proposed reference price
4. the material terms still hash to the recorded fingerprint
5. **in LIVE mode**, an `ApprovalRecord` exists whose fingerprint matches those
   exact terms

There is no flag, no override and no alternate method that skips step 5.

### The fingerprint

An approval binds to a hash of `{proposalId, ticker, side, capitalCents,
quantity, referencePrice, signalId, signalScore}`. If any of those change
between what the human was shown and what would be submitted, the proposal is
**invalidated and regenerated**, never executed. A price move that changes the
share count is a different trade.

The `ApprovalService` records the decision and then asks the router to submit;
the router independently re-verifies the approval from persisted state. Two
independent checks of the same fact is the point.

### What the user sees before approving

Ticker and company · direction · dollar amount · approximate shares · reference
vs current price and the drift between them · signal score, band, uncertainty
and explanation · the full reasoning · every source with tier, excerpt and link ·
**evidence against** · current strategy P&L (starting capital, cash, positions,
unrealised, realised, equity, return) · resulting exposure before and after ·
every risk check with its detail · drawdown and daily-loss headroom · the
invalidation condition · expiry · the fingerprint itself.

### Exits

Exits execute automatically in both modes by default. An exit reduces exposure
and never commits new capital, and blocking a stop-loss behind a human who may
be asleep is more dangerous than letting it run. This is a deliberate,
configurable choice (`requireApprovalForLiveExits`), documented here rather than
buried.

## Exit rules

Evaluated in severity order — capital preservation before thesis:

1. `KILL_SWITCH_LIQUIDATION` (only if liquidation was separately confirmed)
2. `STRATEGY_RISK_SHUTDOWN`
3. `STOP_LOSS` — 8% from entry
4. `TRAILING_STOP` — 6% off the high, armed only once the position has traded
   above entry (otherwise it is just a tighter stop that fires on entry noise)
5. `TAKE_PROFIT` — 12%
6. `SIGNAL_REVERSAL` — live signal ≤ 0, and only from a signal generated *after*
   entry
7. `THESIS_EXPIRY` — 48 hours
8. `MAX_HOLDING_PERIOD` — 72 hours

Every evaluation is recorded, so a *hold* is as explainable as an exit, and
every exit records its reason and detail.

## KILL BOT

`HealthGuard.kill(reason, liquidate = false)`:

- stops the strategy generating executable proposals
- cancels outstanding strategy orders where safe, releasing their reservations
- disables new orders
- preserves every log — the kill itself is logged

**Liquidation is a separate, explicit confirmation** (`--liquidate`, or the
second prompt in the UI). Dumping positions into a thin market is itself a way
to lose money, so it never happens by default.

## Automatic pause

The strategy pauses itself on:

| Fault | Trigger |
|---|---|
| `STALE_MARKET_DATA` | Price older than the configured limit |
| `BROKER_AUTH_FAILURE` | Any 401/403 from the broker — never transient |
| `REPEATED_API_FAILURE` | 3 consecutive broker or 5 market-data failures |
| `SOCIAL_PROVIDER_FAILURE` | `X_FAILURE_TOLERANCE` consecutive X failures |
| `CORRUPT_STRATEGY_STATE` | Negative allocation, orphaned position, reserved > cash |
| `LEDGER_MISMATCH` | Stored cash disagrees with the append-only entry log |

A paused strategy keeps ingesting, scoring and recording — it just stops
committing capital. Blindness is worse than inaction.

Only genuine contact with a provider counts as evidence of health. A cycle with
no open orders proves nothing about the broker, and treating it as a success
would silently reset the circuit breaker every cycle.

## No uncontrolled order loops

- Every order carries a deterministic `clientOrderId`; the broker and the local
  store both reject a repeat.
- A failed submission releases its reservation immediately — cash is never
  stranded against an order that does not exist.
- A rejected entry marks the proposal `FAILED`; it is not resubmitted.
- A rejected **exit** returns the position to `OPEN` and is retried with a fresh
  attempt-numbered key — a stop-loss that the broker bounced once must not be
  permanently disarmed. Retries are rate-limited to one per cycle and every
  attempt is persisted.
- Fills are content-addressed and recorded exactly once; repeated reconciliation
  cannot re-spend cash.
- Duplicate X events are dropped at ingest by post ID.
