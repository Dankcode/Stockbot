# Stockbot — Target Architecture & Data Model

The goal: **modular**, so a change to the fill model touches one file; **honest**, so every number has a provenance; and **persistent**, so every trading session is a durable, comparable record.

Two organizing principles drive every decision below.

**One source of truth per concept.** Today there are two candle sources, two RSIs, two strategy systems, and two fill models. Each duplicate is a bug waiting to surface. Every concept below has exactly one owner.

**The boundary is the contract.** Server and web share schemas, not assumptions. A payload that doesn't match fails loudly at the boundary rather than quietly three panels deep.

---

## 1. Module layout

```
stockbot/
├─ packages/
│  └─ shared/                     # the contract — imported by BOTH sides
│     ├─ schemas/                 # Zod: Bar, Quote, Order, Fill, Session, Metrics, RiskRule…
│     ├─ metrics.ts               # metric definitions, sign conventions, null semantics
│     ├─ format.ts                # money/percent/volume/time formatters (see §5)
│     └─ ranges.ts                # ChartRange ↔ bar interval ↔ lookback. ONE definition.
│
├─ server/
│  ├─ index.js                    # bootstrap only: config → db → routes → listen. ~40 lines.
│  ├─ config/
│  │  └─ index.js                 # env parsing + validation, fails fast on bad config
│  ├─ http/
│  │  ├─ app.js                   # express wiring, error handler, request id
│  │  ├─ middleware/              # auth, validate(schema), rateLimit, asyncHandler
│  │  └─ routes/
│  │     ├─ market.js  sessions.js  orders.js  algorithms.js
│  │     └─ risk.js    alerts.js    settings.js  health.js
│  │                              # routes are THIN: validate → call service → serialize
│  ├─ market/
│  │  ├─ providers/               # alpaca.js, polygon.js, finnhub.js — one interface each
│  │  ├─ chain.js                 # ordered fallback + per-provider health tracking
│  │  ├─ normalize.js             # provider payload → shared Bar/Quote schema
│  │  └─ cache.js                 # TTL cache, keyed (symbol, range, provider)
│  ├─ engine/
│  │  ├─ indicators.js            # from server/index.js:791–976 — already good, just move it
│  │  ├─ fill-model.js            # ★ THE fill model. Used by backtest AND paper. (C3)
│  │  ├─ backtest.js              # pure: (bars, algorithm, config) → run result
│  │  ├─ metrics.js               # pure: (equityCurve, trades, interval) → metrics
│  │  ├─ pool.js                  # worker pool: N workers, queue, timeout, cancellation
│  │  └─ worker.js                # sandboxed child (S1) — no env, no fs, hard time limit
│  ├─ broker/
│  │  ├─ paper-broker.js          # order lifecycle; uses engine/fill-model.js
│  │  ├─ ledger.js                # ★ all account mutations serialize through here (C6)
│  │  └─ positions.js             # lot tracking, avg cost, realized/unrealized split
│  ├─ runtime/
│  │  ├─ session.js               # lifecycle state machine (03-runtime-risk-alerts §1)
│  │  ├─ scheduler.js             # market-hours aware tick loop
│  │  └─ supervisor.js            # owns running sessions; kill switch never queues
│  ├─ risk/
│  │  ├─ rules/                   # one file per rule, uniform interface
│  │  └─ engine.js                # pre-trade checks + continuous monitors
│  ├─ alerts/
│  │  ├─ evaluator.js
│  │  └─ channels/                # in-app.js (v1), webhook.js, email.js (later)
│  ├─ algorithms/
│  │  ├─ loader.js  validator.js  registry.js   # versioning + content hashing
│  └─ db/
│     ├─ client.js                # dialect adapter (§3)
│     ├─ migrate.js               # runner
│     ├─ migrations/              # 0001_init.sql, 0002_….sql — forward only
│     └─ repositories/            # sessions.js orders.js fills.js equity.js …
│                                 # ONLY layer that writes SQL. Services never see it.
│
├─ src/                           # web
│  ├─ app/
│  │  ├─ App.tsx                  # shell + router. Small.
│  │  ├─ routes.tsx
│  │  └─ providers/               # query client, session context, theme
│  ├─ features/
│  │  ├─ overview/  markets/  strategies/  sessions/  risk/  settings/
│  │                              # each: components/ + hooks/ + api.ts, self-contained
│  ├─ charts/                     # the renderer (04-hud-and-chart-spec §3)
│  ├─ components/                 # ← YOUR design-system primitives land here
│  ├─ lib/
│  │  ├─ api.ts                   # typed client, validates against shared schemas
│  │  ├─ query.ts                 # cache, polling coordinator (fixes P5)
│  │  └─ hooks/
│  └─ styles/
│     ├─ tokens.css               # ← YOUR tokens. Everything else consumes these.
│     └─ base.css
│
├─ algorithms/                    # user algorithm files (unchanged format)
└─ docs/plan/
```

