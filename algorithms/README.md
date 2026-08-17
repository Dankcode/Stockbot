# Stockbot Algorithm Format

Stockbot algorithms are small, synchronous JavaScript modules that emit long-only entry and exit signals. Download the **Starter file** from the **Strategies** page, edit it, and upload the finished `.js` file from the same page. Trusted local modules may also be saved in this folder. Every accepted source version is hashed and stored so a backtest or paper session remains attributable to the exact code it ran.

Backtests use real historical bars only and include two controls: **S&P 500 Index (SPY) buy-and-hold** and **Cash**.

## File format

Each algorithm is an ES module with one default-exported object:

```js
export default {
  // Required
  name: "My Strategy",
  signal(context) {
    // "buy", "sell", { action, reason, confidence }, or null
    return null;
  },

  // Optional
  author: "Your name",
  description: "One or two sentences shown in the dashboard.",
  params: { fast: 9, slow: 21 },
  init(context) {
    return { signalsSeen: 0 };
  }
};
```

`signal` is called once per closed bar, in order, starting at index `1`. It must return synchronously:

- `"buy"` or `{ action: "buy", reason?, confidence? }`
- `"sell"` or `{ action: "sell", reason?, confidence? }`
- `null` or `undefined` to do nothing

`reason` is retained with the order for session timelines and exports. `confidence` must be numeric when supplied; Stockbot records it but does not reinterpret it as position size. Async functions and returned promises are rejected.

## Context

`signal(context)` receives:

| Field | Type | Description |
|---|---|---|
| `index` | number | Index of the current closed bar. |
| `bar` | object | Current `{ time, open, high, low, close, volume }` bar. `time` is UTC epoch milliseconds. |
| `bars` | array | Bars from the beginning of the window **through `index` only**. Future bars are not exposed. |
| `closes` | number[] | Closing prices through `index` only. |
| `params` | object | Default `params` merged with the run's overrides, then frozen. |
| `state` | object | The object returned by `init`; it persists between calls within one run. |
| `position` | object | `{ qty, entryPrice, entryIndex }`; `qty > 0` means the strategy is long. |
| `indicators` | object | Cached indicator functions whose returned arrays end at `index`. |
| `research` | object or null | Frozen point-in-time research frame for a pinned plan, or `null` when the session has no research plan. |

`init(context)` runs once before the first signal and should return a plain state object. It receives `params` and an empty bar/close history so initialization cannot inspect the run's future. Keep both `init` and `signal` deterministic: do not depend on wall-clock time, randomness, network state, or mutable global state.

### Indicators

Indicator arrays align with `bars`; read the current value at `[index]`.

| Call | Result |
|---|---|
| `indicators.ema(period)` | Exponential moving average of closes |
| `indicators.sma(period)` | Simple moving average of closes |
| `indicators.rsi(period = 14)` | Wilder-style RSI, from 0 to 100 |
| `indicators.atr(period = 14)` | Wilder Average True Range |
| `indicators.highestHigh(period)` | Highest high from the preceding `period` bars; current bar excluded |
| `indicators.lowestLow(period)` | Lowest low from the preceding `period` bars; current bar excluded |

Series are computed once per run and cached. The facade still returns only the prefix visible at the current index.

### Point-in-time research

A session may pin one immutable AI research plan version. For a pinned plan, `research` is one of:

```js
{
  status: "available",
  symbol: "AAPL",
  decisionAt: 1786200000000,
  snapshot: {
    id: "snapshot-id",
    availableAt: 1786190000000,
    expiresAt: 1786210000000,
    summary: {
      overview: "Source-supported summary",
      keyDrivers: ["Driver"],
      risks: ["Risk"],
      opportunities: ["Opportunity"],
      sentiment: "neutral",
      confidence: 0.7
    },
    sources: [/* immutable source provenance */]
  }
}
```

