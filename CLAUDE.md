# Repository scope — Northstar X Trading Bot

This repository is the **standalone X Trading Bot**. It is not the Northstar
Platform, and it does not contain any part of it.

The bot must remain **independently deployable**: it starts, trades paper and
reports without the Platform being reachable.

## This repo OWNS

- `x-signal-v1` — the strategy version, its weights, thresholds and freeze
- X ingestion, filtering, entity resolution, deduplication
- Signal scoring and explanation
- Tiingo price confirmation
- The risk engine and virtual strategy capital (the $50 ledger)
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

## Rules for future work in this repo

1. Do not build Platform features here. If a task needs portfolio, research,
   recommendations or news intelligence, it belongs in the Platform repo.
2. Do not hard-code Platform state. Membership arrives through the contract.
3. Do not change `x-signal-v1`. A material change is `x-signal-v2`; the
   fingerprint test in `test/unit/strategyFreeze.test.ts` enforces this.
4. Do not enable LIVE. This release is Alpaca PAPER only.
5. Keep the bot independently deployable — the Platform being down is never a
   reason the bot cannot run.
