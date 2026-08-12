# Stockbot

Stockbot is a local-first paper-trading workbench for testing stock strategies against real market data before considering broker execution. It combines a React dashboard with a durable session runtime, a shared backtest/paper fill model, risk controls, and reproducible strategy versions.

Stockbot does **not** route live orders. Provider credentials are used for market data; every order and fill produced by the app is simulated and written to Stockbot's local ledger.

## What is included

- React, TypeScript, Vite, and a routed five-destination dashboard
- Express API under `/api/v1` with validated success and error envelopes
- Real provider data only: Alpaca, then Polygon, then Finnhub
- A `$100,000` default paper account with durable orders, fills, positions, and equity history
- SQLite persistence by default, with the same repository layer available through a PostgreSQL URL
- Backtests and paper execution using one auditable slippage/commission fill model
- Next-bar-open backtest fills, so a signal cannot fill on the bar that produced it
- Versioned algorithms, cached backtests, worker timeouts, and constrained uploads
- Paper-session lifecycle controls, schedules, risk events, alerts, SSE updates, and JSON/CSV exports
- Canvas/SVG market charts with pan, zoom, overlays, and session replay

The implementation follows the decisions in [the revision plan](./docs/plan/00-README.md). Strategy authors should also read [the algorithm format](./algorithms/README.md).

## Requirements

- Node.js 22 or newer (`node:sqlite` is used by the default database adapter)
- npm
- At least one configured market-data provider for quotes and historical bars

Without provider credentials, Stockbot still starts and exposes its local symbol metadata, but prices, charts, backtests, and paper fills report an explicit unavailable state. It never substitutes generated prices or candles.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Add at least one provider key to `.env`, then open `http://127.0.0.1:5173`. The development command starts both services:

- web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4000`

Useful commands:

```bash
npm run client   # Vite only
npm run server   # Express API only
npm test         # Node test suite
npm run lint     # TypeScript check
npm run build    # Typecheck and production web build
npm run check    # lint, tests, and build
```

## Install on a user's laptop

The production package connects only to the database selected by that host user's private `DATABASE_URL`; no database address or credential is compiled into the dashboard. It accepts either a PostgreSQL URL or a file-backed SQLite URL.

```bash
npm run laptop:init       # create a protected host config and enter DATABASE_URL
npm run laptop:install    # build and install the per-user macOS service
npm run laptop:tailscale  # expose only the loopback app through private HTTPS
```

`laptop:install` migrates and validates the selected database before starting the service. Automated orders, fills, session-owned lots, equity, risk events, and audit records are written to SQL. Inspect or export them with `npm run db:status -- --env-file "$HOME/.config/stockbot/stockbot.env"` and `npm run db:trades -- --env-file "$HOME/.config/stockbot/stockbot.env"`. See [Laptop deployment](./docs/LAPTOP_DEPLOYMENT.md) and [Database operations](./docs/DATABASE_OPERATIONS.md) before installing. The scripts are portable and do not install or configure anything until run on the future host.

## Configuration

`.env` is for bootstrap configuration. Settings saved from the dashboard are persisted in the database; Stockbot does not rewrite `.env`.

| Variable | Purpose |
|---|---|
| `HOST` | API bind address. Defaults to `127.0.0.1`; non-loopback hosts require `STOCKBOT_ALLOW_REMOTE=true`. |
| `PORT` | API port. Defaults to `4000`. |
| `DATABASE_URL` | `file:./data/stockbot.db` for SQLite or a `postgres://...` / `postgresql://...` URL. |
| `STOCKBOT_API_TOKEN` | Server-side shared secret required by every `POST`, `PUT`, `PATCH`, and `DELETE` request when configured; enter it per browser session in Settings. |
| `STOCKBOT_SETTINGS_KEY` | Encryption key required before provider secrets can be saved through Settings. |
| `ENGINE_WORKERS` | Number of strategy workers. Defaults to `2` and is limited to `1`–`16`. |
| `ENGINE_TIMEOUT_MS` | Hard deadline for one strategy task. Defaults to `10000`. |
| `QUOTE_FRESHNESS_MS` | Maximum quote age accepted by paper-order risk checks. Defaults to `5000`. |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | Alpaca asset catalogue, quote, and bar access. |
| `POLYGON_API_KEY` | Polygon quote/bar fallback. |
| `FINNHUB_API_KEY` | Finnhub quote/bar fallback. |

See [`.env.example`](./.env.example) for the complete set of URLs, cache durations, feed selection, and runtime defaults.

### Provider behavior

Quotes and bars follow one ordered path: **Alpaca → Polygon → Finnhub**. A provider is skipped when it is not configured and marked degraded when a request fails. Short-lived server caches reduce rate-limit pressure, and `/api/v1/market/health` exposes current provider state.

