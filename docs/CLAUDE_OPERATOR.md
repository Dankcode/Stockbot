# Operating Stockbot from Claude (MCP over Tailscale)

`scripts/mcp/stockbot-mcp.js` is a small, dependency-free [MCP](https://modelcontextprotocol.io) server. It lets Claude on your Mac (the Claude desktop app or Claude Code) operate a Stockbot instance running on another machine in your tailnet, for example the laptop deployment from [LAPTOP_DEPLOYMENT.md](./LAPTOP_DEPLOYMENT.md).

Claude acts as an **operator**. The strategy's own rules make every buy and sell decision, and Stockbot executes them with paper money. Claude creates, starts, monitors, pauses, stops and reports on sessions.

## What Claude can and cannot do

| Tool | Does |
|---|---|
| `stockbot_status` | Health, data providers, paper equity, positions and active sessions |
| `list_strategies` | Installed strategies with default params and current version |
| `market_quote`, `market_bars` | Latest quote and recent bars for a symbol |
| `backtest_strategy` | Read-only backtest of an installed strategy vs SPY/QQQ/IWM/DIA controls |
| `list_sessions`, `session_report` | Sessions; one session's equity, pending/filled/rejected orders (with reasons) and events |
| `create_paper_session` | Creates and starts a **paper** session with fixed dollar sizing and a catastrophe stop |
| `session_control` | start, pause, resume, stop, halt (halt keeps positions) |
| `account_portfolio` | Cash, equity and positions of a paper account |

The tool set is deliberately closed:
- **No algorithm upload or edit.** Uploaded JavaScript can escape the engine sandbox, so only strategies already installed on the instance can be used.
- No settings, research plans, liquidate-all, halt-all or raw order placement.
- Sessions are always paper.

The bridge sends the API token **only** to a Tailscale Serve HTTPS address (`https://<host>.<tailnet>.ts.net`) or loopback. Any other URL is refused, so a typo or an injected value cannot send the token anywhere else. The token lives in `~/.config/stockbot/mcp.env` (mode 600) and never in Claude's own config files.

## Prerequisites

1. **The instance runs current code.** The Bitcoin crossover (`crypto-pack/btc-sma-crossover`) needs the 2026-10-20 changes or later. On the Stockbot host: `git pull && ./scripts/laptop/install.sh`.
2. **Tailscale is connected on this Mac,** and the host's Serve mapping is up. `tailscale serve status` on the host shows the HTTPS URL to use.
3. You have the host's `STOCKBOT_API_TOKEN`, from `~/.config/stockbot/stockbot.env` on the host. Read it on the host; don't paste it into a chat.

## Setup (one command, on the Mac)

```bash
cd ~/Documents/GitHub/Stockbot
./scripts/mcp/setup-claude.sh --url https://<host>.<tailnet>.ts.net
```

The script:
1. checks the URL and that `/api/v1/health` answers;
2. asks for the token without echoing it and writes `~/.config/stockbot/mcp.env`;
3. proves the bridge works by calling `stockbot_status` and `list_strategies` through MCP, and tells you if the Bitcoin strategy is missing on the host;
4. registers `stockbot` in the Claude desktop app's config (`~/Library/Application Support/Claude/claude_desktop_config.json`, backup kept) and, if the `claude` CLI is installed, with Claude Code (`claude mcp add --scope user`).

Then quit and reopen the Claude app and ask Claude to "check Stockbot status".

### Manual registration (if you prefer)

Claude desktop app, inside `mcpServers`:

```json
"stockbot": {
  "command": "/absolute/path/to/node",
  "args": ["/Users/<you>/Documents/GitHub/Stockbot/scripts/mcp/stockbot-mcp.js"],
  "env": { "STOCKBOT_MCP_ENV": "/Users/<you>/.config/stockbot/mcp.env" }
}
```

Claude Code:

```bash
claude mcp add --scope user stockbot --env STOCKBOT_MCP_ENV=$HOME/.config/stockbot/mcp.env -- "$(command -v node)" "$PWD/scripts/mcp/stockbot-mcp.js"
```

Use an absolute `node` path. GUI apps often don't inherit your shell's `PATH` (nvm, Homebrew).

## The Bitcoin crossover agent

Rule: compare Bitcoin's recent average price with its longer average. When the shorter average crosses above the longer one, buy; when it crosses back below, sell. This is installed as `crypto-pack/btc-sma-crossover` (simple moving averages, default 20 and 50 bars).

Recommended starting configuration:

| Setting | Value | Why |
|---|---|---|
| Symbol | `BTCUSD` | |
| Bar interval | `1hour` | 20 h vs 50 h averages, a decision every hour, 24/7, so you see activity within days. `1day` with 20/50 is the classic slow version: a few trades a year. |
| Params | `fast: 20`, `slow: 50` | The strategy's defaults |
| Sizing | `$10,000` per entry | 10% of the $100k paper account |
| Catastrophe stop | `15%` | Exits only on a crash between crossovers. For the pure rule (exit only on the cross-down), set it to the maximum, 50. |

Ask Claude, for example:

> Create a paper session named "Claude agent — BTC SMA crossover" for crypto-pack/btc-sma-crossover on BTCUSD, 1hour bars, fast 20 slow 50, $10,000 per entry, and start it. Then show me the session report.

Daily check:

> Give me the report for the BTC crossover session: equity vs start, any trades since yesterday, pending orders, and any rejections with their reasons. Compare its return since start with a QQQ and SPY backtest over the same range.

Notes:
- Crypto sessions fill in the same tick as the signal at the live quote (since 2026-10-20).
- **Shared account.** Until per-agent sleeves exist (`PLAN-stockbot-swarm-hub-20261021`, Phase 1), every session trades the shared `default-paper` account. Its exposure and drawdown limits are shared with other running sessions, so use fixed sizing and keep an eye on `account_portfolio`.
- The session must be running on the host. The bridge is only a remote control, so Claude doesn't need to stay open.

## Troubleshooting

| Message | Fix |
|---|---|
| `UNREACHABLE` | Tailscale disconnected on the Mac, the host asleep, or Serve mapping off (`tailscale serve status` on the host) |
| `CONFIG_UNSAFE_URL` | Use the `https://…ts.net` name from `tailscale serve status`, not an IP or plain `http` |
| `CONFIG_PERMISSIONS` | `chmod 600 ~/.config/stockbot/mcp.env` |
| `AUTH_NOT_CONFIGURED` / `AUTH_REQUIRED` | Re-run setup with the host's current `STOCKBOT_API_TOKEN` |
| `STRATEGY_NOT_INSTALLED` | Update the host: `git pull && ./scripts/laptop/install.sh` |
| Tools don't appear in Claude | Quit and reopen the Claude app; check the `stockbot` entry in its config |

This bridge is the seed of the swarm hub's MCP server (`PLAN-stockbot-swarm-hub-20261021`, Phase 5). There, each agent gets its own scoped token and sleeve instead of the operator token.
