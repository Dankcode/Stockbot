#!/bin/bash
set -euo pipefail

env_file="${HOME}/.config/stockbot/stockbot.env"
tailscale_binary="${TAILSCALE_BIN:-}"
replace_existing=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) [[ -n "${2:-}" ]] || { echo "--env-file requires a path." >&2; exit 2; }; env_file="$2"; shift 2 ;;
    --tailscale-bin) [[ -n "${2:-}" ]] || { echo "--tailscale-bin requires a path." >&2; exit 2; }; tailscale_binary="$2"; shift 2 ;;
    --replace-existing) replace_existing=1; shift ;;
    *) echo "Usage: $0 [--env-file PATH] [--tailscale-bin PATH] [--replace-existing]" >&2; exit 2 ;;
  esac
done
[[ -f "$env_file" ]] || { echo "Stockbot config not found: $env_file" >&2; exit 1; }
mode="$(/usr/bin/stat -f '%OLp' "$env_file")"
if (( (8#$mode & 077) != 0 )); then
  echo "Refusing config with group/other permissions ($mode): $env_file" >&2
  exit 1
fi
if [[ -z "$tailscale_binary" ]]; then tailscale_binary="$(command -v tailscale || true)"; fi
[[ -x "$tailscale_binary" ]] || { echo "Tailscale CLI not found. Install and sign in, or pass --tailscale-bin." >&2; exit 1; }
node_binary="$(command -v node || true)"
[[ -x "$node_binary" ]] || { echo "Node.js is required to read and validate the protected config." >&2; exit 1; }
port="$("$node_binary" --env-file="$env_file" -p 'process.env.PORT || "4000"')"
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1 && port <= 65535 )) || { echo "PORT must be 1-65535." >&2; exit 1; }

"$tailscale_binary" status >/dev/null
health_payload="$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/api/v1/health")" || {
  echo "Stockbot is not healthy on loopback port $port; start the LaunchAgent first." >&2
  exit 1
}
printf '%s' "$health_payload" | "$node_binary" -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const body = JSON.parse(input);
    if (body?.data?.ok !== true || body?.data?.host !== "127.0.0.1" || body?.data?.database?.ok !== true) process.exit(1);
  });
' || { echo "Stockbot health did not confirm loopback binding and a healthy database." >&2; exit 1; }
unset health_payload

# Serve is private to the tailnet. Do not replace this with `tailscale funnel`.
serve_status="$("$tailscale_binary" serve status 2>&1 || true)"
if [[ "$serve_status" == *"http://127.0.0.1:${port}"* ]]; then
  printf '%s\n' "$serve_status"
  echo "Tailscale Serve already targets this Stockbot port; no change made."
  exit 0
fi
if [[ -n "$serve_status" && "$serve_status" != *"No serve config"* ]] && (( ! replace_existing )); then
  printf '%s\n' "$serve_status"
  echo "Existing Tailscale Serve configuration detected; refusing to replace it." >&2
  echo "Review it, then rerun with --replace-existing only if Stockbot should own HTTPS port 443 at /." >&2
  exit 1
fi
"$tailscale_binary" serve --bg --yes --https=443 "http://127.0.0.1:${port}"
"$tailscale_binary" serve status
