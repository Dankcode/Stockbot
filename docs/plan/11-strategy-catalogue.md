# 11 — Strategy catalogue audit, and eight new methods

Run 2026-09-21 against the working tree. Every number below came from executing the code,
not from reading it.

---

## 1. What was already installed

Twelve strategy methods across four packs, plus the horizon pack's twelve horizon-scaled
variants, plus controls.

| Family | Where | Notes |
|---|---|---|
| EMA crossover momentum | `base-methods/ema-momentum`, `horizon-pack/*-ema`, `automation-methods/atr-gated-ema`, `sentiment-pack/gated-momentum` | Four packs, one idea |
| RSI mean reversion | `base-methods/rsi-mean-reversion`, `horizon-pack/*-rsi`, `automation-methods/rsi-trend-rebound` | |
| Donchian breakout | `base-methods/donchian-breakout`, `horizon-pack/*-donchian`, `automation-methods/donchian-channel` | |
| SMA trend stack | `automation-methods/sma-trend-stack` | |
| Time-series momentum | `momentum-pack/time-series-momentum` | Parameterised lookback, now that `series.offset` is an expression |

**The catalogue was three ideas wearing twelve hats.** The horizon pack rescales EMA / RSI /
Donchian across four holding periods, and `automation-methods` re-expresses three of the same
four with different filters. Useful for horizon comparison; it is not breadth of hypothesis.
Every installed entry rule reads a moving average, an oscillator, or a channel.

### Three findings from the audit

**(a) Two installed strategies can never trade on any supported range.** `RANGE_CONFIG`
caps every range at 180 bars (1H=60, 1D=78, 1W=180, 1M=60d, 3M=140d, 1Y=80 weekly, ALL=140
monthly). Resolved warmup at default params:

| Method | Warmup | Ranges leaving ≥30 usable bars |
|---|---:|---|
| `horizon-pack/yearly-donchian` | 252 | **NONE** |
| `horizon-pack/yearly-ema` | 200 | **NONE** |
| `horizon-pack/monthly-ema`, `monthly-donchian` | 55 | 1W, 3M, ALL |
| `horizon-pack/yearly-rsi` | 51 | 1W, 3M, ALL |
| everything else | ≤50 | most or all ranges |

This is the `minBars: 250` failure again, in a different file: a constant chosen from the
literature rather than from the range table, producing a method that silently never trades.
The horizon pack's "yearly" band is two-thirds dead. Either the ranges need to grow or those
two methods need honest warmups.

**(b) Four strategies had no null hypothesis attached.** `automation-methods`'s pairings
listed only cross-symbol buy-and-hold (SPY/QQQ/IWM/DIA). Those answer "better than which
index", not "better than no information", so the percentile column stayed empty and the
verdict could never rise past `below-passive`. `momentum-pack/time-series-momentum` had the
same gap and reported `incomplete` — "the null hypothesis was never tested". **Fixed:** both
packs now pair a seeded random-entry control (and `automation-methods` an exposure-matched
fixed-interval). `time-series-momentum` moved from `incomplete` to `inside noise` — a real
verdict, from a test that now actually runs.

**(c) `automation-methods/rsi-trend-rebound` trades zero times** on the offline series.
Not investigated here; flagging it because a zero-trade method reads as `fails floor` and
looks like a result rather than a wiring problem.

---

## 2. What was added

Two packs, eight methods, all expressible with the current indicator set and no engine change.

### `plugins/exit-lab.plugin.json` — same entry, three different exits

All three share `base-methods/ema-momentum`'s entry rule **exactly**, including its
first-bar bootstrap clause, so running them alongside it attributes the difference to the
exit and nothing else. Nothing in the catalogue tested exits in isolation.

| Method | Exit |
|---|---|
| `ema-trail-percent` | ratcheting percent trail from the highest close since entry |
| `ema-trail-atr` | chandelier: a multiple of ATR(14) below that peak, so the stop scales with volatility |
| `ema-time-stop` | a fixed number of bars, blind to price after entry — deliberately near-control |

The ratchet uses the `action: "none"` mechanism: a first exit rule that updates `peak` and
declines to trade. Rule ordering is only correct because a new high can never also be a
trailing-stop breach.

**A default worth explaining.** At `trailPercent: 10` and `atrMultiple: 3` the trailing stop
fired **zero times** on the offline series — the cross-down exit reached every trade first,
and both arms silently degenerated into the method they were supposed to differ from. The
defaults are 6% and 2.0×ATR because those *bind*. They are not the best-performing values:
10% and 3.0 both scored higher. An exit that never fires is untestable, not conservative.

### `plugins/anomaly-lab.plugin.json` — five entry families the catalogue lacked

