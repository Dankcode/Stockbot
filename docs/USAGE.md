# Using Stockbot

An end-to-end walkthrough: install the app, authorize the browser, connect market data, upload a strategy, backtest it, run a paper session, and read the result honestly.

For the command-line surface — plugins, research plans, database operations, the macOS service — see [CLI reference](./CLI.md). For the strategy file contract, see [Algorithm format](../algorithms/README.md).

> Stockbot never routes live brokerage orders. Provider credentials retrieve market data only. Every order and fill is simulated by the local paper/backtest engine.

---

## Contents

1. [Install and run](#1-install-and-run)
2. [Authorize the browser tab](#2-authorize-the-browser-tab)
3. [Connect market data](#3-connect-market-data)
4. [Tour of the dashboard](#4-tour-of-the-dashboard)
5. [Add a strategy](#5-add-a-strategy)
6. [Run a backtest](#6-run-a-backtest)
7. [Read the result](#7-read-the-result)
8. [Run a session](#8-run-a-session)
9. [Compare and export](#9-compare-and-export)
10. [Install a plugin bundle](#10-install-a-plugin-bundle)
11. [Turn on AI research](#11-turn-on-ai-research-optional)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Install and run

Requirements: **Node.js 22 or newer** and npm. A market-data provider account is needed for prices, charts, backtests, and fills — without one, Stockbot runs but reports market data as unavailable rather than inventing candles.

```bash
git clone https://github.com/Dankcode/Stockbot.git
cd Stockbot
npm ci
cp .env.example .env
npm run dev
```

`npm run dev` starts two processes side by side:

| Process | Address | What it is |
|---|---|---|
| `api` | `http://127.0.0.1:4000` | Express API, engine, and repository layer |
| `web` | `http://127.0.0.1:5173` | Vite dev server for the React dashboard |

Open **`http://127.0.0.1:5173`**. The dev server proxies `/api` to port 4000, so you only ever visit 5173.

Development defaults to SQLite at `file:./data/stockbot.db`. Set `DATABASE_URL` to a PostgreSQL URL to use PostgreSQL instead. Migrations run forward automatically at startup.

To run the two halves separately — useful when you want to restart just the API:

```bash
npm run server    # API only, port 4000
npm run client    # dashboard only, port 5173
```

---

## 2. Authorize the browser tab

Every mutating request (uploads, backtests, session control, settings saves) requires an operator token. Reads work without it, so an unauthorized tab looks *almost* functional — which is why a failed upload is usually a missing token.

**Step 1 — set the server secret.** Put a random string of 32 or more characters in `.env`:

```bash
# generate one
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

```ini
STOCKBOT_API_TOKEN=<the value you generated>
```

Restart the API after changing `.env`.

**Step 2 — paste it into the tab.** In the dashboard, go to **Settings → API mutation token**, paste the same value into **Server API token**, and set it for the session.

The token lives in that tab's `sessionStorage`, is sent only on mutations, and is never compiled into the frontend bundle. Consequences worth knowing:

- Each browser tab authorizes itself. A new tab starts unauthorized.
- Closing the tab clears it.
- **Never** put the token in a `VITE_*` variable — Vite inlines those into the shipped JavaScript.

If you also plan to save provider secrets through the Settings screen, set `STOCKBOT_SETTINGS_KEY` to a second 32+ character random value. It encrypts those secrets at rest in SQL.

---

## 3. Connect market data

Go to **Settings → Data providers**, fill in at least one provider, and click **Save group**.

| Provider | Fields | Notes |
|---|---|---|
| **Alpaca** | `ALPACA_API_KEY`, `ALPACA_API_SECRET` | Leave `ALPACA_DATA_BASE_URL` at `https://data.alpaca.markets` and `ALPACA_STOCK_FEED` at `iex` unless you have a paid feed. Alpaca also supplies the symbol catalogue. |
| **Polygon** | `POLYGON_API_KEY` | Historical bar fallback. |
| **Finnhub** | `FINNHUB_API_KEY` | Historical bar fallback. |

Stockbot tries providers in order: **Alpaca → Polygon → Finnhub**. The first one that answers wins; the rest are fallbacks, not a blend.

You can also set these in `.env` instead of the UI. Values saved through Settings are encrypted in SQL and take precedence over the bootstrap env.

Confirm it worked in **Settings → Provider health**, which shows each provider's status, message, and latency. A green dot with a latency figure means bars are available.

Without any provider: symbol metadata still resolves, but charts, quotes, backtests, and paper fills all report *unavailable*. Stockbot never substitutes a synthetic candle.

---

## 4. Tour of the dashboard

Five pages, reachable from the sidebar or the command palette:

| Page | Route | What it is for |
|---|---|---|
| **Overview** | `/` | Portfolio, open positions, active sessions, database and provider health, risk summary |
| **Markets** | `/markets` | Symbol search, interactive charts, quotes, movers, indicator overlays |
| **Strategies** | `/strategies` | The algorithm library — upload, enable/disable, open a strategy to backtest it |
| **Sessions** | `/sessions` | Session history, filters, detail views, and side-by-side comparison |
| **Settings** | `/settings` | API token, data providers, provider health, risk profiles, alerts, database connection |

The **command palette** searches pages, sessions, strategies, and symbols in one box — the fastest way to jump to a symbol chart or a past session.

---

## 5. Add a strategy

A strategy is **one JavaScript file** with a default-exported object. No ORM, no SDK, no package install, no server restart.

### The three-step loop

1. **Download.** On **Strategies**, click **Starter file**. (Same file as [`public/stockbot-strategy-template.js`](../public/stockbot-strategy-template.js).)
2. **Edit.** Rename the file, then change the metadata, `params`, and the synchronous `signal()` rules.
3. **Upload & test.** Click **Upload .js**. Stockbot validates the file inside a bounded worker, installs it atomically, and stores a source-hashed version.

The minimum viable strategy:

```js
export default {
  name: "My Strategy",
  params: { period: 20 },
  signal({ index, params, indicators, position }) {
    const average = indicators.sma(params.period);
    if (index < params.period) return null;
    if (position.qty === 0 && average[index] < 100) return "buy";
    if (position.qty > 0 && average[index] >= 100) return "sell";
    return null;
  }
};
```

### What `signal()` is handed

`signal(context)` is called once per **closed** bar, in order, starting at index `1`, and must return synchronously — `"buy"`, `"sell"`, `null`, or an object of the form `{ action, reason?, confidence? }`.

| Field | What it holds |
|---|---|
| `index` | Index of the current closed bar |
| `bar` | `{ time, open, high, low, close, volume }`; `time` is UTC epoch ms |
| `bars`, `closes` | History **through `index` only** — future bars are not exposed |
| `params` | Defaults merged with the run's overrides, then frozen |
| `state` | Whatever `init()` returned; persists across calls within one run |
| `position` | `{ qty, entryPrice, entryIndex }`; `qty > 0` means long |
| `indicators` | Cached indicator functions; returned arrays end at `index` |
| `research` | Frozen point-in-time research frame, or `null` when nothing is pinned |

Async functions and returned promises are rejected. Keep `init()` and `signal()` deterministic — no wall-clock time, no randomness, no network, no mutable globals — or your results stop being reproducible.

Full contract, including the indicator catalogue and the research frame shape: [Algorithm format](../algorithms/README.md).

### Uploading

- Uploads require the API mutation token from step 2.
- Tick **Replace an uploaded file with the same name** to overwrite instead of creating a second entry. Either way the old version stays in **Version history** with its source hash.
- The toggle on each card enables or disables a strategy for sessions. Disabled strategies can still be backtested.
- Trusted local modules can also be dropped straight into `algorithms/`.

> Uploaded code runs in your process. Validation constrains it, but read anything you did not write.

---

## 6. Run a backtest

Open a strategy from the library, then use the **Backtest** panel.

1. **Symbol** — the ticker to trade, e.g. `NVDA`.
2. **Range** — sets both the lookback window and the bar interval:

| Range | Lookback | Bar interval |
|---|---|---|
| `1H` | 3 days | 1 min |
| `1D` | 7 days | 5 min |
| `1W` | 14 days | 1 hour |
| `1M` | 45 days | 1 day |
| `3M` | 120 days | 1 day |
| `1Y` | 420 days | 1 week |
| `ALL` | ~10 years | 1 month |

3. **Backtest parameters** — override any key in the strategy's `params` for this run only. The file on disk is not modified.
4. Click **Run backtest**.

### How fills work

A signal is evaluated **after bar `N` closes** and can fill only at **bar `N+1`'s open**. A signal on the final bar stays unfilled rather than receiving a fabricated price. The same fill model powers backtests and paper sessions, so a backtest number and a paper number mean the same thing.

Every run also computes two controls automatically, whether or not you display them:

| Method | Purpose |
|---|---|
| Uploaded strategy | Your exact source version plus this run's parameter overrides |
| SPY buy-and-hold | Real S&P 500 ETF control over the same requested range |
| Cash | Flat `$100,000` control with no market exposure |

The checkboxes in **Tested methods** choose what is *visible*. They never skip or alter the calculation.

---

## 7. Read the result

The result panel reports **Return**, **Max drawdown**, **Sharpe**, and **Trades**, plus a comparison row: *Strategy vs SPY* and *Strategy vs Cash*.

**Beating SPY and Cash is the floor, not the finding.** Both controls hold a different asset than your strategy traded, so beating them may only mean you picked a symbol that went up. Three **same-asset** controls ship in `algorithms/` and run as ordinary peer strategies through the identical engine, fill model, and metrics:

| Control file | The question it answers |
|---|---|
| `control-buy-and-hold.js` | Did the rules beat simply owning the symbol they traded? |
| `control-fixed-interval.js` | Or did being in the market ~40% of the time do the work? |
| `control-random-entry.js` | Would *any* information-free schedule have looked the same? |

Backtest your strategy and each control on the same symbol and range, then compare.

`control-random-entry.js` is seeded and deterministic, so a given `seed` always reproduces. **Vary `seed` across 10–20 runs and compare your strategy against the resulting distribution, not against one draw.** On a 400-bar test series, ten seeds spanned −31% to +160% — and one of them beat buy-and-hold outright. A single random control that your strategy beats proves nothing.

The full procedure, including how to decide whether a gap is real: [Control group](./CONTROL_GROUP.md).

**Version history** on the same page lists every stored version with its source hash and timestamp, so any result stays attributable to the exact code that produced it.

---

## 8. Run a session

A backtest is a one-shot calculation. A **session** is a durable, resumable run with its own ledger, event timeline, risk events, and export.

On **Sessions**, create a draft session:

| Field | Meaning |
|---|---|
| **Name** | Your label for the run |
| **Mode** | `paper` (forward, live bars) or `backtest` (historical window) |
| **Symbols** | Comma-separated list, e.g. `SPY, QQQ` |
| **Algorithm** | Any enabled strategy from the library |
| **Version** | The exact stored version to run — earlier versions stay selectable |
| **Range** | Sets the window, and for `backtest` the start and end timestamps |
| **Bar interval** | Defaults from the range; override it independently if you want |

These inputs are persisted before the session starts, which is what makes a run reproducible later.

Lifecycle actions, from the session detail page:

| Action | Effect |
|---|---|
| **Start** | Begin executing from the draft configuration |
| **Pause** / **Resume** | Suspend and continue without losing state |
| **Stop** | End the session normally and finalize the ledger |
| **Halt** | Emergency stop with a recorded reason; also available per account |

A live session streams updates over `/api/v1/stream` — session, risk, alert, and market events — so the dashboard updates without polling.

Session modes are restricted to `backtest` and `paper` at the API level. There is no live brokerage order route to enable.

---

## 9. Compare and export

**Sessions → Compare** puts runs side by side with a configuration diff, so when two sessions disagree you can see whether the cause was the strategy version, a parameter, the range, or the interval.

Each session detail page offers an **export** of its orders, fills, and equity curve.

From the command line:

```bash
npm run db:trades -- --account default-paper --format csv --output trades.csv
```

See [CLI reference](./CLI.md#database-operations) for the full flag list, and [Database operations](./DATABASE_OPERATIONS.md) for backup and recovery.

---

## 10. Install a plugin bundle

Uploading `.js` is right for strategies you wrote yourself. For methods **shared between people**, the `stockbot.plugin.v1` format carries the same logic as *data*: a frozen rule tree walked by an interpreter with a closed operator set, a node budget, and a nesting cap. No `eval`, no dynamic import, no string is ever compiled. The worst a malicious method can do is return a wrong number.

Five bundles ship in `plugins/`:

| Bundle | Contents |
|---|---|
| `core-controls` | 3 control methods |
| `base-methods` | 3 base trading methods |
| `horizon-pack` | 14 methods across four holding-period horizons |
| `sentiment-pack` | 2 methods, 2 research plans, 2 skills |
| `gov-research` | 2 research plans, 1 skill |

```bash
npm run plugin -- list
npm run plugin -- inspect --plugin horizon-pack
npm run plugin -- requirements --plugin sentiment-pack
```

A plugin **declares** what it needs — source ids, secret *names*, prompt templates, whether an AI CLI is required — and never supplies any of it. `requirements` checks those declarations against your configuration and fails loudly with the exact remedy, rather than letting a research-gated strategy quietly never trade. Every `role: "strategy"` method must name its controls or validation rejects the file.

Full format, authoring guide, and the CLI's skill surface: [Plugin format](./PLUGIN_FORMAT.md) and [CLI reference](./CLI.md#plugins).

---

## 11. Turn on AI research (optional)

Research is **disabled** until the server operator configures at least one exact HTTPS origin *and* an AI CLI. Plans cannot name executables, inject arguments or environment variables, or fetch arbitrary origins — they only reference code-owned adapters and source ids that you registered.

```bash
npm run research -- adapters
npm run research -- validate --file research-plans/catalyst-composite.json
npm run research:probe -- --symbol NVDA
```

`research:probe` issues one real request per scrape step through the adapter's actual guardrails and names whichever guardrail rejected a source — the quickest way to find out why a source is silent.

Four plans ship in `research-plans/`:

| Plan | Sources |
|---|---|
| `sec-edgar-filings` | 8-K, Form 4, EDGAR full-text search |
| `gov-contracts-defense` | Daily DoD contract announcements, USAspending agency activity |
| `market-news-sentiment` | Nasdaq, Finviz |
| `catalyst-composite` | All three combined — the one intended for session pinning |

The single-source plans exist so you can attribute an edge to a specific source rather than to the bundle.

Resulting summaries and their source provenance are immutable SQL snapshots. A strategy can read one only when it existed by that bar's canonical decision timestamp (`bar.time`) — so pinned research cannot leak the future into a backtest.

Protocol, configuration, import/run commands, and session pinning: [AI research](./AI_RESEARCH.md). Per-source authorization status and two documented dead ends: [Research sources](./RESEARCH_SOURCES.md).

---

## 12. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Uploads, backtests, or saves fail; reads work fine | The tab has no operator token. **Settings → API mutation token**, paste the `STOCKBOT_API_TOKEN` value, set it for the session. A new tab needs it again. |
| Charts, quotes, and backtests say *unavailable* | No provider is configured, or its key is rejected. Check **Settings → Provider health**. Stockbot will not fabricate bars to fill the gap. |
| Dashboard loads but every API call fails | The API process is not running or is on a different port. Start it with `npm run server` and confirm `PORT=4000`, which is what Vite proxies to. |
| Saving provider secrets fails | `STOCKBOT_SETTINGS_KEY` is unset or shorter than 32 characters. |
| A backtest returns no trades | Usually the entry condition never fires within the range, or `index` guards skip the whole window. Widen the range, or log intermediate values from `signal()` while testing. |
| A strategy that gates on research never trades | No research plan is pinned to the run, so `research` is `null`. Pin a plan, or check `npm run plugin -- requirements`. |
| A research source returns nothing | Its origin is not registered in `RESEARCH_WEB_SOURCES_JSON`. Run `npm run research:probe` — it names the guardrail that rejected the source. |
| Database settings save is refused | Saves are blocked while trading sessions are active, and require `STOCKBOT_CONFIG_FILE` to point at an owner-only (`chmod 600`) env file. Stop active sessions first. |
| A new database profile shows no history | Correct. Saving a profile does not copy data, and it requires a service restart to take effect. |
| `--env-file` is rejected | The file must be a regular file with owner-only permissions: `chmod 600 <path>`. |

Verify the whole tree at once:

```bash
npm run check     # tsc --noEmit, node --test, vite build
```

Service logs, when running as the macOS LaunchAgent:

```bash
tail -f "$HOME/Library/Logs/Stockbot/stockbot.error.log"
```

---

## Where to go next

- [CLI reference](./CLI.md) — every command, flag, and env file rule
- [Algorithm format](../algorithms/README.md) — the full strategy contract
- [Control group](./CONTROL_GROUP.md) — how to read a result without fooling yourself
- [Plugin format](./PLUGIN_FORMAT.md) — authoring `stockbot.plugin.v1`
- [Horizon pack](./HORIZON_PACK.md) · [Sentiment pack](./SENTIMENT_PACK.md)
- [AI research](./AI_RESEARCH.md) · [Research sources](./RESEARCH_SOURCES.md)
- [Laptop deployment](./LAPTOP_DEPLOYMENT.md) · [Database operations](./DATABASE_OPERATIONS.md)

Stockbot is research software, not financial advice.