or `{ status: "unavailable", symbol, decisionAt, reason }`. An unpinned session receives `null`. When the plan declares `delivery.required: true`, the engine skips `signal()` for a bar that has no eligible, unexpired snapshot; an optional plan calls `signal()` with the explicit unavailable frame.

Selection is free of lookahead: a snapshot is visible only when its symbol matches, `availableAt <= decisionAt`, and it has not expired. Although `signal()` evaluates a fully closed bar, `decisionAt` is conservatively the bar's canonical timestamp (`bar.time`, generally its open), not the later callback or close time. Research that arrives during a bar waits until the next bar. Backtests use only previously archived SQL snapshots and never run a scraper or AI model to manufacture historical knowledge. The selected snapshot id is retained on algorithm-generated paper orders and archived backtest trades/fills.

The AI summary is context, not an order. It has no action, quantity, or execution fields. Your reviewed JavaScript remains responsible for returning a signal:

```js
signal({ research, position }) {
  if (!research || research.status !== "available") return null;
  const { sentiment, confidence } = research.snapshot.summary;
  if (position.qty === 0 && sentiment === "bullish" && confidence >= 0.8) {
    return { action: "buy", reason: `Archived research ${research.snapshot.id}` };
  }
  return null;
}
```

See [AI research](../docs/AI_RESEARCH.md) for plan configuration, provenance, and pinning.

## Fill and portfolio rules

The execution sequence is deliberate:

```text
bar N closes → signal is evaluated → order becomes pending → bar N+1 opens → fill
```

- A signal never fills on its own bar's close.
- A signal emitted by the final bar is reported as `unfilledSignal`; Stockbot does not invent a next price.
- Runs are long-only with one position per algorithm/symbol. A buy while long or sell while flat is ignored.
- A buy uses up to 95% of available cash in the standalone backtest engine. Runtime risk profiles can impose a smaller size.
- Sells close the full position.
- The fill model applies directional basis-point slippage, fixed commission, per-share commission, and quantity precision. The `/api/v1/algorithms/:id/backtest` endpoint defaults to 5 bps slippage unless a model is supplied.
- An open position is marked to the final real close; it is not force-sold at the end of the window.
- Starting equity is `$100,000` for algorithm backtests.

The strategy API uses normal dollar/share numbers inside the worker. Persistent API records use integer cents and micro-shares.

## Controls and metrics

Every algorithm backtest includes:

- **S&P 500 Index (SPY) — Control**: buy and hold real SPY bars over the requested range
- **Cash — Control**: unchanged `$100,000` equity

The result panel shows checked controls for the strategy, SPY, and Cash. Unchecking a method hides its comparison column only; the backend still calculates and records all three methods for a consistent result.

Those two are market-level controls. Three **same-asset** controls also ship in this folder as ordinary trusted local strategies, so they run through the identical engine, fill model, and metrics and are compared as peer runs:

- `control-buy-and-hold.js` — buys once, never sells. The same-asset benchmark, and usually the hardest one to beat.
- `control-fixed-interval.js` — buys every N bars and holds M bars, ignoring price. Tune N and M to match your strategy's `exposurePercent`.
- `control-random-entry.js` — deterministic seeded pseudo-random entries and exits. Vary `seed` across 10–20 runs to build a null distribution; judging against a single seed is how draw variance gets mistaken for an edge.

All three are deterministic by design. None calls `Math.random`, because a nondeterministic control would break the result cache described below and make cached and fresh runs disagree. See [Control group](../docs/CONTROL_GROUP.md) for the comparison procedure.

> [!IMPORTANT]
> **These `.js` files are superseded by JSON plugins.** Every method below now exists in `plugins/*.plugin.json` as `stockbot.plugin.v1` data, verified to reproduce the `.js` original trade-for-trade across 39 configurations. Both paths load, so until you delete the superseded files each method appears twice in the Strategies list. See [Plugin format](../docs/PLUGIN_FORMAT.md) for the migration command. Uploaded `.js` strategies are unaffected — the plugin format does not replace the upload path, it adds a safer one for *sharing*.