### Dependency rule

```
routes → services (broker, runtime, risk, alerts) → repositories → db client
                 ↘ engine (pure)     ↘ market (I/O)
```

Arrows point one way only. `engine/` is pure — no I/O, no DB, no config reads. That's what makes it testable, and it's why the golden-file tests in `01-code-review.md#M4` become easy once the move is done.

### Why this shape

- **`engine/fill-model.js` is called out with a star** because it's the single change that makes backtest and paper results comparable. It's the fix for C3 and it must be one module, not two implementations that agree today.
- **`broker/ledger.js` is the only writer of account state.** Every mutation goes through one serialized queue. That's a five-line abstraction that permanently kills the C6 race class.
- **`db/repositories/` is the only place SQL appears.** Services call `sessions.create(...)`, never a query. This is what makes the SQLite→Postgres swap a config change.
- **`packages/shared/ranges.ts`** exists because `chartRanges` currently lives in two places with different day counts (`src/main.tsx:192` vs `server/index.js:402`).

---

## 2. Persistence strategy: SQLite now, Postgres later

The requirement is that swapping in your Postgres URL later is a **config change, not a rewrite**. That holds if you accept four constraints from day one.

**Timestamps.** `INTEGER` epoch milliseconds, UTC. Not `DATETIME`, not `TIMESTAMP`. SQLite has no date type and Postgres has three; integers are unambiguous, sort correctly, and index identically in both. Format at the display boundary only.

**Money.** `INTEGER` minor units (cents). The current code floats money everywhere with `.toFixed(2)` band-aids — `server/index.js:1430–1435` alone has five. Accumulated float error in a P&L ledger is the kind of bug you find six months later. Convert at the boundary: `centsToDisplay()` in `shared/format.ts`.

**Quantity.** `INTEGER` micro-shares (qty × 1,000,000). Supports fractional shares exactly and keeps position arithmetic in integers.

**SQL dialect.** Stay in the intersection. No `AUTOINCREMENT`, no `INSERT OR REPLACE`, no `strftime`, no Postgres arrays or `JSONB` operators. JSON goes in `TEXT` columns, parsed in the repository layer. Use `INTEGER PRIMARY KEY` with application-generated UUIDv7 strings (`TEXT`) instead — sortable by time, portable, no sequence semantics to reconcile.

### The client adapter

```js
// db/client.js
export function createClient(url) {
  return url.startsWith("postgres")
    ? pgAdapter(url)          // rewrites ? → $1, $2…
    : sqliteAdapter(url);     // node:sqlite or better-sqlite3
}
// Both expose: query(sql, params) → rows
//              transaction(fn)   → runs fn with a scoped client
```

Repositories write `?` placeholders. The pg adapter rewrites them. One `DATABASE_URL` in config selects the dialect; nothing above the adapter knows which one it got.

### Migrations

Forward-only numbered `.sql` files, each applied inside a transaction, recorded in `schema_migrations`. No down migrations — for a personal tool they're maintenance you'll never use and a false sense of safety.

