#!/usr/bin/env bash
#
# Start two live paper traders, and run the controlled comparison alongside them.
#
# Why it is split this way
# ------------------------
# Every paper session trades the SAME `default-paper` account, and the risk rules in
# server/risk/profile.js are evaluated against that account's portfolio, not per session:
#
#   maxSymbolExposure     25% of account equity
#   maxConcurrentPositions 5
#   maxPositionSize       20% of account equity
#
# So a live control group is not a control group. Seven arms long the same symbol share
# one 25% exposure budget, arms six and seven are blocked outright, and buy-and-hold —
# which is supposed to hold ~100% — gets starved. The controls would look bad for reasons
# that have nothing to do with the market, which flatters the strategies. That is the
# worst failure mode a control group can have.
#
# Therefore:
#   * LIVE  — two strategies, on two different symbols so their exposure does not collide.
#             These are what you check later in the dashboard.
#   * BACKTEST — the full control group, where each arm runs isolated on its own $100k
#             with no shared account, which is where a control actually means something.
#
# Safe to re-run: it reuses a server that is already up and labels each cohort by date.

set -euo pipefail
cd "$(dirname "$0")/../.."

LIVE_A_SYMBOL="${LIVE_A_SYMBOL:-AAPL}"
LIVE_B_SYMBOL="${LIVE_B_SYMBOL:-NVDA}"
STRATEGY_A="base-methods/ema-momentum"
STRATEGY_B="base-methods/rsi-mean-reversion"
# The live arms and the comparison MUST use the same bar interval, or the backtest is
# measuring a different strategy from the one that is actually trading. 1W maps to 1hour
# bars, so the live arms make a decision every market hour and you see activity the same
# session. For a slower, statistically thicker comparison use RANGE=3M BAR_INTERVAL=1day
# and accept roughly one decision per day.
RANGE="${RANGE:-1W}"
export BAR_INTERVAL="${BAR_INTERVAL:-1hour}"
SEEDS="${SEEDS:-20}"
LABEL="live-$(date +%Y%m%d-%H%M)"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-4000}"
API="http://127.0.0.1:${PORT}/api/v1"
TOKEN="$(grep -E '^STOCKBOT_API_TOKEN=' .env | cut -d= -f2-)"

if [ -z "$TOKEN" ]; then
  echo "STOCKBOT_API_TOKEN is not set in .env — the API refuses every mutation without it." >&2
  exit 1
fi

api() { curl -sS -m 60 -H "x-stockbot-token: $TOKEN" "$@"; }

# ----------------------------------------------------------------- the server
if curl -sf -m 3 "$API/health" >/dev/null 2>&1; then
  echo "Reusing the Stockbot API already listening on port $PORT."
else
  echo "Starting the Stockbot API on port $PORT…"
  mkdir -p logs
  nohup npm run server > logs/server.log 2>&1 &
  disown || true
  for _ in $(seq 1 60); do
    curl -sf -m 2 "$API/health" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -sf -m 3 "$API/health" >/dev/null 2>&1; then
    echo "The API did not come up. Last lines of logs/server.log:" >&2
    tail -20 logs/server.log >&2
    exit 1
  fi
  echo "API is up. Logs: logs/server.log"
fi

# ------------------------------------------------------- live paper sessions
version_of() {
  api "$API/algorithms/$(printf '%s' "$1" | sed 's|/|%2F|g')" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(j.error){console.error(j.error.message);process.exit(1)}process.stdout.write(j.data.version.id)})'
}

start_live() {
  local strategy="$1" symbol="$2"
  local version id
  version="$(version_of "$strategy")"
  id="$(api -X POST "$API/sessions" -H 'content-type: application/json' -d "$(node -e '
    const [name, algorithmVersionId, symbol] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      name, mode: "paper", algorithmVersionId, symbols: [symbol], barInterval: process.env.BAR_INTERVAL,
      // Match the backtest default so the live arms and the comparison below price
      // trades identically. The session schema would otherwise default to 0 bps.
      fillModel: { slippageBps: 5, fixedCommission: 0, perShareCommission: 0 },
      schedule: { type: "market_hours", timezone: "America/New_York" }
    }));
  ' "$LABEL · $strategy · $symbol" "$version" "$symbol")" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);if(j.error){console.error(j.error.code+": "+j.error.message);process.exit(1)}process.stdout.write(j.data.id)})')"
  api -X POST "$API/sessions/$id/start" >/dev/null
  echo "  started $id  $strategy on $symbol"
}

echo
echo "── Live paper traders (${BAR_INTERVAL} bars, US market hours) ──"
start_live "$STRATEGY_A" "$LIVE_A_SYMBOL"
start_live "$STRATEGY_B" "$LIVE_B_SYMBOL"

# --------------------------------------------------- controlled comparison
echo
echo "── Controlled comparison (backtest, isolated per arm) ─────────"
mkdir -p reports
for symbol in "$LIVE_A_SYMBOL" "$LIVE_B_SYMBOL"; do
  out="reports/experiment-${symbol}-$(date +%Y%m%d).txt"
  echo "  $symbol → $out"
  node scripts/experiment.js run \
    --symbol "$symbol" --range "$RANGE" --seeds "$SEEDS" \
    --strategy "$STRATEGY_A" --strategy "$STRATEGY_B" \
    > "$out" 2>/dev/null || echo "    (comparison failed for $symbol — see above)"
done

# ------------------------------------------------------------------ summary
echo
echo "── Running now ────────────────────────────────────────────────"
api "$API/sessions?status=running" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const j=JSON.parse(d);
  if (j.error) { console.error(j.error.message); process.exit(1); }
  for (const s of j.data) console.log("  " + s.status.padEnd(8) + (s.symbols||[]).join(",").padEnd(8) + s.name);
  console.log("\n  " + j.data.length + " session(s) live. Open the dashboard to watch them.");
});'
echo
echo "Dashboard: run 'npm run client' and open http://127.0.0.1:5173"
echo "Comparison reports are in reports/."
