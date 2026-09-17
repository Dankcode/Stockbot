# 06 — Experiments, active-trader visibility, and symbol selection

Code review and implementation plan for running a set of methods against their proper
control group, on any symbol, from the CLI or the dashboard — plus letting the selector
choose the symbol.

Reviewed at commit `2efea30` with 20 files modified in the working tree. Phases 1 and 2
are implemented in this change; phases 3–5 remain follow-up work.

---

## Contents

- [Code review](#code-review)
- [The structural gap](#the-structural-gap)
- [Phase 1 — shipped](#phase-1--shipped-experiment-engine-and-cli)
- [Phase 2 — first-class cohorts](#phase-2--first-class-cohorts-in-sql)
- [Phase 3 — active-trader visibility](#phase-3--active-trader-visibility-per-symbol)
- [Phase 4 — manual selection in the dashboard](#phase-4--manual-selection-in-the-dashboard)
- [Phase 5 — AI selection and scraped recommendations](#phase-5--ai-selection-and-scraped-recommendations)
- [Configuration that is currently missing](#configuration-that-is-currently-missing)

---

## Code review

### Summary

This is a well-built codebase. The engine is pure and deterministic, plugin methods are
data walked by a bounded interpreter rather than code that gets executed, results are
content-hashed and cached on every input that can change them, and the control-group
doctrine is written down and taken seriously. The findings below are mostly about a
subsystem that was designed but never wired up, plus one auth default that fails in the
wrong direction.

### Critical issues

| # | File | Line | Issue | Severity |
|---|---|---|---|---|
| 1 | `server/http/middleware.js` | 15 | `mutationAuth` returns `next()` when `config.apiToken` is unset, so with no `STOCKBOT_API_TOKEN` every `POST`/`PATCH`/`DELETE` — create session, start, halt, upload algorithm — is unauthenticated. Your `.env` has no such token today. `operatorAuth` in the same file fails **closed** with a 503 for exactly this case, which is what makes this look like an oversight rather than a decision. Loopback binding limits the blast radius to local processes, and `config/index.js:88` does require a token when `allowRemote` is on — but "any local process can start a paper trader" is a weaker guarantee than the code reads as offering. | 🔴 Critical |
| 2 | `server/market/chain.js` | 128–130 | `movers()` calls `search("", { withQuotes: true, limit: 60 })`, which fans out up to 60 concurrent per-symbol quote requests to one provider on every call, with no result-level cache and no concurrency cap. This is also the function symbol selection most wants to lean on. Against Alpaca's rate limits this will start returning `degraded` under normal dashboard polling. | 🔴 Critical |

### Suggestions

| # | File | Line | Suggestion | Category |
|---|---|---|---|---|
| 3 | `server/plugins/algorithm-bridge.js` | 85 | `expandPairing` is exported and never called anywhere in the repo. It is the one piece of code that turns `pairings` from documentation into something executable, and it has been sitting unused. Phase 1 supersedes it with `server/experiments/plan.js`, which adds arm deduplication and manual overrides — delete `expandPairing` rather than leaving two answers to the same question. | Maintainability |
| 4 | `server/algorithms/service.js` | 160 | The backtest cache key hashes `{ strategy: bars, spy: spyBars }` together. Correct, but it means every strategy's cached result for a symbol is invalidated whenever SPY's bar cache refreshes independently — the hit rate is far lower than the design implies. A 3-strategy × 20-seed experiment is ~25 engine runs that mostly should have been cache hits. Consider keying the strategy result on the strategy bars alone and storing the SPY/Cash control block under its own key. | Performance |
| 5 | `server/algorithms/service.js` | 85 | `if (!force && Date.now() - loadedAt < 5_000 && snapshot.algorithms.length)` — when a refresh yields zero algorithms (every plugin failed to load, say), the staleness guard never short-circuits, so every subsequent call re-walks the filesystem and re-hashes every plugin file. Track `loadedAt` independently of whether the result was empty. | Performance |
| 6 | `server/algorithms/service.js` | 89–101 | `refresh()` issues three sequential DB round-trips per algorithm — `getById`, then `create`/`update`, then `addVersion`. With 44 registered algorithms that is 132 queries every five seconds under active polling. Batch it, or skip the write path entirely when `sourceHash` is unchanged. | Performance |
| 7 | `server/engine/backtest.js` | 270–271 | Dead branch: `if (index < bars.length - 1) pendingSignal = candidate; else pendingSignal = candidate;` — both arms are identical. The final-bar behaviour is handled correctly further down via `unfilledSignal`, so this is vestigial rather than broken, but it reads as a half-applied fix and will mislead the next person. | Correctness |
| 8 | `server/market/chain.js` | 130 | `movers()` sorts by `Math.abs(quote.changePercent)`, which interleaves the biggest gainers and the biggest losers into one list. That is a volatility ranking, not a movers list; name it accordingly or split the two. | Correctness |
| 9 | `scripts/*.js` | — | `research.js`, `plugin.js` and `horizon-matrix.js` each carry their own copy of env-file loading, flag parsing and the loopback API client — including three separate restatements of the `chmod 600` rule and the "process.env wins" rule. Phase 1 extracts `scripts/lib/cli.js`; migrate the existing three onto it so the security-relevant rules have one definition. | Maintainability |
| 10 | `server/db/migrations/0001_init.sql` | 57 | `sessions.algorithm_version_id` is singular, with no grouping column. See [the structural gap](#the-structural-gap) below. | Architecture |

### What looks good

- **The engine is honest.** Fill at next bar's open, `unfilledSignal` rather than an
  invented final fill, an open position marked to the last real close instead of being
  force-sold, and `barsHash` verified against the supplied window. These are the details
  that quietly inflate returns everywhere else, and they are all handled.
- **Plugins are data, not code.** `method-engine.js` binds a frozen rule tree and walks
  it with a closed operator set under a node budget. `registry.js` rejects unresolvable
  references — an undeclared series, an uninitialised state key, a param with no default
  — before a plugin is considered installed, and rejects a method that reads randomness
  without declaring a seed, on the grounds that it would silently corrupt the result
  cache. That last check is unusually thoughtful.
- **The result cache keys on everything that can change the answer**: version, params,
  symbol, interval, window, bars hash, fill-model hash.
- **`docs/CONTROL_GROUP.md` is the best file in the repo.** The three same-asset controls,
  the insistence on a distribution rather than a single seed, the "every parameter you
  tried counts as a test" line, and the observation that a control which can only ever
  confirm you is not a control. Phase 1 is largely an attempt to make the code enforce
  what that document already argues.

### Verdict

**Approve, with the auth default fixed.** Finding 1 is a two-line change and should not
wait for the rest of the plan. Findings 2 and 4–6 are performance work that becomes
urgent precisely when the experiment and selection features start driving real load.

---

## The structural gap

`sessions.algorithm_version_id` is a single column. A session binds exactly one algorithm
version, so "add these methods to my current session and run them" is not expressible in
the schema as it stands. Your current session — `test`, AAPL, `1day`, paper, draft, bound
to `control-buy-and-hold` — is one arm of an experiment with no way to name the others.

The temptation is to make a session hold many algorithms. That is the wrong fix: it
breaks the one-session-one-version invariant that makes every equity curve, order and
risk event attributable to exact code, and that invariant is load-bearing for everything
in `docs/plan/03`.

The right shape is a layer above:

```
experiment  ──┬── session (arm: strategy)  ── one algorithm version
              ├── session (arm: control)   ── one algorithm version
              ├── session (arm: control)   ── one algorithm version
              └── …
```

An experiment is a set of sibling sessions over one symbol and window, one per arm, each
still bound to exactly one version. Comparison, verdicts and the "which arm is live"
question all belong to the experiment; execution, risk and attribution stay with the
session. Nothing about the runtime has to change.

---

## Phase 1 — shipped: experiment engine and CLI

Implemented in this change, with 42 new tests. `npm test` is 291/291 green and
`tsc --noEmit` is clean.

### New modules

| File | Responsibility |
|---|---|
| `server/experiments/plan.js` | Resolves a selection into an executable plan: strategy arms, control arms, seed fan-out, congruent params. Pure. |
| `server/experiments/runner.js` | Executes a plan through an injected executor, with concurrency, failure isolation and progress. Ships `createApiExecutor` for the loopback backtest endpoint. |
| `server/experiments/report.js` | Runs the `CONTROL_GROUP.md` gauntlet and emits a verdict per strategy, plus the comparison table. |
| `server/experiments/selection.js` | Scores symbols on suitability for systematic testing. Pure; facts are injected. |
| `scripts/lib/cli.js` | Shared env loading, flag parsing and the loopback client, extracted from the three existing CLIs. |
| `scripts/experiment.js` | `run`, `plan`, `select`, `sessions`, `methods`. |
| `scripts/dev/offline-matrix.js` | Runs the identical plan/report code against synthetic bars, for verifying wiring with no provider. |

### Three properties the planner enforces

1. **Congruence.** Controls inherit the strategy's symbol, range, interval and fill model,
   plus the `controlParams` the pairing declares. A monthly strategy against a daily
   control measures turnover, not skill.
2. **Distribution, not draw.** Any control whose defaults include a `seed` is fanned out
   across `seeds` runs. A control the caller pinned to one explicit seed is not — that is
   a deliberate single-path comparison.
3. **Deduplication.** Arms are interned on `(algorithmId, params)` with order-stable
   param hashing, so buy-and-hold on one symbol runs once no matter how many strategies
   named it. Three strategies sharing the shipped pairings collapse **69 naive runs into
   25**.

A strategy with neither a declared pairing nor explicit controls is a hard error, not a
bare single-arm run. An uncontrolled backtest is the artefact this whole subsystem exists
to prevent.

### The verdict gauntlet

Ordered with early exits, exactly as `CONTROL_GROUP.md` prescribes:

| Verdict | Condition |
|---|---|
| `fails-floor` | Did not beat cash. Nothing below matters. |
| `below-passive` | Sharpe at or under same-asset buy-and-hold. |
| `no-timing-edge` | An exposure-matched control that ignores price returned more. |
| `inside-noise` | Under the 90th percentile of the random-control distribution. |
| `incomplete` | The strategy arm failed, or no random distribution was produced. |
| `worth-recording` | Cleared every control it was measured against. |

Warnings ride alongside the verdict rather than changing it: an exposure gap over 10
percentage points, fewer than 10 seeds, fewer than 5 closed trades, an open position at
the end of the window.

### Usage

```bash
# automated — controls come from the plugin's own pairings block
npm run experiment -- run --symbol NVDA --strategy base-methods/ema-momentum

# manual — you choose the strategy and the comparison
npm run experiment -- run --symbol NVDA \
  --strategy base-methods/ema-momentum \
  --control core-controls/buy-and-hold \
  --control core-controls/fixed-interval \
  --control core-controls/random-entry \
  --seeds 20

# every installed strategy against its declared controls
npm run experiment -- run --symbol NVDA --all-strategies

# let the selector choose the symbol first
npm run experiment -- run --auto --strategy base-methods/rsi-mean-reversion

# ranking only, no backtests
npm run experiment -- select --limit 5

# materialise the arms as sibling draft sessions
npm run experiment -- sessions --symbol NVDA --strategy base-methods/ema-momentum

# verify the wiring with no market-data provider (synthetic bars)
npm run experiment:offline -- --bars 600 --seeds 20
```

`run` exits 0 even when nothing clears its controls — that is a successful experiment
with a negative result, not a command failure. Only an execution failure exits non-zero.

## Phase 2 — first-class cohorts in SQL — shipped

**Migration `0005_experiments.sql`**

```sql
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  bar_interval TEXT NOT NULL,
  window_start INTEGER,
  window_end INTEGER,
  fill_model_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,          -- the frozen plan, for reproducibility
  selection_json TEXT,              -- selector output when --auto chose the symbol
  created_at INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN experiment_id TEXT REFERENCES experiments(id);
ALTER TABLE sessions ADD COLUMN experiment_arm TEXT;   -- 'strategy' | 'control'
ALTER TABLE sessions ADD COLUMN experiment_arm_id TEXT; -- e.g. 'ctl/random#seed=7'
CREATE INDEX sessions_experiment_idx ON sessions(experiment_id, experiment_arm);
```

Implemented:

1. `server/db/repositories/experiments.js` following the existing repository shape.
2. `server/experiments/service.js` — create, get, list, and `report(id)` which reads the
   sibling sessions' metrics and runs the phase-1 summarizer over them.
3. `POST /api/v1/experiments`, `GET /api/v1/experiments/:id`,
   `POST /api/v1/experiments/:id/start` (starts every arm),
   `POST /api/v1/experiments/:id/halt` (halts every arm — this must reuse the existing
   kill-switch path, not a new one).
4. `scripts/experiment.js sessions` switches to the cohort endpoint. Session names
   remain readable, but cohort membership is the `experiment_id` foreign key, never
   parsed text.

The persisted plan includes the exact algorithm-version binding selected when the cohort
was created. A later plugin or upload change therefore cannot rewrite the code behind an
existing arm. Cohort creation also cleans up all sibling rows on a failed creation.

**Exit:** an experiment is a durable record. Restart the server and the cohort, its plan,
version bindings, sibling arms and report all survive.

---

## Phase 3 — active-trader visibility per symbol

The question "what is actually trading AAPL right now, and which arm is it?" currently
requires reading the sessions list and inferring.

1. `GET /api/v1/overview/active?symbol=SYM` — for each running session on that symbol:
   arm id, experiment, current position, unrealized P&L, last signal with its reason,
   next scheduled evaluation, and which risk rules are closest to their thresholds.
2. Stream it over the existing SSE hub (`server/http/event-hub.js`) rather than adding
   another poll.
3. `src/features/markets/MarketInspector.tsx` grows an **Active traders** rail: one row
   per live arm on the inspected symbol, with the strategy arm visually distinguished
   from its controls, and a per-arm halt.
4. Overlay live arm entries and exits onto `MarketChart` using the existing
   `StaticOverlays` layer, colour-keyed by arm.

The important design point: controls that are running live must be visually distinct from
the strategy. An operator glancing at four AAPL sessions needs to see instantly that three
of them are null hypotheses, not four ideas.

**Exit:** open a symbol, see every arm trading it, halt any one of them from that view.

---

## Phase 4 — manual selection in the dashboard

`CreateSessionDialog` currently offers one algorithm and one version. Extend it into a
mode switch rather than a replacement:

- **Single session** — today's behaviour, unchanged.
- **Experiment** — multi-select strategies; controls default to each strategy's declared
  pairing and are shown as an editable list with their congruent params; a seed count; a
  live-updating "this expands to N arms (M duplicate runs shared)" line straight from
  `buildExperimentPlan`.

Notes:

- Everything is dynamic across symbols already. The plan builder takes the symbol as
  input and nothing in it is per-symbol.
- Surface the exposure-match warning **in the dialog**, before the run, not only in the
  report afterwards. Tuning `entryEveryBars`/`holdBars` after seeing the result is how
  exposure matching gets skipped.
- Reuse `MetricMatrix` and `ConfigDiff` from `SessionComparePage` for the experiment
  detail view; it already does most of what is needed for four arms.

**Exit:** a strategy plus its control group can be launched from the dashboard on any
symbol, with no CLI.

---

## Phase 5 — AI selection and scraped recommendations

### What is shipped

`server/experiments/selection.js` scores symbols on **suitability for systematic
testing** — liquidity, volatility in a usable band, trend clarity, and research coverage
— with hard gates that exclude rather than penalise, and per-component reasons attached
to every candidate.

It deliberately does not predict returns. A screener that ranks by expected performance
is a tip sheet, and the whole point of the control-group work is to stop treating one
flattering number as evidence. Missing data is excluded from the weighted average rather
than defaulted to a neutral value — scoring an absent sentiment reading as 0.5 invents a
fact.

### What remains

1. **`server/experiments/screener.js`** — gather the facts. Order matters, cheapest first:
   - Alpaca/Polygon/Finnhub bars, already wired through `market.getBars`, give price,
     dollar volume, ATR and trend with no new source.
   - `market.movers()` narrows the universe — but fix finding 2 first, or the screener
     will be the thing that trips the rate limit.
   - Research coverage comes from `research_documents` counts per symbol, which is a
     SQL query against data you already archive, not a new scrape.
2. **Register the free sources.** Everything below needs `RESEARCH_WEB_SOURCES_JSON`
   entries; a plan step whose `sourceId` is absent fails closed with
   `RESEARCH_SOURCE_NOT_CONFIGURED`, which is the correct behaviour and also why nothing
   currently runs:
   - SEC EDGAR full-text search and company RSS — already modelled in
     `research-plans/sec-edgar-filings.json` and `stockbot-alpha/feeds/providers/`.
   - `market-news-sentiment` and `social-sentiment` plans — need an `AI_CLI_COMMAND` for
     the summarizer.
   - `gov-contracts-defense` — worth wiring, but read
     `docs/RESEARCH_SOURCES.md` first: SAM.gov requires an API key and FPDS returns an
     unsupported content type. Both are documented dead ends.
3. **`getResearch` in the selection path.** The hook exists and is deliberately left
   unwired: connecting it unconditionally would make every selection run fail closed on
   an install with no registered sources. Wire it behind a configuration check, and keep
   the current behaviour — a research adapter that throws removes the coverage component
   and says so, rather than dropping the symbol.
4. **Universe expansion.** `market.getBars` rejects symbols outside the asset catalogue
   with `UNKNOWN_SYMBOL`. Without Alpaca credentials the catalogue is the 17 entries in
   `LOCAL_ASSETS`, which is a small universe to select from. Selection quality is bounded
   by catalogue breadth before it is bounded by the scoring function.
5. **Persist recommendations.** Write each selection run to `research_runs` with its
   inputs, weights, gates and evidence. A recommendation you cannot reconstruct six weeks
   later is not auditable, and the experiment that followed it is not reproducible.

**Exit:** `experiment run --auto` picks a symbol from real screening data, records why it
picked it with source provenance, and the whole chain from recommendation to verdict is
reconstructible from SQL.

---

## Configuration that is currently missing

None of this is a code problem, but all of it silently disables features:

| Variable | Status | Consequence |
|---|---|---|
| `STOCKBOT_API_TOKEN` | absent | Every CLI that reaches the API refuses to start (`AUTH_NOT_CONFIGURED`) — and, per finding 1, every mutating HTTP route is currently unauthenticated. |
| `RESEARCH_WEB_SOURCES_JSON` | absent | No source is registered, so all research plans fail closed. |
| `AI_CLI_COMMAND` | absent | No summarizer, so sentiment-gated methods never see an available snapshot and never fire. |
| `STOCKBOT_SETTINGS_KEY` | absent | Provider secrets cannot be encrypted into SQL. |

`npm run plugin -- requirements` reports all of this against your actual configuration,
with the remedy for each. Run it before blaming a strategy for not trading.

---

## Live end-to-end run — seven bugs the unit tests missed

Run on 2026-08-24 against the real API with a synthetic market provider
(`scripts/dev/integration-server.js`). `createStockbot()` already accepts an injected
`market`, so everything above the provider boundary is production code: migrations,
repositories, plugin loader, engine worker pool, result cache, HTTP routing, auth
middleware, supervisor, paper broker.

The synthetic universe is falsifiable on purpose. `THIN` trades $2M/day, `PENNY` is
priced at $2.40, `NEWCO` has 40 bars. If any of the three reaches a recommendation, a
gate is broken.

| # | Where | What broke | Fix |
|---|---|---|---|
| B1 | `server/algorithms/service.js` — `publicAlgorithm` | Every plugin control was reported as a **strategy**. The bridge builds `plugin: {role, horizon, controlFor}`; `publicAlgorithm` dropped it. `--all-strategies` swept the whole control group in as treatment arms and the `EXPERIMENT_ROLE_INVALID` guard never fired. Masked for `.js` files by the `control-` filename convention. | Expose `role`, `horizon`, `controlFor`. Registry now reports 32 strategies / 11 controls / 1 benchmark. |
| B2 | `server/http/middleware.js` — `mutationAuth` | Audit finding 1, proven: with no `STOCKBOT_API_TOKEN`, unauthenticated `POST /api/v1/sessions` returned **HTTP 201** and wrote a real session row. | Fail closed with `503 AUTH_NOT_CONFIGURED`, matching `operatorAuth`. |
| B3 | `server/experiments/selection.js` — `DEFAULT_GATES` | **The AI-selection path was dead on arrival.** `minBars: 250` is unreachable: `RANGE_CONFIG` limits are 60/78/180/60/140/80/140, ceiling 180. Every symbol excluded at every range; `run --auto` always `EXPERIMENT_NO_CANDIDATE`. The unit tests injected 300-bar arrays and never met a real range limit. | Gate on coverage of the requested window (80% of `range.limit`) with a 40-bar floor. Regression test asserts against the real range table. |
| B4 | `server/experiments/report.js` | A strategy with **2 closed trades** was reported as `clears controls`. Trade count was only a warning, and the verdict is what gets quoted. | New `insufficient-evidence` verdict below 5 closed round trips. A loss with 2 trades still reads `fails-floor`. |
| B5 | `server/experiments/plan.js` | Controls were interned before the strategy, so the compare link built from the first four arms held **four controls and no treatment arm**. | Intern the strategy first. |
| B6 | `scripts/experiment.js` — `sessions` | Cohort arms defaulted to **0 bps** slippage while backtest arms used **5 bps** — the exact "same fill model or it is not a comparison" rule, broken. | Pin one fill model across every arm and print it. |
| B7 | `scripts/experiment.js` — `--all-strategies` | Unusable twice: tripped the 32-strategy cap, then hard-failed on the first `.js` method with no pairing. | Skip unpaired methods with a count on stderr, add `--plugin` to scope the sweep, make the cap error actionable. |

### What worked first time

- Full session lifecycle: `draft → arming → running → halted`, audit rows per transition,
  the running arm visible in `/overview`, clean halt.
- Result cache: 27 ms cold backtest, 4 ms warm with `cache.hit: true`.
- Arm deduplication under real load: 25 arms over HTTP in 157 ms against 69 naive runs.
- All 44 algorithms loaded with zero plugin errors; cold boot to serving in 520 ms.

### Correction to finding 6

Finding 6 above flags 132 DB round-trips per `refresh()`. Measured, a full cold boot
*including* that refresh takes **520 ms** on SQLite. The arithmetic is right but the
severity was not — I flagged it from reading and the stopwatch does not back it. Worth
batching before the Postgres path; not worth doing first.

### Action required

The B2 fix means mutating routes refuse to work until `STOCKBOT_API_TOKEN` is set. Add a
32+ character value to `.env` (`openssl rand -hex 32`) or the dashboard returns 503 on
every action.
