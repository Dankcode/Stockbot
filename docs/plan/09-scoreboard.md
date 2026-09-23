# 09 — The scoreboard

Four boards, one scale, 0–10.

Stockbot already scores things, but inconsistently: `server/experiments/selection.js` emits
a 0–1 tradeability number with `reasons`, `evidence` and a tie `separation`;
`server/experiments/report.js` emits a categorical verdict and no number at all; session
health is not scored anywhere. The scoreboard makes one grammar out of those and adds the
two boards that don't exist.

---

## 1. Why a number at all, and what it must not become

A score's job here is **ordering and triage** — which of forty candidates to look at first.
It is not a summary of truth, and the moment it is read as one it starts doing damage: a
single number invites comparison between things that aren't comparable, hides how much
evidence sits underneath it, and is trivially gamed by whoever tunes the weights.

Five rules keep it honest. They are the whole design; everything below is application.

**R1 — Gates exclude, they do not score down.** A symbol below the liquidity floor is
reported as *excluded* with the gate named, not given a 2. A thin symbol with a beautiful
trend is untradeable at any realistic slippage, and a 2 invites someone to trade it anyway
because it is the best 2 on the list. `selection.js` already works this way; the other three
boards inherit it.

**R2 — Unmeasured shrinks the denominator; it never defaults.** A component with no data
contributes nothing and the weighted mean is taken over the remaining weight, with the
candidate flagged. Scoring an absent reading as 5/10 invents a fact. Note the footgun
`selection.js` documents: `Number(null)` is `0` and `Number.isFinite(0)` is `true`, so
absence must be checked *before* coercion.

**R3 — Confidence is a separate field and is never blended into the score.** A 7 on four
closed trades and a 7 on two hundred are different claims. Mixing evidence volume into the
number destroys both signals. Carry `confidence: "low" | "medium" | "high"` beside the
score, with the reason, and let the renderer grey out low-confidence rows.

**R4 — A score may never outrank the verdict that produced it.** On the strategy board the
gauntlet remains the source of truth; the score orders *within* a verdict band. It must be
structurally impossible for a `fails-floor` to score above a `worth-recording`, however
flattering its margins. Assert this as a property test, not a convention.

**R5 — No score leaves a scorer without `reasons` and `evidence`.** `reasons` is prose a
human reads; `evidence` is the raw component values the number was computed from. A bare
number is not a permitted return value.

Two consequences worth stating explicitly:

- **Scores are not comparable across boards.** A strategy at 7 and a symbol at 7 share a
  scale but not a meaning. Each board renders its own one-line scale caption.
- **Nothing on any board is a recommendation to trade.** Board A says a rule set beat its
  controls on a window; Board B says a symbol can be measured; Board C says a session is
  behaving as configured. None of them says "buy".

---

## 2. The shared anchors

Every board maps to the same verbal anchors, so "6" means the same *kind* of thing
everywhere even though the inputs differ.

| Score | Anchor | Meaning |
|---:|---|---|
| 0–2 | **Fails a floor** | Hard failure. Do not proceed. |
| 3–4 | **Worse than the null** | Measurable, and beaten by doing nothing / the naive alternative. |
| 5–6 | **Inside noise** | Cannot be distinguished from the null with the evidence available. |
| 7–8 | **Clears its controls** | Beats the relevant null on sufficient evidence, once. |
| 9–10 | **Replicated** | Clears its controls *and* survives independent repetition. |

**The 9-gate.** A single run can score at most **8.0**, on every board. Nine and above
requires independent replication — for a strategy, ≥3 unrelated symbols and ≥2 windows; for
a symbol, stability across ≥2 non-overlapping windows; for a session, ≥30 days clean; for a
plan task, a second reviewer or a second machine reproducing the acceptance evidence. This
is the anti-overfitting rule and it belongs in the scale, not in a footnote, because the
number is what gets quoted.

**Component shapes.** Reuse the two helpers `selection.js` already has, promoted to the
shared module: `ramp(value, floor, ceiling)` for monotone components (more liquidity is
always better) and `band(value, ideal, span)` for components with a good middle (volatility:
too little is untradeable, too much is unmanageable). Bands must be **segmented by asset
class** — the current `band(atrPercent, 2.75, 2.6)` hits zero at 5.35% ATR, so crypto scores
near zero on 25% of the weight for being crypto rather than for being untradeable.

**Ties.** Carry `separation` — the gap between the top two. Inside a threshold, state that
the ordering is arbitrary and say so in words, as `selection.js` already does.

---

## 3. Board A — Strategy (research)

*Scale caption: "how decisively this rule set beat its own control group, on this window."*

The gauntlet in `report.js` runs as ordered early exits. Each verdict owns a score band; the
position **within** the band comes from the margin by which it passed or failed. That
structure is what enforces R4.

| Verdict | Band | Position within band from |
|---|---|---|
| `fails-floor` | 0.0–2.0 | how far below zero the return sat |
| `below-passive` | 3.0–4.4 | Sharpe shortfall vs same-asset buy-and-hold |
| `no-timing-edge` | 4.5–5.4 | return shortfall vs the exposure-matched control |
| `inside-noise` | 5.5–6.9 | percentile against the random seeds, 0–89 → mapped across the band |
| `incomplete` | *unscored* | no random distribution ran; the null was never tested |
| `insufficient-evidence` | capped 5.0 | cleared everything on <5 closed round trips; confidence `low` |
| `worth-recording` | 7.0–8.0 | percentile ≥90 plus risk-adjusted margin over buy-and-hold |
| replicated `worth-recording` | 8.1–10.0 | breadth: how many unrelated symbols and windows it held on |

