#!/bin/bash
set -euo pipefail

env_file="${1:?Usage: run-stockbot.sh ENV_FILE NODE_BINARY}"
node_binary="${2:?Usage: run-stockbot.sh ENV_FILE NODE_BINARY}"
script_dir="$(cd "$(dirname "$0")" && pwd -P)"
repo_root="$(cd "$script_dir/../.." && pwd -P)"

[[ -f "$env_file" ]] || { echo "Stockbot config not found: $env_file" >&2; exit 1; }
mode="$(/usr/bin/stat -f '%OLp' "$env_file")"
if (( (8#$mode & 077) != 0 )); then
  echo "Refusing config with group/other permissions ($mode): $env_file" >&2
  exit 1
fi
[[ -x "$node_binary" ]] || { echo "Node executable not found: $node_binary" >&2; exit 1; }
[[ -f "$repo_root/dist/index.html" ]] || { echo "Production build missing; run scripts/laptop/install.sh again." >&2; exit 1; }

"$node_binary" --env-file="$env_file" -e '
  const required = ["DATABASE_URL", "STOCKBOT_API_TOKEN", "STOCKBOT_SETTINGS_KEY"];
  if (required.some((name) => !process.env[name])) throw new Error("Required Stockbot server configuration is missing.");
  if (process.env.STOCKBOT_API_TOKEN.length < 32 || process.env.STOCKBOT_SETTINGS_KEY.length < 32) {
    throw new Error("Stockbot server secrets must contain at least 32 characters.");
  }
' >/dev/null

export NODE_ENV=production
export HOST=127.0.0.1
unset STOCKBOT_ALLOW_REMOTE
cd "$repo_root"
exec "$node_binary" --env-file="$env_file" server/index.js
