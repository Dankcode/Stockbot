# Stockbot Algorithm Format

Drop a `.js` file in this folder (or upload one from the **My Algorithms** page) and Stockbot will backtest it against every other installed algorithm on the same symbol, the same real historical bars, and the same time window. Every comparison automatically includes two control groups: **S&P 500 Index (SPY) buy-and-hold** and **Cash**.

## File format

Each algorithm is an ES module with a default export:

```js
export default {
  // Required
  name: "My Strategy",
  signal(context) {
    // return "buy", "sell", or null (do nothing) for each bar
    return null;
  },

  // Optional
  author: "Your name",
  description: "One or two sentences shown in the dashboard.",
  params: { fast: 9, slow: 21 },          // tunable constants, passed back to you
  init(context) { return { myCounter: 0 }; } // build initial state before the run
};
```

`signal` is called once per bar, in order, starting at index 1. Return `"buy"` to enter a position, `"sell"` to exit, or `null`/`undefined` to do nothing.

## The context object

Both `signal(context)` and `init(context)` receive:

| Field        | Type     | Description |
| ------------ | -------- | ----------- |
| `index`      | number   | Current bar index (signal only). Bars before `index` are the only ones you should read — looking ahead is cheating. |
| `bar`        | object   | Current bar: `{ time, open, high, low, close, volume }` (signal only). |
| `bars`       | array    | All bars in the window (split-adjusted, real market data). |
| `closes`     | number[] | Convenience array of closing prices. |
| `params`     | object   | Your `params`, so tuning lives in one place. |
| `state`      | object   | Whatever `init` returned. Mutate it freely between calls. |
| `position`   | object   | `{ qty, entryPrice, entryIndex }` — `qty > 0` means you are long. (signal only) |
| `indicators` | object   | Precomputed, cached indicator series (below). |

### Indicators

Each call returns a full array aligned with `bars` — read your value at `[index]`. Computed once per backtest and cached, so call freely.

| Call | Returns |
| ---- | ------- |
| `indicators.ema(period)`        | Exponential moving average of closes |
| `indicators.sma(period)`        | Simple moving average of closes |
| `indicators.rsi(period = 14)`   | Wilder RSI of closes (0–100) |
| `indicators.atr(period = 14)`   | Wilder Average True Range |
| `indicators.highestHigh(period)`| Highest high of the *previous* `period` bars (excludes current bar) |
| `indicators.lowestLow(period)`  | Lowest low of the *previous* `period` bars (excludes current bar) |

## Backtest rules (identical for every algorithm)

- Long-only, single position at a time. `"buy"` while holding and `"sell"` while flat are ignored.
- Buys invest 95% of available cash at the bar's close; sells liquidate at the close.
- Starting account: $100,000 paper money.
- Bars are real, split-adjusted market data (Alpaca → Polygon → Finnhub).
- Every algorithm in a comparison runs on the exact same bars, so results are directly comparable.
- Metrics reported: total return %, win rate, max drawdown, trade count, final equity.

## Control groups

Two controls are added to every comparison automatically — you don't write them:

- **S&P 500 Index (SPY) — Control**: buy-and-hold SPY over the same window. Beating this is the bar that matters.
- **Cash — Control**: flat $100,000 baseline.

## Minimal template

```js
export default {
  name: "Golden Cross 50/200",
  author: "you",
  description: "Buys the 50/200 SMA golden cross, exits on the death cross.",
  params: { fast: 50, slow: 200 },
  signal({ index, params, indicators, position }) {
    if (index < params.slow) return null;
    const fast = indicators.sma(params.fast);
    const slow = indicators.sma(params.slow);
    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];
    if (position.qty === 0 && crossedUp) return "buy";
    if (position.qty > 0 && crossedDown) return "sell";
    return null;
  }
};
```

## Installing

- **Folder**: save the file in `algorithms/` (this folder). It's picked up within ~15 seconds, or immediately on server restart.
- **Webpage**: My Algorithms → Upload algorithm (.js). Uploaded files land in `algorithms/uploads/` and are validated before being accepted.

## Safety note

Algorithm files are plain JavaScript executed by the local Stockbot server with normal Node permissions. Only install files you wrote or trust — review code from other people before dropping it in.
