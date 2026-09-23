# PLAN-tailscale-postgres-20260923

**Goal:** Point the existing Stockbot app at a dedicated, least-privileged PostgreSQL role/database on `oldlaptop`, reachable only over Tailscale with SCRAM auth and verify-full TLS — no public exposure, no `0.0.0.0` binds, no changes to unrelated services. Zero application code changes are required; this is a configuration + DB-host hardening task.

**Non-goals:** no new ORM/migration framework (Stockbot's native forward-only migrations already cover schema); no Tailscale Serve/Funnel exposure of the *app* (that's the opposite direction and already governed by existing, untouched `HOST=127.0.0.1` defaults); no copying data from the current local SQLite ledger (this is a fresh connection — see evidence below); no `scripts/laptop/install.sh` / LaunchAgent packaging unless you separately want the full production-on-this-Mac deployment.

## Current evidence (read-only repo inspection, 2026-09-23)

- Stack: Node 22 ESM Express API (`server/`), Vite/React frontend (`src/`), shared zod schemas (`packages/shared/`). `pg@8.23.0` is already a direct dependency — no install needed.
- DB abstraction (`server/db/client.js`): one `createClient(databaseUrl)` factory dispatching on URL scheme — `file:...` → `node:sqlite`, `postgres://`/`postgresql://` → `pg.Pool`. It supports an optional `hostaddr` query param so a connection can dial an explicit IP while keeping the URL hostname for TLS SNI/verification — exactly the MagicDNS-plus-fallback-IP shape you described.
- Config (`server/config/index.js`): single env var **`DATABASE_URL`** (not separate `PGHOST`/`PGUSER`/etc.), defaulting to `file:<repo>/data/stockbot.db` when unset. `STOCKBOT_DATABASE_LOCATION` (`local`/`remote`) auto-infers from the URL's hostname if not set explicitly. `STOCKBOT_CONFIG_FILE` names a protected, owner-only (0600) env file the running app is allowed to persist Settings-UI database changes back into. App `HOST` stays loopback unless `STOCKBOT_ALLOW_REMOTE=true` — unrelated, left untouched.
- Settings UI (`server/settings/database-service.js`) backs **Settings → Database connection** in the dashboard: builds the URL from discrete fields (hostname, optional connect IP, port, database, username, password, TLS mode `disable|require|verify-full`), verifies identity (`current_user`/`current_database`) and TLS (`pg_stat_ssl.ssl`), runs migrations, and atomically rewrites `STOCKBOT_CONFIG_FILE`. It never redisplays the password — this is the safest path since it avoids ever pasting a full connection string anywhere.
- CLI (`scripts/database.js`, `npm run db:init|db:status|db:backup|db:trades`): reads `DATABASE_URL` from `--env-file <path>` (must be 0600) or `.env`, never prints it. `db:init` applies checksum-verified forward migrations (5 files in `server/db/migrations/`) and idempotently creates the `default-paper` account; `db:status` is read-only.
- Runtime loading: `server/index.js` does `import "dotenv/config"` (loads repo-root `.env`, already gitignored, for dev). The repo's own laptop-deployment wrapper (`scripts/laptop/run-stockbot.sh`) instead launches with `node --env-file=<protected path> server/index.js` plus `export STOCKBOT_CONFIG_FILE=<same path>` — that pattern is reusable standalone without adopting the rest of the LaunchAgent/Tailscale-Serve flow.
- Current state: the repo's `.env` has **no `DATABASE_URL` set at all** → Stockbot is presently on local SQLite. This is a new connection, not a migration.
- Docs already describe this connection shape (README, `docs/DATABASE_OPERATIONS.md`, `docs/LAPTOP_DEPLOYMENT.md`), but that deployment doc is the mirror image of your request: it exposes the *app* over Tailscale Serve while Postgres stays loopback-only on the same host. Your case has the app as *client* and Postgres remote on `oldlaptop`, so Postgres itself needs a narrow, TLS-only, tailnet-scoped inbound rule — none of the existing scripts do that side; Part B below is new.
- `pg` 8.23.0 parses `sslmode` straight out of the connection string (no extra code needed): `sslmode=verify-full` requires the server certificate's CN/SAN to match the hostname and chain to a CA Node already trusts. `tailscale cert` issues a publicly-trusted (Let's Encrypt) cert for exactly `YOUR_OLD_LAPTOP.tailnet-name.ts.net` when tailnet HTTPS is enabled — so no custom CA / `NODE_EXTRA_CA_CERTS` plumbing is needed.
- This session's sandboxed shell on your Mac has no tailnet route and no `tailscale` CLI on `PATH`, so I could not resolve the MagicDNS name or read your Mac's own Tailscale IP from here — see blockers.

## A. Repository-specific files/variables to change

**No source file changes.** Two ways to wire the connection — pick one:

**Option 1 (recommended) — Settings UI does the work:**
1. `npm run laptop:init` — creates a protected 0600 config file (default `~/.config/stockbot/stockbot.env`; pass `--env-file /other/path` to change it). It hidden-prompts once for a `DATABASE_URL` (any placeholder is fine, the Settings UI overwrites it).
2. Launch Stockbot against that file:
   ```bash
   export STOCKBOT_CONFIG_FILE="$HOME/.config/stockbot/stockbot.env"
   node --env-file="$STOCKBOT_CONFIG_FILE" server/index.js
   ```
