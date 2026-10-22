# Agent swarm: one agent, one sleeve, orders off

Stockbot is the hub. Each swarm agent is a Hermes profile with its own $100,000
paper sleeve and its own token. Stockbot schedules the agent's research tasks,
performs every data retrieval itself, stores the agent's report and decisions,
and polices any order the agent asks for. Order intents are **disabled** until
the operator turns them on for the swarm **and** for that agent.

## The loop

```
scheduler (one supervisor, DB lease) ── task ──► worker (Mac, Hermes host)
  worker: claim → write prompt → hermes --profile sb-<name> chat --toolsets mcp-stockbot-agent
  Hermes agent (MCP tools only): current_task → retrieve … → submit_report
  Stockbot: receipts for each retrieval → report + attributed decisions → task completed
  worker: asks Stockbot (not Hermes) whether the report exists; otherwise fails the task
```

- **Trusted retrieval.** `retrieve` makes Stockbot fetch the quote, bars or a
  registered web page and returns a `receiptId`. Reports may cite only receipts
  Stockbot wrote for that task and agent. Report provenance (providers, synthetic
  or not, content hashes) is computed from the receipts. Any provenance field an
  agent sends is rejected.
- **Scope.** The worker launches Hermes with only the `mcp-stockbot-agent` toolset
  (no web, file or terminal tools), `--ignore-rules`, inside the run directory,
  and with a minimal environment (no Stockbot or database secrets). Launch
  toolsets come from an allowlist.
  The agent MCP server holds one agent token and has no claim, session,
  strategy, settings or raw-order tools.
- **Isolation.** An agent token reaches only `/api/v1/agent/*` and only its own
  agent's tasks, receipts, sleeve and decisions. Operator routes reject it.
- **Nothing silent.** Missed tasks expire, runs without a report fail with a
  reason, and Hermes stderr is redacted before it is stored.

## First agent

The operator CLI uses the operator token in `~/.config/stockbot/mcp.env`
(the same 0600 file as the operator MCP bridge).

```bash
npm run swarm -- create alpha                  # sleeve + token + research/agents/first-agent-plan.json
# then, once, the three hermes commands it prints:
hermes profile create sb-alpha --clone
hermes --profile sb-alpha mcp add stockbot-agent --command "$(which node)" \
  --env STOCKBOT_AGENT_ENV=$HOME/.config/stockbot/agents/sb-alpha.env \
  --args "$PWD/scripts/mcp/stockbot-agent-mcp.js"
hermes --profile sb-alpha mcp test stockbot-agent
hermes --profile sb-alpha mcp list   # must show only stockbot-agent; remove anything else
```

`--clone` copies the default profile's model settings and `.env`, so it may also
copy MCP servers. The agent's server has its own name, `stockbot-agent`, and the
worker grants only that server's toolset. Even so, remove any other server the
list shows, above all an operator `stockbot` bridge, which holds the operator
token.

```bash

npm run swarm -- prove alpha                   # one real cycle now, prints the persisted chain
```

`prove` exits non-zero unless the task completed with a report. Its output lists
the task, report provenance (which must show the real provider, for example
`alpaca`, and `synthetic: false`), each decision, `ordersEnabled: false` and
`intents: 0`.

For scheduled cycles, run the worker from cron or launchd on the Hermes host,
for example every 15 minutes: `npm run swarm:worker -- --profile sb-alpha`. It
exits quickly when nothing is due.

## Orders (later)

Leave orders off until a few real cycles have been reviewed. Then:

```bash
npm run swarm -- orders swarm on     # global switch
npm run swarm -- orders alpha on     # per-agent switch; both must be on
```

Every intent must reference one of the agent's own `buy`/`sell` decisions (a
`hold` can never become an order) from the last 24 hours, inside the plan's
universe. The swarm ceilings apply (15% of sleeve per position, 10 positions, 20
intents a day). Market hours and quote freshness still apply, and a quote stamped
more than 1 s in the future is rejected on every order path. A closed market
produces a rejection, never a fill at a stale price.

Intents are idempotent. The client order id is derived from the intent id, and
the ledger is unique on it. If the process dies between submission and
acknowledgement, a retry with the same `idempotencyKey` finds the order that was
written. If no order was written, the retry sends it once. The supervisor
closes out any intent still mid-submission after 5 minutes. It records the order
if one exists and otherwise rejects the intent as `submission_interrupted`. It
never resends a stale intent.

## PostgreSQL cutover

Production is PostgreSQL, so the swarm schema is rehearsed there before it is
applied. Run on the Stockbot host:

```bash
# 1. Disposable-server rehearsal of the migration, dump/restore and rollback:
STOCKBOT_TEST_POSTGRES_URL=postgres://<admin>:<pw>@127.0.0.1:5432/postgres \
  node --test test/db/postgres-migration.test.js

# 2. Rehearse on a copy of the real data (pg_dump → scratch DB → migrate → compare every row):
node scripts/swarm/cutover.js rehearse --env-file ~/.config/stockbot/stockbot.env --admin-url <role that may CREATE DATABASE>

# 3. Cut over (stop → verified pg_dump → migrate → re-compare → SWARM_SCHEDULER=1 → start → checks):
node scripts/swarm/cutover.js apply --env-file ~/.config/stockbot/stockbot.env

# Rollback (saves the current state first, restores the pre-cutover dump, removes SWARM_SCHEDULER):
node scripts/swarm/cutover.js rollback --env-file ~/.config/stockbot/stockbot.env --dump <pre-cutover dump>
```

`rollback` accepts only the backup that `apply` recorded, refuses a dump that
already has the swarm schema, saves the current state first, and runs the drop
and restore as one transaction. If the restore fails, the database is left
exactly as it was and the service stays stopped, so start it again (or fix the
problem and rerun) yourself. Database passwords go to the PostgreSQL tools
through `PGPASSWORD`, never on the command line. Rows written to existing tables
after cutover, such as sleeve accounts and audit entries, are reverted by a
rollback. They remain in the saved `stockbot-before-rollback-*.dump`.

`apply` refuses without a rehearsal from the last 24 hours for the same database.
It also refuses if `RESTART_RUNNING_SESSIONS` is on, so the legacy sessions stay
inactive. After start it requires exactly one live supervisor lease and orders
still disabled. Only the process with `SWARM_SCHEDULER=1` schedules, and the
database lease stops a second one from also scheduling.

Note: starting the new code runs pending migrations on boot. Use `apply` rather
than a plain restart, so the backup and the row comparison happen first.
