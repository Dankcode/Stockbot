#!/usr/bin/env bash
# Deploys one commit of Stockbot to the Linux host (old laptop) as a new release
# directory next to the current one, then switches the systemd unit over.
#
#   bash deploy-release.sh <commit> [--yes]
#
# Reads everything from the running install (unit file, release dir, env file,
# port, token) instead of assuming it, shows what it found, and asks before it
# changes anything. Order: build + test the new release → back up the database
# → switch the unit → health checks → on any failure, put the old unit back.
# Migrations run on boot inside a transaction and are additive, so the old
# release keeps working against the migrated database (rollback = old unit).
set -euo pipefail
umask 077

COMMIT="${1:?Usage: deploy-release.sh <commit> [--yes]}"
ASSUME_YES=0; [[ "${2:-}" == "--yes" ]] && ASSUME_YES=1
REPO_URL="${STOCKBOT_REPO_URL:-https://github.com/Dankcode/Stockbot.git}"
STATE="$HOME/.local/state/stockbot/deploy"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$STATE"
LOG="$STATE/deploy-$STAMP.log"
exec > >(tee -a "$LOG") 2>&1

say()  { printf '\n== %s\n' "$*"; }
die()  { printf '\nFAILED: %s\n(log: %s)\n' "$*" "$LOG"; sleep 1; exit 1; }
ask()  { (( ASSUME_YES )) && return 0; local reply; read -r -p "$1 [y/N] " reply </dev/tty; [[ "$reply" =~ ^[Yy]$ ]]; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(($1)(v))})"; }

command -v node >/dev/null || die "node is not installed"
command -v git  >/dev/null || die "git is not installed"
command -v curl >/dev/null || die "curl is not installed"

say "1/8 Finding the running install"
if systemctl --user cat stockbot.service >/dev/null 2>&1; then SCOPE=(--user); SUDO=(); 
elif systemctl cat stockbot.service >/dev/null 2>&1; then SCOPE=(); SUDO=(sudo);
else die "no stockbot.service unit found (user or system)"; fi
UNIT_PATH="$(systemctl "${SCOPE[@]}" show -p FragmentPath --value stockbot.service)"
[[ -f "$UNIT_PATH" ]] || die "unit file not found: $UNIT_PATH"
CURRENT="$(grep -oE "$HOME/stockbot-releases/[^/ \"']+" "$UNIT_PATH" | head -1 || true)"
[[ -n "$CURRENT" && -d "$CURRENT" ]] || die "could not find the current release dir in $UNIT_PATH"
ENV_FILE="$(grep -oE -- '--env-file=[^ "]+' "$UNIT_PATH" | head -1 | cut -d= -f2- || true)"
[[ -z "$ENV_FILE" ]] && ENV_FILE="$(grep -oE '^EnvironmentFile=-?[^ ]+' "$UNIT_PATH" | head -1 | sed 's/^EnvironmentFile=-\{0,1\}//' || true)"
[[ -z "$ENV_FILE" && -f "$HOME/.config/stockbot/stockbot.env" ]] && ENV_FILE="$HOME/.config/stockbot/stockbot.env"
[[ -f "$ENV_FILE" ]] || die "could not find the env file (looked in the unit and ~/.config/stockbot/stockbot.env)"
envval() { node --env-file="$ENV_FILE" -e "process.stdout.write(process.env['$1'] ?? '')"; }
PORT="$(envval PORT)"; PORT="${PORT:-4000}"
TOKEN="$(envval STOCKBOT_API_TOKEN)"
DATABASE_URL="$(envval DATABASE_URL)"
[[ -n "$TOKEN" ]] || die "STOCKBOT_API_TOKEN is not set in $ENV_FILE"
API="http://127.0.0.1:$PORT/api/v1"
get()  { curl -fsS -H "x-stockbot-token: $TOKEN" "$API$1"; }
post() { curl -fsS -H "x-stockbot-token: $TOKEN" -H 'content-type: application/json' -X POST -d "$2" "$API$1"; }
NAME="swarm-experiments-$(date +%Y%m%d)"; NEW="$HOME/stockbot-releases/$NAME"
for suffix in b c d e f; do [[ -e "$NEW" ]] && NEW="$HOME/stockbot-releases/$NAME$suffix"; done
[[ -e "$NEW" ]] && die "release dir $NEW already exists"
DB_KIND="sqlite"; [[ "$DATABASE_URL" == postgres* ]] && DB_KIND="postgres"