3. In the dashboard, **Settings → Database connection** → Remote/private PostgreSQL → fill in hostname `YOUR_OLD_LAPTOP.tailnet-name.ts.net`, port `5432`, database/role/password (blocked on you, see E), TLS mode `verify-full`, and — only if MagicDNS proves unreliable from wherever the app runs — the optional connect-address field with `YOUR_TAILSCALE_IP`. Save. It verifies identity + TLS, migrates, rewrites the protected file, and flags a restart; restart the process once.

**Option 2 (CLI-first, verifies headlessly before the app ever runs):**
1. Put the URL from Deliverable C into the protected file by hand (or via `laptop:init`'s prompt).
2. `npm run db:init -- --env-file ~/.config/stockbot/stockbot.env` then `npm run db:status -- --env-file ...` — proves auth + TLS + migrations with no server running.
3. Once green, launch as in Option 1 step 2.

Either way: keep the URL only in the protected out-of-repo file — never in the repo's `.env` (it's gitignored, but unnecessary here anyway).

## B. DB-host (oldlaptop) commands, with backup/rollback

I can't reach `oldlaptop` from this session (only this Mac is linked). These commands assume a Debian/Ubuntu-style systemd install (`/etc/postgresql/<ver>/main/…`) — confirm with step 0 first and substitute real paths if it's a different layout.

**0. Discover (safe, no changes):**
```bash
sudo -u postgres psql -c "SHOW config_file;"
sudo -u postgres psql -c "SHOW hba_file;"
sudo -u postgres psql -c "SHOW server_version;"
sudo systemctl status postgresql   # or: pg_lsclusters
```

**1. Backup before touching anything:**
```bash
sudo cp /etc/postgresql/<ver>/main/postgresql.conf{,.bak-$(date +%F)}
sudo cp /etc/postgresql/<ver>/main/pg_hba.conf{,.bak-$(date +%F)}
```

