# The X Signal Engine

## What it is not

It is not a sentiment classifier with a threshold. "Positive tweet → buy" fails
for reasons that are easy to state and hard to fix piecemeal:

- the account may have no idea what it is talking about
- the content may be true but immaterial
- the story may be two days old and fully priced
- one story repeated by a hundred accounts is not a hundred pieces of evidence
- the enthusiasm may be manufactured
- "$F" may not mean Ford

Each of those is a separate dimension in this engine, and each has a specific
mechanism that prevents it from being gamed by the others.

## Structure

```
direction  = sentiment                          only sentiment sets the sign
conviction = weighted mean of the six           0..1
             non-directional dimensions
base       = sentiment × conviction             −100..+100
priceAdj   = gated, capped market-data term     ≤ ±15 points
score      = clamp(base + priceAdj, −100, +100)
```

The composite deliberately does **not** sum eight weighted numbers. A plain
weighted sum lets a loud, popular, recent, meaningless post score highly on six
dimensions and produce a trade. Here, conviction *scales* direction and cannot
create it: a maximally credible, novel, material post with neutral sentiment
scores ≈ 0, which is correct — that is information, not a trade.

### Bands

| Score | Band |
|---|---|
| ≤ −60 | Strong Bearish |
| −59 … −25 | Bearish |
| −24 … +24 | Neutral |
| +25 … +59 | Bullish |
| ≥ +60 | Strong Bullish |

## The eight dimensions

### Sentiment (−100…+100) — direction

A deterministic finance lexicon with negation, hedging and intensity handling.
Not a language model, for two reasons: an order must never trace back to
generated text, and historical replay is meaningless if the scorer drifts
between runs. The same post always yields the same number, and the UI can show
which terms produced it.

The lexicon is finance-specific. In general English "miss" is neutral and "beat"
is violent; in earnings language they are the two most directional words there
are.

- Phrases beat words: `beats expectations` is scored as a phrase, not as `beats`.
- `denies it will cut guidance` scores positive, not negative.
- `reportedly may raise guidance` is discounted 40% for hedging.
- One extreme term dominates a long mild post — a guidance cut is not diluted
  by three vague positives.

### Materiality (0…100) — could this move fundamentals?

A 20-type event taxonomy (M&A, guidance change, regulatory approval/action,
earnings, short report, contract, legal, capital return/raise, index change,
operational incident, executive change, workforce, product, partnership,
analyst, macro, credit event, general commentary), each with a documented base
score, then adjusted for specificity: concrete figures raise it, vague or
rumoured framing lowers it.

Across a cluster it takes the strongest well-supported reading rather than an
average, so a crowd of vague posts cannot dilute a real event.

### Credibility (0…100) — who is saying it?

Tier does the work:

| Tier | Base | Who |
|---|---|---|
| 1 | 88 | Company accounts, executives, regulators, agencies, exchanges |
| 2 | 72 | Financial journalists, recognised industry experts, specialist publications |
| 3 | 52 | Sell-side analysts, specialist commentators, industry participants |
| 4 | 22 | General accounts, unverified commentary |

**Follower count can never promote a tier.** It contributes a logarithmic term
capped at **5 points**, which is smaller than the gap between any two tiers. A
50-million-follower anonymous account scores below a 1,200-follower regulator,
and there is a test that says so.

Accounts are classified from an explicit allowlist; unknown accounts default to
Tier 4. Very new accounts are penalised (−15 under 30 days).

Across a cluster, credibility takes the **best** source, not the average: one
regulator is not made less credible by a hundred anonymous accounts repeating
them. The crowd's contribution is handled by cross-source confirmation instead.

### Novelty (0…100) — is this new?

Decays with how long the *story* has been circulating, not how old the post is.
The 300th retelling of a two-hour-old story is not novel even if it was posted a
second ago. Stories are clustered by a dedup key built from entities + numeric
facts + event vocabulary, so two accounts reporting the same guidance raise land
in one cluster while a different story about the same company does not.

