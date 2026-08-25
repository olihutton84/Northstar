# Architecture

## The shape of the thing

Northstar is layered so that the decision-making code never touches a vendor,
and the vendor code never makes a decision.

```
                    ┌──────────────────────────────────────────┐
   X API  ────────► │ XProvider          (SocialDataProvider)  │
   Tiingo ────────► │ TiingoMarketData   (MarketDataProvider)  │  provider seam
   Alpaca ────────► │ AlpacaBroker       (BrokerProvider)      │
                    └────────────────────┬─────────────────────┘
                                         │  normalised domain types only
                    ┌────────────────────▼─────────────────────┐
                    │  Ingestion → Filtering → Resolution       │
                    │  → Signal Engine → Proposal               │  pipeline
                    │  → Risk Engine → OrderRouter → Positions  │
                    │  → Exit Engine → Analytics                │
                    └────────────────────┬─────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────┐
                    │  StrategyRunner · HealthGuard             │  runtime
                    │  ApprovalService                          │
                    └────────────────────┬─────────────────────┘
                                         │
                    ┌────────────────────▼─────────────────────┐
                    │  Trading Lab dashboard + JSON API · CLI   │  surfaces
                    └──────────────────────────────────────────┘
```

Every layer depends only on the layer above it and on `domain/types.ts`. The
composition root (`src/app.ts`) is the only file that knows which
implementation of each seam is in use — which is why the entire pipeline runs
identically against fixtures in tests and against X/Tiingo/Alpaca in production,
with no conditionals inside the strategy.

## The cycle

`StrategyRunner.runCycle()` is one heartbeat:

| # | Stage | What can go wrong, and what happens |
|---|---|---|
| 0 | Health | Corrupt state or a ledger mismatch pauses the strategy before anything else runs |
| 1 | Ingest | X failure is survivable — the cycle continues on stored events so open positions are still managed |
| 2 | Filter | Spam, memes, giveaways, cashtag stuffing, reposts and duplicates are rejected or downweighted |
| 3 | Resolve | Posts map to Northstar security IDs with a confidence score; low confidence never trades |
| 4 | Signal | Composite score, components, contributions, evidence for and against, explanation |
| 5 | Mark | Positions marked to market; equity snapshotted with the benchmark price |
| 6 | Exit | Every open position evaluated against the ordered exit rules |
| 7 | Propose | Qualifying signals sized against the strategy's own available capital |
| 8 | Risk | Independent decision per proposal; may permit less than proposed, never more |
| 9 | Execute | PAPER submits automatically; LIVE stops at `AWAITING_APPROVAL` |
| 10 | Reconcile | Fills recorded once, positions opened/closed, ledger updated |
| 11 | Analytics | Forward returns registered and measured; survival metrics refreshed |

Ordering matters. Exits run **before** new proposals so that capital freed by an
exit is available in the same cycle, and so a strategy-level risk breach stops
new risk while still letting existing positions be closed.

## The decision chain

Every stage writes to `decision_log` under a shared `correlationId`, and every
record links to the one before it by ID:

```
social_events ──► filter_results
              └─► ticker_resolutions ──► signals ──► trade_proposals
                                                 └─► risk_decisions
                                                 └─► approvals
                                                 └─► orders ──► fills
                                                            └─► positions ──► exits
                                                                          └─► signal_outcomes
```

So `northstar trace <proposalId>` reconstructs the whole story: which posts,
scored how, by which config version, cleared by which risk checks, approved by
whom, filled at what price, exited for what reason, and how it turned out.

Nothing is updated destructively except genuinely mutable working state
(position marks, order status, ledger cash). Every *decision* is append-only.

## Immutability of strategy versions

`StrategyVersionSpec` and `SignalEngineConfig` are immutable and registered by
ID. Every signal records the `signalConfigId` that produced it and every
proposal records the `strategyVersion`.

Changing a weight, a risk limit, the universe or the capital allocation means
publishing a **new version**, not editing the old one. `publishStrategyVersion`
and `registerSignalConfig` both throw on a duplicate ID. Rewriting a published
version in place would silently falsify every historical signal that references
it, which is the fastest way to make a backtest lie.

Trading Lab sweeps weights via `deriveSignalConfig(base, newId, ...)`, which
deep-clones rather than mutating, so v1 stays exactly as it was.

## Money

All money is integer cents (`Cents`). Share quantities stay floating point
because Alpaca supports fractional shares, but every conversion back into money
rounds to cents explicitly.

The `$50` strategy ledger is deliberately separate from the Alpaca account
balance. The account may hold thousands of dollars this strategy is not allowed
to touch; orders are sized against `CapitalLedgerService.availableCents()`, and
the risk engine checks it again independently.

`verifyIntegrity()` recomputes cash from the append-only entry log and compares
it with the stored balance. A mismatch is not a warning — it pauses the
strategy.

### Reservations

Cash committed to an unfilled order is *reserved*, so two proposals in the same
cycle cannot spend the same dollar. Reservations are keyed by proposal ID and
settled from the entry log rather than tracked separately, so committed capital
cannot drift away from the audit trail. When an order reaches a terminal state
the whole reservation is retired — including the part that was actually spent,
which has by then left the ledger as cash.

## Time

Nothing outside `core/index.ts` calls `Date.now()`. Every timestamp flows
through a `Clock`, so the whole system can be driven by a `FixedClock` in tests
and in historical replay, and a signal generated at a given instant reproduces
exactly.

## Persistence

SQLite via Node's built-in `node:sqlite` — no driver, no ORM. The schema is
small, the queries are explicit, and the decision log survives in an environment
with no dependencies available. `Store` owns every table; no other layer knows
the storage shape.
