/**
 * Fetches real daily bars for the rotation universe and runs the pure ranking
 * and backtest over them. Stockbot never invents candles: a symbol whose bars
 * cannot be fetched is reported in `errors` and left out, never filled in.
 */
import { ROTATION_MIN_BARS, rankRotation } from "./rotation.js";
import { runRotationBacktest } from "./rotation-backtest.js";
import { ROTATION_BENCHMARK, ROTATION_SURVIVORSHIP_WARNING, rotationSymbols } from "./rotation-universe.js";

const DAILY_RANGE = "3M"; // the daily-interval range; minBars extends its history
const SPARK_BARS = 60;

function sparkline(bars) {
  const tail = bars.slice(-SPARK_BARS).map((bar) => Number(bar.close));
  if (tail.length < 2 || !(tail[0] > 0)) return [];
  return tail.map((close) => Number((close / tail[0]).toFixed(4)));
}

export function createRotationService({ market, universe = rotationSymbols, concurrency = 4 }) {
  if (!market?.getBars) throw new TypeError("Rotation service requires market bars.");

  async function loadBars(minBars) {
    const symbols = typeof universe === "function" ? universe() : universe;
    const all = [...new Set([...symbols, ROTATION_BENCHMARK])];
    const barsBySymbol = {};
    const errors = [];
    const sources = new Set();
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= all.length) return;
        const symbol = all[index];
        try {
          const data = await market.getBars(symbol, DAILY_RANGE, { minBars });
          const bars = data?.bars ?? data;
          if (!Array.isArray(bars) || bars.length === 0) throw new Error("no bars returned");
          if (data?.interval && data.interval !== "1day") throw new Error(`expected daily bars, received ${data.interval}`);
          barsBySymbol[symbol] = bars;
          if (data?.source) sources.add(data.source);
        } catch (cause) {
          errors.push({ symbol, message: cause?.message ?? String(cause) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(8, concurrency)) }, worker));
    return { barsBySymbol, errors, requested: all.length, sources: [...sources] };
  }

  async function screen(options = {}) {
    // A year of regime chart needs the 200-day mean for each of its 260 days.
    const loaded = await loadBars(ROTATION_MIN_BARS + 260);
    if (!loaded.barsBySymbol[ROTATION_BENCHMARK]) {
      return Object.freeze({ available: false, reason: `${ROTATION_BENCHMARK} bars are unavailable, so the regime and ranking cannot be computed.`, errors: loaded.errors, requested: loaded.requested });
    }
    const ranked = rankRotation(loaded.barsBySymbol, options);
    const benchBars = loaded.barsBySymbol[ROTATION_BENCHMARK];
    const regimeWindow = benchBars.slice(-260);
    const closes = benchBars.map((bar) => Number(bar.close));
    const regimeSeries = regimeWindow.map((bar, offset) => {
      const end = benchBars.length - regimeWindow.length + offset;
      const window = ranked.config.regimeSma;
      const average = end + 1 >= window ? closes.slice(end + 1 - window, end + 1).reduce((sum, value) => sum + value, 0) / window : null;
      return { time: Number(bar.time), close: Number(bar.close), sma: average === null ? null : Number(average.toFixed(4)) };
    });
    return Object.freeze({
      available: true,
      asOf: Number(benchBars.at(-1).time),
      sources: loaded.sources,
      requested: loaded.requested,
      scored: Object.keys(loaded.barsBySymbol).length,
      eligibleCount: ranked.rows.filter((row) => row.eligible).length,
      errors: loaded.errors,
      survivorshipWarning: ROTATION_SURVIVORSHIP_WARNING,
      regime: ranked.regime,
      regimeSeries,
      config: ranked.config,
      selected: ranked.selected,
      targets: ranked.targets,
      cashWeight: ranked.cashWeight,
      rows: ranked.rows.map((row) => ({ ...row, spark: sparkline(loaded.barsBySymbol[row.symbol]) })),
      caption: "Momentum rotation — a strategy hypothesis to test against SPY and Cash, not a forecast."
    });
  }

  async function backtest({ years = 3, rebalanceEvery, trailingStop, rotation = {} } = {}) {
    const span = Math.max(1, Math.min(7, Number(years) || 3));
    const loaded = await loadBars(Math.min(2000, Math.ceil(span * 252) + ROTATION_MIN_BARS));
    if (!loaded.barsBySymbol[ROTATION_BENCHMARK]) {
      return Object.freeze({ available: false, reason: `${ROTATION_BENCHMARK} bars are unavailable; the backtest uses them as its calendar and control.`, errors: loaded.errors, requested: loaded.requested });
    }
    const result = runRotationBacktest(loaded.barsBySymbol, { rebalanceEvery, trailingStop, rotation });
    return Object.freeze({
      available: true,
      sources: loaded.sources,
      requested: loaded.requested,
      scored: Object.keys(loaded.barsBySymbol).length,
      errors: loaded.errors,
      survivorshipWarning: ROTATION_SURVIVORSHIP_WARNING,
      ...result,
      trades: result.trades.slice(-200),
      rebalances: result.rebalances.slice(-60)
    });
  }

  return { screen, backtest };
}