**2. Dedicated least-privileged role + database** (interactive `psql`, so the password never touches shell history or logs):
```bash
sudo -u postgres psql
```
```sql
CREATE ROLE APP_USER WITH LOGIN PASSWORD 'paste-at-the-prompt' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE APP_DATABASE OWNER APP_USER;
\c APP_DATABASE
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO APP_USER;
```
(Stockbot's own migrations run as this role and create their tables under `public` — schema ownership is all it needs.)

**3. Confirm SCRAM (should already be default on PG 14+):**
```bash
sudo -u postgres psql -c "SHOW password_encryption;"
```
If it isn't `scram-sha-256`: set it in `postgresql.conf`, `sudo systemctl reload postgresql`, then re-run `\password APP_USER` — changing the setting alone doesn't rehash an existing role's stored password.

**4. Listen on loopback + the explicit tailnet IP only:**
```ini
listen_addresses = 'localhost,YOUR_TAILSCALE_IP'
```
`sudo systemctl restart postgresql` (listen-address changes need a restart, not just reload).

**5. Narrow `pg_hba.conf` line** — above any broader catch-all so it matches first:
```
hostssl  APP_DATABASE  APP_USER  <app-client-tailnet-ip>/32  scram-sha-256
```
Use the Mac's real Tailscale IP (blocked on you, see E). Do not add a non-SSL `host` line for this role/database. `sudo systemctl reload postgresql` (pg_hba only needs reload).

**6. TLS cert for verify-full:**
```bash
sudo tailscale cert --cert-file /etc/postgresql/tailscale/server.crt \
                     --key-file  /etc/postgresql/tailscale/server.key \
                     YOUR_OLD_LAPTOP.tailnet-name.ts.net
sudo chown postgres:postgres /etc/postgresql/tailscale/server.*
sudo chmod 600 /etc/postgresql/tailscale/server.key
```
In `postgresql.conf`:
```ini
ssl = on
ssl_cert_file = '/etc/postgresql/tailscale/server.crt'
ssl_key_file  = '/etc/postgresql/tailscale/server.key'
```
`sudo systemctl restart postgresql`. Tailscale certs auto-renew (~90 days) but don't auto-reinstall into arbitrary services — plan a periodic re-run of the `tailscale cert` command + `systemctl reload postgresql`, or it'll quietly break one day.

**7. Local self-test on oldlaptop before trusting the network path:**
```bash
psql "host=127.0.0.1 dbname=APP_DATABASE user=APP_USER sslmode=verify-full" -c "select 1"
```

**Rollback (all of B):** restore the two `.bak-<date>` files, `sudo systemctl restart postgresql`. Drop the role/database only once you're sure nothing else was pointed at them (`DROP DATABASE APP_DATABASE; DROP ROLE APP_USER;`) — otherwise just remove the pg_hba line and leave the role.

## C. Sanitized connection-string template

```
postgresql://APP_USER:URL_ENCODED_PASSWORD@YOUR_OLD_LAPTOP.tailnet-name.ts.net:5432/APP_DATABASE?sslmode=verify-full
```
Optional — only if MagicDNS resolution proves unreliable from wherever the app runs — dial the IP directly while keeping the hostname for TLS SNI/verification (the `hostaddr` param `server/db/client.js` already implements):
```
postgresql://APP_USER:URL_ENCODED_PASSWORD@YOUR_OLD_LAPTOP.tailnet-name.ts.net:5432/APP_DATABASE?sslmode=verify-full&hostaddr=YOUR_TAILSCALE_IP
```
URL-encode the password (`encodeURIComponent(password)` in a throwaway REPL line) rather than writing the raw password into any file to check.

## D. Verification evidence to collect

- **Listener:** on oldlaptop, `sudo ss -ltnp | grep 5432` should show exactly `127.0.0.1:5432` and `YOUR_TAILSCALE_IP:5432`, nothing else.
- **Authenticated remote TLS:** from the Mac, `psql "host=YOUR_OLD_LAPTOP.tailnet-name.ts.net dbname=APP_DATABASE user=APP_USER sslmode=verify-full" -c "select current_user, current_database(), (select ssl from pg_stat_ssl where pid = pg_backend_pid());"` — confirms your role/db and `ssl = t`.
- **Migrations:** `npm run db:status -- --env-file ~/.config/stockbot/stockbot.env` — compares migration checksums and ledger invariants; clean exit means done.
- **App health:** with Stockbot running against this config, `curl -s http://127.0.0.1:4000/api/v1/health` should show `data.ok: true`, `data.host: "127.0.0.1"`, `data.database.ok: true`. The Settings → Database connection panel also reports `tls: true` after a successful save/test.

## E. Explicit blockers (not guessed)

- **Database name and app role name** — not yet chosen; needed for B.2 and C.
- **Postgres password** — never type it anywhere I can see it; generate locally (`openssl rand -base64 24`) and enter it only at the interactive `psql` prompt (B.2), the `laptop:init` hidden prompt, or the Settings UI password field.
- **oldlaptop's actual OS / Postgres major version / config paths** — I assumed Debian/Ubuntu with systemd; run step B.0 first and substitute the real paths if it's different (a different distro, Docker, etc.).
- **The Mac's own Tailscale IP/CIDR** for the pg_hba rule — I couldn't fetch it; this session's sandboxed shell has no tailnet route and no `tailscale` CLI on `PATH`. Run `tailscale ip -4` in a normal Terminal on the Mac.
- **Where the app process will actually run** — this Mac only, or other tailnet devices too — decides whether the pg_hba rule is a single `/32` or needs more than one client entry.
- **Whether tailnet HTTPS/cert issuance is already enabled** — required for `tailscale cert` to succeed; if not, you'll hit that as an explicit error the first time you run it, before anything else in B is affected.

## Steps, ordered

1. oldlaptop: discovery (B.0) — no changes.
2. Backups (B.1).
3. Create role + database (B.2); confirm SCRAM (B.3).
4. Tighten `listen_addresses` (B.4); restart.
5. Narrow `pg_hba.conf` (B.5); reload.
6. Issue Tailscale cert, wire TLS (B.6); restart.
7. Local self-test on oldlaptop (B.7).
8. Mac: build the connection string (C); verify remote TLS auth (D bullet 2).
9. `npm run laptop:init` if the protected config file doesn't exist yet; write `DATABASE_URL` into it.
10. `npm run db:init -- --env-file ...` then `npm run db:status -- --env-file ...` (D bullet 3).
11. Launch Stockbot against that config (A); check `/api/v1/health` (D bullet 4).
12. If using the Settings UI path instead, Save there, confirm `restartRequired`/`tls: true`, restart the process.

## Tests

`db:init`/`db:status` (schema + ledger invariants), the `psql sslmode=verify-full` probe (auth + TLS), the health endpoint (app-level). No source changes are made, so `npm run lint`/`npm test` are unaffected — running them once before/after is optional, just to confirm nothing else in the working tree regressed (unrelated modified files are already present in `git status`).

## Risks

- Restarting `postgresql` on oldlaptop briefly drops any other local consumers of that instance — check what else uses it first.
- A too-broad pg_hba CIDR, or an accidental non-SSL `host` line, is the actual security regression to watch for in review.
- Tailscale HTTPS certs expire (~90 days) and need a renewal step or verify-full silently breaks later.
- Hand-editing `postgresql.conf`/`pg_hba.conf` risks a typo — the discovery-then-backup-then-reload-where-possible sequence above keeps mistakes cheap to revert.

## Rollback

Restore the `.bak-<date>` config files and restart `postgresql`; the role/database are new and safe to drop if nothing else depends on them. Nothing on the Stockbot side needs rollback beyond deleting/reverting the protected env file — no repo files were touched by this plan.

## Review findings

None yet — this is the initial plan, not an implementation. Given your rule that higher-risk work gets an independent review before it goes live, flag the `pg_hba.conf` line and `listen_addresses` value for a second look before this is considered done — a mistake there is a network-exposed database.
