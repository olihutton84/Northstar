# Platform integration

The boundary between the **Northstar Platform** and the **X Trading Bot**, in
both directions. Nothing in this document is built on the Platform side here —
this repository defines only its own half.

```
                 universe snapshot (in)
Northstar  ──────────────────────────────►  X Trading Bot
 Platform  ◄──────────────────────────────  (independently deployable)
                 bot results (out)
```

The bot runs without the Platform. Both directions are optional.

---

## 1. Inbound — the universe contract

The Platform owns portfolio, research and watchlist membership. The bot
consumes it and never invents it.

### Payload

```jsonc
{
  "version": "platform-2026-08-26-a",     // required, non-empty
  "generatedAt": "2026-08-26T06:00:00Z",  // required, parsable
  "securities": [                         // required, non-empty
    {
      "ticker": "NVDA",                   // required
      "companyName": "NVIDIA Corporation",// required — the resolver matches on it
      "sources": ["ALPACA_US_EQUITY", "NORTHSTAR_PORTFOLIO"],  // required, ≥1
      "securityId": "sec_NVDA",           // optional, derived from ticker if absent
      "aliases": ["Nvidia", "NVIDIA"],    // optional
      "exchange": "NASDAQ",               // optional
      "alpacaTradable": true,             // optional, default true
      "alpacaFractionable": true,         // optional, default true
      "active": true                      // optional, default true
    }
  ]
}
```

Recognised `sources`: `ALPACA_US_EQUITY`, `NORTHSTAR_WATCHLIST`,
`NORTHSTAR_RESEARCH`, `NORTHSTAR_PORTFOLIO`, `TRADING_LAB_UNIVERSE`.

### Delivery

| Today | Later |
|---|---|
| `NORTHSTAR_UNIVERSE_FILE=/path/to/universe.json` | an HTTP reader passed to `loadUniverse()` |

`load.ts` takes a `UniverseSource` — `describe()` and `read()`. Adding HTTP
means writing one more of those. The bot never imports from the Platform repo.

### Guarantees the bot makes

- **All or nothing.** Any validation failure rejects the whole snapshot. A
  partially-applied universe would silently change what may be traded.
- **Loud.** A rejection names every problem in the banner, on the console and
  in the session record.
- **Safe.** A rejected snapshot falls back to the bot's own list, labelled
  `BOT FALLBACK`, never presented as Platform state.
- **Reconstructable.** `version`, `generatedAt` and a content `fingerprint` are
  written to the session record, so any trade can be replayed against the exact
  eligible universe that produced it.

An empty `securities` array is **rejected**, not accepted — an empty universe
would stop all trading while looking healthy.

---

## 2. Outbound — what the bot can expose

All of this already exists on the console's JSON API. The Platform reads it;
nothing is pushed from here.

| Field | Where |
|---|---|
| strategy version, fingerprint, status, run state | `GET /api/observability` → `strategy`, `providers` |
| signals + full explanations, component contributions | `GET /api/signals`, `GET /api/dashboard` → `signalFeed` |
| per-signal evidence and audit trail | `GET /api/signals/:id/audit` |
| proposals | `GET /api/proposals`, `dashboard.proposals` |
| risk rejections and every check run | `GET /api/decision-log` (stage `RISK`), audit view |
| orders, fills | `GET /api/orders` |
| positions | `GET /api/positions` |
| cash, reserved, equity, P&L | `GET /api/ledger`, `GET /api/equity-curve` |
| API health and usage per vendor | `observability.api` |
| provider health (X / Tiingo / Alpaca) | `observability.process`, `GET /api/health` |
| kill-switch state and halt reason | `observability.killSwitch`, `observability.strategy.haltReason` |
| **universe version, origin and fingerprint** | `observability.providers.universe` |
| survival / experiment metrics | `GET /api/analytics` |

`src/pipeline/analytics/survival.ts` is the intended shape for a Bot Arena
consumer: return, benchmark, alpha, drawdown, win rate, average winner/loser,
turnover, trade count, costs, status and `sampleAdequate`.

### Stability

These are the bot's public surface. Fields may be **added**; removing or
repurposing one is a breaking change for the Platform and should be treated as
such.

---

## 3. What is deliberately absent

The bot does not, and should not, expose or consume: portfolio valuations,
Trading 212 state, research notes, recommendations, Decide output, Reddit or
news intelligence, or any Platform UI concern. If a future task seems to need
one of those here, it belongs in the Platform repository.