```
db/migrations/0001_init.sql
              0002_add_risk_rules.sql
```

---

## 3. Schema

Written in the portable subset. Comments explain the *why*, which is the part that's expensive to rediscover.

```sql
-- ─── migration tracking ──────────────────────────────────────────
CREATE TABLE schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- ─── accounts ────────────────────────────────────────────────────
-- Multi-account from day one. You'll want to run two strategies with
-- separate capital without them sharing a P&L, and retrofitting an
-- account_id onto a populated orders table is miserable.
CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  mode           TEXT NOT NULL,            -- 'paper' | 'live'  (live = future)
  starting_cash  INTEGER NOT NULL,         -- cents
  cash           INTEGER NOT NULL,         -- cents, current
  realized_pnl   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER
);

-- ─── settings ────────────────────────────────────────────────────
-- Replaces the .env-rewriting in server/index.js:199 (finding S3).
-- .env keeps bootstrap-only values a human edits; everything the app
-- writes at runtime lives here. Secrets encrypted at rest.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- ─── algorithms ──────────────────────────────────────────────────
CREATE TABLE algorithms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  author      TEXT,
  description TEXT,
  source_path TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- Every edit to an algorithm file creates a version row. A session
-- pins the exact source_hash it ran, so a result from three months
-- ago is always reproducible and always attributable to real code.
-- This is also what makes upload-overwrite (finding S4) non-destructive.
CREATE TABLE algorithm_versions (
  id            TEXT PRIMARY KEY,
  algorithm_id  TEXT NOT NULL REFERENCES algorithms(id),
  source_hash   TEXT NOT NULL,            -- sha256 of file contents
  source_code   TEXT NOT NULL,            -- full snapshot; disk is cheap, history isn't
  params_json   TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  UNIQUE (algorithm_id, source_hash)
);

-- ─── sessions ────────────────────────────────────────────────────
-- The central record. Everything the HUD compares hangs off this.
CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES accounts(id),
  name                 TEXT NOT NULL,
  mode                 TEXT NOT NULL,     -- 'backtest' | 'paper'
  status               TEXT NOT NULL,     -- see 03-runtime-risk-alerts §1
  algorithm_version_id TEXT REFERENCES algorithm_versions(id),
  params_json          TEXT NOT NULL DEFAULT '{}',
  symbols_json         TEXT NOT NULL,     -- ["AAPL","NVDA"]
  bar_interval         TEXT NOT NULL,     -- '1min'|'5min'|'1hour'|'1day'
  window_start         INTEGER,           -- backtest window
  window_end           INTEGER,
  fill_model_json      TEXT NOT NULL,     -- ★ slippage/commission/fill-rule, FROZEN at start
  risk_profile_json    TEXT NOT NULL DEFAULT '{}',
  starting_equity      INTEGER NOT NULL,
  ending_equity        INTEGER,
  started_at           INTEGER,
  ended_at             INTEGER,
  stop_reason          TEXT,              -- 'user'|'schedule'|'risk_halt'|'error'|'completed'
  error_detail         TEXT,
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_sessions_account ON sessions(account_id, started_at DESC);
CREATE INDEX idx_sessions_status  ON sessions(status);

-- Metrics are DERIVED, stored separately, and recomputable. Keeping them
-- out of `sessions` means fixing a metric bug (finding C7) is a recompute,
-- not a schema migration — and you can keep old + new side by side.
CREATE TABLE session_metrics (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  computed_at        INTEGER NOT NULL,
  metrics_version    TEXT NOT NULL,       -- bump when a definition changes
  return_percent     REAL,
  final_equity       INTEGER,
  max_drawdown       REAL,                -- ONE sign convention. Positive magnitude. (C7e)
  sharpe             REAL,                -- annualized by ACTUAL bar interval (C7b)
  sortino            REAL,
  profit_factor      REAL,                -- NULL when no losses — never 99 (C7c)
  win_rate           REAL,                -- NULL when no closed trades — never 0 (C7d)
  trade_count        INTEGER NOT NULL DEFAULT 0,
  exposure_percent   REAL,
  avg_trade_percent  REAL,
  UNIQUE (session_id, metrics_version)
);

-- ─── orders & fills ──────────────────────────────────────────────
CREATE TABLE orders (
  id               TEXT PRIMARY KEY,
  client_order_id  TEXT NOT NULL UNIQUE,  -- idempotency: a retried submit can't double-fill
  session_id       TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL,         -- 'buy' | 'sell'
  order_type       TEXT NOT NULL DEFAULT 'market',
  qty              INTEGER NOT NULL,      -- micro-shares
  limit_price      INTEGER,               -- cents
  status           TEXT NOT NULL,         -- 'pending'|'filled'|'partial'|'rejected'|'canceled'
  reject_reason    TEXT,                  -- risk rule id, stale quote, insufficient funds…
  signal_reason    TEXT,                  -- WHY the algorithm fired. Surfaced in the UI.
  submitted_at     INTEGER NOT NULL,
  resolved_at      INTEGER
);
CREATE INDEX idx_orders_session ON orders(session_id, submitted_at DESC);
CREATE INDEX idx_orders_symbol  ON orders(account_id, symbol, submitted_at DESC);

-- Separate from orders so partial fills, and later real broker fills,
-- need no schema change. Costs stored per fill because that's where
-- they're incurred — and it's what makes backtest/paper comparable (C3).
CREATE TABLE fills (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  qty            INTEGER NOT NULL,        -- micro-shares
  price          INTEGER NOT NULL,        -- cents, AFTER slippage
  reference_price INTEGER NOT NULL,       -- cents, BEFORE slippage — lets you audit the model
  commission     INTEGER NOT NULL DEFAULT 0,
  filled_at      INTEGER NOT NULL,
  quote_age_ms   INTEGER                  -- staleness at fill time (finding C4)
);
CREATE INDEX idx_fills_order ON fills(order_id);

-- ─── positions ───────────────────────────────────────────────────
-- Lot-level, not aggregate. Closed lots stay as history, which is what
-- makes per-trade P&L attribution and win-rate honest.
CREATE TABLE position_lots (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  symbol        TEXT NOT NULL,
  qty_open      INTEGER NOT NULL,
  qty_original  INTEGER NOT NULL,
  entry_price   INTEGER NOT NULL,         -- cents
  entry_order_id TEXT REFERENCES orders(id),
  exit_price    INTEGER,
  exit_order_id TEXT REFERENCES orders(id),
  realized_pnl  INTEGER,                  -- cents, net of commission
  opened_at     INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX idx_lots_open ON position_lots(account_id, symbol, closed_at);

-- ─── equity time series ──────────────────────────────────────────
-- The curve behind every chart and every session comparison.
CREATE TABLE equity_snapshots (
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at               INTEGER NOT NULL,
  equity           INTEGER NOT NULL,      -- cents
  cash             INTEGER NOT NULL,
  position_value   INTEGER NOT NULL,
  drawdown_percent REAL NOT NULL,
  PRIMARY KEY (session_id, at)
);

-- ─── backtest cache ──────────────────────────────────────────────
-- Fixes P2. Recompute only when an input actually changed.
CREATE TABLE backtest_runs (
  id                   TEXT PRIMARY KEY,
  algorithm_version_id TEXT NOT NULL REFERENCES algorithm_versions(id),
  symbol               TEXT NOT NULL,
  bar_interval         TEXT NOT NULL,
  window_start         INTEGER NOT NULL,
  window_end           INTEGER NOT NULL,
  bars_hash            TEXT NOT NULL,     -- provider revisions invalidate automatically
  params_hash          TEXT NOT NULL,
  fill_model_hash      TEXT NOT NULL,
  result_json          TEXT NOT NULL,     -- trades + equity curve + metrics
  computed_at          INTEGER NOT NULL,
  compute_ms           INTEGER,
  UNIQUE (algorithm_version_id, symbol, bar_interval,
          window_start, window_end, bars_hash, params_hash, fill_model_hash)
);

-- ─── risk ────────────────────────────────────────────────────────
CREATE TABLE risk_profiles (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  name        TEXT NOT NULL,
  rules_json  TEXT NOT NULL,              -- see 03-runtime-risk-alerts §2
  is_default  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Every trigger, logged. This is the audit trail for "why did my bot stop."
CREATE TABLE risk_events (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  at           INTEGER NOT NULL,
  rule_id      TEXT NOT NULL,
  severity     TEXT NOT NULL,             -- 'info' | 'warn' | 'block' | 'halt'
  action_taken TEXT NOT NULL,             -- 'logged'|'order_rejected'|'session_halted'|'liquidated'
  detail_json  TEXT NOT NULL,             -- threshold, observed value, symbol
  order_id     TEXT REFERENCES orders(id)
);
CREATE INDEX idx_risk_events_session ON risk_events(session_id, at DESC);

-- ─── alerts ──────────────────────────────────────────────────────
CREATE TABLE alerts (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id),
  name           TEXT NOT NULL,
  trigger_type   TEXT NOT NULL,           -- 'metric_threshold'|'risk_event'|'session_state'|'signal'|'schedule'
  condition_json TEXT NOT NULL,
  channel        TEXT NOT NULL,           -- 'in_app' (v1) | 'webhook' | 'email'
  channel_config_json TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  cooldown_ms    INTEGER NOT NULL DEFAULT 0,   -- prevents alert storms
  last_fired_at  INTEGER,
  created_at     INTEGER NOT NULL
);

CREATE TABLE alert_deliveries (
  id           TEXT PRIMARY KEY,
  alert_id     TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  session_id   TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  at           INTEGER NOT NULL,
  status       TEXT NOT NULL,             -- 'sent'|'failed'|'suppressed'
  payload_json TEXT NOT NULL,
  error_detail TEXT
);
CREATE INDEX idx_deliveries_alert ON alert_deliveries(alert_id, at DESC);

-- ─── audit ───────────────────────────────────────────────────────
-- Cheap, and the first thing you'll want when something surprises you.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,              -- 'user'|'scheduler'|'risk_engine'
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  detail_json TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
```

