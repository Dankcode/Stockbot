import crypto from "node:crypto";
import path from "node:path";
import { AppError } from "../http/errors.js";
import { getRangeConfig } from "../../packages/shared/ranges.js";
import {
  hashAlgorithmSource,
  installAlgorithmAtomically,
  loadAlgorithmRegistry
} from "./registry.js";

const METRICS_VERSION = "2026-08-truth-v1";
const CASH_CONTROL_SOURCE = `export default { name: "Cash — Control", signal() { return null; } };`;
const SPY_CONTROL_SOURCE = `export default { name: "S&P 500 Index (SPY) — Control", signal({ index, position }) { return index === 1 && position.qty === 0 ? { action: "buy", reason: "Buy-and-hold control entry" } : null; } };`;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stable(value)).digest("hex");
}

function cents(value) { return Math.round(Number(value) * 100); }
function microShares(value) { return Math.round(Number(value) * 1_000_000); }

export function normalizeBacktestResult(result) {
  return {
    ...result,
    trades: result.trades.map((trade) => ({
      ...trade,
      quantity: microShares(trade.quantity),
      referencePrice: cents(trade.referencePrice),
      price: cents(trade.price),
      grossNotional: cents(trade.grossNotional),
      notional: cents(trade.notional),
      commission: cents(trade.commission),
      cashDelta: cents(trade.cashDelta),
      slippageCost: cents(trade.slippageCost),
      realizedPnl: cents(trade.realizedPnl)
    })),
    fills: undefined,
    equityCurve: result.equityCurve.map((point) => ({
      time: Number(point.time),
      equity: cents(point.equity),
      cash: cents(point.cash),
      positionValue: cents(point.positionValue)
    })),
    metrics: { ...result.metrics, finalEquity: cents(result.metrics.finalEquity) },
    endingState: {
      cash: cents(result.endingState.cash),
      position: {
        ...result.endingState.position,
        qty: microShares(result.endingState.position.qty),
        entryPrice: cents(result.endingState.position.entryPrice)
      }
    }
  };
}

function publicAlgorithm(item, version, enabled = true) {
  return {
    id: item.id,
    name: item.name,
    author: item.author ?? null,
    description: item.description ?? null,
    file: path.basename(item.path),
    uploaded: item.uploaded,
    enabled,
    params: item.params,
    sourceHash: item.sourceHash,
    version: version ? { id: version.id, hash: version.sourceHash, createdAt: version.createdAt } : null
  };
}