Components feeding the within-band position — all already computed in `summarizeGroup`:
excess Sharpe over `passive`, excess return over `exposureMatched`, `percentile` against
`randomDistribution`, and the drawdown ratio against buy-and-hold.

Three rules specific to this board:

- **`closedTradeCount` sets confidence, never score.** Below `MIN_CLOSED_TRADES` (5) it also
  triggers the capped verdict — that is the existing behaviour and it stays.
- **An exposure gap past `EXPOSURE_TOLERANCE_POINTS` (10pp) forces confidence to `low`**, with
  the gap in the reason. The comparison is measuring time-in-market, not timing.
- **`incomplete` is not a zero.** It is an absence of measurement and renders as `—`.
  Scoring it invites someone to read "0" as "bad strategy" rather than "no test ran".

---

## 4. Board B — Symbol (tradeability)

*Scale caption: "how well this symbol can be systematically traded and measured — not
whether it will go up."*

Mostly a rescale and a surfacing job: `selection.js` already produces the number, the gates,
the reasons and the separation. Changes:

1. Multiply to 0–10, one decimal, at the presentation boundary only. Keep the internal 0–1.
2. Segment the volatility band by asset class (the crypto trap above).
3. Surface it — today selection is CLI-only with no `/api/v1/selection` route, so no UI can
   show it.
4. Keep `researchCoverage` honest: `research_documents` has **no symbol column**; symbol lives
   on `research_runs`, so coverage needs a JOIN.

**Barred inputs, by your decision of 2026-08-26 and restated here because this is exactly the
place it would erode:** backtest or experiment performance must not feed this score. A
screener that ranks on its own backtests is a tip sheet, and one that selects on the window
it then tests on has look-ahead baked in. Prior verdicts for a symbol may be displayed in an
adjacent column; they may not enter the number.

---

## 5. Board C — Session (operational health)

*Scale caption: "is this session behaving the way it was configured to behave" — not "is it
making money."*

New board; nothing scores this today. Inputs come from the risk engine and session state.

| Component | Weight | Shape |
|---|---:|---|
| Drawdown headroom vs `maxDrawdown.percentFromPeak` | 0.25 | ramp — at the limit is 0 |
| Daily-loss headroom vs `maxDailyLoss.percentOfStartingEquity` | 0.15 | ramp |
| Risk-event rate (blocks + rejections per 100 orders) | 0.20 | inverse ramp |
| Data freshness — `dataStaleness` warnings per session-day | 0.15 | inverse ramp |
| Fill quality — realized vs modelled slippage | 0.15 | band around 1.0 |
| Cadence — evaluations actually performed ÷ scheduled | 0.10 | ramp |

**P&L is deliberately excluded.** A session that made money while breaching its exposure
limit and running on stale quotes is unhealthy, and a health board that rewards it will be
used to justify leaving it running. Return belongs on Board A, where it is measured against
controls.

Two notes: a daily-bar paper session evaluates once per trading day, so give it ≥10
evaluations before scoring at all — `confidence: low` and `—` until then, which is also the
honest answer to why the dashboard looks empty. And a halted session scores `—`, not 0; it
stopped correctly, which is the risk engine working.

---

## 6. Board D — Plan task (delivery quality)

*Scale caption: "was this prompt's acceptance criterion actually demonstrated."*

Not code — a table maintained in `docs/plan/07-signal-method-prompts.md`, scored per prompt.

| Component | Points |
|---|---:|
| The prompt's stated acceptance criterion met, with pasted evidence | 4 |
| Exercised end to end (`npm run experiment:offline` output pasted), not unit tests alone | 2 |
| Tests assert against the real constant (`RANGE_CONFIG`, `INDICATOR_FUNCTIONS`, the 0–512 bound) rather than a hand-picked fixture | 1 |
| A falsifiable negative case included — an input that MUST be rejected | 1 |
| Invariants still hold: buy-and-hold trades once; 20 seeds → 20 distinct outcomes | 1 |
| No source changed outside the files the prompt named | 1 |

**Hard cap: 5.0 without the end-to-end row.** This encodes the rule the codebase learned the
expensive way — 42 passing tests and a clean typecheck shipped an experiment engine with
seven live bugs, one of which (`minBars: 250` against a `RANGE_CONFIG` ceiling of 180) made
the AI-selection path incapable of ever returning a candidate. Green unit tests are not
evidence a feature works.

---

## 7. Where it lives

```
server/scoring/scale.js      anchors, ramp, band, weighted mean with shrinking
                             denominator, confidence, separation, the 9-gate. ONE copy.
server/scoring/strategy.js   Board A — consumes summarizeGroup() output
server/scoring/symbol.js     Board B — thin adapter over selection.js scoring
server/scoring/session.js    Board C — consumes risk engine + session state
scripts/scoreboard.js        npm run scoreboard -- --board strategy|symbol|session
server/http/routes/scoreboard.js   GET /api/v1/scoreboard/:board
```

Persist Board A and C results so trends are visible rather than recomputed each view; Board
B is cheap and can be computed on demand. Board D is markdown.

The renderer prints score, confidence, and the first reason **on the same line**. A score
rendered alone is the failure mode this whole document exists to prevent.