### Schema notes worth keeping

- **`fill_model_json` is frozen into the session row.** Change your slippage assumption next month and old sessions still explain themselves. Without this, historical comparison quietly becomes meaningless.
- **`metrics_version` on `session_metrics`** means fixing a metric definition is a recompute pass, and you can hold old and new side by side to see what moved.
- **`bars_hash` in `backtest_runs`** means a provider revising historical data invalidates the cache automatically, rather than serving a stale result forever.
- **`reference_price` next to `price` on fills** lets you audit the fill model itself — "what did slippage actually cost me this session" is a query, not a guess.
- **`signal_reason` on orders** is the thread from a number in the HUD back to the line of strategy code that caused it. It's the difference between a dashboard and a black box.

---

## 4. API surface

RESTful, versioned, validated against shared schemas at the boundary. Existing market routes stay roughly as-is; everything else is new.

```
# Market (mostly existing)
GET    /api/v1/market/search?q=
GET    /api/v1/market/quote/:symbol
GET    /api/v1/market/bars/:symbol?interval=&start=&end=
GET    /api/v1/market/movers
GET    /api/v1/market/health              → per-provider status. Surfaced in the status bar.

# Algorithms
GET    /api/v1/algorithms
GET    /api/v1/algorithms/:id/versions
POST   /api/v1/algorithms                 → upload (validated, versioned, sandbox-checked)
PATCH  /api/v1/algorithms/:id             → params, enabled
POST   /api/v1/algorithms/:id/backtest    → cached run

# Sessions  ← the core of the new surface
GET    /api/v1/sessions?status=&mode=&limit=&cursor=
POST   /api/v1/sessions                   → create (does not start)
GET    /api/v1/sessions/:id               → header + metrics
GET    /api/v1/sessions/:id/equity?resolution=   → downsampled server-side
GET    /api/v1/sessions/:id/orders?cursor=
GET    /api/v1/sessions/:id/events        → risk events + state transitions, merged timeline
POST   /api/v1/sessions/:id/start
POST   /api/v1/sessions/:id/pause
POST   /api/v1/sessions/:id/resume
POST   /api/v1/sessions/:id/stop
POST   /api/v1/sessions/:id/halt          → ★ KILL SWITCH. Never queued behind work.
GET    /api/v1/sessions/compare?ids=a,b,c → aligned curves + metric matrix + config diff
GET    /api/v1/sessions/:id/export?format=csv|json

# Portfolio & orders
GET    /api/v1/accounts/:id/portfolio
POST   /api/v1/accounts/:id/orders        → manual paper order
POST   /api/v1/accounts/:id/liquidate     → failsafe

# Risk & alerts
GET    /api/v1/risk/profiles
PUT    /api/v1/risk/profiles/:id
GET    /api/v1/risk/events?session_id=
GET    /api/v1/alerts
POST   /api/v1/alerts
GET    /api/v1/alerts/feed?since=

# Live
GET    /api/v1/stream                     → SSE: session state, fills, equity ticks,
                                            risk events, alerts. Replaces 4 polls (P5).
```

