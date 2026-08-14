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

# LaunchAgents can be denied background access to source checkouts in macOS
# privacy-protected folders such as Documents. Install a private runtime copy
# under Library so the service is independent from the checkout location.
runtime_root="${HOME}/Library/Application Support/Stockbot/app"
runtime_parent="$(dirname "$runtime_root")"
mkdir -p "$runtime_parent"
chmod 700 "$runtime_parent"
runtime_tmp="$(mktemp -d "${runtime_parent}/.app.XXXXXX")"
runtime_backup="${runtime_parent}/.app.previous"
/bin/cp -R "$repo_root/server" "$runtime_tmp/server"
/bin/cp -R "$repo_root/packages" "$runtime_tmp/packages"
/bin/cp -R "$repo_root/algorithms" "$runtime_tmp/algorithms"
/bin/cp -R "$repo_root/dist" "$runtime_tmp/dist"
/bin/cp -R "$repo_root/scripts" "$runtime_tmp/scripts"
/bin/cp "$repo_root/package.json" "$repo_root/package-lock.json" "$runtime_tmp/"
if [[ -d "$runtime_root/algorithms/uploads" ]]; then
  /bin/cp -R "$runtime_root/algorithms/uploads/." "$runtime_tmp/algorithms/uploads/"
fi
(cd "$runtime_tmp" && "$npm_binary" ci --omit=dev)
chmod -R u=rwX,go= "$runtime_tmp"
if [[ -e "$runtime_root" ]]; then
  /bin/rm -rf "$runtime_backup"
  /bin/mv "$runtime_root" "$runtime_backup"
fi
/bin/mv "$runtime_tmp" "$runtime_root"
/bin/rm -rf "$runtime_backup"

label="com.stockbot.laptop"
agents_dir="${HOME}/Library/LaunchAgents"
logs_dir="${HOME}/Library/Logs/Stockbot"
plist_path="${agents_dir}/${label}.plist"
mkdir -p "$agents_dir" "$logs_dir"
: > "$logs_dir/stockbot.log"
: > "$logs_dir/stockbot.error.log"
chmod 600 "$logs_dir/stockbot.log" "$logs_dir/stockbot.error.log"

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"; value="${value//</&lt;}"; value="${value//>/&gt;}"
  value="${value//\"/&quot;}"; value="${value//\'/&apos;}"
  printf '%s' "$value"
}
escaped_env="$(xml_escape "$env_file")"
escaped_node="$(xml_escape "$node_binary")"
escaped_logs="$(xml_escape "$logs_dir")"
escaped_runtime="$(xml_escape "$runtime_root")"

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
    <string>${escaped_runtime}/scripts/laptop/run-stockbot.sh</string>
    <string>${escaped_env}</string>
    <string>${escaped_node}</string>
    <string>${escaped_runtime}</string>
  </array>
  <key>WorkingDirectory</key><string>${escaped_runtime}</string>
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

wait_for_launchagent_unload() {
  local attempt
  for (( attempt = 1; attempt <= 10; attempt += 1 )); do
    if ! /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 1
  done
  if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
    echo "Stockbot LaunchAgent did not finish unloading after 10 seconds." >&2
    return 1
  fi
}

bootstrap_launchagent() {
  local attempt
  # launchd may briefly reject bootstrap after bootout even once the job no
  # longer appears in `launchctl print`. Retry that transient teardown window.
  for (( attempt = 1; attempt <= 5; attempt += 1 )); do
    if /bin/launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
      return 0
    fi
    if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 1
  done
  if ! /bin/launchctl bootstrap "$domain" "$plist_path"; then
    echo "Stockbot LaunchAgent could not be loaded after bounded retries." >&2
    return 1
  fi
}

if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "$domain/$label" || true
  wait_for_launchagent_unload
fi
if (( start_service )); then
  bootstrap_launchagent
  /bin/launchctl kickstart -k "$domain/$label"
  echo "Stockbot LaunchAgent installed and started."
else
  echo "Stockbot LaunchAgent installed but not started (--no-start)."
fi
echo "Configuration: $env_file"
echo "Logs: $logs_dir"