export function createAlgorithmService({ config, enginePool, repository, market }) {
  const algorithmsDir = path.join(config.workspaceRoot, "algorithms");
  const uploadsDir = path.join(algorithmsDir, "uploads");
  let snapshot = { algorithms: [], errors: [] };
  let loadedAt = 0;

  async function refresh(force = false) {
    if (!force && Date.now() - loadedAt < 5_000 && snapshot.algorithms.length) return snapshot;
    snapshot = await loadAlgorithmRegistry({ algorithmsDir, uploadsDir, enginePool });
    loadedAt = Date.now();
    for (const item of snapshot.algorithms) {
      const existing = await repository.getById(item.id);
      if (!existing) {
        await repository.create({ id: item.id, name: item.name, author: item.author, description: item.description, sourcePath: path.relative(config.workspaceRoot, item.path) });
      } else {
        await repository.update(item.id, { name: item.name, author: item.author, description: item.description, sourcePath: path.relative(config.workspaceRoot, item.path) });
      }
      await repository.addVersion({
        id: `${item.id}:${item.sourceHash.slice(0, 24)}`,
        algorithmId: item.id,
        sourceHash: item.sourceHash,
        sourceCode: item.source,
        params: item.params
      });
    }
    return snapshot;
  }

  async function list() {
    const loaded = await refresh();
    const algorithms = await Promise.all(loaded.algorithms.map(async (item) => {
      const [version, row] = await Promise.all([repository.getLatestVersion(item.id), repository.getById(item.id)]);
      return publicAlgorithm(item, version, row?.enabled ?? true);
    }));
    return { algorithms, errors: loaded.errors };
  }

  async function get(id, { includeSource = false } = {}) {
    const loaded = await refresh();
    const item = loaded.algorithms.find((algorithm) => algorithm.id === id);
    if (!item) throw new AppError("ALGORITHM_NOT_FOUND", `Unknown algorithm: ${id}`, 404);
    const [version, row] = await Promise.all([repository.getLatestVersion(id), repository.getById(id)]);
    return { ...publicAlgorithm(item, version, row?.enabled ?? true), ...(includeSource ? { source: item.source } : {}) };
  }

  async function versions(id) {
    await get(id);
    return repository.listVersions(id);
  }

  async function update(id, changes) {
    await get(id);
    const row = await repository.update(id, { enabled: changes.enabled });
    return { ...(await get(id)), enabled: row.enabled };
  }

  async function upload({ filename, source, overwrite = false }) {
    const installed = await installAlgorithmAtomically({
      uploadsDir,
      filename,
      source,
      overwrite,
      preflight: ({ source: algorithmSource, filename: workerFilename }) => enginePool.validateAlgorithm({ algorithmSource, filename: workerFilename })
    });
    loadedAt = 0;
    await refresh(true);
    return get(installed.id, { includeSource: true });
  }

  async function backtest(id, { symbol, range = "3M", params = {}, fillModel = { slippageBps: 5, fixedCommission: 0, perShareCommission: 0 } }) {
    const algorithm = await get(id, { includeSource: true });
    const marketData = await market.getBars(symbol, range);
    if (marketData.bars.length < 5) throw new AppError("INSUFFICIENT_BARS", "At least five real bars are required.", 422);
    const rangeConfig = getRangeConfig(range);
    const spyMarketData = String(symbol).toUpperCase() === "SPY" ? marketData : await market.getBars("SPY", range);
    const version = await repository.getLatestVersion(id);
    const key = {
      algorithmVersionId: version.id,
      symbol: String(symbol).toUpperCase(),
      barInterval: rangeConfig.interval,
      windowStart: marketData.bars[0].time,
      windowEnd: marketData.bars.at(-1).time,
      barsHash: hash({ strategy: marketData.bars, spy: spyMarketData.bars }),
      paramsHash: hash(params),
      fillModelHash: hash(fillModel)
    };
    const cached = await repository.findBacktest(key);
    if (cached) return { ...cached.resultJson, cache: { hit: true, computedAt: cached.computedAt }, source: marketData.source, algorithmVersionId: version.id, metricsVersion: METRICS_VERSION };
    const started = Date.now();
    const [strategyRaw, spyRaw, cashRaw] = await Promise.all([
      enginePool.runBacktest({ algorithmSource: algorithm.source, filename: algorithm.file, bars: marketData.bars, params, startingCash: 100_000, fillModel, interval: rangeConfig.interval }),
      enginePool.runBacktest({ algorithmSource: SPY_CONTROL_SOURCE, filename: "spy-control.js", bars: spyMarketData.bars, startingCash: 100_000, fillModel, interval: rangeConfig.interval }),
      enginePool.runBacktest({ algorithmSource: CASH_CONTROL_SOURCE, filename: "cash-control.js", bars: marketData.bars, startingCash: 100_000, fillModel, interval: rangeConfig.interval })
    ]);
    const strategy = normalizeBacktestResult(strategyRaw);
    const spy = normalizeBacktestResult(spyRaw);
    const cash = normalizeBacktestResult(cashRaw);
    const result = {
      ...strategy,
      controls: [
        { id: "control/spy", name: "S&P 500 Index (SPY) — Control", metrics: spy.metrics, equityCurve: spy.equityCurve },
        { id: "control/cash", name: "Cash — Control", metrics: cash.metrics, equityCurve: cash.equityCurve }
      ],
      comparison: { vsSpyPercent: strategy.metrics.returnPercent - spy.metrics.returnPercent, vsCashPercent: strategy.metrics.returnPercent }
    };
    await repository.putBacktest({ id: crypto.randomUUID(), ...key, result, computedAt: Date.now(), computeMs: Date.now() - started });
    return { ...result, cache: { hit: false, computedAt: Date.now() }, source: marketData.source, algorithmVersionId: version.id, metricsVersion: METRICS_VERSION };
  }

  return { refresh, list, get, versions, update, upload, backtest, metricsVersion: METRICS_VERSION };
}