echo "unit:            $UNIT_PATH (${SCOPE[*]:-system})"
echo "current release: $CURRENT"
echo "new release:     $NEW  (commit $COMMIT)"
echo "env file:        $ENV_FILE"
echo "api:             $API"
echo "database:        $DB_KIND"

say "2/8 State before the change"
get /health | json 'v=>"health ok="+v.data.ok+" db="+v.data.database.ok' || die "the running server does not answer on $API"
SESSIONS_BEFORE="$(get '/sessions?limit=100' | json 'v=>v.data.map(s=>s.id+":"+s.status).sort().join(" ")')"
PAUSED="$(tr ' ' '\n' <<<"$SESSIONS_BEFORE" | grep -c ':paused$' || true)"
echo "sessions: $(tr ' ' '\n' <<<"$SESSIONS_BEFORE" | cut -d: -f2 | sort | uniq -c | tr '\n' ' ')"
if (( PAUSED > 0 )); then
  echo "NOTE: $PAUSED paused session(s). The engine marks paused sessions 'errored' on every restart (known, pre-existing)."
  echo "      They can be brought back afterwards with POST /api/v1/sessions/<id>/recover."
fi
ask "Build $COMMIT into $NEW, back up the database, and switch over?" || die "stopped by operator; nothing changed"