The bundled asset catalogue is metadata for search only. It is not a source of prices, volumes, bars, indicators, signals, or P&L. Chart diagnostics are computed from the same real bars shown on screen.

## Persistence

The default database is `data/stockbot.db`. Forward-only migrations run at startup, and repositories own all SQL. Sessions, algorithm versions, backtest cache entries, schedules, orders, fills, position lots, equity snapshots, risk events, alerts, settings, and audit events survive a restart.

The storage contract is deliberately portable:

- timestamps are UTC epoch milliseconds
- money is stored as integer cents
- quantities are stored as integer micro-shares
- IDs are generated by the application
- JSON values are serialized at the repository boundary

To use PostgreSQL, install dependencies normally and set `DATABASE_URL` to a PostgreSQL connection string. The adapter rewrites portable `?` placeholders to PostgreSQL parameters; services and routes do not change.

## Trading semantics

Backtests evaluate a strategy only with bars through the current closed bar. A signal on bar `N` becomes a pending order and may fill only at bar `N+1`'s open. A final-bar signal is returned as unfilled instead of being fabricated into a trade.

The shared fill model records the reference price, directional slippage, commission, actual fill price, quantity, and slippage cost. Session configuration freezes that model and the exact algorithm version so results remain explainable later. Strategy comparisons include SPY buy-and-hold and Cash controls.

Paper orders use the same fill economics but must also pass live safety gates such as market hours, quote freshness, price sanity, exposure, order-rate, and available-funds checks. They remain local simulations; Alpaca paper-order routing is not enabled.

## Sessions, risk, and recovery

A session follows an explicit lifecycle:

```text
draft → arming → running ⇄ paused → stopping → stopped
                    └──────────────→ halted
                    └──────────────→ errored
```

Backtests normally complete from `arming` to `stopped`. Paper sessions can be manual, market-hours, fixed-window, cron, or continuous schedules. Stop, per-session halt, account-wide halt, and optional liquidation operations are recorded with their reasons. Rejected orders and triggered guardrails remain visible rather than disappearing.

If the server exits while a session is active, startup reconciliation marks that ambiguous run `errored` and records a restart event; it does not silently backfill missed trades. A stopped, halted, or errored session is a durable historical record.

## API contract

All new routes are rooted at `/api/v1`. Successful JSON responses use:

```json
{ "data": {}, "meta": {} }
```

Errors use a stable code and message:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed.", "detail": {} } }
```

Each response includes an `x-request-id` header. When `STOCKBOT_API_TOKEN` is set, mutating requests must include:

```http
x-stockbot-token: your-token
```

The token is server configuration, not a Vite environment variable. After opening the dashboard, enter the same value under **Settings → API mutation token**. The dashboard keeps it in the current tab's session storage, sends it only with mutating requests, never echoes it after entry, and removes it when you clear the control or end the tab session. Do not create a `VITE_STOCKBOT_API_TOKEN`: `VITE_*` values are embedded in the browser bundle.

Main route groups:

| Route | Responsibility |
|---|---|
| `GET /api/v1/health` | Service mode, bind address, database health, and provider health |
| `/api/v1/overview` | Aggregate account/session/risk/alert summary |
| `/api/v1/market/*` | Search, movers, provider health, quotes, and real bars |
| `/api/v1/algorithms/*` | Algorithms, versions, uploads, enablement, and backtests |
| `/api/v1/sessions/*` | Create, list, run, pause, resume, stop, halt, compare, and export sessions |
| `/api/v1/accounts/*` | Portfolio, paper orders, liquidation, and account-wide halt |
| `/api/v1/risk/*` | Risk profiles and event history |
| `/api/v1/alerts/*` | Alert rules, delivery feed, and acknowledgements |
| `/api/v1/settings/*` | Public settings state, encrypted updates, and provider tests |
| `GET /api/v1/stream` | Server-sent session, risk, alert, and market events |

`GET /api/health` remains only as a compatibility redirect to `/api/v1/health`.

## Local security model

- The API and Vite bind to loopback by default, and browser CORS accepts local origins only.
- Set `STOCKBOT_API_TOKEN` before allowing any other process or machine to reach the API.
- Enter that token through Settings for each operator browser session; it is not compiled into the frontend or stored in local storage or cookies.
- Read-only routes, including SSE, do not require that token in the local security model. Remote binding is therefore an explicit opt-in and should sit behind network-level access control.
- Settings secrets are encrypted with AES-256-GCM in SQL and are never returned to the browser. Losing `STOCKBOT_SETTINGS_KEY` makes stored secrets unreadable.
- Uploaded strategies are validated and run in bounded workers, but JavaScript sandboxing is defense in depth, not permission to execute unknown hostile code. Review every strategy you install.
- Manual files in `algorithms/` are treated as trusted local source; browser uploads are isolated under `algorithms/uploads/`.

Stockbot is research software, not financial advice or a live brokerage system.
