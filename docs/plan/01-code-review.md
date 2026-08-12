# Stockbot — Code Review

Reviewed at commit `d7edaf8` ("new algorithm dashboard"). Scope: `server/index.js` (2,007 lines), `src/main.tsx` (3,206 lines), `src/styles.css` (3,049 lines), `algorithms/`, `src/strategy`, `src/control`.

Findings are ranked by severity. Every finding cites the line it lives on and the fix it needs.

**The headline:** the engine underneath is good. The indicator math, the pluggable algorithm format, the provider fallback chain, and the control-group comparison are all sound ideas, well executed. What undermines them is that a second, synthetic data path runs in parallel with the real one and is labelled `"real"`, and the backtest fill model doesn't match the paper fill model. Fix those two things and every number in the app becomes trustworthy. Don't refactor anything until they're fixed — you'd be preserving the bugs in nicer packaging.

---

## Severity legend

| | Meaning |
|---|---|
| **C** | Critical — produces wrong numbers or loses data. Fix before anything else. |
| **S** | Security — exploitable on your LAN today. |
| **P** | Performance — degrades under normal use. |
| **M** | Maintainability — slows every future change. |

---

## C1 — Synthetic market data is stamped `dataStatus: "real"`

**Where:** `server/index.js:347` (`getCandles`), `:380` (`getDiagnostics`), `:1205` (`getAlgorithmTrades`), `:1318` (`buildMarketAsset`), `:1343`, `:1346`.

`getCandles()` manufactures 79 candles per asset from `Math.sin`/`Math.cos`:

```js
const rhythm = Math.sin(point / 5 + index * 1.7) * 0.008;
const micro  = Math.cos(point / 2.8 + index) * 0.004;
```

`buildMarketAsset()` attaches those candles to every `Asset` and then sets `dataStatus: "real"` on line 1343. The frontend's `hasRealMarketData()` (`src/main.tsx:225`) checks exactly that field, so it trusts the synthetic series. `spark` (line 1346) is likewise sine-wave drift.

Three consequences:

1. **Two contradictory candle sources.** Real bars arrive through a completely separate path — `GET /api/market/bars/:symbol` → `realBars` state (`src/main.tsx:2030`). `asset.candles` is fake, `realBars[symbol:range]` is real, and both are in scope in the same component. Which one a given panel reads is currently a coin flip.
2. **`getDiagnostics` (`:380`) is not RSI.** It computes `rsi = 38 + (gains / 14) * 38 + clamp(...) * 2.2` — a made-up formula, applied to made-up candles. Meanwhile `rsiSeries()` at `:906` is a correct Wilder RSI, used only by the algorithm engine. The dashboard shows the fake one.
3. **`getAlgorithmTrades` (`:1205`) fabricates trades.** Four hardcoded entries at candle indices `12 + (index % 4)`, `31 + (index % 5)`, … with invented `confidence` values from `Math.sin`. These render as BUY/SELL markers on the chart, indistinguishable from real backtest markers.
4. **`GET /api/strategies` (`:1902`) returns 100 lines of hardcoded metrics** — `maxDrawdown: -2.1, winRate: 61, sharpe: 1.74` and so on, invented at authoring time. It happens to be dead code (nothing in `src/` calls it), so delete it rather than fix it. Worth noting because it's the same instinct as the other three, and dead endpoints returning plausible-looking fake data have a way of getting wired up later by mistake.

The README states "All charts render real market bars" and "does not invent buy/sell markers." Both claims are currently false.

**Fix:** delete `getCandles`, `getDiagnostics`, `getAlgorithmTrades`, and the `spark` generator. Reduce `Asset` to quote-only fields (price, previousClose, change, volume, provenance). Make `/api/market/bars` the single source of series data, and compute diagnostics from those bars with the existing `createIndicators()` (`:957`). If a provider can't supply bars, return the unavailable state that's already modelled — never a substitute.

---

## C2 — The backtest fills on the signal bar's own close

**Where:** `server/index.js:1020–1023`, and the same pattern at `:820` in `backtestStockbotMomentum`.

```js
const signal = algorithm.signal({ index, bar, ... });   // bar includes bar.close
if (signal === "buy" && qty === 0) {
  const notional = cash * 0.95;
  qty = notional / bar.close;                            // fills at that same close
```

