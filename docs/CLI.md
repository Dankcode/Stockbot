# Stockbot CLI reference

Every command-line surface in Stockbot: running the app, plugins, AI research, the database, the horizon matrix, and the macOS service.

For the dashboard walkthrough, see [Usage guide](./USAGE.md).

---

## Contents

- [Conventions](#conventions)
- [Running the app](#running-the-app)
- [Quality gates](#quality-gates)
- [Plugins](#plugins)
- [AI research](#ai-research)
- [Database operations](#database-operations)
- [Horizon matrix](#horizon-matrix)
- [macOS service](#macos-service)
- [Environment variables](#environment-variables)
- [Exit codes and error codes](#exit-codes-and-error-codes)

---

## Conventions

**Passing flags through npm.** `npm run` needs `--` before script arguments. Everything after it goes to the script:

```bash
npm run plugin -- inspect --plugin horizon-pack
#              ^^ required
```

Running the script directly avoids the separator:

```bash
node scripts/plugin.js inspect --plugin horizon-pack
```

**Flag syntax.** `--name value` and `--name=value` are both accepted. `--help` prints usage for `plugin`, `research`, `db:*`, `horizon:matrix`, and `research:probe`.

**`--env-file PATH`.** Most commands accept it. Rules that trip people up:

- The file must be a **regular file** with **owner-only permissions**. `chmod 600 <path>` or the command refuses with `ERR_ENV_FILE_PERMISSIONS`.
- Real process environment variables **override** file values, not the other way around.
- Without the flag, the project `.env` is read, then overlaid with `process.env`.
- This is how you point a command at the production config: `--env-file "$HOME/.config/stockbot/stockbot.env"`.

**Commands that need the API running.** `plugin skill run`, and every `research` subcommand except `validate`, call the loopback Stockbot API and need `STOCKBOT_API_TOKEN`. They never send that token to a remote host. Start the server first (`npm run server`) or target the installed service.

---

## Running the app

| Command | What it does |
|---|---|
| `npm run dev` | API and dashboard together, named and colour-coded, killed together |
| `npm run server` | API only — Express on `HOST:PORT`, default `127.0.0.1:4000` |
| `npm run client` | Vite dev server only, `127.0.0.1:5173`, proxying `/api` to port 4000 |
| `npm run build` | `tsc --noEmit` then `vite build` |
| `npm run preview` | Serve the production build locally |

```bash
npm ci
cp .env.example .env
npm run dev            # then open http://127.0.0.1:5173
```

Migrations run forward automatically at server startup.

---

## Quality gates

| Command | What it does |
|---|---|
| `npm run lint` | `tsc --noEmit` — types only, no emit |
| `npm test` | `node --test` across `test/` |
| `npm run check` | lint, then test, then build — run this before committing |

```bash
npm run check
```

---

## Plugins

`stockbot.plugin.v1` bundles are **data**: a frozen rule tree walked inside the bounded engine worker with a closed operator set, a node budget, and a nesting cap. No plugin-provided JavaScript is compiled or executed. A plugin declares the sources, secret *names*, prompt templates, and CLI facilities it needs — it never carries a URL binding, a credential, or a command.

```
npm run plugin -- list
npm run plugin -- validate --file PLUGIN.json
npm run plugin -- inspect --plugin ID [--json]
npm run plugin -- requirements [--plugin ID] [--env-file PATH]
npm run plugin -- templates [--template ID]
npm run plugin -- export --plugin ID [--out DIR]
npm run plugin -- skill list
npm run plugin -- skill run --skill PLUGIN/SKILL --symbol SYM [--env-file PATH]
```

### `list`

Every plugin in `plugins/`, with method, research-plan, and skill counts.

```bash
$ npm run plugin -- list
base-methods@1.0.0           3 methods · 0 research · 0 skills
  Base trading methods
core-controls@1.0.0          3 methods · 0 research · 0 skills
  Core control group
gov-research@1.0.0           0 methods · 2 research · 1 skills
  Government and disclosure research
horizon-pack@1.0.0          14 methods · 0 research · 0 skills
  Horizon pack
sentiment-pack@1.0.0         2 methods · 2 research · 2 skills
  News and social sentiment
```

### `validate --file PLUGIN.json`

Full schema and safety validation of a file that is not yet installed — run it on anything you received from someone else. Checks the operator set, the node budget, the nesting cap, and the rule that every `role: "strategy"` method must name its controls.

```bash
npm run plugin -- validate --file plugins/horizon-pack.plugin.json
```

### `inspect --plugin ID`

Methods, parameters, declared requirements, research plans, and skills for one plugin. `--json` emits the raw plugin document.

```bash
npm run plugin -- inspect --plugin sentiment-pack
npm run plugin -- inspect --plugin sentiment-pack --json
```

### `requirements [--plugin ID]`

Resolves declared requirements against your actual configuration and reports what is missing, with the exact remedy. Omit `--plugin` to check every installed plugin.

```bash
npm run plugin -- requirements --env-file "$HOME/.config/stockbot/stockbot.env"
```

What it reads from your environment, and what it deliberately does not: source **ids** (presence only, not the URLs behind them), secret **names** (never values), and whether an AI CLI command is set (never the path). A plugin learns that a capability exists; it never learns what backs it.

Run this before blaming a strategy. An unmet requirement is why a research-gated method silently never trades.

### `templates [--template ID]`

Lists the prompt templates a plugin may reference by id, or renders one.

### `export --plugin ID [--out DIR]`

Writes a plugin's research plans out as standalone JSON files. Defaults to `research-plans/`.

```bash
npm run plugin -- export --plugin gov-research --out research-plans/
```

### `skill list` / `skill run`

A **skill** names research plans defined in the same plugin. `skill run` resolves them, checks the plugin's requirements against your configuration, imports the plans through the loopback API, pins the returned immutable plan versions, and gathers evidence for a symbol.

```bash
npm run plugin -- skill list
npm run plugin -- skill run --skill sentiment-pack/daily-sentiment-sweep --symbol NVDA
```

It never executes anything a plugin names — because the format has no field in which a plugin could name an executable.

Requires the API running and `STOCKBOT_API_TOKEN` set.

Format details and authoring guide: [Plugin format](./PLUGIN_FORMAT.md) · [Plugin design system](./PLUGIN_DESIGN_SYSTEM.md).

---

## AI research

```
npm run research -- adapters [--env-file PATH]
npm run research -- validate --file PLAN.json [--env-file PATH]
npm run research -- import --file PLAN.json [--env-file PATH]
npm run research -- run --plan PLAN_ID --symbol SYMBOL [--version VERSION_ID] [--env-file PATH]
npm run research -- list [--limit N] [--env-file PATH]
npm run research -- show --run RUN_ID [--env-file PATH]
npm run research -- snapshot --id SNAPSHOT_ID [--env-file PATH]
```

All subcommands except `validate` call the loopback API and require `STOCKBOT_API_TOKEN`.

| Subcommand | What it does |
|---|---|
| `adapters` | Which adapters are configured, which source ids are registered, whether an AI CLI is set. **Start here** — research stays disabled until at least one HTTPS origin and one AI CLI exist. |
| `validate --file` | Schema-check a plan without importing it. The only offline subcommand. |
| `import --file` | Import a plan and create a version. Plans are data; importing one never grants it new reach. |
| `run --plan --symbol` | Execute a plan for one symbol. `--version` pins an exact plan version. |
| `list [--limit N]` | Recent runs, newest first. |
| `show --run RUN_ID` | One run's steps, outputs, and provenance. |
| `snapshot --id ID` | One immutable snapshot with its sources. |

```bash
npm run research -- adapters
npm run research -- validate --file research-plans/catalyst-composite.json
npm run research -- import --file research-plans/catalyst-composite.json
npm run research -- run --plan catalyst-composite --symbol NVDA
npm run research -- list --limit 20
```

A plan cannot name an executable, inject arguments or environment variables, or fetch an origin you did not register. A step whose `sourceId` is absent from `RESEARCH_WEB_SOURCES_JSON` fails closed with `RESEARCH_SOURCE_NOT_CONFIGURED` — which means you **remove a source by deleting its entry from the env, not by editing plans**.

### `research:probe`

```
node scripts/research-probe.js [--symbol SYM] [--plan FILE]... [--env-file PATH] [--dry-run]
npm run research:probe -- --symbol NVDA
```

Issues **one real request per scrape step** through the adapter's actual guardrails and names whichever guardrail rejected each source. This is the diagnostic for "the plan runs but a source returns nothing."

- `--plan FILE` may be repeated; the four shipped plans are the default.
- `--dry-run` resolves and reports without issuing network requests.

Protocol and configuration: [AI research](./AI_RESEARCH.md). Per-source authorization status, plus two documented dead ends (SAM.gov's required API key, FPDS's unsupported content type): [Research sources](./RESEARCH_SOURCES.md).

---

## Database operations

```
npm run db:init   [-- --env-file PATH]
npm run db:status [-- --env-file PATH]
npm run db:backup -- --output /path/to/stockbot-YYYY-MM-DD.db
npm run db:trades -- [--account ID] [--session ID] [--since TIME]
                     [--format json|csv] [--output PATH|-] [--limit N]
```

`DATABASE_URL` is required and is read from the private environment or `.env`. **The connection string is never printed.**

| Command | What it does |
|---|---|
| `db:init` | Apply forward-only migrations and create the default paper account. Safe to re-run. |
| `db:status` | Migration state and connectivity, without disclosing the connection string. |
| `db:backup` | Snapshot a SQLite database to `--output`. Required flag. |
| `db:trades` | Export simulated orders and fills. |

`db:trades` flags:

| Flag | Meaning |
|---|---|
| `--account ID` | Restrict to one account, e.g. `default-paper` |
| `--session ID` | Restrict to one session |
| `--since TIME` | Only trades at or after this time |
| `--format json\|csv` | Output format; defaults to `json` |
| `--output PATH` | Write to a file; `-` or omitted writes to stdout |
| `--limit N` | Cap the number of rows |

```bash
npm run db:status -- --env-file "$HOME/.config/stockbot/stockbot.env"
npm run db:trades -- --account default-paper --format csv --output trades.csv
npm run db:backup -- --output "$HOME/backups/stockbot-$(date +%F).db"
```

The database stores accounts, sessions, algorithm versions, cached backtests, schedules, simulated orders and fills, position lots, equity snapshots, risk events, alerts, settings, and audit events. Market candles are **not** stored — they are fetched from providers and held only in short-lived server caches.

More: [Database operations](./DATABASE_OPERATIONS.md).

---

## Horizon matrix

```
npm run horizon:matrix -- --symbol SYM [--range 1Y] [--seeds 10] [--json] [--env-file PATH]
```

Runs the horizon pack — EMA momentum, RSI mean reversion, and Donchian breakout, each at four holding-period bands — against matched controls, and prints the comparison.

| Flag | Default | Meaning |
|---|---|---|
| `--symbol` | *required* | Ticker, upper-cased automatically |
| `--range` | `1Y` | Any chart range key: `1H`, `1D`, `1W`, `1M`, `3M`, `1Y`, `ALL` |
| `--seeds` | `10` | Random-control seeds per band. More seeds, tighter distribution. |
| `--json` | off | Machine-readable output |
| `--env-file` | project `.env` | Alternate environment |

```bash
npm run horizon:matrix -- --symbol NVDA --range ALL --seeds 20
```

All twelve variants read the same `1day` bars. Daily/weekly/monthly/yearly is the **target holding period** (~2, ~5, ~21, ~252 bars), not the bar interval — the engine has no yearly interval, and resampling would change the data as well as the horizon.

`control-horizon-fixed.js` and `control-horizon-random.js` take the same `horizon` parameter, so turnover and exposure are matched band by band. Comparing a yearly strategy against a daily control measures transaction costs, not skill.

More: [Horizon pack](./HORIZON_PACK.md).

---

## macOS service

Installs Stockbot as a per-user LaunchAgent keeping the API on `127.0.0.1:4000`.

| Command | What it does |
|---|---|
| `npm run laptop:init` | Create `~/.config/stockbot/stockbot.env` as mode `0600`, prompting for `DATABASE_URL` with hidden input and generating secrets **without printing them** |
| `npm run laptop:install` | `npm ci`, lint, test, build, database init, then stage a private production runtime |
| `npm run laptop:status` | Config presence and permissions, Node availability, LaunchAgent state, loopback health, Tailscale Serve status |
| `npm run laptop:tailscale` | Map the loopback HTTP service through private Tailscale Serve |
| `npm run laptop:uninstall` | Remove the LaunchAgent and staged runtime |

Each script accepts `--env-file PATH` to target a config other than the default.

```bash
npm run laptop:init
npm run laptop:install
npm run laptop:status
```

The staged runtime lives at:

```text
~/Library/Application Support/Stockbot/app
```

After saving a database profile in **Settings**, restart the service to pick it up:

```bash
launchctl kickstart -k "gui/$(id -u)/com.stockbot.laptop"
npm run laptop:status
```

Logs:

```bash
tail -f "$HOME/Library/Logs/Stockbot/stockbot.error.log"
```

`laptop:init` refuses to overwrite an existing config, requires `openssl` and Node 22+, and accepts only `file:`, `postgres://`, or `postgresql://` database URLs. `laptop:status` exits non-zero if the config is missing or its permissions are looser than `600`.

**Tailscale scope.** `laptop:tailscale` maps *only* Stockbot's loopback HTTP service through private Tailscale Serve. It does not configure, proxy, or expose PostgreSQL, and it never uses Funnel.

More: [Laptop deployment](./LAPTOP_DEPLOYMENT.md).

---

## Environment variables

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | API bind address and port. Production forces `127.0.0.1`. Default port `4000`. |
| `DATABASE_URL` | SQLite file URL (`file:./data/stockbot.db`) or PostgreSQL connection URL. |
| `STOCKBOT_DATABASE_LOCATION` | UI classification only: `local` or `remote`. |
| `STOCKBOT_CONFIG_FILE` | Absolute owner-only env path the database-settings screen may write to. Leave empty to forbid that. |
| `STOCKBOT_API_TOKEN` | 32+ character mutation secret, entered once per browser tab. **Never** use a `VITE_*` name. |
| `STOCKBOT_SETTINGS_KEY` | 32+ character key encrypting provider secrets stored in SQL. |
| `STOCKBOT_MODE` | Runtime label; production uses `local-paper`. |
| `ENGINE_WORKERS`, `ENGINE_TIMEOUT_MS` | Strategy worker concurrency and per-run deadline. |
| `QUOTE_CACHE_MS`, `QUOTE_FRESHNESS_MS` | Quote cache TTL, and the maximum quote age paper risk checks will accept. |
| `BAR_SETTLE_DELAY_MS` | Delay before a bar is treated as closed. |
| `ALPACA_API_KEY`, `ALPACA_API_SECRET` | Alpaca catalogue, quote, and bar access. |
| `ALPACA_DATA_BASE_URL`, `ALPACA_STOCK_FEED` | Default `https://data.alpaca.markets` and `iex`. |
| `ALPACA_ASSET_CACHE_TTL_MS` | Symbol catalogue cache lifetime. |
| `POLYGON_API_KEY`, `FINNHUB_API_KEY` | Historical bar fallbacks, tried in that order after Alpaca. |
| `RESEARCH_WEB_SOURCES_JSON` | Code-owned source ids mapped to exact, credential-free HTTPS origins. Registering an origin here is the **only** switch that enables a source. |
| `AI_CLI_COMMAND`, `AI_CLI_ARGS_JSON`, `AI_CLI_MODEL` | Server-owned summarizer executable, fixed argv, provenance label. |
| `AI_CLI_MAX_INPUT_BYTES`, `AI_CLI_MAX_OUTPUT_BYTES`, `AI_CLI_TIMEOUT_MS` | Server-side input, output, and deadline caps. |
| `AI_CLI_ENV_ALLOWLIST_JSON` | Explicit allowlist of credential **names** the AI CLI may receive. |

Bootstrap values come from `.env` or the protected env file. Provider settings saved in the dashboard are encrypted in SQL and take precedence. The production database panel atomically updates only its own fields in the protected env and preserves unrelated secrets.

Secrets never belong in source control, frontend code, logs, URLs shown to users, or any `VITE_*` value — Vite inlines those into the shipped bundle.

---

## Exit codes and error codes

`0` on success, non-zero on failure. Each CLI prints `CODE: message` to stderr.

| Code | Meaning and fix |
|---|---|
| `ERR_ENV_FILE_NOT_FOUND` | `--env-file` path does not exist. |
| `ERR_ENV_FILE_INVALID` | Not a regular file, or the project `.env` could not be parsed. |
| `ERR_ENV_FILE_PERMISSIONS` | Env file is group- or world-readable. `chmod 600 <path>`. |
| `PLUGIN_CLI_ERROR` | Bad plugin command, unknown flag, or missing value. |
| `PLUGIN_API_ERROR` | The API rejected the request — usually a missing or wrong `STOCKBOT_API_TOKEN`. |
| `PLUGIN_API_INVALID_RESPONSE` | Non-JSON response; typically the API is not running on the expected port. |
| `RESEARCH_CLI_ERROR` | Unknown research subcommand or missing required flag. |
| `RESEARCH_API_ERROR` | The API rejected the research request. |
| `RESEARCH_SOURCE_NOT_CONFIGURED` | A plan step names a `sourceId` absent from `RESEARCH_WEB_SOURCES_JSON`. |
| `ERR_DATABASE_CLI` | Unknown database subcommand, or `DATABASE_URL` is missing. |
| `HORIZON_CLI_ERROR` | Unknown flag, missing value, or no `--symbol`. |

---

## See also

- [Usage guide](./USAGE.md) — the dashboard, end to end
- [Algorithm format](../algorithms/README.md) — the strategy file contract
- [Plugin format](./PLUGIN_FORMAT.md) — `stockbot.plugin.v1`
- [Control group](./CONTROL_GROUP.md) — how to read a result
- [AI research](./AI_RESEARCH.md) · [Research sources](./RESEARCH_SOURCES.md)
- [Horizon pack](./HORIZON_PACK.md) · [Sentiment pack](./SENTIMENT_PACK.md)
- [Laptop deployment](./LAPTOP_DEPLOYMENT.md) · [Database operations](./DATABASE_OPERATIONS.md)
