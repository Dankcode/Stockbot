# Horizon pack

Twelve strategies — three methods across four holding-period horizons — each with a congruent control group. The question it answers is not "does this method work" but **"at what horizon does this method work, and is the answer just turnover?"**

## Why holding periods, not bar intervals

Stockbot's `barInterval` accepts `1min`, `5min`, `1hour`, `1day`, `1week`, `1month`. There is **no yearly interval**, and provider history for weekly and monthly bars is thin enough that switching intervals would change the *data* as well as the horizon — two variables moving at once, which is not an experiment.

So every variant in this pack reads the **same 1day bars**. "Daily / weekly / monthly / yearly" is the target holding period, expressed through indicator lookbacks and time stops:

| Horizon | Target hold | Character |
|---|---:|---|
| Daily | ~2 bars | Intraday-to-overnight reaction |
| Weekly | ~5 bars | Swing; roughly one trading week |
| Monthly | ~21 bars | Position; roughly one trading month |
| Yearly | ~252 bars | Primary trend; roughly one trading year |

One data requirement, four honest horizons, and yearly actually runs.

## The twelve strategies

| File | Method | Horizon | Params |
|---|---|---|---|
| `horizon-daily-ema.js` | EMA momentum | Daily | fast 3, slow 8, stop 3% |
| `horizon-weekly-ema.js` | EMA momentum | Weekly | fast 9, slow 21, stop 8% |
| `horizon-monthly-ema.js` | EMA momentum | Monthly | fast 21, slow 55, stop 15% |
| `horizon-yearly-ema.js` | EMA momentum | Yearly | fast 50, slow 200, stop 30% |
| `horizon-daily-rsi.js` | RSI mean reversion | Daily | period 3, oversold 25, hold ≤3 |
| `horizon-weekly-rsi.js` | RSI mean reversion | Weekly | period 7, oversold 30, hold ≤10 |
| `horizon-monthly-rsi.js` | RSI mean reversion | Monthly | period 21, oversold 40, hold ≤21 |
| `horizon-yearly-rsi.js` | RSI mean reversion | Yearly | period 50, oversold 45, hold ≤252 |
| `horizon-daily-donchian.js` | Donchian breakout | Daily | entry 5, exit 3, 1.5× ATR(7) |
| `horizon-weekly-donchian.js` | Donchian breakout | Weekly | entry 20, exit 10, 2× ATR(14) |
| `horizon-monthly-donchian.js` | Donchian breakout | Monthly | entry 55, exit 20, 3× ATR(20) |
| `horizon-yearly-donchian.js` | Donchian breakout | Yearly | entry 252, exit 126, 4× ATR(50) |

`algorithms/horizon-pack.json` is the machine-readable manifest of these pairings and the controls each one belongs with. The registry ignores it — only `.js` files in `algorithms/` are loaded as strategies.

**One tuning note worth carrying forward.** RSI compresses toward 50 as its lookback grows, so the oversold trigger has to *rise* with the horizon. An earlier draft used a literal RSI(50) < 30 for the yearly variant and took **zero trades across 1500 bars on every test series** — the condition is close to nonexistent. The thresholds shipped here were raised until each horizon actually trades. They are a fix for a dead variant, not a fitted edge.

## The congruent controls

Two control files cover all four horizons through a `horizon` param:

**`control-horizon-fixed.js`** — buys on a fixed cadence, holds a fixed span, ignores price. Cadence is derived from `dutyCycle` (default 0.4) so exposure stays comparable across horizons while turnover scales with the band.

**`control-horizon-random.js`** — deterministic seeded pseudo-random entries and exits, with entry rate and hold bounds derived from the same band. Vary `seed`.

`control-buy-and-hold.js` from the base control group is horizon-independent and serves as the passive upper bound for all four.

Measured over 1500 synthetic daily bars, the controls track their bands:

| Horizon | Fixed control | Random control (seed 3) |
|---|---|---|
| Daily | 600 trades, 40% exposure | 616 trades, 41% |
| Weekly | 231 trades, 39% | 242 trades, 44% |
| Monthly | 57 trades, 40% | 58 trades, 42% |
| Yearly | 5 trades, 49% | 3 trades, 29% |

**Why this matters more than it looks.** A daily strategy might take 200 trades where a yearly strategy takes 8. Comparing either against one generic random control measures transaction costs and calls the result skill. The control has to trade like the thing it is controlling for.

The same 1500-bar series shows turnover falling cleanly across the bands — daily 199 trades on average, weekly 68, monthly 31, yearly 8. That monotonic drop is what makes the horizons distinguishable; if it ever inverts after you retune params, the pack has stopped measuring horizon.

## Running the matrix

```bash
npm run horizon:matrix -- --symbol NVDA --range 1Y
npm run horizon:matrix -- --symbol NVDA --range 1Y --seeds 20
npm run horizon:matrix -- --symbol NVDA --range 1Y --json > matrix.json
```

It calls the loopback API with the operator token, exactly like `npm run research` — the engine, caching, and provenance are identical to what the dashboard shows. Ranges are the API's own: `1H`, `1D`, `1W`, `1M`, `3M`, `1Y`, `ALL`.

Output is grouped by horizon, each block showing the three methods, that horizon's fixed control, and the median and range of that horizon's random distribution. The `pctile` column is the strategy's percentile against those seeds.

**A row is interesting only when it beats both its own fixed control and the top of its own random range.** Percentile under ~90 is inside the noise.

### Give yearly enough window

The yearly variants use 200–252 bar lookbacks. Over a 1-year range they have almost no bars left to trade after warmup, and the honest reading of a near-empty yearly row is "not enough data," not "this horizon fails."

Use `--range ALL`, or at minimum `1Y` for daily/weekly and several years for monthly/yearly. On the 1500-bar (~6 year) test series the yearly variants took 6–11 trades; on 400 bars they took 0–3.

## Reading the result

The interesting finding is usually not which cell wins. It is the **shape** of the grid:

- **Trend methods** (EMA, Donchian) conventionally improve with horizon. If they don't on your symbol, that is a real finding about the symbol.
- **Mean reversion** (RSI) conventionally decays with horizon. The monthly and yearly RSI variants exist to make you check rather than assume.
- **If every method's best horizon is the same one**, you have probably discovered something about the window — a regime, a drawdown, a single gap — rather than about the methods.

Everything in [Control group](./CONTROL_GROUP.md) still applies, especially: every parameter set you try counts as a test. This pack runs 12 strategies at once, so one of them beating its control at p≈92 is roughly what you would expect from chance alone. Twelve tests need a higher bar than one, and the honest move is to fix the horizon you believe in, then re-run it on several unrelated symbols.
