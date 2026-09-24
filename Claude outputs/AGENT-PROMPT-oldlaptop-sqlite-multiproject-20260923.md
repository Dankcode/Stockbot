# Prompt for your implementation agent: SQLite-on-oldlaptop for multiple projects

Paste this to Codex (or whichever agent will actually touch oldlaptop). It follows the owner's standard contract: implement only what's approved here, stop and ask rather than guess on anything marked BLOCKER, write a failing test first where a test makes sense, run focused then full tests, and report back changed files/commands/results/risks/rollback. No secrets get printed, logged, or committed anywhere in this work.

---

## Context

There is no existing app repository for this yet — it's being built from scratch on `oldlaptop`, so there's nothing to inspect first (that's different from a normal "plan and do not code" task; this is greenfield). `oldlaptop` will host multiple independent projects, each with its own Python + SQLite backend, reachable from other tailnet devices (this Mac, etc.) only through Tailscale.

`oldlaptop` infrastructure already known:
- MagicDNS: `YOUR_OLD_LAPTOP.tailnet-name.ts.net`
- Tailnet IPv4: `YOUR_TAILSCALE_IP`
- Python's bundled SQLite library: 3.46.1
- The standalone `sqlite3` CLI is **not** installed on oldlaptop — all inspection/backup/admin work must go through Python's `sqlite3` module, not shell commands.
- `oldlaptop` already runs a separate Stockbot service that claims `tailscale serve --https=443` at the root path (`/`) pointed at `127.0.0.1:4000` — **do not touch, reconfigure, or collide with that mapping.** Any new project's Tailscale Serve route must use either a distinct path under the same HTTPS port (`tailscale serve --set-path /projectname http://127.0.0.1:<port>`) or an entirely different port (e.g. `--https=8443`). Run `tailscale serve status` first and read it before adding anything.

## Non-negotiable architecture (already decided — do not deviate)

**Each project gets its own SQLite file and its own app/API process, both running on `oldlaptop` itself.** No project's database file is ever mounted, shared, or opened directly by a process on another machine — not over SMB/NFS/SSHFS, not by pointing a remote hostname at the file, not by two machines opening the same `.sqlite` file concurrently. The only thing that crosses the network is HTTP(S) traffic to that project's own API, and only over Tailscale (loopback-bound app + `tailscale serve`, exactly like the existing Stockbot deployment). If a future need genuinely requires multiple machines/processes writing concurrently to the same logical database, that is a "use the PostgreSQL instance already on oldlaptop instead" decision, made explicitly and separately — never solved by relaxing SQLite's file-access boundary.

## What to build, per project

1. **Directory + venv.** One directory per project (naming: BLOCKER — confirm with the owner), its own Python virtual environment, its own `requirements.txt`/`pyproject.toml`. Do not share a venv or dependency set across projects.

2. **Database file.** `<project_dir>/data/<project>.sqlite`, created via a small init script that, on first connect, sets:
   ```python
   conn.execute("PRAGMA journal_mode=WAL")
   conn.execute("PRAGMA synchronous=FULL")
   conn.execute("PRAGMA foreign_keys=ON")
   conn.execute("PRAGMA busy_timeout=5000")
   ```
   Verify `journal_mode` actually reports `wal` after setting it (some filesystems/mounts silently refuse WAL — fail loudly if so, don't fall back silently). Directory must not live under any network-mounted path — confirm it's on oldlaptop's local disk.

3. **Migrations.** Plain numbered `.sql` files (e.g. `migrations/0001_init.sql`) applied by a small Python runner that tracks applied versions + checksums in a `schema_migrations` table (mirrors the pattern already proven in the Stockbot repo — same idea, ported to Python, don't invent a different scheme). Migrations must be forward-only and idempotent to re-run.

4. **App/API.** BLOCKER — confirm framework (FastAPI+uvicorn is the reasonable default for a small Tailscale-only service; do not silently pick something else without asking). The app binds to `127.0.0.1` only — never `0.0.0.0`, never the Tailscale interface IP directly — and requires a bearer-token style shared secret for any mutating request, generated with `python -c "import secrets; print(secrets.token_hex(32))"` and written straight into an owner-only (mode 600) env file, never echoed to a terminal, log, or committed file. Expose a `GET /health` route that reports `{"ok": true, "database": {"ok": true, "journal_mode": "wal"}}` style status, no secrets in the body.

5. **Process supervision.** BLOCKER — confirm `oldlaptop`'s OS first (`uname -a`, and if Linux, which init system: `systemctl --version` or check for `/run/systemd`). Use whatever the platform's real service manager is (systemd unit under a dedicated low-privilege user, or the platform's local equivalent) — do not hand-roll a `nohup`/`screen` background process for anything meant to stay up.

6. **Tailscale exposure.** Confirm the port/path allocation against `tailscale serve status` (see Context above), then:
   ```
   tailscale serve --bg --yes --https=443 --set-path /<projectname> http://127.0.0.1:<port>
   ```
   (or a distinct `--https` port if path-based routing doesn't fit the client). Never `tailscale funnel`. Never expose the SQLite file's port/path — there is no "SQLite port" here at all, only the app's HTTP port, which is the point.

7. **Backups.** A scheduled script (systemd timer / cron, whichever matches step 5's answer) that uses Python's online backup API — not the missing CLI:
   ```python
   import sqlite3
   src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
   dest = sqlite3.connect(backup_path)
   src.backup(dest)
   dest.execute("PRAGMA integrity_check")
   dest.execute("PRAGMA foreign_key_check")
   dest.close(); src.close()
   ```
   Refuse to overwrite an existing backup path (write to a new timestamped file each run, same convention as Stockbot's `db:backup`). Keep backups on oldlaptop's local disk (or copy them off afterward as a separate step) — never write the live `.sqlite` file itself anywhere off-box while it's open.

8. **Tests.** Before writing app code: a failing test that opens the DB, runs the init pragmas, and asserts `journal_mode == "wal"`. Then migration-runner tests (apply → re-apply is a no-op → checksum mismatch fails loudly). Then an integration test that starts the app on a random loopback port and hits `/health`. Run the focused tests as each piece lands, then the full suite before reporting done.

## Verification evidence to report back (no secrets in any of it)

- `journal_mode` pragma reads `wal` on the live database file.
- `tailscale serve status` output showing the new route alongside the untouched existing Stockbot route.
- `curl` from this Mac to the project's HTTPS tailnet URL hitting `/health` and getting `ok: true`.
- A backup file produced, `PRAGMA integrity_check` clean, and a restore into a scratch path opened successfully.
- Full test suite passing.

## Blockers — stop and ask the owner, don't guess

- Project name(s) — how many projects are being set up right now, and what to call each one (directory names, Tailscale Serve path segments, ports).
- Web framework/tooling preference (FastAPI/Flask/other; venv vs uv vs poetry).
- `oldlaptop`'s actual OS and init system (needed before step 5/7 can be written concretely).
- Which OS user each project's service should run as (a shared low-priv service account, or one per project).
- Port/path allocation plan across all current and reasonably-foreseeable future projects on this host, so this doesn't collide again next time.

---

*Companion context: [[PLAN-tailscale-postgres-20260923]] covers the separate Stockbot-to-Postgres-on-oldlaptop connection — that plan and this one target the same physical host but different projects/engines; nothing in this prompt should touch anything set up for that one.*
