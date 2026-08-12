#!/bin/bash
set -euo pipefail

env_file="${HOME}/.config/stockbot/stockbot.env"
[[ "${1:-}" == "--env-file" ]] && { env_file="${2:?--env-file requires a path}"; shift 2; }
[[ $# -eq 0 ]] || { echo "Usage: $0 [--env-file PATH]" >&2; exit 2; }
[[ -f "$env_file" ]] || { echo "Config: missing ($env_file)"; exit 1; }
mode="$(/usr/bin/stat -f '%OLp' "$env_file")"
if (( (8#$mode & 077) != 0 )); then echo "Config permissions: unsafe ($mode; expected 600)"; exit 1; fi
node_binary="$(command -v node || true)"
[[ -x "$node_binary" ]] || { echo "Node.js: not found"; exit 1; }
port="$("$node_binary" --env-file="$env_file" -p 'process.env.PORT || "4000"')"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "Config: invalid PORT"; exit 1; }
label="com.stockbot.laptop"
domain="gui/$(id -u)"
if /bin/launchctl print "$domain/$label" >/dev/null 2>&1; then echo "LaunchAgent: loaded"; else echo "LaunchAgent: not loaded"; fi
if curl --fail --silent --max-time 3 "http://127.0.0.1:${port}/api/v1/health" >/dev/null; then echo "Loopback health: OK"; else echo "Loopback health: unavailable"; fi
if command -v tailscale >/dev/null 2>&1; then tailscale serve status; else echo "Tailscale CLI: not found on PATH"; fi
