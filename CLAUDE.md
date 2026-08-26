# Repository scope — Northstar X Trading Bot

This repository is the **standalone X Trading Bot**. It is not the Northstar
Platform, and it does not contain any part of it.

The bot must remain **independently deployable**: it starts, trades paper and
reports without the Platform being reachable.

## This repo OWNS

- `x-signal-v1` — the strategy version, its weights, thresholds and freeze
- X ingestion, filtering, entity resolution, deduplication
- Manual X ingest (the temporary operator-supplied experiment)
- Signal scoring and explanation
- Tiingo price confirmation
- The risk engine and virtual strategy capital (the execution-epoch ledger)
- Alpaca **PAPER** execution, orders, fills, positions, exits
- Reconciliation, restart recovery, the kill switch
- The autonomous runner and API efficiency
- Bot monitoring — the **X Bot Console** (see naming below)
- Railway deployment of this bot
- Bot analytics and experiment output (replay, comparison, survival metrics)

## This repo DOES NOT own

- Trading 212 portfolio
- Northstar Research
- Decide
- Northstar Reports
- The portfolio recommendation engine
- The Reddit / news research system
- Northstar's main UI and design system (Stitch)
- Northstar v0.2 recommendations

Those belong to the **Northstar Platform** repository. The Platform is an
external **provider** (it supplies universe membership) and an external
**consumer** (it may read this bot's results). Neither direction is built here.

## Naming

| System | Its UI is called |
|---|---|
| Northstar Platform | **Trading Lab** |
| This repo | **X Bot Console** |

The console is the local dashboard and CLI in `src/api` + `src/ui`. Some
internal identifiers still read `Trading Lab`; those are labels only and are
being retired opportunistically, not by a risky sweeping rename.

## The universe boundary

Portfolio, research and watchlist membership belongs to the Platform. The bot
consumes it through one small contract and never invents it.

```
Northstar Platform  ──(universe snapshot)──►  X Trading Bot
```

- **Contract**: `src/universe/contract.ts` — a versioned snapshot, strictly
  validated, all-or-nothing.
- **Loading**: `src/universe/load.ts` — `NORTHSTAR_UNIVERSE_FILE` today; an
  HTTP source later by passing a different reader. No import from the Platform.
- **Fallback**: `src/universe/seed.ts` — the bot's own list. A plausible
  stand-in that goes stale. It is **not** live Platform membership.

Priority is: **valid Platform snapshot → otherwise bot fallback.** Whichever is
active is stated in the startup banner, on the console and in the session
record. A malformed snapshot is rejected whole, never partially ingested.

The active origin is decided by what is configured **now**, not by what is
stored from a previous run — otherwise a session that once had a Platform
snapshot would keep trading that list after the snapshot was withdrawn.

### Why the `NORTHSTAR_*` source names remain

`x-signal-v1` declares `NORTHSTAR_WATCHLIST`, `NORTHSTAR_RESEARCH` and
`NORTHSTAR_PORTFOLIO` in its frozen spec, and those names are part of the
strategy fingerprint. They are kept as the **integration contract**: the
vocabulary the Platform uses when it hands over membership. Renaming them would
republish the strategy version for no behavioural gain.

## Execution epochs — capital without republishing the strategy

`x-signal-v1` declares a $50 allocation and always will: that figure is inside
its fingerprint and is the record of what the published version said. What the
bot actually deploys comes from the **active execution epoch**.

```
src/config/executionEpochs.ts   declared epochs, oldest first; the last is active
```

| | |
|---|---|
| Active epoch | `paper-1000-v1` — **$1,000** |
| Max position | **$200** (20% of equity, derived not restated) |
| Max holdings | 5 |
| Version still says | $50 (frozen, fingerprint `b45f2bbd5224201a`) |

How much capital an operator puts behind a strategy is an execution decision,
not a belief about the market — it changes no score, weight or threshold. So it
lives in an epoch. Each epoch owns its own ledger, and every order, position and
ledger entry carries its `epochId`. Superseding an epoch **closes** it; it never
edits it, so the $50 run stays exactly as it traded.

Epochs are declared in code, not read from the environment: a typo in a
deployment variable must not be able to change how much money the bot deploys.

## Execution tiers and autonomous PAPER

The tier is **derived from the wiring**, never declared by a flag
(`src/runtime/AutonomyGate.ts`):

| Tier | Data | Broker | Autonomous? |
|---|---|---|---|
| `SIMULATION` | fixtures | simulated | yes — nothing real is touched |
| `PAPER` | real X + Tiingo | Alpaca PAPER | yes, once every gate passes |
| `LIVE` | real | Alpaca LIVE | **never** — a human approves every order |
| `INCOHERENT` | fixtures | Alpaca | **blocked** |

`INCOHERENT` is the case that matters. Alpaca PAPER is a real account with a
real audit trail; fixture-driven orders written into it would be a fictional
track record indistinguishable from a genuine one. Fixture data may only reach a
simulated broker, and a real broker may only be reached by real data.

There is **no override**. A test seam permitting fixtures to reach a real broker
would be the exact bug the gate exists to prevent. Tests get automatic routing
by genuinely being in `SIMULATION`.

LIVE is decided first and by either witness — the broker's mode or the strategy
mode — so a simulated broker running in LIVE mode still requires a human.

## Manual X ingest — a temporary experiment

The X API costs money. For a bounded experiment the operator supplies real,
public X posts by hand: `src/ingest/`, `src/providers/social/ManualSocialProvider.ts`.

```
northstar manual start "<note>"     open the window (does NOT start trading)
northstar manual add --url … --at … --text "…"
pbpaste | northstar manual batch    one per line: <url> | <ISO ts> | <text>
northstar manual list               what is held, pending and ingested
northstar manual stop "<reason>"    close early; it expires on its own anyway
```

Manual posts route through the **existing** pipeline unchanged — event
detection, ticker resolution, `x-signal-v1`, Tiingo confirmation, risk, Alpaca
PAPER. Nothing downstream knows the evidence arrived through a person.

| | |
|---|---|
| Source / provenance | `X_MANUAL` / `MANUAL_OPERATOR_SUPPLIED` |
| Dedup key | canonical X status id, not the URL as typed |
| Vendor cost | **0 requests** |
| Window | **7 days**, ceiling in `MANUAL_INGEST_MAX_DAYS` |
| LIVE | **never** — refused at provider construction *and* in the gate |

Three properties make this safe rather than reckless:

- **It is never presented as the API.** `describeProviders().x` is a third
  state, `MANUAL`. The console reads **MANUAL REAL POSTS**, never *X API LIVE*.
- **It expires by itself.** The expiry is computed from `startedAt` plus a
  constant in code; it is deliberately NOT stored, so editing the row cannot
  extend the experiment. Only a code change can.
- **Every trade traces to a URL.** The observation keeps both the canonical URL
  and the one actually pasted, plus who supplied it and when.

Opening the window does not start trading, and submitting posts does not open
the window. Both are explicit, separate acts.

The social provider is chosen at construction, so opening the window while the
bot is running has no effect until it restarts — the autonomy gate reports that
case (`manual-provider-current`) rather than leaving the queue silently unread.

## Rules for future work in this repo

1. Do not build Platform features here. If a task needs portfolio, research,
   recommendations or news intelligence, it belongs in the Platform repo.
2. Do not hard-code Platform state. Membership arrives through the contract.
3. Do not change `x-signal-v1`. A material change is `x-signal-v2`; the
   fingerprint test in `test/unit/strategyFreeze.test.ts` enforces this.
   Capital is **not** a material change — see the execution epochs below.
4. Do not enable LIVE. This release is Alpaca PAPER only.
5. Keep the bot independently deployable — the Platform being down is never a
   reason the bot cannot run.
