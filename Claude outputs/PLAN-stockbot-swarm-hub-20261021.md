# PLAN-stockbot-swarm-hub-20261021

**Mode:** Plan and do not code. Read-only review of `~/Documents/GitHub/Stockbot` at `30cc047`.
**Owner:** Codex implements after the owner approves, phase by phase; Hermes runs each acceptance check. Higher-risk phases (2, 5) get an independent review before deploy.
**Supersedes** the trading model in `PLAN-stockbot-multiagent-research-20261021` (rev 3). Its Phase 0 (making Hermes runs safe), the X discovery collector, the algorithm scan and the 1–10 score with graded predictions carry over as agent **tools and inputs** (mapped below).

## New direction (owner decisions, 2026-10-21)

| Decision | Answer |
|---|---|
| Money | **Paper only.** Real money is a separate, later decision after agents beat their controls. |
| Autonomy | **Fully autonomous within hard limits.** Agents place their own trades; Stockbot enforces caps; the owner reviews after. Replaces the 2026-08-26 "recommend → owner confirms" rule for the swarm. |
| Attribution | **One sleeve per agent:** each agent trades its own isolated paper account. |
| Benchmarks | **SPY and QQQ** for every sleeve. |

**Stockbot's role:** the hub. It holds the books, executes and polices every trade, stores all research and evidence, runs the control groups, and is where the owner views and reviews everything.
**Hermes's role:** the swarm. Agents do research, author research plans, and submit trades through Stockbot's API.

## Goal

1. Any number of Hermes agents (up to a ceiling) each trade a **$100k paper sleeve**, autonomously, inside limits Stockbot enforces.
2. Every sleeve is continuously compared with **SPY and QQQ bought at the same moment with the same money** and with a **random-trading control** that matches the agent's turnover. This is the app's main purpose.
3. Hermes agents can **create, version and attach their own research plans**. Stockbot schedules them, records every run, and links every trade to the research behind it.
4. One place to see and review it all: leaderboard, per-agent detail, trades with their research, plans, X evidence, and graded predictions.

## Non-goals

- No real money and no live broker routing in this plan.
- No shorting, leverage or options. The engine is long-only and stays that way.
- **Agents never upload JavaScript algorithms.** Uploaded strategies can escape the `node:vm` sandbox to full host RCE (2026-08-25 finding, unfixed). Agents may use only installed declarative JSON plugin methods as tools, and plans are data, never code.
- No agent access to other agents' sleeves, the operator token, `.env`, or the ledger tables directly.
- No "beats the index" claim before minimum evidence (see Leaderboard).

## Current evidence (what already exists)

| Need | Already in Stockbot | Gap |
|---|---|---|
| Isolated sleeves | `accounts` table (`id, name, mode, starting_cash, cash, realized_pnl`); ledger and portfolio are account-scoped; `POST /accounts/:id/orders` fills immediately at a fresh quote through the paper broker + risk engine | No agent identity; one shared operator token; all sessions share `default-paper` (the Oct 6 audit found position contention there) |
| Risk limits | `server/risk/profile.js` + engine: per-order (exposure, position size, funds, rate limits) and continuous (daily loss, drawdown, account drawdown); protective stop-loss exits; halt-all | No operator-level ceiling above per-sleeve profiles; no swarm-wide halt |
| Controls | `docs/CONTROL_GROUP.md`; `core-controls` (buy-and-hold, random-entry, fixed-interval); `experiments/report.js` verdict gauntlet with `insufficient-evidence` | Backtest-only. No live, time-aligned index comparison per sleeve |
| Research plans | `POST /research/plans/validate`, `POST /research/plans` (immutable, hashed versions), runs, point-in-time snapshots; adapters `web.page.v1`, `ai.cli.summary.v1` | Plans can only scrape registered origins and summarize. No notion of agent, universe, cadence or decision policy; no agent-authored reports |
| Hermes + X | `scripts/hermes-research.js`, Twitter CLI 0.8.6 | One-shot runner with the issues listed in the previous plan's Phase 0 |
| Agent tooling | README/CLI docs describe API use | No Stockbot MCP server. Hermes supports MCP servers, so this would be the natural tool surface |