say "3/8 Building and testing the new release"
git clone --quiet "$REPO_URL" "$NEW"
git -C "$NEW" -c advice.detachedHead=false checkout --quiet "$COMMIT"
echo "checked out $(git -C "$NEW" log --oneline -1)"
if [[ -d "$CURRENT/algorithms/uploads" ]]; then mkdir -p "$NEW/algorithms/uploads"; cp -a "$CURRENT/algorithms/uploads/." "$NEW/algorithms/uploads/"; fi
[[ -f "$CURRENT/algorithms/params.json" ]] && cp -a "$CURRENT/algorithms/params.json" "$NEW/algorithms/params.json"
(cd "$NEW" && npm ci --no-audit --no-fund >/dev/null)
echo "swarm + database tests (must pass):"
(cd "$NEW" && node --test test/swarm/*.test.js test/db/*.test.js 2>&1 | grep -E '^# (pass|fail|skipped)') || true
FAILS="$(cd "$NEW" && node --test test/swarm/*.test.js test/db/*.test.js 2>&1 | grep -E '^# fail' | awk '{print $3}')"
[[ "$FAILS" == "0" ]] || die "swarm/database tests failed in $NEW; nothing switched"
if [[ "${STOCKBOT_DEPLOY_SKIP_FULL_SUITE:-0}" != "1" ]]; then
  echo "full suite (informational; 3 frontend failures are known on Node 22.22):"
  (cd "$NEW" && node --test 2>&1 | grep -E '^# (pass|fail|skipped)') || true
fi
(cd "$NEW" && npx vite build >/dev/null) || die "vite build failed; nothing switched"
[[ -f "$NEW/dist/index.html" ]] || die "build produced no dist/index.html"
echo "Files in the current release that the new one lacks (check none are needed):"
comm -23 <(ls -A "$CURRENT" | sort) <(ls -A "$NEW" | sort) | sed 's/^/  /' || true

say "4/8 Backing up the database"
DUMP=""
if [[ "$DB_KIND" == "postgres" ]]; then
  command -v pg_dump >/dev/null || die "pg_dump is not installed"
  DUMP="$STATE/stockbot-pre-$NAME-$STAMP.dump"
  pg_dump -Fc -f "$DUMP" "$DATABASE_URL"
  pg_restore -l "$DUMP" >/dev/null || die "the dump does not read back"
else
  SQLITE_FILE="${DATABASE_URL#file:}"; SQLITE_FILE="${SQLITE_FILE#//}"
  DUMP="$STATE/stockbot-pre-$NAME-$STAMP.sqlite"
  node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$SQLITE_FILE" "$DUMP"
fi
echo "backup: $DUMP ($(du -h "$DUMP" | cut -f1))"

say "5/8 Switching the unit to the new release"
UNIT_BACKUP="$STATE/stockbot.service.bak-$STAMP"
cp "$UNIT_PATH" "$UNIT_BACKUP"
rollback() {
  echo "Rolling back to $CURRENT"
  "${SUDO[@]}" cp "$UNIT_BACKUP" "$UNIT_PATH"
  "${SUDO[@]}" systemctl "${SCOPE[@]}" daemon-reload
  "${SUDO[@]}" systemctl "${SCOPE[@]}" restart stockbot.service
  for _ in $(seq 1 60); do get /health >/dev/null 2>&1 && { echo "old release is back up"; return; }; sleep 2; done
  echo "OLD RELEASE DID NOT COME BACK. Unit backup: $UNIT_BACKUP  DB backup: $DUMP" >&2
}
TMP_UNIT="$(mktemp)"; sed "s#$CURRENT#$NEW#g" "$UNIT_PATH" > "$TMP_UNIT"
grep -q "$NEW" "$TMP_UNIT" || die "could not rewrite the unit"
"${SUDO[@]}" cp "$TMP_UNIT" "$UNIT_PATH"; rm -f "$TMP_UNIT"
"${SUDO[@]}" systemctl "${SCOPE[@]}" daemon-reload
"${SUDO[@]}" systemctl "${SCOPE[@]}" restart stockbot.service

say "6/8 Health checks"
UP=0
for _ in $(seq 1 90); do get /health >/dev/null 2>&1 && { UP=1; break; }; sleep 2; done
if (( ! UP )); then journalctl "${SCOPE[@]}" -u stockbot.service -n 40 --no-pager || true; rollback; die "new release did not become healthy"; fi
if ! get /swarm/automation >/dev/null 2>&1; then rollback; die "new release is up but the swarm experiment API is missing (migration 0008 not applied?)"; fi
SESSIONS_AFTER="$(get '/sessions?limit=100' | json 'v=>v.data.map(s=>s.id+":"+s.status).sort().join(" ")')"
CHANGED="$(diff <(tr ' ' '\n' <<<"$SESSIONS_BEFORE") <(tr ' ' '\n' <<<"$SESSIONS_AFTER") | grep -E '^[<>]' || true)"
UNEXPECTED="$(grep '^>' <<<"$CHANGED" | grep -v ':errored$' || true)"
if [[ -n "$UNEXPECTED" ]]; then echo "$CHANGED"; rollback; die "sessions changed in an unexpected way across the restart"; fi
[[ -n "$CHANGED" ]] && { echo "Sessions that went paused -> errored (known restart behaviour):"; grep '^>' <<<"$CHANGED" | sed 's/^> /  /'; }
ERRORS="$(journalctl "${SCOPE[@]}" -u stockbot.service --since "-3 min" --no-pager 2>/dev/null | grep -ciE 'error|exception' || true)"
echo "health ok; experiment API present; journal error lines in last 3 min: $ERRORS"

say "7/8 Starting the experiment"
if get /swarm/experiments | json 'v=>v.data.some(e=>e.name==="disc")' | grep -q true; then
  echo "experiment 'disc' already exists"
elif ask "Create experiment 'disc' (agents disc-growth + disc-hold, SPY/QQQ control, \$100k paper each)?"; then
  post /swarm/experiments '{"name":"disc"}' | json 'v=>"created: "+v.data.arms.map(a=>a.label+" from "+a.startDate).join(", ")' \
    || echo "could not create it (agent cap of 8, or a name clash). See: curl $API/swarm/experiments"
fi
if ask "Turn on the daily Discovery run (10:00 ET) and the review/learning job?"; then
  post /swarm/automation '{"discoverySchedule":true,"review":true}' | json 'v=>JSON.stringify(v.data)'
fi
for agent in disc-growth disc-hold; do post "/swarm/agents/agent-$agent/intents" '{"enabled":true}' >/dev/null 2>&1 && echo "paper orders on for $agent" || true; done
GLOBAL="$(get /swarm | json 'v=>v.data.intentsEnabled')"
echo "swarm-wide order switch is currently: $GLOBAL"
if [[ "$GLOBAL" != "true" ]] && ask "Turn the swarm-wide paper order switch ON (affects every agent whose own switch is on)?"; then
  post /swarm/intents '{"enabled":true}' | json 'v=>"swarm orders: "+v.data.intentsEnabled'
fi

say "8/8 Done"
echo "running:   $NEW ($(git -C "$NEW" log --oneline -1))"
echo "rollback:  cp '$UNIT_BACKUP' '$UNIT_PATH' && systemctl ${SCOPE[*]} daemon-reload && systemctl ${SCOPE[*]} restart stockbot.service"
echo "db backup: $DUMP"
echo "log:       $LOG"