| Method | Claim |
|---|---|
| `near-annual-high` | price near its rolling high keeps drifting up — a different claim from trailing-return momentum |
| `squeeze-breakout` | breakouts out of compressed volatility carry further than breakouts out of noise |
| `distance-reversion` | reversion stated in price distance from a moving average, not in an oscillator |
| `price-rsi-divergence` | price lower than N bars ago while RSI is higher, using an exact `ema(1)` close series for the comparison |
| `weekday-effect` | a calendar effect read from the bar timestamp, carrying no price information at all |

Two of these needed fixing before they were worth testing, and both fixes are structural
rather than tuning:

- **`squeeze-breakout` was self-defeating as first written.** Requiring contraction *on the
  breakout bar* is contradictory — the breakout expands short-window ATR. Measured over 550
  bars: the contraction gate was true on 121, the breakout on 21, and both on **1**. The gate
  is now read `gateOffset` bars *before* the breakout, which is what the claim actually says.
- **`near-annual-high` was born dead** at the literature's 252-bar high: warmup 252 against a
  180-bar ceiling, i.e. finding (a) above, committed by me. Defaults are now 60/50 — the
  longest window leaving usable bars on 3M and 1W — with the 252-bar version documented as
  unreachable until windowed backtests exist.

`weekday-effect` is included as a near-null arm on purpose. It makes a published claim, uses
no price information, and any method that cannot beat it is not using price either.

---

## 3. Verification

`node scripts/plugin.js validate` passes on all four touched plugins. `npx tsc --noEmit`
clean. `node --test`: one failure, `test/services/bootstrap.test.js` — "Selection service
requires market bars and a selection universe", which is in the uncommitted
`server/selection/` work and unrelated to these plugins.

Every new method trades, and **every exit rule in all eight fires at least once** on the
offline series — checked explicitly, because a rule that compiles and never fires is the
silent failure mode here:

```
exit-lab/ema-trail-percent      trades= 18  exits: Percent trailing stop from peak | Fast EMA crossed below slow EMA
exit-lab/ema-trail-atr          trades= 18  exits: ATR chandelier stop from peak | Fast EMA crossed below slow EMA
exit-lab/ema-time-stop          trades= 16  exits: Fixed holding period elapsed
anomaly-lab/near-annual-high    trades=  8  exits: Close fell below the trend average
anomaly-lab/squeeze-breakout    trades=  7  exits: Close below the shorter channel low
anomaly-lab/distance-reversion  trades= 16  exits: Price returned to the moving average | Holding period expired
anomaly-lab/price-rsi-divergence trades= 22 exits: RSI recovered to the exit level | Holding period expired
anomaly-lab/weekday-effect      trades=169  exits: Fixed holding period elapsed
```

`scripts/dev/offline-matrix.js` now runs all sixteen strategies (48 arms). Invariants held:
buy-and-hold trades once, 20 random seeds produced 20 distinct outcomes.

**These verdicts are from synthetic bars and are evidence about wiring, not about trading.**
They are recorded so a later run that differs is visibly a change rather than a surprise.

| Method | Verdict on the synthetic series |
|---|---|
| `base-methods/ema-momentum` | clears controls |
| `base-methods/donchian-breakout` | clears controls |
| `exit-lab/ema-trail-percent` | clears controls |
| `exit-lab/ema-trail-atr` | clears controls |
| `exit-lab/ema-time-stop` | clears controls *(42.7pp exposure gap — retune the control before reading it)* |
| `base-methods/rsi-mean-reversion`, `momentum-pack/time-series-momentum`, `anomaly-lab/near-annual-high`, `anomaly-lab/squeeze-breakout` | inside noise |
| `automation-methods/donchian-channel`, `atr-gated-ema` | below passive |
| `automation-methods/sma-trend-stack`, `rsi-trend-rebound`, `anomaly-lab/distance-reversion`, `price-rsi-divergence`, `weekday-effect` | fails floor |

Note that `ema-time-stop` — the arm designed to be nearly a control — clears its controls and
posts the best Sharpe and smallest drawdown of the three exit variants. On a synthetic series
that is a curiosity, but it is exactly the result that should make you distrust the other two
until real data disagrees.

---

## 4. Still not expressible

- **Volume confirmation.** `bar.volume` is readable but every indicator computes over closes
  (`createIndicators` passes `closes` to `sma`/`ema`/`rsi`), so there is no volume average to
  compare against. A volume-confirmed breakout needs one new indicator.
- **Anything cross-sectional.** One symbol per `runBacktest`, single `symbol` in the plan
  schema. See `docs/plan/07-signal-method-prompts.md` P9.
- **z-score / Bollinger / volatility targeting.** No standard-deviation series. See P7.
- **Turn-of-month calendar effects.** Day-of-week is computable from the epoch timestamp;
  day-of-month is not, because months vary in length and there is no calendar function.
- **Pyramiding.** The engine holds one position with no adds.