Two packs of strategies also live in this folder, each with controls matched to it:

- **Horizon pack** — `horizon-{daily,weekly,monthly,yearly}-{ema,rsi,donchian}.js`, twelve variants on the same `1day` bars where the horizon is the target holding period (~2, ~5, ~21, ~252 bars). Matched controls are `control-horizon-fixed.js` and `control-horizon-random.js`, both taking a `horizon` param. `horizon-pack.json` is the manifest of pairings; the registry ignores it because only `.js` files are loaded. See [Horizon pack](../docs/HORIZON_PACK.md).
- **Sentiment pack** — `sentiment-gated-momentum.js` reads the point-in-time `research` frame and enters only on bullish, confident summaries; `control-sentiment-blind.js` runs identical rules with no research at all. See [Sentiment pack](../docs/SENTIMENT_PACK.md).

Pair each strategy with the control built for it. Comparing a yearly strategy against a daily control measures turnover and slippage, not skill.

The result includes total return, interval-aware Sharpe and Sortino ratios, positive-magnitude maximum drawdown, profit factor, win rate, trade count, exposure, average trade, and final equity. `profitFactor` is `null` when there are no losses, and `winRate` is `null` when there are no closed trades.

Results are cached by algorithm version, parameters, symbol, interval/window, real-bar hash, and fill-model hash. Changing any of those inputs produces a new run.

## Minimal example

```js
export default {
  name: "Golden Cross 50/200",
  author: "you",
  description: "Enters on a 50/200 SMA golden cross and exits on the death cross.",
  params: { fast: 50, slow: 200 },

  signal({ index, params, indicators, position }) {
    if (index < params.slow) return null;

    const fast = indicators.sma(params.fast);
    const slow = indicators.sma(params.slow);
    const crossedUp = fast[index - 1] <= slow[index - 1] && fast[index] > slow[index];
    const crossedDown = fast[index - 1] >= slow[index - 1] && fast[index] < slow[index];

    if (position.qty === 0 && crossedUp) {
      return { action: "buy", reason: "50-day SMA crossed above 200-day SMA" };
    }
    if (position.qty > 0 && crossedDown) {
      return { action: "sell", reason: "50-day SMA crossed below 200-day SMA" };
    }
    return null;
  }
};
```

## Installing and versioning

### Trusted folder

Save reviewed source as `algorithms/my-strategy.js`. Files in this root folder are treated as trusted local code and loaded during registry discovery. They appear on the next registry refresh (normally within about five seconds) or after a server restart.

### Browser upload

Download [`public/stockbot-strategy-template.js`](../public/stockbot-strategy-template.js), edit and rename it, set the API mutation token for the current browser tab, then choose **Strategies → Upload .js**. The upload flow writes accepted files to `algorithms/uploads/`. The equivalent API is `POST /api/v1/algorithms` with `{ filename, source, overwrite? }`.

Uploads are limited to 500,000 bytes, validated in a worker before installation, and moved into place atomically. Overwriting does not erase history: a new `algorithm_versions` row stores the changed source hash and snapshot, while existing sessions remain pinned to their original version.

## Sandbox and source restrictions

Uploaded algorithms execute in a worker thread with memory limits, a task timeout, disabled string/Wasm code generation, and no injected filesystem, network, or environment APIs. Static validation conservatively rejects executable references to:

```text
import  require  process  globalThis  eval  Function
```

Practical consequences:

- use only the context and standard arithmetic/array/object operations
- do not import npm or Node modules
- do not access environment variables, files, sockets, or subprocesses
- do not generate code dynamically
- keep `init` and `signal` synchronous and computationally bounded

This sandbox limits accidents and common capability escapes; it is not a formal security boundary for malicious JavaScript. Review code from other people before uploading it. Files manually placed in the trusted root `algorithms/` deserve extra care because registry discovery loads them as trusted local source.

For app setup, providers, persistence, and API authentication, see the [project README](../README.md).
