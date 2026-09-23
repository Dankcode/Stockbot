# 07 — Signal methods worth adding

Scope: **signal generation only.** Validation methodology, execution/sizing and the
`stockbot-alpha` merge are named where they block a method, but are not planned here.

Everything in "what the surface can do" was verified against this repo on 2026-09-20 by
compiling a probe plugin and running it through the real `compileMethod` → `runBacktest`
path, not by reading the code. The probe is in the appendix.

---

## 1. What a `rules.v1` method can express today

**Indicators** (`server/engine/indicators.js`, gated by `INDICATOR_FUNCTIONS` in
`method-engine.js`): `ema`, `sma`, `rsi`, `atr`, `highestHigh`, `lowestLow`. That is all.

**Expression** (`server/plugins/expression.js`): arithmetic, comparison, `and`/`or`/`not`/
`if`, `crossesAbove`/`crossesBelow`, `lookup`, and readers for `param`, `const`, `state`,
`bar`, `position`, `series`, `var`, `research`.

Three non-obvious capabilities that widen the surface considerably — all verified:

| Trick | How | Verified |
|---|---|---|
| **Lagged price** | `ema` with period 1 returns the close series exactly, so `{"series":{"name":"px","offset":60}}` is "the close 60 bars ago" | max abs error vs `bar.close` = **0** over 600 bars |
| **Ratcheting state** | a first exit rule with `action:"none"` and a `set` block updates state and declines to trade; placing it under `close > peak` is safe because a new high can never be a trailing-stop breach | tightening `trailPercent` 12 → 4 moved trades 14 → 19 and produced `Trailing stop from peak` exits |
| **Derived constants** | `derived` evaluates in declaration order and can reference earlier entries, so a horizon expands into a hold span without repeating arithmetic in every rule | compiles; used by the horizon pack |

**Four hard ceilings.** Each blocks a specific method below:

1. `series.offset` is read with `Number(operand.offset ?? 0)` — **not** evaluated as an
   expression. A lookback cannot be a param, so it cannot be swept. (Blocks #1's sweep.)
2. No standard-deviation series. No z-score, no Bollinger, no realized-vol target. ATR is
   the only dispersion measure available. (Blocks #7.)
3. Indicator periods resolve once at `init` from params/derived, so no period can depend on
   `barsSinceEntry`. A true chandelier exit (highest high *since entry*) is out; a
   fixed-lookback trailing stop is in.
4. One symbol per `runBacktest` call, and the experiment plan schema pins a single
   `symbol`. Nothing cross-sectional is expressible at any price. (Blocks #9.)

Also worth knowing: a signal may return `confidence`, it is stored on the fill, and
`runBacktest` never reads it — every entry is `positionFraction` (0.95) of cash.

---

## 2. Ranked methods

Ranking is **evidence quality × fit to this codebase ÷ build cost**. None of these is a
prediction of profit; each is a hypothesis the control-group gauntlet exists to reject.

### Tier 1 — expressible today, zero engine changes

**#1 Time-series (absolute) momentum.** *Buy when today's close exceeds the close N bars
ago and sits above a long trend average; exit on the flip.* This is the single
most-replicated systematic family in the public literature (Moskowitz–Ooi–Pedersen 2012
and the trend-following replications since), and it is **not** what's installed:
`ema-momentum` is a 9/21 crossover, which is a smoothing artifact, not a lookback return.
Adding it gives the gauntlet a genuinely different treatment arm to reject.
Controls: `buy-and-hold` (mandatory — this family is long-biased) plus `fixed-interval`
tuned to match exposure.
Caveat: without ceiling #1 fixed you can only test *one* lookback per method id, so ship it
as three ids (63 / 126 / 252 bars) or fix #6 first.

**#2 Regime gate on the existing mean-reversion method.** `rsi-mean-reversion` currently
fires in every regime; on the offline series it lands at **fails floor**. Mean reversion is
regime-dependent, so gate entries on `close < SMA(trendPeriod)` (buy dips only in
non-uptrends) or the reverse, and make the gate a param so both directions are arms of one
experiment. Cheapest real improvement in this list: one `and` clause.

**#3 Ratcheting trailing stop as a shared exit block.** Every installed method exits on a
fixed percentage from *entry*, which gives back the whole excursion on a winner. The ratchet
verified above trails from the running peak. Apply it as a variant of each existing method
so the experiment measures the exit change in isolation, with the unmodified method as its
own control. Highest expected improvement per line changed.

**#4 Volatility-band entry gate.** `atr / close * 100` inside `[minAtrPercent,
maxAtrPercent]`. Screens out both dead names and ones whose stops cannot survive normal
noise. Note the band mis-scores crypto (see `stockbot_symbol_selection`) — segment the
defaults by asset class or crypto arms will silently gate themselves off.

**#5 Donchian exit repair.** `donchian-breakout` enters on an N-bar high and exits on a
fixed percentage — the asymmetry is why it reads **fails floor** offline. The classic form
exits on an M-bar `lowestLow` (M < N). Both indicators already exist; this is a rules edit.

### Tier 2 — one named engine change each, then expressible

**#6 Make `series.offset` an expression.** In `expression.js`, evaluate `operand.offset`
through `recurse` before the integer check, keeping the 0–512 bound and the
never-add-only-subtract rule. Unlocks parameter sweeps of the lookback — the single most
important parameter of the best-evidenced family in this list. Smallest change, largest
unlock.

**#7 Add `stdev` to the indicator set.** A `stdevSeries(values, period)` in
`indicators.js`, exposed in `createIndicators` and added to `INDICATOR_FUNCTIONS`. Unlocks
z-score mean reversion, Bollinger bands, and — with Tier 3 sizing — volatility targeting,
which is the change that most reliably improves risk-adjusted return in published trend
research.

**#8 Let `confidence` size the position.** The plumbing is already there on both sides; only
`recordFill` ignores it. Turns every method above into a graded rather than binary signal.
Note this crosses into execution/sizing — out of the scope chosen for this doc, listed so it
isn't rediscovered later.

### Tier 3 — real architecture first

**#9 Cross-sectional momentum / relative strength.** Best evidence quality of anything here,
and entirely blocked by ceiling #4: it needs multi-symbol fan-out in `runBacktest` and in the
experiment plan schema. Two traps already documented: the look-ahead bias of screening on
today's most-actives and backtesting on history (label screen-sourced picks
forward-test-only), and the absence of a real universe (`stockbot_symbol_selection`).

**#10 News / filing drift.** `stockbot-alpha` already has the point-in-time feed layer,
`assertNoLookAhead`, and `news-drift.js`, but nothing in `server/` reads it. Note that the
sidecar README's claim that "the legacy engine does none of these" is now **stale** —
`server/engine/backtest.js` already fills at the next bar's open and charges slippage and
commission. The remaining gap is the feed layer, not the fill model.

---

## 3. How to test each one

No sandbox can reach market data — `data.alpaca.markets`, `api.polygon.io` and `finnhub.io`
all fail from both the VM and the cloud container. So the ladder is four rungs, and the first
three need no network at all.

**Rung 1 — does it compile and is it schema-valid?**

```bash
node scripts/plugin.js validate --file plugins/<name>.plugin.json
```

**Rung 2 — does it trade, and do the rules actually fire?** Drop the plugin in `plugins/`,
then:

```bash
npm run experiment:offline -- --bars 600 --seeds 20
```

Synthetic bars with three deliberate regimes, through the real engine, fill model, metrics,
planner and verdict code. What this proves is mechanical, not financial. Read two things:
the **invariants** line at the bottom (buy-and-hold trades once; 20 seeds produce 20 distinct
outcomes), and whether *each of your exit reasons appears at all* — an exit rule that never
fires is the most common silent failure in a rules method.

**Rung 3 — does it survive the whole API path?** `scripts/dev/integration-server.js` runs the
real API against an injected synthetic market service. Boot and test must share **one**
`device_bash` call; background processes do not survive between calls.

**Rung 4 — real data, on Leon's machine only.** One command, dry-run first:

```bash
npm run experiment -- run --symbol SPY --all-strategies --seeds 20 --range 1Y --json
```

Then `--auto` for the recommend-and-confirm selection path.

**Per-method acceptance criteria**

| # | Fires correctly when… | Rejected if… |
|---|---|---|
| 1 | entries cluster in the synthetic up-trend regime and stop in the down regime | it trades uniformly across all three regimes — the lookback isn't being read |
| 2 | gated and ungated arms differ in trade count | identical counts — the gate is always true |
| 3 | `Trailing stop from peak` appears in exit reasons and tightening the trail raises trade count | the reason never appears |
| 4 | a low-ATR synthetic stretch produces no entries | entry count unchanged by the band |
| 5 | exits land on the M-bar low, not a fixed distance from entry | — |

---

## 4. What "it worked" has to mean

The gauntlet in `server/experiments/report.js` already encodes this; use it rather than
eyeballing a return number.

- `fails-floor` → `below-passive` → `no-timing-edge` → `inside-noise` →
  `insufficient-evidence` (<5 closed round trips) → `worth-recording`, as ordered early exits.
- **Never judge against one random seed.** On a 400-bar series where buy-and-hold returned
  +153%, ten seeds of the random control spanned −31% to +160%.
- **Match exposure before believing a comparison.** The offline run flags an exposure gap in
  percentage points; a 26pp gap invalidates the row.
- `RANGE_CONFIG` caps any range at 60–180 bars, so a single run cannot support Sharpe or
  drawdown honestly. 180 bars is also why absolute bar-count gates silently exclude
  everything — gate on *coverage of the requested window* instead.
- One symbol over one window is an anecdote. Repeat on unrelated symbols before the word
  "strategy".

---

## 5. Decisions needed

1. **#1 as three fixed-lookback ids now, or fix #6 (`series.offset`) first and ship one
   sweepable method?** Fixing first is ~30 lines and avoids three near-duplicate ids.
2. **#3 as variants of the existing methods, or as a shared exit block in the schema?**
   Variants are testable immediately; a shared block needs a `rules.v1` schema addition.
3. **Does #8 (confidence-scaled sizing) belong in this pass?** It changes every result in the
   cache, so it is cleaner before the new methods land than after.

---

## Appendix — the verified probe

Compiles, validates (`OK probe-pack@0.0.1`), and on 600 synthetic bars with
`trailPercent: 4` produced 19 trades, 9 closed, exits from both `Momentum flip` and
`Trailing stop from peak`. Numbers from synthetic data prove wiring, not edge.

```jsonc
{
  "id": "probe-tsmom", "role": "strategy", "horizon": "daily",
  "params": { "lookback": 60, "trendPeriod": 100, "trailPercent": 12,
              "maxHoldBars": 250, "minAtrPercent": 0.3, "maxAtrPercent": 6 },
  "method": {
    "kind": "rules.v1",
    "warmup": { "param": "trendPeriod" },
    "state": { "peak": 0 },
    "indicators": {
      "px":    { "fn": "ema", "period": 1 },                        // == close series
      "trend": { "fn": "sma", "period": { "param": "trendPeriod" } },
      "atr":   { "fn": "atr", "period": 14 }
    },
    "derived": { "trailFrac": { "div": [{ "param": "trailPercent" }, 100] } },
    "entry": [{
      "when": { "and": [
        { "gt":  [{ "bar": "close" }, { "series": { "name": "px", "offset": 60 } }] },
        { "gt":  [{ "bar": "close" }, "trend"] },
        { "gte": [{ "div": [{ "mul": ["atr", 100] }, { "bar": "close" }] }, { "param": "minAtrPercent" }] },
        { "lte": [{ "div": [{ "mul": ["atr", 100] }, { "bar": "close" }] }, { "param": "maxAtrPercent" }] }
      ]},
      "set": { "peak": { "bar": "close" } },
      "reason": "Momentum above trend, inside volatility band"
    }],
    "exit": [
      { "when": { "gt": [{ "bar": "close" }, { "state": "peak" }] },
        "set": { "peak": { "bar": "close" } }, "action": "none", "reason": "ratchet peak" },
      { "when": { "lte": [{ "bar": "close" },
                  { "mul": [{ "state": "peak" }, { "sub": [1, { "const": "trailFrac" }] }] }] },
        "reason": "Trailing stop from peak" },
      { "when": { "gte": [{ "var": "barsSinceEntry" }, { "param": "maxHoldBars" }] },
        "reason": "Time stop" },
      { "when": { "lt": [{ "bar": "close" }, "trend"] }, "reason": "Momentum flip" }
    ]
  }
}
```

`offset: 60` is a literal because of ceiling #1. Making it `{ "param": "lookback" }` throws
`series offset must be an integer from 0 through 512` — confirmed, not assumed.