**Conventions.** Envelope `{ data, meta }` on success; `{ error: { code, message, detail } }` on failure — with **stable machine-readable codes**, which fixes the ambiguity in finding M5. Cursor pagination on every list. `GET /api/v1/sessions/:id/equity?resolution=` downsamples server-side so the client never receives 50,000 points to draw 800 pixels.

**On SSE.** The runtime knows the instant something changes; polling asks four times a second whether anything did. One event stream replaces four intervals, cuts provider rate-limit burn, and makes the HUD feel live rather than refreshed. It also removes the background-tab waste in P5 for free.

---

## 5. The shared formatter layer

This is the piece that ties the code review's C7 to the UX work in `04-hud-and-chart-spec.md`, so it's worth being explicit.

`packages/shared/format.ts` is the **only** place a number becomes a string:

```ts
formatMoney(cents, { compact?: boolean })      // 1234567 → "$12,345.67" | "$12.3K"
formatPercent(value, { signed?: boolean })     // 12.345  → "+12.35%"
formatQty(microShares)                         //
formatVolume(n)                                // 1652100 → "1.65M"
formatTime(epochMs, interval)                  // resolution-aware
formatMetric(key, value)                       // ← dispatches on the metric registry
```

`formatMetric` reads from a metric registry that owns, per metric: label, unit, precision, sign convention, "higher is better" direction, and what `null` renders as. That registry is what guarantees drawdown reads the same way in the comparison table, the session detail header, and the chart tooltip — the failure mode in C7d/C7e where the same metric renders three different ways in three panels.

Today `src/main.tsx:25–36` defines formatters at module scope in the frontend and the server rounds independently with `.toFixed()`. Both sides import the shared module instead.

---

## 6. Configuration

```
DATABASE_URL=file:./data/stockbot.db      # → postgres://… later. Only line that changes.
PORT=4000
HOST=127.0.0.1                            # ← was 0.0.0.0 (finding S1/S2)
STOCKBOT_API_TOKEN=                       # shared secret for mutating routes
ALPACA_API_KEY= / ALPACA_API_SECRET=      # bootstrap only; runtime edits go to `settings`
POLYGON_API_KEY= / FINNHUB_API_KEY=
ENGINE_WORKERS=4
ENGINE_TIMEOUT_MS=10000
```

`config/index.js` parses and validates at boot and **fails fast** on malformed config. A trading bot that starts with a silently missing key and reports "unavailable" for an hour is worse than one that refuses to start.
