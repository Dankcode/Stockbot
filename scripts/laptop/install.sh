#!/bin/bash
set -euo pipefail

umask 077
env_file="${HOME}/.config/stockbot/stockbot.env"
start_service=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ -n "${2:-}" ]] || { echo "--env-file requires a path." >&2; exit 2; }; env_file="$2"; shift 2 ;;
    --no-start) start_service=0; shift ;;
    *) echo "Usage: $0 [--env-file PATH] [--no-start]" >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "This installer supports macOS only." >&2; exit 1; }
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"
node_binary="$(command -v node || true)"
npm_binary="$(command -v npm || true)"
[[ -x "$node_binary" && -x "$npm_binary" ]] || { echo "Node.js 22+ and npm are required." >&2; exit 1; }
node_major="$($node_binary -p 'Number(process.versions.node.split(".")[0])')"
(( node_major >= 22 )) || { echo "Node.js 22 or newer is required." >&2; exit 1; }
[[ -f "$env_file" ]] || { echo "Create the protected config first: $script_dir/init-config.sh --env-file '$env_file'" >&2; exit 1; }
mode="$(/usr/bin/stat -f '%OLp' "$env_file")"
if (( (8#$mode & 077) != 0 )); then
  echo "Refusing config with group/other permissions ($mode). Run: chmod 600 '$env_file'" >&2
  exit 1
fi

echo "Installing dependencies and building Stockbot in $repo_root"
cd "$repo_root"
"$npm_binary" ci
"$npm_binary" run lint
"$npm_binary" test
"$npm_binary" run build
"$node_binary" scripts/database.js init --env-file "$env_file"
"$npm_binary" prune --omit=dev

label="com.stockbot.laptop"
agents_dir="${HOME}/Library/LaunchAgents"
logs_dir="${HOME}/Library/Logs/Stockbot"
plist_path="${agents_dir}/${label}.plist"
mkdir -p "$agents_dir" "$logs_dir"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  value="${value//\"/&quot;}"; value="${value//\'/&apos;}"
  printf '%s' "$value"
}
escaped_repo="$(xml_escape "$repo_root")"
escaped_env="$(xml_escape "$env_file")"
escaped_node="$(xml_escape "$node_binary")"
escaped_logs="$(xml_escape "$logs_dir")"

plist_tmp="$(mktemp "${TMPDIR:-/tmp}/stockbot-launchagent.XXXXXX")"
cleanup() { /bin/rm -f "$plist_tmp"; }
trap cleanup EXIT
cat > "$plist_tmp" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>${escaped_repo}/scripts/laptop/run-stockbot.sh</string>
    <string>${escaped_env}</string>
    <string>${escaped_node}</string>
  </array>
  <key>WorkingDirectory</key><string>${escaped_repo}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escaped_logs}/stockbot.log</string>
  <key>StandardErrorPath</key><string>${escaped_logs}/stockbot.error.log</string>
</dict></plist>
PLIST
/usr/bin/plutil -lint "$plist_tmp" >/dev/null
/bin/cp "$plist_tmp" "$plist_path"
chmod 600 "$plist_path"

domain="gui/$(id -u)"
if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "$domain/$label" || true
fi
if (( start_service )); then
  /bin/launchctl bootstrap "$domain" "$plist_path"
  /bin/launchctl kickstart -k "$domain/$label"
  echo "Stockbot LaunchAgent installed and started."
else
  echo "Stockbot LaunchAgent installed but not started (--no-start)."
fi
echo "Configuration: $env_file"
echo "Logs: $logs_dir"
