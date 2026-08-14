#!/bin/bash
set -euo pipefail

umask 077
config_file="${HOME}/.config/stockbot/stockbot.env"

if [[ "${1:-}" == "--env-file" ]]; then
  [[ -n "${2:-}" ]] || { echo "--env-file requires a path." >&2; exit 2; }
  config_file="$2"
  shift 2
fi
[[ $# -eq 0 ]] || { echo "Usage: $0 [--env-file PATH]" >&2; exit 2; }

if [[ -e "$config_file" ]]; then
  echo "Configuration already exists at $config_file; leaving it unchanged."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "openssl is required to generate server secrets." >&2; exit 1; }
node_binary="$(command -v node || true)"
[[ -x "$node_binary" ]] || { echo "Node.js 22+ is required to write the protected server config." >&2; exit 1; }
echo "Enter the private SQL DATABASE_URL for this laptop. Input is hidden."
IFS= read -r -s database_url
echo
[[ -n "$database_url" ]] || { echo "DATABASE_URL cannot be empty." >&2; exit 1; }
case "$database_url" in
  file:*|postgres://*|postgresql://*) ;;
  *) echo "DATABASE_URL must be a file:, postgres://, or postgresql:// URL." >&2; exit 1 ;;
esac

api_token="$(openssl rand -hex 32)"
settings_key="$(openssl rand -hex 32)"
mkdir -p "$(dirname "$config_file")"
config_tmp="$(mktemp "$(dirname "$config_file")/.stockbot.env.XXXXXX")"
cleanup() { /bin/rm -f "$config_tmp"; }
trap cleanup EXIT
printf '%s\0%s\0%s\0' "$database_url" "$api_token" "$settings_key" | "$node_binary" -e '
  const { readFileSync } = require("node:fs");
  const [databaseUrl, apiToken, settingsKey] = readFileSync(0).toString().split("\0");
  const value = (input) => JSON.stringify(input);
  process.stdout.write([
    "# Stockbot laptop server configuration. Keep mode 600.",
    `DATABASE_URL=${value(databaseUrl)}`,
    `STOCKBOT_DATABASE_LOCATION=${value((() => {
      if (!/^postgres(?:ql)?:\\/\\//i.test(databaseUrl)) return "local";
      const host = new URL(databaseUrl).hostname;
      return ["localhost", "127.0.0.1", "::1"].includes(host) ? "local" : "remote";
    })())}`,
    `STOCKBOT_API_TOKEN=${value(apiToken)}`,
    `STOCKBOT_SETTINGS_KEY=${value(settingsKey)}`,
    "PORT=4000", "HOST=127.0.0.1", "STOCKBOT_MODE=local-paper",
    "ENGINE_WORKERS=2", "ENGINE_TIMEOUT_MS=10000", "QUOTE_FRESHNESS_MS=5000",
    "ALPACA_API_KEY=", "ALPACA_API_SECRET=", "POLYGON_API_KEY=", "FINNHUB_API_KEY=",
    ""
  ].join("\n"));
' > "$config_tmp"
chmod 600 "$config_tmp"
/bin/mv "$config_tmp" "$config_file"
trap - EXIT
unset api_token settings_key database_url
echo "Created protected configuration at $config_file. Secrets were not displayed."
