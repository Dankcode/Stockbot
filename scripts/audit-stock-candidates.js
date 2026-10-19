// Read-only evaluation of provider bar snapshots saved by an operator audit.
// Usage: node scripts/audit-stock-candidates.js <snapshot-directory>
import fs from "node:fs/promises";
import path from "node:path";
import { recommendSymbols } from "../server/experiments/selection.js";
import { EnginePool } from "../server/engine/pool.js";
import { epochForZonedDateTime, zonedDateTimeParts, EXCHANGE_TIMEZONE } from "../server/runtime/schedules.js";

const directory = path.resolve(process.argv[2] ?? "reports/trading-audit-2026-10-06");
const histories = new Map();
for (const name of await fs.readdir(directory)) {
  if (!/^[A-Z]+\.json$/.test(name)) continue;
  const { data } = JSON.parse(await fs.readFile(path.join(directory, name), "utf8"));
  if (data?.interval !== "1day" || !data.bars?.length) continue;
  histories.set(data.symbol, data);
}
const ranking = await recommendSymbols({
  universe: [...histories.keys()], range: "3M", limit: 12,
  getBars: async (symbol) => histories.get(symbol)
});
const pool = new EnginePool({ size: 1 });
const candidates = [];
try {
  const methods = await Promise.all(["trend-pullback", "ema-momentum", "rsi-mean-reversion", "donchian-breakout"].map(async (id) => ({
    id, source: await fs.readFile(new URL(`../algorithms/${id}.js`, import.meta.url), "utf8")
  })));
  for (const candidate of ranking.recommended) {
    const history = histories.get(candidate.symbol);
    const bars = history.bars.filter((bar) => {
      const time = Number(bar.time);
      const utc = new Date(time);
      const date = time % 86_400_000 === 0
        ? { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() }
        : zonedDateTimeParts(time, EXCHANGE_TIMEZONE);
      return epochForZonedDateTime({ ...date, hour: 16, minute: 0, second: 0 }, EXCHANGE_TIMEZONE) <= Date.now();
    });
    const signals = [];
    for (const method of methods) {
      const result = await pool.evaluateSignal({ algorithmSource: method.source, bars,
        position: { qty: 0, entryPrice: 0, entryIndex: -1 } });
      signals.push({ method: method.id, signal: result.signal, barTime: result.barTime });
    }
    candidates.push({ ...candidate, provider: history.source, latestProviderBar: history.bars.at(-1).time, evaluatedBar: bars.at(-1)?.time, signals });
  }
} finally { await pool.close(); }
const result = { checkedAt: new Date().toISOString(), note: "Read-only forward paper candidates, not orders or return predictions. Signals use conservatively closed daily bars; re-evaluate before starting sessions.", ...ranking, candidates };
await fs.writeFile(path.join(directory, "candidates.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ eligibleCount: ranking.eligibleCount, excluded: ranking.excluded.map(({ symbol, blockers }) => ({ symbol, blockers })), candidates: candidates.map(({ symbol, score, signals, evaluatedBar }) => ({ symbol, score, evaluatedBar, buySignals: signals.filter(({ signal }) => signal?.action === "buy").map(({ method }) => method) })) }, null, 2));
