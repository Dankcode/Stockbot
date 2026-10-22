# CHANGES-stockbot-swarm-loop-20261022

Builds the first slice of `PLAN-stockbot-swarm-hub-20261021`: one agent with its own sleeve, end to end, with orders disabled. The plan's other phases (leaderboard, benchmarks, random controls, further research methods) are not started.

## What exists now

- **Schema (`0006_swarm.sql`, additive only).** Adds `agents`, `agent_tokens`, `agent_plans`, `agent_tasks`, `retrieval_receipts`, `agent_reports`, `report_evidence`, `agent_decisions`, `agent_intents` and `swarm_leases`. No existing table or row changes; this was verified on SQLite and on PostgreSQL 16.
- **Agents and sleeves.** Each agent gets a $100k `sleeve-<name>` account and a token, which is shown once and stored as a SHA-256 hash. `/api/v1/agent/*` accepts only agent tokens and acts only on the caller's own agent. Operator routes are at `/api/v1/swarm/*`. Retirement is final. Sleeve portfolios need the operator token on the general accounts route.
- **Plans** (`stockbot.agent-plan.v1`). Strict zod validation, immutable versions, one active version per agent.
- **Scheduler.**
  - Plan cadence becomes tasks, unique per slot.
  - Only the process with `SWARM_SCHEDULER=1` schedules, and a DB lease stops a second one.
  - Missed daily windows are recorded as expired.
  - The daylight-saving gap rolls forward.
- **Trusted retrieval.** `retrieve` makes Stockbot fetch the quote, bars or a registered web page and write a receipt. Reports may cite only receipts written for that task and agent. Provenance is computed from the receipts, and agent-supplied provenance fields are rejected.
- **Worker + agent MCP server.**
  - `scripts/swarm/worker.js` claims a task, then runs `hermes --profile sb-<name> chat --toolsets mcp-stockbot-agent --ignore-rules` in the run directory with a minimal environment.
  - The agent MCP server is `scripts/mcp/stockbot-agent-mcp.js`, registered in the profile as `stockbot-agent`.
  - Afterwards the worker asks Stockbot whether a report exists, and otherwise fails the task.
- **Shared Hermes launcher** (`scripts/lib/hermes.js`). Used by the research CLI and the worker.
  - Flags verified against the installed Hermes 0.20.5 parser.
  - `verifyHermesCli` re-checks `chat --help` before each run.
  - Toolsets come from an allowlist; stderr is redacted.
  - The research CLI no longer grants the `file` toolset and inlines its evidence instead.
- **Intents (disabled by default).**
  - Need the global and per-agent switches.
  - Must reference the agent's own buy/sell decision, at most 24h old and meeting the plan's minimum score, with at most one live intent per decision.
  - Plan and swarm size limits apply.
  - Serialized per sleeve; transitions are compare-and-set.
  - Idempotent through `clientOrderId = intent:<id>`.
  - The background sweep never trades.
  - Every order path now also rejects quotes stamped more than 1s in the future.
- **Operator CLI** (`npm run swarm -- create|prove|show|task|plan|status|orders|token|tick`).
- **Cutover tool** (`scripts/swarm/cutover.js rehearse|apply|rollback`).

## Evidence

- Full suite: 374 pass, 0 fail, on the Mac working copy (with the Hermes-source parser check) and in a Linux container with PostgreSQL 16.15 (with the PostgreSQL rehearsal). `tsc --noEmit` is clean.
- The four migration tests assert the exact schema from one shared fixture. The backup and restart checks are kept.
- The end-to-end test runs scheduled task → worker → strict fake Hermes → real agent MCP server → receipts → report → HOLD → completed. It checks the persisted chain in SQL, zero orders, zero sessions touched, and that no secrets were in Hermes's environment.
- **PostgreSQL rehearsal test.**
  - Seeds a pre-0006 database with 24 inactive legacy sessions and takes a `pg_dump`.
  - Restores and migrates a copy; every pre-existing row is unchanged (it fails on a single tampered field).
  - Runs a cycle, then dump/restore of the migrated database is identical, and rollback restores the old schema.
- **Cutover dry run** against a simulated production database:
  - `rehearse` → `apply`: backup, migrate, row comparison, single supervisor, orders still off.
  - A second supervisor is refused the lease.
  - `rollback` refuses the wrong dump, refuses a corrupt dump before touching the service, and leaves the database unchanged when the restore fails at its last statement; the real rollback returns to 0005.
  - No password appears in the output.
- An independent review found 7 confirmed issues, including a concurrent-buy cap bypass on PostgreSQL, the sweep trading late, the future-quote check breaking strategy sessions, and a non-atomic rollback. All 7 are fixed with regression tests.

## Not yet proven

- A cycle with real Hermes and real market data. This sandbox cannot reach either. On the Mac: `npm run swarm -- create alpha`, the printed `hermes profile/mcp` commands, then `npm run swarm -- prove alpha`. The provenance must show the real provider and `synthetic: false`.
- The production cutover itself (`cutover.js rehearse`, then `apply`, on the Stockbot host).

## Required before enabling paper orders

- **Protective exits** for agent sleeves (stop-loss and max-hold from the plan). Sleeves have no session, so nothing closes a position if the agent goes silent. Not built.
- The event stream (`/api/v1/stream`) still broadcasts every account's order events to any local client.

## Rollback

Code: revert the commit. Database: `cutover.js rollback --dump <the backup apply printed>`. It saves the current state first and restores atomically. The 24 legacy sessions are never touched (`RESTART_RUNNING_SESSIONS` must stay off).