## Architecture

```
            ┌──────────────────────── Hermes (Mac now, Pi later) ────────────────────────┐
            │  profile sb-agent-A   profile sb-agent-B   …   (one agent = one profile)    │
            │  cron: poll tasks → research (X CLI, web, SEC) → report → trade intents     │
            └───────────────┬─────────────────────────────────────────────────────────────┘
                            │ Stockbot MCP server (stdio) or HTTP API, agent-scoped token
┌───────────────────────────▼────────────────────────── Stockbot hub ─────────────────────────────┐
│ agents ─ plans (versioned JSON) ─ tasks (due runs) ─ reports (append-only, point-in-time)          │
│ intents ──► policy check (plan universe, operator ceilings, sleeve risk profile, market hours)    │
│         ──► paper broker fill ──► ledger (sleeve account) ──► protective exits (stop, max hold)   │
│ controls: SPY & QQQ time-aligned curves · turnover-matched random sleeve · optional algo baselines│
│ metrics/leaderboard · predictions grading · review queue · kill switches · audit log             │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Stockbot owns schedules, money and truth. Hermes is the worker: it **pulls** due tasks rather than being pushed. This matches the fleet rule that the Mac↔Pi bridge is pull-only and that peer messaging is unverified.

## Components

### 1. Agents and sleeves
- `agents(id, name, description, runtime 'hermes', hermes_profile, status active|paused|halted|retired, account_id UNIQUE, risk_profile_json, created_by 'operator'|'agent', created_at, retired_at)`.
- Creating an agent creates its own paper account with the standard starting cash (default $100,000), so every sleeve starts equal.
- `agent_tokens(id, agent_id, token_hash, scopes, created_at, last_used_at, revoked_at)`. The token is shown once and stored only as a hash. It lives in that Hermes profile's protected env, never in plan files, reports or the vault.
- Middleware: an agent token can read market data and its own sleeve, plans, tasks and reports, and can write reports, plans and intents **for its own agent id only**. Everything else needs the operator token.

### 2. Trading by intent (autonomous, policed)
Agents never call `/accounts/:id/orders`. They submit **intents**:

`POST /agents/:id/intents { idempotencyKey, symbol, side, notional | qty, thesis, reportId, maxHoldDays, stopLossPercent, invalidation }`

Stockbot then:
1. **Validates against the plan:** the symbol is in the attached plan's universe rules (US-listed stock/ETF, price ≥ $5, ADV ≥ $20M via the existing selection gates); `reportId` exists, is the agent's own, and is ≤ 24 h old.
2. **Checks ceilings in order:** swarm halt → agent status → **operator ceilings** (below) → sleeve risk profile → existing pre-trade risk engine (quote freshness, market hours, funds, exposure, rate limits).
3. **Executes:**
   - inside regular hours: fills at the fresh quote through the paper broker, with the same fill model (slippage bps) for every sleeve;
   - outside hours: queues for the next open using the existing next-open machinery, including the live-quote fallback added 2026-10-20.
4. **Records** intent → order → fill → report with full attribution, and returns the result and any rejection reason to the agent.
5. **Enforces exits it promised:** stop-loss and max-hold become protective exits Stockbot runs itself, even if the agent goes silent.

**Operator ceilings** (owner-set, agents cannot change; `settings` keys):

| Ceiling | Default | Scope |
|---|---|---|
| Max agents | 8 | swarm |
| Sleeve starting cash | $100,000 | per agent |
| Max position | 15% of sleeve equity | per agent |
| Max open positions | 10 | per agent |
| Max intents per day | 20 | per agent |
| Max gross exposure | 100% (no leverage) | per agent |
| Daily loss → auto-pause | 3% | per agent |
| Drawdown from peak → auto-halt | 20% | per agent |
| Swarm drawdown → halt all agents | 15% of total paper equity | swarm |
| Required stop-loss on every buy | ≤ 15% | per intent |
| Required max hold | ≤ 120 trading days | per intent |

### 3. Controls and benchmarks (the core of the app)
Each sleeve is compared against:
- **SPY and QQQ index sleeves (virtual, time-aligned):** "$100k bought at the agent's inception, at the same fill model, held." Computed from bars at each equity snapshot time, so there are no extra ledger positions. Use split-adjusted (price-only) bars, the same basis as agent positions, which receive no dividends in the paper ledger. A total-return line is shown as a secondary reference with the dividend gap labelled (D3).
- **Random-trading control (real shadow sleeve, `kind=control`):** for every agent buy of $N, the control buys $N of a symbol drawn with a seed from the **same candidate universe the agent's report listed**. It holds for the same number of days, with the same fill model. This is the null hypothesis from `CONTROL_GROUP.md` applied live: *would any trading with this shape and these candidates have done as well?* It is how picking skill is separated from "the market went up" and "this sector went up".
- **Cash** (0% line).
- **Optional algorithm baselines (D4):** existing Stockbot strategies (for example Donchian, EMA momentum, BTC crossover) run as non-LLM "agents" on their own sleeves. These show whether the LLM swarm beats plain rules.

### 4. Research plans by Hermes
A new plan kind, `stockbot.agent-plan.v1`: **JSON data, validated with zod, versioned and immutable like existing plans.** Hermes agents author and update it themselves through `POST /agents/:id/plans/validate` and `POST /agents/:id/plans` (D2).

```jsonc
{
  "kind": "stockbot.agent-plan.v1",
  "name": "Catalyst momentum, mid/large caps",
  "horizon": { "minDays": 10, "maxDays": 60 },
  "universe": { "assetClasses": ["us_equity", "etf"], "minPrice": 5, "minDollarVolume": 20000000, "exclude": ["OTC"] },
  "cadence": [{ "task": "research", "cron": "15 16 * * 1-5", "timezone": "America/New_York" },
              { "task": "review_positions", "cron": "0 9 * * 1-5", "timezone": "America/New_York" }],
  "sources": [{ "kind": "x.search", "queries": ["…"], "maxPosts": 25 },
              { "kind": "stockbot.scan", "strategies": ["base-methods/donchian-breakout"] },
              { "kind": "web", "domains": ["sec.gov", "investor relations"] }],
  "roles": ["scout", "skeptic", "fundamentals", "risk"],
  "decision": { "minScore": 7, "maxNewPositionsPerDay": 2, "positionPercent": 8, "stopLossPercent": 8, "maxHoldDays": 40 },
  "requestedLimits": { "maxPositions": 8 }
}
```

- Validation rejects any requested limit above an operator ceiling, any unknown source kind, and any free-form code field.
- Attaching a new plan version to an agent is logged and shown in the review queue. The leaderboard marks the date, so performance is never silently mixed across plan versions.
- `x.search` and `stockbot.scan` are **declarations of what the agent will use**. The Twitter CLI runs on the Hermes side (that is where the X session lives), and `stockbot.scan` calls Stockbot's scan endpoint (previous plan, Phase 2).

### 5. Automation loop
- Stockbot's scheduler turns each plan's `cadence` into **tasks**: `tasks(id, agent_id, plan_version_id, kind, due_at, claimed_at, completed_at, status, report_id)`.
- Each Hermes agent profile has one Hermes cron job (every 15 min), roughly:
  1. `get_tasks`; if nothing is due, exit cheaply.
  2. Claim the task.
  3. Run research (X CLI collection, web/SEC, Stockbot market facts and scan) with sub-agent roles per plan.
  4. `submit_report`.
  5. `submit_intent` for each decision.
  6. Complete the task.
- Missed or failed tasks expire visibly. Nothing retries silently.
- **Reports** (`agent_reports`, append-only): as-of, plan version, candidates, each with the rev-3 **1–10 score** (code-computed components), evidence URLs, the X post ids used, and predictions (20-trading-day excess vs SPY). Prediction grading from the previous plan runs here unchanged, per agent.
- **Tool surface:** a small **Stockbot MCP server** (`scripts/mcp/stockbot-mcp.js`, stdio, wraps the HTTP API with the agent's token) exposing `get_tasks, claim_task, get_market_facts, scan_signals, get_portfolio, submit_report, submit_intent, complete_task, validate_plan, save_plan`. Hermes profiles load it as an MCP server. No `file` or terminal toolsets are needed for trading, which shrinks the prompt-injection blast radius.

### 6. Hub UI
- **Leaderboard (new home page):** one row per agent sleeve (plus algorithm baselines), showing:
  - return since inception, return vs SPY and vs QQQ (time-aligned), and vs its random control;
  - max drawdown, Sharpe, trade count, win rate, and current exposure;
  - a status badge for evidence strength. Until a sleeve has ≥ 60 trading days and ≥ 20 closed trades, its comparison reads **insufficient evidence**. After that, excess return over SPY is shown with a bootstrap 90% interval, never as a bare "beats SPY".
- **Agent detail:** an equity chart with SPY, QQQ, random control and cash lines from the same start; plan versions on a timeline; positions; trades. Each trade opens its intent, thesis, report, sources and X posts. Also shown: graded predictions and rejections with plain-language reasons (reusing `orderReasons`).
- **Research library:** plans and versions with diffs, reports, X evidence, and task history.
- **Review queue:** a daily digest of new trades, plan changes, auto-pauses and halts, rejection spikes and stale agents. The owner can pause, resume, halt, retire and annotate.
- **Controls page:** swarm totals vs SPY and QQQ; the distribution of agent excess returns vs the distribution of random controls.
- Existing pages (Sessions, Strategies, Markets, Selector) remain as tools. Selector and scan results become agent inputs.

### 7. Safety and operations
- Kill switches: per-agent pause/halt, swarm halt (extending halt-all to all agent sleeves), and a global "intents disabled" flag.
- Every intent, rejection, plan change and token use is audited (existing audit log).
- Prompt injection: all research text is untrusted. Agents act only through the scoped MCP/API. A compromised agent can at worst trade its own paper sleeve within ceilings.
- Rate limits per agent token; intents are idempotent by `idempotencyKey`.
- Stockbot stays on loopback/Tailscale. Do not expose it publicly while the sandbox RCE is open, even though agents cannot upload code.

## Decisions still needed from the owner

- **D1: Ceilings.** Accept the defaults above (8 agents, $100k each, 15% max position, 3% daily-loss pause, 20% drawdown halt, 15% swarm halt), or set your own.
- **D2: Who may create agents.**
  - (a) Hermes may create plans and new plan versions freely, but **new agents (new sleeves) need owner approval** in the review queue. Recommended: a new sleeve is new money and resets a comparison.
  - (b) Hermes may also create agents up to the max-agents ceiling.
- **D3: Dividend basis.** Price-only comparison (recommended, matching the ledger) with total-return as a reference line, or credit dividends to sleeves (more work).
- **D4: Algorithm baselines.** Run 2–3 existing strategies as non-LLM sleeves alongside the swarm? Recommended: yes. It is the cheapest way to learn whether the LLM research adds anything.
- **D5: Retirement rule.** Keep every agent's history forever, but should an agent auto-retire after, say, 120 trading days when its bootstrap interval vs SPY is entirely below zero? Recommended: flag it for review, don't auto-retire.
- **D6: Where Hermes runs.** Mac now (X browser session), Pi later.
- **D7: Crypto.** Keep BTC out of the swarm (comparisons are vs SPY/QQQ), with the BTC crossover only as an optional algorithm baseline sleeve.

## Proposed files

| Area | Files |
|---|---|
| Schema | `server/db/migrations/0006_swarm.sql`: `agents`, `agent_tokens`, `agent_plans` (versions), `tasks`, `agent_reports`, `intents`, `benchmark_points`, `control_links`; `accounts.kind` (`agent`, `control`, `baseline`, `default`) |
| Shared | `packages/shared/swarm.js`: zod for agent-plan.v1, intent, report (with 1–10 score components and predictions), and ceilings |
| Server | `server/swarm/agents.js` (create/pause/retire, sleeve provisioning, tokens); `server/swarm/intents.js` (policy pipeline → broker; protective exits); `server/swarm/tasks.js` (cadence → tasks); `server/swarm/benchmarks.js` (time-aligned SPY/QQQ curves); `server/swarm/random-control.js` (seeded shadow trades); `server/swarm/leaderboard.js` (metrics, bootstrap CI, evidence labels) |
| Auth | `server/http/middleware.js`: `agentAuth` (hash lookup, scope, rate limit) beside `operatorAuth` |
| Routes | `server/http/routes/agents.js` (operator: CRUD, pause/halt, tokens; agent: me, plans, tasks, reports, intents), `routes/swarm.js` (leaderboard, controls, review queue) |
| Runtime | `server/runtime/supervisor.js`: protective exits and continuous risk for agent sleeves; swarm-halt; the snapshot cadence writes `benchmark_points` |
| MCP | `scripts/mcp/stockbot-mcp.js` (stdio, agent token from env) + `docs/SWARM_AGENTS.md` (Hermes profile setup, cron, MCP config) |
| Hermes side (docs + templates, not code in Hermes) | `research/agents/templates/*.md` role prompts, `research/agents/example-agent-plan.json`, and a Hermes skill doc "stockbot-agent-loop" |
| UI | `src/features/swarm/{LeaderboardPage, AgentDetailPage, ResearchLibraryPage, ReviewQueuePage, ControlsPage}.tsx`; routes; the home route becomes the Leaderboard |
| Tests | below |

## Ordered steps (each phase ships on its own)

0. **Prerequisite:** the previous plan's Phase 0. The dedicated `stockbot-research` Hermes profile pattern is generalized to one profile per agent.
1. **Agents, sleeves, tokens.** Migration, agent service, scoped auth, operator routes, and an agent list in the UI. No trading yet.
2. **Intents and execution** (independent review before deploy). Policy pipeline, ceilings, next-open queueing, mandatory stops and max-hold, rejections returned to agents, audit.
3. **Controls.** Time-aligned SPY/QQQ curves, random shadow sleeves, equity and benchmark snapshots at each close, and leaderboard metrics with evidence labels.
4. **Plans, tasks, reports.** Agent-plan.v1 validate/save/version/attach, cadence → tasks, append-only reports with 1–10 scores and predictions, and grading.
5. **MCP server and Hermes loop** (independent review). MCP tools, profile templates, a cron recipe, and an end-to-end dry run against the synthetic live server.
6. **Hub UI.** Leaderboard home, agent detail, research library, review queue, controls page.
7. **Algorithm baselines (D4) and Pi scheduling (D6).** Optional.

## Tests (write each failing test first)

- **Isolation:** agent A's token cannot read B's sleeve, submit intents for B, or call operator routes. A revoked token returns 401 immediately.
- **Ceilings:** an intent over 15% of sleeve, the 11th open position, or a 21st intent today is rejected with a reason. A plan requesting a limit above a ceiling fails validation. Ceilings cannot be changed with an agent token.
- **Policy:** a symbol outside the plan's universe (OTC, $3 price, $2M ADV), a missing or foreign or stale `reportId`, and a buy without a stop or max-hold are all rejected.
- **Execution:** inside hours, a fill at a fresh quote with the shared fill model. After hours, the intent is queued and fills at the next open, including the live-quote fallback. The idempotency key prevents duplicates.
- **Mandatory exits:** a position whose agent goes silent is closed by Stockbot at its stop or max-hold.
- **Auto-pause/halt:** a 3% daily loss pauses the agent; a 20% drawdown halts it; a 15% swarm drawdown halts every agent sleeve; the controls keep running.
- **Benchmarks:** an agent created at T gets SPY/QQQ curves starting exactly at T's next tradable price with $100k. Two agents created on different days have different, correctly aligned benchmark curves.
- **Random control:** for a fixture of 10 agent buys, the control makes 10 buys of equal notional from the reported candidate lists with equal hold lengths, reproducible by seed.
- **Leaderboard:** under 60 days or 20 trades ⇒ `insufficient evidence`. A synthetic sleeve with a known +5%/yr edge gets a bootstrap interval that excludes 0 after enough days.
- **Plans:** a plan with an unknown source kind, a code-like field or an oversize limit fails. A new version never mutates the old one. Attaching a version creates a review-queue item.
- **No code path:** there is no route by which an agent token can install an algorithm or plugin.

## Acceptance check (Hermes, end to end)

Against `SYNTHETIC_LIVE=1` (the integration server) first, then the real Mac instance with Alpaca paper data:

1. The operator creates two agents. Each gets a $100k sleeve and a token; the tokens go into two Hermes profiles.
2. Agent A authors and saves a plan through MCP. Tasks appear on schedule. A claims one, posts a report with 1–10 scores, and submits 2 intents. Fills land **only** in A's sleeve and link back to the report.
3. An intent over the position ceiling is rejected, and the reason reaches the agent.
4. The leaderboard shows A and B with SPY, QQQ and random-control comparisons from each one's own start, labelled `insufficient evidence`.
5. The swarm halt stops all agent intents. Random controls and benchmark curves keep updating.
6. After 20 trading days the first predictions are graded on the agent detail page.

## Risks

- **Autonomous trading bugs move paper money fast.** Ceilings, idempotency, mandatory exits, auto-pause and the swarm halt are the guard. Phase 2 must pass an independent review.
- **Look-alike success.** With few agents and a few months of data, some agent will beat SPY by luck. Bootstrap intervals, the random-control comparison and the evidence labels are there so the hub never overclaims. A real-money decision should require a sleeve to beat SPY, QQQ **and** its random control out of sample.
- **Cost.** Each agent run is several LLM calls. Cadence lives in plans and is visible, and the max-agents ceiling bounds it.
- **X account.** Cookie-based reads can get the account rate-limited or locked; use a secondary account. One shared X session for all agents means sequential collection; do not run agents' X searches in parallel.
- **The sandbox RCE remains open.** It is excluded by design here (agents cannot upload JS), but it still blocks any public exposure of the API.

## Rollback

Every phase is additive: new tables, routes, pages and an MCP script. Disabling intents (global flag) and revoking agent tokens stops all swarm activity immediately, and existing sessions, strategies and the default paper account are untouched. Revert per phase. Leave the tables in place for the record.

## Mapping from the previous plan (rev 3)

| Previous plan item | Here |
|---|---|
| Phase 0: safe Hermes runner | Prerequisite step 0; generalized to one profile per agent |
| X discovery collector | Hermes-side agent tool, declared as an `x.search` source in agent plans |
| Algorithm scan (`server/selection/scan.js`) | `scan_signals` MCP tool; `stockbot.scan` plan source |
| 1–10 Outlook score + predictions + grading | Inside every agent report; graded per agent |
| Owner confirms each hit; evaluate-on-start | Replaced for the swarm by autonomous intents. Evaluate-on-start is still useful for manual strategy sessions and algorithm baselines. |
