#!/usr/bin/env bash
#
# Connect Claude on this Mac to a Stockbot instance over Tailscale.
#
#   ./scripts/mcp/setup-claude.sh --url https://<oldlaptop>.<tailnet>.ts.net
#
# 1. Checks the URL is a Tailscale HTTPS name (or loopback) and that /api/v1/health answers.
# 2. Asks for the instance's STOCKBOT_API_TOKEN without echoing it, and writes
#    ~/.config/stockbot/mcp.env with mode 600. The token never goes into Claude's config.
# 3. Proves the bridge works by calling stockbot_status and list_strategies through MCP.
# 4. Registers the bridge with the Claude desktop app (backup first) and, if present,
#    Claude Code (`claude mcp add --scope user`).
#
# Flags: --url URL (required) · --no-desktop · --no-claude-code · --token-stdin (read token from stdin)
#        --config-dir DIR (default ~/.config/stockbot) · --desktop-config FILE

set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
BRIDGE="$REPO/scripts/mcp/stockbot-mcp.js"

URL=""
DESKTOP=1
CLAUDE_CODE=1
TOKEN_STDIN=0
CONFIG_DIR="$HOME/.config/stockbot"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --no-desktop) DESKTOP=0; shift ;;
    --no-claude-code) CLAUDE_CODE=0; shift ;;
    --token-stdin) TOKEN_STDIN=1; shift ;;
    --config-dir) CONFIG_DIR="${2:-}"; shift 2 ;;
    --desktop-config) DESKTOP_CONFIG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$URL" ] || { echo "--url is required, e.g. --url https://oldlaptop.your-tailnet.ts.net" >&2; exit 2; }

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js 22+ is required on this Mac." >&2; exit 1; }
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node.js 22+ is required (found $("$NODE" -v))." >&2; exit 1; }

# 1. URL safety + reachability (health is a read-only, unauthenticated route)
"$NODE" --input-type=module -e "
  import { validateBaseUrl } from '$BRIDGE';
  try { validateBaseUrl(process.argv[1]); } catch (error) { console.error(error.message); process.exit(1); }
" "$URL"
echo "Checking ${URL%/}/api/v1/health ..."
if ! curl -fsS -m 10 "${URL%/}/api/v1/health" >/dev/null; then
  echo "Cannot reach Stockbot at $URL." >&2
  echo "Check: Tailscale is connected on this Mac (menu bar), the oldlaptop is online, and 'tailscale serve status' on the oldlaptop shows the HTTPS mapping." >&2
  exit 1
fi
echo "Reachable."

# 2. Token → protected file
if [ "$TOKEN_STDIN" = 1 ]; then
  IFS= read -r TOKEN
else
  printf "Paste the oldlaptop's STOCKBOT_API_TOKEN (input hidden): "
  IFS= read -rs TOKEN; echo
fi
[ "${#TOKEN}" -ge 32 ] || { echo "That token is shorter than 32 characters; check ~/.config/stockbot/stockbot.env on the oldlaptop." >&2; exit 1; }
umask 077
mkdir -p "$CONFIG_DIR"
ENV_FILE="$CONFIG_DIR/mcp.env"
TMP="$(mktemp "$CONFIG_DIR/.mcp.env.XXXXXX")"
printf 'STOCKBOT_URL=%s\nSTOCKBOT_API_TOKEN=%s\n' "${URL%/}" "$TOKEN" > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$ENV_FILE"
unset TOKEN
echo "Wrote $ENV_FILE (mode 600)."

# 3. Prove the bridge end to end through MCP
STOCKBOT_MCP_ENV="$ENV_FILE" "$NODE" --input-type=module -e "
  import { spawn } from 'node:child_process';
  import readline from 'node:readline';
  const child = spawn(process.execPath, ['$BRIDGE'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map(); let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => { const message = JSON.parse(line); waiting.get(message.id)?.(message); });
  const call = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'setup', version: '1' } });
  const status = await call('tools/call', { name: 'stockbot_status', arguments: {} });
  const strategies = await call('tools/call', { name: 'list_strategies', arguments: { query: 'crypto-pack' } });
  child.kill();
  if (status.result?.isError) { console.error('stockbot_status failed: ' + status.result.content[0].text); process.exit(1); }
  const parsed = JSON.parse(status.result.content[0].text);
  console.log('Bridge OK. Providers: ' + parsed.providers.map((p) => p.id + '=' + p.status).join(', ') + '; paper equity: \$' + parsed.portfolio?.equity);
  const crypto = strategies.result?.isError ? [] : JSON.parse(strategies.result.content[0].text);
  if (!crypto.some((item) => item.id === 'crypto-pack/btc-sma-crossover')) {
    console.log('NOTE: crypto-pack/btc-sma-crossover is not installed on that instance yet. On the oldlaptop: git pull && ./scripts/laptop/install.sh');
  } else {
    console.log('Bitcoin SMA Crossover strategy is installed.');
  }
"

# 4a. Claude desktop app
if [ "$DESKTOP" = 1 ]; then
  mkdir -p "$(dirname "$DESKTOP_CONFIG")"
  if [ -f "$DESKTOP_CONFIG" ]; then cp -p "$DESKTOP_CONFIG" "$DESKTOP_CONFIG.bak-$(date +%Y%m%d%H%M%S)"; fi
  "$NODE" -e "
    const fs = require('node:fs');
    const [file, node, bridge, envFile] = process.argv.slice(1);
    let config = {};
    if (fs.existsSync(file)) {
      try { config = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); }
      catch { console.error('Existing Claude desktop config is not valid JSON; left untouched. Add the stockbot server manually (see docs/CLAUDE_OPERATOR.md).'); process.exit(0); }
    }
    config.mcpServers = { ...(config.mcpServers || {}), stockbot: { command: node, args: [bridge], env: { STOCKBOT_MCP_ENV: envFile } } };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    console.log('Registered \"stockbot\" in ' + file + ' (backup kept). Quit and reopen the Claude app to load it.');
  " "$DESKTOP_CONFIG" "$NODE" "$BRIDGE" "$ENV_FILE"
fi

# 4b. Claude Code
if [ "$CLAUDE_CODE" = 1 ] && command -v claude >/dev/null 2>&1; then
  claude mcp remove --scope user stockbot >/dev/null 2>&1 || true
  claude mcp add --scope user stockbot --env "STOCKBOT_MCP_ENV=$ENV_FILE" -- "$NODE" "$BRIDGE" \
    && echo "Registered \"stockbot\" with Claude Code (user scope)."
fi

echo "Done. Ask Claude: \"Check Stockbot status\" to confirm it can see the instance."
