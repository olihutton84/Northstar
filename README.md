# Northstar

Trading Lab, and its first live experiment: the **X Signal Bot** (`x-signal-v1`).

The bot reads X, decides whether anything said there is *material, credible, new
and corroborated*, turns that into an explainable signal, puts the signal in
front of an independent risk engine, and only then produces a trade — paper
automatically, live only with a human's explicit approval of that exact order.

It is deliberately **not** a sentiment bot. A positive tweet is not a buy.

```
X → Ingestion → Filtering → Ticker Resolution → Signal Engine → Risk Engine
  → Trade Proposal → Alpaca Paper OR Human-Approved Live Order
  → Trade → Performance → Analytics
```

---

## Quick start

```bash
npm install
cp .env.example .env          # fill in keys, or leave blank to run on fixtures

npm run seed                  # strategy, universe and the $50 capital ledger
npm run cycle                 # one full pipeline cycle
npm run serve                 # dashboard at http://localhost:3737
```

Every command loads the repo-root `.env` automatically (Node's native
`--env-file-if-exists`), and prints which providers are actually wired up:

```
X:            LIVE
Market Data:  TIINGO
Broker:       ALPACA PAPER
Mode:         PAPER
```

No credentials? Set `NORTHSTAR_USE_FIXTURES=true` and everything runs offline
against recorded fixtures — same code path, no network.

```bash
npm run simulate -- --cycles 300   # offline paper qualification run
npm test                           # 144 unit / integration / failure tests
```

Tests deliberately do **not** load `.env` — they must behave the same on every
machine, with or without credentials on disk.

---

## Commands

| Command | What it does |
|---|---|
| `seed` | Create the strategy, universe allowlist and $50 ledger (idempotent) |
| `cycle` | Run one full pipeline cycle |
| `paper --interval 15` | Run the paper loop continuously |
| `serve` | Start the Trading Lab dashboard and JSON API |
| `status` | Strategy status and capital ledger |
| `signals [n]` | Recent signals with their full explanations |
| `trace <id>` | Reconstruct one decision chain end to end |
| `simulate --cycles N` | Offline paper simulation over the real pipeline |
| `report [1h\|1d\|1w\|1m]` | Paper-qualification report |
| `kill <reason> [--liquidate]` | Engage the kill switch |
| `resume <note>` | Clear a pause or kill |
| `mode PAPER\|LIVE` | Set the trading mode |

---

## How it is put together

Every external system sits behind a provider interface, so the strategy never
learns who the vendor is:

| Seam | Interface | Implementations |
|---|---|---|
| Social | `SocialDataProvider` | `XProvider`, `FixtureSocialProvider` |
| Market data | `MarketDataProvider` | `TiingoMarketDataProvider`, `FixtureMarketDataProvider` |
| Broker | `BrokerProvider` | `AlpacaBrokerProvider` (PAPER/LIVE), `SimulatedBrokerProvider` |

```
src/
  core/          clock, ids, integer-cent money, result, redacting logger
  domain/        the shared vocabulary — no I/O, no vendor terms
  config/        env, immutable signal config, immutable strategy versions
  persistence/   SQLite schema + repositories (the full decision chain)
  providers/     the three seams above
  universe/      the explicit investable allowlist
  pipeline/      ingestion → filtering → resolution → signal → proposal → risk
                 → execution → analytics
  runtime/       health guard / kill switch, approval service, strategy runner
  api/ ui/       Trading Lab dashboard and JSON API
  cli/           northstar CLI and the offline simulation
```

Further reading:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, data flow, decision log
- [`docs/SIGNAL_ENGINE.md`](docs/SIGNAL_ENGINE.md) — the composite, dimension by dimension
- [`docs/RISK_AND_SAFETY.md`](docs/RISK_AND_SAFETY.md) — risk engine, live gate, fail-safes
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operating it, including live-mode readiness

---

## The three rules this design exists to enforce

**1. No unexplained numbers.** A signal carries its eight component scores, the
points each contributed, the posts behind it, the market data behind it, the
evidence *against* it, and a written explanation. `northstar signals` prints it;
the dashboard shows it; `northstar trace` reconstructs the whole chain from post
to outcome.

**2. Risk overrides the signal.** The risk engine runs independently of the
signal engine and has final authority. A +100 signal with a failing check
produces no order. Every check it ran is recorded, passed or failed.

**3. Nothing reaches live money unattended.** `OrderRouter` is the only code
path to a broker. In LIVE mode it requires an `ApprovalRecord` whose fingerprint
matches the exact terms — ticker, side, dollars, quantity, price, signal — that
the human was shown. If price or size drifts between display and submission, the
proposal is *invalidated and regenerated*, never executed.

---

## Status

v0.1, `TESTING`. Paper qualification has run offline; live mode is code-complete
and gated but has never been enabled. See
[`docs/RUNBOOK.md`](docs/RUNBOOK.md#live-mode-readiness) for exactly what remains
before it should be.
