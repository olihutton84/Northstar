# Runbook

## First run

```bash
npm install
cp .env.example .env     # fill in the blanks; loaded automatically from here on
npm run seed
npm run cycle
npm run serve            # http://localhost:3737
```

`.env` at the repo root is picked up by every `npm run` bot command via Node's
`--env-file-if-exists`, so a missing `.env` is not an error — you simply get
fixtures, and the banner says so.

`seed` is idempotent: it creates the strategy, records the immutable version
spec, persists the universe allowlist and the source registry, and initialises
the $50 ledger. Running it again does not reset anything.

## Running paper mode

Paper mode is fully automatic. It ingests X, generates signals, creates
proposals, passes them through risk, submits eligible orders, monitors fills,
records positions, closes them per the exit rules and records outcomes — with no
manual intervention.

```bash
npm run paper -- --interval 15      # a cycle every 15 minutes
npm run paper -- --interval 15 --cycles 100
```

Or drive it from the dashboard's **Run cycle** button.

Every run opens with a provider banner stating exactly what is wired up:

```
X:            LIVE          or   X:            FIXTURE
Market Data:  TIINGO             Market Data:  FIXTURE
Broker:       ALPACA PAPER       Broker:       SIMULATED
Mode:         PAPER              Mode:         PAPER
```

Green means real, yellow means fixture. It is read from the constructed
providers, not from the environment, so it cannot disagree with what the bot is
actually using.

A *half*-configured credential pair is a hard error, not a fallback:

```
Configuration error
Alpaca PAPER is partially configured: ALPACA_PAPER_KEY_ID set, but
ALPACA_PAPER_SECRET_KEY missing. ...
```

Falling back there would produce a simulator that looks live, which is the worst
available outcome. Set the missing variable, or unset both to choose fixtures
deliberately.

## Checking on it

```bash
npm run status                     # providers, run state, ledger, open positions
npm run lab -- signals 10          # recent signals, fully explained
npm run report -- 1d               # paper-qualification report
npm run lab -- trace <proposalId>  # the whole decision chain
```

Dashboard sections: header status, **Bot Equity vs Benchmark**, live signal feed
with per-signal explanation, trade proposals, open positions, recent trades,
signal performance, source analytics, and risk.

## Stopping it

```bash
npm run lab -- kill "reason here"                # stop new risk, keep positions
npm run lab -- kill "reason here" --liquidate    # also close every position
npm run lab -- resume "fault cleared"
```

(`lab` is the single entry point every other script delegates to, so it loads
`.env` exactly the same way.)

In the UI, **KILL BOT** asks separately whether to liquidate. The default is no.

## When it pauses itself

Check `northstar status` or `GET /api/health` for the fault and the open
incident. The common ones:

| Fault | What to do |
|---|---|
| `SOCIAL_PROVIDER_FAILURE` | Check the X token and rate-limit headroom, then `resume` |
| `BROKER_AUTH_FAILURE` | Rotate the Alpaca key. Confirm you rotated the key for the mode you are running |
| `STALE_MARKET_DATA` | Check Tiingo. The bot is correct to refuse to trade on old marks |
| `LEDGER_MISMATCH` | **Do not resume blindly.** Read `GET /api/ledger` — the entry log is authoritative. Reconcile before resuming |
| `CORRUPT_STRATEGY_STATE` | Read the incident detail; it names the specific invariant that broke |

A paused strategy keeps observing and recording. Resuming clears open incidents
and resets the failure counters.

## Before the first real-credential run

```bash
npm run readiness
```

PASS/FAIL gates for: credentials loaded, X reachable, Tiingo reachable, Alpaca
PAPER reachable, market status known, ledger reconciled, kill switch functional,
no unresolved migrations, no pending corrupt state, and provider banner
accurate. Exit code 0 on PASS, 1 on FAIL.

Every check is read-only. **Readiness never submits an order.** The kill-switch
check in particular is a *dry* evaluation: it proves the interlock rejects a
killed strategy by evaluating risk against a copy of the strategy record, and
never touches the running one.

```bash
npm run reconcile
```

Compares the Northstar ledger against the broker's orders, fills and positions
and reports discrepancies by severity. It is strictly read-only and repairs
nothing — when the two sides disagree one of them is wrong, and an automated fix
has even odds of destroying the evidence needed to work out which.

Note on a shared account: a broker position *larger* than Northstar's is not a
discrepancy (another strategy or a manual trade may hold it). Only a shortfall
is, because that means Northstar believes it owns something the broker cannot
confirm.

## Auditing a signal

```bash
npm run audit                 # most recent signal
npm run audit -- <signalId>   # a specific one
```

Or click **Full audit trail** under the signal feed in Trading Lab. Shows the
source posts with tiers and filter verdicts, entity-resolution confidence per
post, every scored dimension with the points it contributed, the price data used
for confirmation, the evidence against — and **why the signal did or did not
become a proposal**, taken from the recorded disposition rather than
re-derived from thresholds after the fact.

## Offline qualification

```bash
npm run simulate -- --cycles 300
```

Runs the real pipeline against a deterministic synthetic X stream and synthetic
prices. It qualifies the *machinery* — that the stages connect, that the risk
controls bind, that the ledger reconciles — and explicitly not the strategy's
edge, because the prices are generated. The report says so in its own output.

## Testing

```bash
npm test               # everything
npm run test:unit      # scoring, resolution, filtering, risk, ledger, exits
npm run test:integration   # X event → … → analytics
npm run test:failure   # provider outages, the live gate, order-lifecycle faults
```

---

## Live-mode readiness

Live mode is code-complete and gated, and has never been enabled. Before it
should be, in order:

### 1. Real paper qualification

The offline simulation proves the plumbing, not the edge. Run paper against the
**real** X API, **real** Tiingo prices and a **real** Alpaca paper account until
you have:

- at least 20 closed trades (the threshold at which the survival classifier will
  even consider a status above `TESTING`)
- at least 30 signals measured at the 1-day horizon
- zero unexplained health incidents
- a ledger that reconciles at every check

Then read `northstar report`. If `Sample adequate` says `NO`, you are not ready,
regardless of what the return says.

### 2. Credentials

Set `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY` and
`NORTHSTAR_LIVE_TRADING_ENABLED=true`. Paper and live variables are disjoint;
there is no fallback in either direction, and a live broker pointed at a paper
host refuses to start (and vice versa).

### 3. Switch mode

```bash
npm run lab -- mode LIVE
npm run serve
```

The banner will then read `Broker: ALPACA LIVE` and `Mode: LIVE`.

The mode flag alone does not switch broker credentials — the process must have
been started with live trading enabled, and the API returns a 409 explaining
this if it was not.

### 4. What live mode then does

```
Signal → Trade Proposal → Risk Check → USER APPROVAL → Alpaca Live Order
```

Proposals stop at `AWAITING_APPROVAL` and appear at the top of the dashboard.
Review shows everything listed in
[`RISK_AND_SAFETY.md`](RISK_AND_SAFETY.md#what-the-user-sees-before-approving).
**APPROVE** binds to a fingerprint of the exact terms; if price or size moves
before submission, the proposal is invalidated and regenerated rather than
executed. **REJECT** closes it.

Proposals expire after 15 minutes. An expired proposal cannot be approved.

### 5. Sizing

The $50 allocation is the point, not a placeholder. Do not raise it because a
status label changed — the labels are descriptive, the classifier explicitly
refuses to promote on a thin sample, and nothing in Northstar increases real
capital automatically.