The algorithm is handed the current bar — including its close — and then filled at that close. In live trading you cannot know a bar's close until the bar is over, so by definition you cannot transact at it. Every strategy in the app gets a free look at the price it trades at.

This is subtle and it inflates results systematically, most severely for the mean-reversion and breakout strategies where the entry decision *is* a function of the close. `algorithms/README.md` warns authors that looking ahead is cheating, then the engine does it on their behalf.

**Fix:** fill at the **next bar's open**. Signal on bar `i`, execute at `bars[i+1].open`, skip the signal if `i+1` doesn't exist. This is one of the highest-value changes in this document — it costs ~15 lines and it's the difference between backtest numbers that predict paper results and numbers that don't.

---

## C3 — Backtest and paper trading use different fill models

**Where:** backtest `server/index.js:978`; paper `:1815`.

The backtest fills at `bar.close` with **zero commission and zero slippage**, and always sizes at `cash * 0.95` (`:1020`). The paper broker fills at `asset.price` from a 30-second-stale quote cache (`:74`), also with no costs, at whatever qty the caller passes.

The entire premise of the app is comparing an algorithm against controls and against live paper performance. Those comparisons are apples-to-oranges while the two engines disagree about what a fill is.

**Fix:** one `FillModel` module used by both paths — configurable slippage (bps or ATR fraction), commission, and a fill-price rule. Persist the model's parameters with each session so a stored result can always be reproduced.

---

## C4 — Paper orders have no market-hours or quote-freshness gate

**Where:** `server/index.js:1815–1830`.

```js
if (asset.dataStatus !== "real") { return 503; }
const notional = Number((qty * asset.price).toFixed(2));
```

`dataStatus === "real"` only means a provider answered at some point in the last 30 seconds of cache. There's no check that the market is open, that the quote isn't Friday's close being filled on a Sunday, or that the price is within a sanity band of the last known price. A bot left running over a weekend fills every order at the same frozen price and reports a flat, tidy P&L that means nothing.

**Fix:** reject fills unless (a) the quote timestamp is within a configurable freshness window, (b) the market session is open for that asset class, and (c) the price is within N% of the prior tick. These become the first three rules of the risk engine (see `03-runtime-risk-alerts`).

---

## C5 — Account state is in-memory; a restart erases everything

**Where:** `server/index.js:60`.

```js
const account = { cash: 100000, buyingPower: 100000, realizedPnl: 0, orders: [], positions: {} };
```

Cash, positions, orders, and realized P&L live in a module-scope object. `npm run dev` restarting on a file save wipes your entire trading history. There is no session concept at all — you cannot answer "how did last Tuesday's run compare to today's."

This is the reason for the SQL layer, and it's specified in `02-architecture.md`.

---

## C6 — Read-modify-write race on `account`

**Where:** `server/index.js:1819` then `:1837`; same shape in `/api/failsafe/liquidate` at `:1875`.

```js
const asset = await getAsset(symbol);        // network I/O — yields the event loop
...
if (notional > account.cash) { return 400; } // check
...
account.cash -= notional;                    // mutate
```

The `await` between the balance check and the balance mutation is a network round-trip. Two concurrent buy requests both pass the check against the same `account.cash`, then both debit it — cash goes negative and the position sizes are wrong. The failsafe liquidate has the same window, and it's the one endpoint that must never misbehave.

**Fix:** serialize all account mutations through a single async queue (or, once C5 lands, a database transaction with the balance check inside it). Fetch the quote *before* entering the critical section.

---

## C7 — Metric bugs that corrupt strategy rankings

Five separate issues, all in the comparison surface that the app exists to provide:

| # | Where | Problem |
|---|---|---|
| a | `server/index.js:1433` | `dayChange: sum(unrealizedPnl) * 0.18` — a magic 0.18 multiplier. This number is invented. Day change is *equity now − equity at prior session close*; it needs a stored snapshot. |
| b | `server/index.js:1076` | `sharpe = (mean/stdDev) * Math.sqrt(252)` regardless of bar resolution. Annualizing 1-hour bars by √252 understates by roughly √6.5. A 1H Sharpe and a 3M daily Sharpe are currently placed in the same column and compared. Derive the factor from the bar interval. |
| c | `server/index.js:1089` | `profitFactor: grossLoss > 0 ? ... : grossWin > 0 ? 99 : 1`. The `99` sentinel sorts straight to the top of any "best strategy" ranking. A strategy with one lucky trade and no losses outranks everything. Use `null` and render it as `∞` / `—`. |
| d | `server/index.js:1086` ↔ `src/main.tsx:2079` | Server returns `winRate: null` when no trade closed; frontend does `strategy.metrics!.winRate ?? 0`. "No data" silently becomes "0% win rate," so a strategy that never traded ranks below one that lost money. |
| e | `server/index.js:1087` ↔ `src/main.tsx:31` | `maxDrawdown` is built with `Math.min` so it's negative, then rendered as `` `${strategy.maxDrawdown}%` ``. The table reads "Drawdown −18.2%", which parses as a *good* number next to columns where negative is bad. Pick one sign convention and enforce it in a shared formatter. |

**Fix:** a single `metrics.js` module owning definitions, sign conventions, null semantics, and display formatting — imported by both server and web. This is the "one metric vocabulary" rule in `04-hud-and-chart-spec.md`.

---

## S1 — Uploaded algorithms execute unsandboxed in the API process

**Where:** `server/index.js:1748–1776`; validation at `:1097`.

```js
fs.writeFileSync(fullPath, code);
const module = await import(`${pathToFileURL(fullPath).href}?v=${Date.now()}`);
validateAlgorithm(module.default, `${safeName}.js`);
```

Arbitrary JavaScript is written to disk and imported into the main server process. `validateAlgorithm` only checks the export's *shape* — it runs after the module's top-level code has already executed. Uploaded code inherits full Node privileges: `fs`, `net`, `child_process`, and `process.env`, which by then holds your Alpaca and OpenAI keys (`saveSettings` writes them there at `:213`).

The endpoint has no authentication, and `vite.config.ts:7` sets `host: "0.0.0.0"`, so the dev proxy is reachable from anything on your network.

The README's "only install files you trust" caveat is honest but insufficient for something shaped like a product. It's also a correctness problem, not only a security one: a runaway `while(true)` in an uploaded strategy hangs the server, including the failsafe liquidate endpoint.

**Fix, in order of effort:**
1. Immediate: bind Express to `127.0.0.1`, remove `host: "0.0.0.0"` from the Vite config.
2. Run algorithms in a `node:worker_threads` worker with `resourceLimits` and a wall-clock timeout. Strip `process.env` inside the worker. This also solves P2.
3. Validate before executing — parse with a JS parser and reject imports/`require`/`process`/`globalThis` access before the module is ever loaded.

---

## S2 — No authentication on any endpoint, including settings

Every route is unauthenticated. `POST /api/settings` (`:1448`) writes `.env` on disk and mutates `process.env` live. `GET /api/settings` (`:1444`) leaks credential metadata — `hasValue` plus the last four characters via `maskSecret` (`:163`).

**Fix:** for personal use, localhost binding plus a shared-secret header on mutating routes is proportionate. The SaaS-shaped version needs real sessions; the architecture doc keeps an `accounts` table so that's a later addition rather than a rewrite.

---

## S3 — `saveSettings` destroys the `.env` file it rewrites

**Where:** `server/index.js:193` (`serializeEnv`), `:199` (`saveSettings`).

`readEnvFile()` parses `.env` into a flat object, then `serializeEnv` writes `KEY=value` lines back. Every comment in your `.env` is deleted on each save. Values aren't quoted, so anything containing `#`, a newline, or leading whitespace round-trips incorrectly (the `\n` strip on `:195` is a partial guard).

**Fix:** move runtime-editable settings out of `.env` and into the `settings` table (`02-architecture.md`). Leave `.env` for bootstrap-only values that a human edits. This also fixes the awkward "the app rewrites its own config file" pattern.

---

## S4 — Upload overwrites silently, and rejection can delete a good file

**Where:** `server/index.js:1751`, `:1770`.

`safeName` collapses to `[a-zA-Z0-9-_]`, so `my strategy.js` and `my-strategy.js` and `my/strategy.js` all land on `my-strategy.js`. There's no existence check — a second upload silently replaces the first. Worse, if the *new* upload fails validation, `fs.unlinkSync(fullPath)` at `:1770` deletes the file, taking the previously working algorithm with it.

