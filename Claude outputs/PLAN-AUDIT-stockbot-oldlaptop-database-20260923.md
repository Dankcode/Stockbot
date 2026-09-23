# PLAN + AUDIT: Stockbot ↔ the oldlaptop database

## Audit finding, up front

"Connect Stockbot to this SQL database" runs into the same rule you stated yourself for the Python multi-project work: **SQLite cannot be safely reached over a network from a process that isn't the one that owns the file.** Stockbot's own DB layer (`server/db/client.js`) only knows two modes — a local `file:` SQLite path, or a real network database protocol (`postgres://` via `pg`). There is no "remote SQLite" mode, and building one would mean reinventing a wire protocol that Postgres already gives you for free. So "Stockbot connects to a SQLite database on oldlaptop" is only architecturally sound in one specific shape: **Stockbot itself runs on oldlaptop**, colocated with that file, exactly like the per-project pattern just set up for the Python work. If Stockbot keeps running somewhere else (the Mac, presumably), SQLite is off the table for this and the database has to be the PostgreSQL instance already on oldlaptop — which is not new work, it's the plan from earlier today.

That gives two real paths. I'm not picking one for you since it's a real fork, but I have a recommendation.

## Path 1 (recommended) — Stockbot stays where it is, uses PostgreSQL on oldlaptop

This is **[[PLAN-tailscale-postgres-20260923]]**, unchanged. Nothing about the new SQLite/multi-project work affects it: different database engine, different port (5432 vs. whatever path/port each SQLite project's API sits behind on Tailscale Serve), no shared resources, no code changes to Stockbot beyond the `DATABASE_URL` wiring already documented there. Stockbot keeps running wherever it runs today; only the ledger's storage moves to oldlaptop.

**Status check against that earlier plan** — confirm before treating this as done:
- Has the dedicated Postgres role + database actually been created on oldlaptop yet (Deliverable B.2 of that plan)?
- Is `listen_addresses`/`pg_hba.conf` narrowed to the tailnet (B.4–B.5)?
- Has the `tailscale cert` been issued for `verify-full` (B.6)?

If all three are already done, this path is just: build the `DATABASE_URL`, wire it into a protected `STOCKBOT_CONFIG_FILE`, and run the verification steps from that plan's Deliverable D. If none of it is done yet, that earlier plan is still the thing to execute — this audit doesn't change a line of it.

## Path 2 (bigger change) — relocate Stockbot itself to run on oldlaptop with a local SQLite file

This is the only way "Stockbot + SQLite + oldlaptop" is architecturally sound — it requires Stockbot to become one of the colocated app+db projects, not a remote client of one.

**Audit finding — this is not a small change.** Stockbot already has a "run in production on a laptop, reachable over Tailscale" story (`docs/LAPTOP_DEPLOYMENT.md`, `scripts/laptop/install.sh`, `run-stockbot.sh`, `configure-tailscale.sh`), but it is **macOS-only**:
- `install.sh` hard-refuses to run at all on anything that isn't Darwin: `[[ "$(uname -s)" == "Darwin" ]] || { echo "This installer supports macOS only." >&2; exit 1; }`.
- Both `install.sh`'s helper checks and `configure-tailscale.sh` read file permissions with `stat -f '%OLp'` — that's BSD/macOS `stat` syntax; Linux's GNU `stat` needs `-c '%a'` instead. Patching just the Darwin check wouldn't be enough.
- The whole process-supervision model is a launchd `LaunchAgent`/`.plist` — there's no equivalent outside macOS; a Linux host needs a systemd unit instead, written from scratch.
- The hostname `oldlaptop-aspire-vn7-591g` (an Acer Aspire VN7-591G) makes it likely oldlaptop isn't a Mac at all — worth confirming with `uname -a` on oldlaptop before scoping this any further, since the answer determines whether this is "port three scripts" or "this laptop literally can't run this deployment path."

So Path 2 isn't "point `DATABASE_URL` at a new file" — it's "port Stockbot's entire production deployment tooling to a second OS," on top of the app-level SQLite work. That's a materially bigger and riskier lift than Path 1, and it hasn't been asked for explicitly yet — flagging it now so it's a deliberate choice, not a surprise mid-implementation.

### If you do want Path 2 — Phase 0 sketch (not a full plan; scope this properly once chosen)
1. Confirm oldlaptop's OS/init system (`uname -a`; if Linux, confirm systemd via `systemctl --version`).
2. Write a systemd-unit equivalent of the LaunchAgent (env file loading via `EnvironmentFile=`, restart policy, log paths) — new file, no macOS plist reuse.
3. Fix the `stat` calls in any script reused on Linux (`-c '%a'` instead of `-f '%OLp'`).
4. Reuse Stockbot's existing SQLite path as-is (`server/db/client.js` already handles `file:` URLs with WAL/foreign-keys/busy-timeout — nothing to change there) — just point `DATABASE_URL` at a local path on oldlaptop instead of the Mac.
5. Reuse `configure-tailscale.sh`'s *logic* (health-check-then-serve) but fix the portability issues above before running it.
6. Decide how the existing SQLite ledger data (if any exists on the Mac today) gets there — copy via `db:backup` + restore, or start fresh; this is a real data-migration decision, not a rollback-free config change like Path 1.

## Recommendation

**Path 1**, unless there's a specific reason Stockbot needs to physically run on oldlaptop (data locality, wanting one fewer machine in the loop, etc.) — nothing here forces that. Postgres already gives Stockbot a durable, TLS+SCRAM-secured ledger reachable from wherever it runs, with zero relocation risk and a plan that's already written and unaffected by today's SQLite work.

## Blockers

- Which path do you actually want — does Stockbot need to physically live on oldlaptop, or is reaching the database over the network (Path 1) sufficient?
- If Path 1: are the Postgres role/database/password/cert steps from the earlier plan already done, or still pending?
- If Path 2: oldlaptop's OS/init system (unconfirmed), and whether any existing Mac-side SQLite ledger data needs to move over or this starts fresh.

## Review findings

- No security regression in reusing Path 1 — same role isolation, TLS, and narrow `pg_hba` scoping as already planned.
- Path 2's macOS-only tooling fails *closed*, not silently — `install.sh`'s Darwin check exits before touching anything on a non-Mac host, so there's no risk of half-applying a broken deployment; the cost of trying it prematurely is wasted time, not a broken system.
