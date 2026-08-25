# Replay and version comparison

## Why replay exists

Two questions need answering before real money is anywhere near this:

1. *Would this decision have been made the same way, given only what was known
   at the time?*
2. *Is a proposed change to the strategy actually better, or just different?*

Both need the same thing: the ability to run the **real** pipeline over a frozen
window of history, with no possibility of seeing the future.

## No look-ahead, structurally

Replay swaps only the three providers. `ReplaySocialProvider` and
`ReplayMarketDataProvider` filter every read against the replay clock:

- an event is invisible until `capturedAt <= now` — when Northstar actually
  *observed* it, not when it was written
- a bar is invisible until `at <= now`
- a requested bar range is **clamped** to now, so asking for a future window
  returns nothing rather than the future

The filtering lives inside the providers, not in the engine, so a caller cannot
opt out of it and a future provider method cannot forget it as long as it goes
through `visibleBars`.

Every replay reports `hiddenEvents` and `hiddenBars` per cycle. If nothing were
ever hidden, time was not actually stepping and the result would be a look-ahead
backtest wearing a replay costume — so the counts are part of the output, not an
internal detail.

Datasets are validated on load: an event captured before it was posted, a
duplicate post id, or an inverted window is rejected rather than replayed.

## Using it

```bash
# Build a deterministic sample dataset (synthetic prices — machinery only)
npm run replay -- sample --out data/replay/sample.json --hours 120

# Freeze what a real run actually saw
npm run replay -- export --days 7 --out data/replay/week.json

# Replay it through the real pipeline
npm run replay -- run data/replay/week.json --step 30
```

Output: trades, return, benchmark, alpha, maximum drawdown, win rate, turnover,
costs, Sharpe, signal hit rate, mean excess return, source-tier performance,
risk interventions by check, filter verdicts, health incidents and errors.

A replay is deterministic: the same dataset and version always produce the same
trades, P&L and interventions. There is a test that asserts it.

## Comparing versions

```bash
npm run compare -- data/replay/week.json --versions 1.0.0,1.1.0
```

Both versions run over the identical dataset, each in its own in-memory
database, so the only difference between the runs is the strategy version.

Candidates are published with `deriveStrategyVersion`, which deep-clones the
base and registers the result under a **new** id. The baseline therefore cannot
drift underneath a comparison, and `publishStrategyVersion` refuses a duplicate
id — a published version can never be quietly redefined. The same holds for
signal configs via `deriveSignalConfig` / `registerSignalConfig`.

The comparison reports return, benchmark, alpha, maximum drawdown, turnover, hit
rate, trade count, signals generated, risk interventions and a per-version
source-tier breakdown — which is usually where a weighting change shows up
first, since it changes *which* sources drive trades before it changes the
headline return.

## The caveat that matters

A version "winning" on four trades has not won. The comparison flags a thin
sample explicitly:

```
SAMPLE TOO SMALL: the thinnest version closed 5 trade(s) against a 20-trade
minimum. Ranking these versions is not yet meaningful — a difference this size
is noise, and picking a winner from it would be overfitting to one window.
```

And the sample dataset's prices are synthetic. A sample replay validates the
machinery and the risk controls; it says nothing whatever about whether X
contains alpha. Only an exported real dataset can speak to that.