**Fix:** write to a temp path, validate, then atomically rename. Reject on collision unless `overwrite: true` is passed. Version algorithms in the DB (`algorithm_versions`) so history survives.

---

## P1 — Rendering the portfolio generates hundreds of throwaway fake candles

**Where:** `server/index.js:1401` (`getPortfolio`) → `:1390` (`getAsset`) → `:1373` (`getQuotedMarket`) → `:1318` (`buildMarketAsset`).

`getPortfolio()` calls `getAsset()` once per position. Each `getAsset` reloads the catalog, then runs the full `buildMarketAsset` pipeline: 79 synthetic candles + `getDiagnostics` + 4 fabricated trades — all discarded, since the caller only reads `asset.price`.

A 10-position portfolio builds 790 candles and 40 fake trades per request, and the frontend polls this on an interval (`src/main.tsx:2403`).

**Fix:** falls out of C1. Add a `getQuote(symbol)` that returns only price data; `getPortfolio` uses that.

---

## P2 — Backtests run synchronously on the request thread and block everything

**Where:** `server/index.js:1516` (`/api/compare/:symbol`), `:1654` (`/api/algorithms/scan`).

`/api/compare` loops every installed algorithm through `runAlgorithmBacktest` inline. `/api/algorithms/scan` is O(algorithms × symbols) — up to 10 symbols × N algorithms, all synchronous. Node is single-threaded: while a scan runs, *every* other request queues behind it, including `/api/failsafe/liquidate`. Your emergency exit is blocked by a report.

There's also no result cache. Identical `(algorithm, params, symbol, range)` requests recompute from scratch on every poll.