A cluster that already produced a signal is discounted to 25%: acting on it
again is the same trade twice.

### Engagement velocity (0…100) — is credible attention accelerating?

Measured against **the author's own baseline**, captured at ingest time. A
500-like post from an account that normally gets 20 scores high; the same post
from an account that normally gets 50,000 scores zero. Absolute popularity earns
nothing.

Tier 4 engagement is halved and Tier 3 scaled to 0.8 — a mob is the easiest
thing on X to manufacture. This is the lowest-weighted dimension (0.08) for the
same reason: a tiebreaker, never a driver.

### Cross-source confirmation (0…100) — independent corroboration

Counts distinct **authors**, tier-weighted, not posts:

| Tier | Weight per independent author |
|---|---|
| 1 | 1.00 |
| 2 | 0.80 |
| 3 | 0.45 |
| 4 | 0.10 |

A single source scores **0** — confirmation is by definition about a second
voice. One author posting five times counts once. A hundred anonymous accounts
are worth at most ~10 weighted sources, still less than two journalists plus a
regulator. This is the structural answer to "a story repeated by 100 accounts is
not 100 pieces of evidence"; the filter's duplicate detection removes most of
them before they get this far.

### Price confirmation (−100…+100) — market context, not thesis

Blends momentum, abnormal move (in units of the stock's own recent volatility),
abnormal volume and market-relative return, using Northstar's existing Tiingo
integration. There is no second price vendor.

Two guardrails keep this an X strategy rather than a momentum strategy:

1. **Cap.** It may move the composite by at most ±15 points.
2. **Gate.** It applies only once the X-derived base already clears ±20 points.

Without the gate, quiet days with drifting prices would slowly turn the bot into
a trend follower. With it, market data can corroborate or discount an
information thesis but can never manufacture one. Stale data halves the
contribution; missing data removes it and raises uncertainty.

### Recency (0…100)

Exponential decay on the newest triggering post, six-hour half-life. Events
older than 48 hours cannot trigger a signal at all.

## Weights, and why

| Dimension | Weight | Reasoning |
|---|---|---|
| Credibility | 0.26 | The most common way a social signal goes wrong is trusting an account that had no business knowing anything |
| Materiality | 0.24 | Separates a CEO announcing an acquisition from a CEO posting a photo |
| Cross-source | 0.18 | The main defence against a single fabricated or misread post |
| Novelty | 0.14 | Information already in the tape is not tradable |
| Recency | 0.10 | Real but hours-old still beats minutes-old, but recency alone is near-worthless |
| Engagement | 0.08 | The most gameable dimension on X |

These live in `SIGNAL_CONFIG_V1`, not scattered through the engine, so Trading
Lab can sweep them as an experiment via `deriveSignalConfig`. Each variant gets
its own ID, so signals stay reproducible.

## Uncertainty

Uncertainty is **not** one minus confidence. It measures how thin the evidence
is, independently of how extreme the score is — a −80 signal from one anonymous
account is both strong *and* highly uncertain, and the risk engine needs to see
both facts separately.

Drivers: source thinness, resolution ambiguity, sentiment disagreement between
sources, missing market data, low materiality. The risk engine refuses anything
above 0.6, and the proposal builder applies an uncertainty haircut to position
size.

## Every signal is explained

A persisted `XSignal` carries: ticker, score, band, timestamp, triggering event
IDs, all eight components, a per-component points contribution with prose, the
full evidence list (author, tier, excerpt, URL, weight, sentiment, event type),
supporting evidence, **contradictory evidence**, price-confirmation detail,
independent source count, resolution confidence, uncertainty, and a written
explanation.

The engine never returns an unexplained number. `northstar signals` prints all
of it.

## Re-signalling

The engine will not re-emit a signal for a security when no new evidence has
arrived and the previous signal is under an hour old. Without that guard it
re-scores the same stored events every cycle and floods the analytics sample
with correlated rows, which makes hit rate meaningless. Fresh evidence always
bypasses the interval, and periodic re-evaluation still happens because the exit
engine watches the live signal for reversals.
