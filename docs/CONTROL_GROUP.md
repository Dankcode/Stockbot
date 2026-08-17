# The control group

A backtest result on its own is not evidence. It is one number produced by one strategy on one symbol over one window, and almost any set of rules can produce a good one somewhere. The control group is what turns that number into a claim you can defend.

Stockbot already computes two controls on every algorithm backtest, automatically and unconditionally:

| Built-in control | What it answers |
|---|---|
| **SPY buy-and-hold** | Did this beat owning the market? |
| **Cash** | Did this beat doing nothing at all? |

Those are market-level controls and they are the right floor. This document adds three **same-asset** controls that ship as ordinary strategy files in `algorithms/`, run through the identical engine, fill model, and metrics, and are compared as peer runs.

## The three controls

### 1. `control-buy-and-hold.js` — passive exposure

Buys the tested symbol on the first fillable bar and never sells.

This is usually the hardest benchmark in the set and the one most often skipped. Beating SPY while trading NVDA is not an achievement if NVDA tripled and your strategy captured a third of it. Buy-and-hold on the *traded symbol* strips that drift out of the reported return and leaves only what the rules contributed.

Exposure is ~100% by construction, so judge it on risk-adjusted terms — Sharpe, Sortino, max drawdown — not total return. A strategy that matches buy-and-hold's return at half its drawdown has done real work.

### 2. `control-random-entry.js` — the null hypothesis

Enters and exits on a deterministic seeded pseudo-random schedule that carries no market information.

This is the control that answers the question everything else dances around: *would any sequence of trades with roughly this shape have looked the same on this symbol over this window?*

It is deterministic on purpose. Stockbot caches results by algorithm version, params, symbol, interval, window, bar hash, and fill-model hash. A control that read a real random source would silently break that contract and make cached and fresh runs disagree. Instead it runs a SplitMix32-style mixer over a counter seeded only from `params.seed`, advanced exactly once per bar. Same seed and same bars always produce the same trades — and different seeds produce genuinely different outcomes.

| Param | Default | Effect |
|---|---|---|
| `seed` | `1` | Selects the draw sequence. **Vary this.** |
| `entryProbability` | `0.05` | Per-bar chance of entering when flat. Raise for more trades. |
| `minHoldBars` / `maxHoldBars` | `5` / `20` | Randomized holding period bounds. |

**Never judge against a single seed.** On a 400-bar synthetic series where buy-and-hold returned +153%, ten seeds of this control returned between **−31% and +160%**. One seed beat buy-and-hold outright. If you had run seed 1 and stopped, you would have "discovered" an edge that was pure draw variance.

### 3. `control-fixed-interval.js` — exposure-matched

Buys every `entryEveryBars` bars, holds `holdBars`, ignores price completely.

Where random entry gives you a null *distribution*, this gives you a single reproducible null *path* with a tunable time-in-market. Its job is to separate two claims that strategies routinely conflate:

1. *"My rules pick good moments."* — must beat this control.
2. *"Being in the market ~40% of the time on this symbol paid off."* — this control already does that, with no rules at all.

Tune the params so its `exposurePercent` lands near your strategy's, then compare. Measured on the same synthetic series:

| `entryEveryBars` | `holdBars` | Exposure |
|---:|---:|---:|
| 20 | 8 | 40.1% |
| 10 | 5 | 50.1% |
| 30 | 25 | 83.5% |

An edge only counts if it survives that match.

## Installing them

These are trusted local sources. Save them in the repo root `algorithms/` folder and they load on the next registry refresh (about five seconds) or a server restart — no upload, no restart required for the files themselves:

```text
algorithms/control-buy-and-hold.js
algorithms/control-fixed-interval.js
algorithms/control-random-entry.js
```

They obey every sandbox restriction in the [algorithm contract](../algorithms/README.md): synchronous, deterministic, no imports, no `process`, no network, no dynamic code, no `Math.random`.

## The procedure

Run these in order. Stopping early is how strategies get promoted on evidence they do not have.

**1. Establish the floor.** Backtest your strategy. Read the built-in SPY and Cash columns first. If it loses to Cash, stop — nothing below will save it.

**2. Beat the same asset.** Backtest `control-buy-and-hold` on the same symbol, interval, window, and fill model. Compare return, Sharpe, Sortino, and max drawdown. Identical inputs matter: change any of them and Stockbot correctly treats it as a different run, but you are then comparing two different experiments.

**3. Match the exposure.** Note your strategy's `exposurePercent`. Tune `control-fixed-interval`'s `entryEveryBars` and `holdBars` until its exposure is close, then compare. A strategy that only beats a lower-exposure control has discovered leverage, not skill.

**4. Build the null distribution.** Run `control-random-entry` across at least 10 seeds — 20 is better — holding everything else fixed. Set `entryProbability` and the hold bounds so its trade count is in the neighbourhood of your strategy's.

Your strategy's percentile against that distribution is the actual result. Beating the median is weak evidence. Beating every seed in a 20-seed spread is a real finding worth writing down.

**5. Attribute research separately.** If the strategy reads `research`, repeat step 4 with the session pinned to each single-source plan in turn — `sec-edgar-filings`, `gov-contracts-defense`, `market-news-sentiment` — and with no plan pinned at all. If performance holds up without any research pinned, the research is decoration. See [Research sources](./RESEARCH_SOURCES.md).

## Reading the results honestly

**Every parameter you tried counts as a test.** Twenty parameter sweeps and one that beat every control is roughly what you would expect from twenty coin flips. Stockbot records every run, which makes this checkable — and makes quietly forgetting the nineteen failures harder.

**Same window, same symbol, same fill model, or it is not a comparison.** Slippage and commission are not rounding errors here. A high-turnover strategy and a one-trade control experience completely different fill costs, and a strategy whose edge disappears at realistic slippage never had one.

**A single symbol is an anecdote.** Repeat the full procedure on several unrelated symbols before calling anything a strategy rather than a curve fit.

**Exposure is not free.** `exposurePercent` is the single most-abused number in a backtest. Compare risk-adjusted, exposure-matched, or not at all.

**These controls are also unit tests.** If a control produces an impossible result — buy-and-hold making more than one trade, random entry returning identical numbers across seeds — the bug is in the engine or the fill model, not in the market. That is a feature: a control group that can only ever confirm you is not a control group.