**Fix:** worker pool (shared with S1's sandbox) + a `backtest_runs` cache table keyed on `(algorithm_version, params_hash, symbol, range, bars_hash)`. Recompute only when an input actually changes. Keep the kill-switch route on a path that never touches the pool.

---

## P3 — The chart recomputes its entire scene on every hover

**Where:** `src/main.tsx:384–559`.

`CandlestickChart` derives everything inline on each render: `Math.max(...candles.map(...))` (`:408–410`), the moving average, VWAP, ATR, and every SVG path string. None of it is memoized. Line 405 stores hover state in the component:

```js
const [hoveredCandle, setHoveredCandle] = React.useState<...>(null);
```

So moving the mouse one pixel re-renders the component and re-derives the whole scene — the moving average, both band lines, the area path, every candle body. **This is the stutter you're seeing in the chart.**

Two secondary issues: `Math.max(...array)` spreads the array into arguments and will throw `RangeError` past roughly 100k elements (the same pattern repeats at `:309–310` in `rangeStats` and `:1211–1212` in `MiniCandles`), and `step = chart.width / candles.length` (`:416`) with no minimum means dense ranges render sub-pixel bodies that alias into mush.

**Fix:** detailed in `04-hud-and-chart-spec.md` — split the static scene from the interactive layer so hover only re-renders the crosshair, memoize geometry on `(bars, viewport, overlays)`, and replace spread-max with single-pass reducers.

---

## P4 — `App()` is one component with 39 `useState` and 12 `useEffect`

**Where:** `src/main.tsx:2003–3190` (1,190 lines).

Every piece of state in the dashboard lives in one component, so every change re-renders all of it. Typing a character in the settings modal (`settingsDraft`, `:2018`) re-renders every chart on screen. The `notice` string (`:2029`) does the same.

**Fix:** feature-scoped state, colocated with the features that own it. Server data belongs in a query cache, not `useState`. Layout in `02-architecture.md`.

---

## P5 — Four uncoordinated polling intervals that never pause

**Where:** `src/main.tsx:2171`, `:2204`, `:2403`, `:2413`.

Four independent `setInterval` timers, no `document.visibilityState` check, no shared scheduler. The app polls at full rate in a background tab indefinitely — burning provider rate limit on data nobody is looking at. Each timer also takes its own path through `cachedJson` (`:2101`), so cache hit rates are worse than they look.

**Fix:** one polling coordinator that pauses on `visibilitychange` and backs off on failure. Move the live data path to server-sent events once the runtime lands — the bot already knows when something changed, so polling is the wrong shape.

---

## M1 — Two monoliths and a stylesheet

`src/main.tsx` is 3,206 lines holding ~20 components at module scope, with no routing, no data layer, and no state container. `server/index.js` is 2,007 lines mixing HTTP routing, three market-data providers, indicator math, the backtest engine, the algorithm loader, settings persistence, and the paper broker. `src/styles.css` is 3,049 lines with no token layer.

Nothing here is *wrong* — it's what a project looks like when it's been growing fast. But it's the reason the next feature is expensive, and it's what you're asking to fix. Target layout is in `02-architecture.md`.

---

## M2 — Two competing strategy systems

`src/strategy/stockbotStrategy.ts` and `src/control/baselines.ts` are vestigial. `evaluateStockbotMomentum()` reimplements momentum logic in the browser (imported at `src/main.tsx:21`, called at `:2060`) that the server already owns properly in `algorithms/ema-momentum.js`. `compareBaselines()` returns hardcoded allocation numbers unrelated to the real SPY/Cash controls the server computes at `server/index.js:1573–1590`.

So there are two answers to "what does the strategy say," and the frontend one is the naive one.

**Fix:** delete both files. The server's algorithm registry is the only strategy system. If you want a client-side preview, have it call the same engine.

---

## M3 — No shared contract between server and web

`src/types.ts` describes the API from the frontend's point of view; the server has no schema at all and is plain JS excluded from `tsc --noEmit`. Nothing detects drift. `SavedCandle`, `ScanResult`, `CompareStrategy` and friends (`src/main.tsx:70–160`) are hand-maintained mirrors of whatever the server happens to return today.

**Fix:** a `packages/shared` with Zod schemas as the single source of truth — types inferred for the web, runtime validation at the server boundary. Contract violations become a test failure instead of an `undefined` three panels deep.

---

## M4 — Zero tests, on a codebase whose entire output is numbers

`npm run lint` is `tsc --noEmit`, and `server/` isn't typechecked at all. The backtest engine, the metric math, and the fill logic — the code most likely to be silently wrong and most expensive to be wrong about — have no coverage.

**Fix, and do this before the refactor:** golden-file tests. Freeze a known bar series as a fixture, run each algorithm, snapshot the trades and metrics. Then the Phase 0 fixes (C2, C3, C7) produce a *reviewable diff* of exactly which numbers changed and by how much — which is the only safe way to make those changes. Add property tests for the invariants: equity never goes negative, `sum(fills) == position delta`, cash + position value == equity at every bar.

---

## M5 — Assorted

- **`dist/` is committed** but also listed in `.gitignore`. Stale build artifacts in the repo. `git rm -r --cached dist`.
- **`GET /api/strategies` (`:1902–2003`) is 100 lines of dead code** returning hardcoded metrics. Nothing in `src/` calls it. Delete.
- **Error responses are ambiguous.** Routes return `{ error, data: <empty shape> }` with a 500 (`server/index.js:1605`, `:1797`), so the client can't distinguish "no data for this symbol" from "the server is broken." Needs an error taxonomy with stable codes.
- **`getPortfolio` returns `orders.slice(0, 12)`** (`:1436`) — a hardcoded page size with no pagination and no way to reach order 13.
- **`buyingPower` is just `cash`** (`:1431`), which is fine for cash accounts but should be an explicit derivation once risk limits exist.
- **`chartRanges` is duplicated** between `src/main.tsx:192` and `rangeBacktestConfig` at `server/index.js:402`, with different day counts. Range semantics should live in shared code.

---

## What I'd fix first

In order. Each line is independently shippable.

1. **C2** (next-bar-open fills) — biggest single correctness win, ~15 lines.
2. **M4** (golden-file tests) — actually do this *with* C2, so you can see the diff.
3. **C1** (delete synthetic data) — largest deletion, makes every displayed number honest.
4. **C7** (metric fixes) — rankings become meaningful.
5. **S1 step 1 + S2** (localhost bind, shared secret) — two lines of config.
6. **C6** (account mutation queue) — small, prevents a class of bug that's miserable to debug.
7. **C5** (SQL persistence) — unblocks sessions, and therefore everything you asked for.

Everything after that is the refactor, sequenced in `05-roadmap.md`.
