import { createHash } from "node:crypto";
import vm from "node:vm";
import { parentPort } from "node:worker_threads";
import {
  defaultExportSpan,
  validateAlgorithm,
  validateAlgorithmSource
} from "../algorithms/validator.js";
import { runBacktest } from "./backtest.js";
import { createIndicators } from "./indicators.js";

const scriptCache = new Map();

function sourceHash(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

async function loadSource(source, filename = "algorithm.js") {
  validateAlgorithmSource(source, { file: filename });
  const hash = sourceHash(source);
  if (!scriptCache.has(hash)) {
    const span = defaultExportSpan(source, { file: filename });
    const transformed = `${source.slice(0, span.index)}__algorithm =${source.slice(span.index + span.length)}`;
    scriptCache.set(hash, new vm.Script(`"use strict";\n${transformed}`, { filename }));
  }
  const sandbox = { __algorithm: undefined };
  const context = vm.createContext(sandbox, {
    name: `stockbot:${filename}`,
    codeGeneration: { strings: false, wasm: false }
  });
  scriptCache.get(hash).runInContext(context);
  return { algorithm: validateAlgorithm(sandbox.__algorithm, { file: filename }), sourceHash: hash };
}

function normalizeSignal(rawSignal) {
  if (rawSignal === null || rawSignal === undefined) return null;
  if (rawSignal && typeof rawSignal.then === "function") {
    throw new TypeError("Algorithm signal() must be synchronous.");
  }
  if (rawSignal === "buy" || rawSignal === "sell") return { action: rawSignal };
  if (typeof rawSignal === "object" && (rawSignal.action === "buy" || rawSignal.action === "sell")) {
    return {
      action: rawSignal.action,
      reason: typeof rawSignal.reason === "string" ? rawSignal.reason : undefined,
      confidence: Number.isFinite(Number(rawSignal.confidence)) ? Number(rawSignal.confidence) : undefined
    };
  }
  throw new TypeError('Algorithm signal() must return "buy", "sell", a structured signal, or null.');
}

function evaluateLatestSignal(algorithm, payload) {
  if (!Array.isArray(payload.bars) || payload.bars.length === 0) {
    throw new TypeError("Signal evaluation requires at least one closed bar.");
  }
  let priorTime = -Infinity;
  const bars = Object.freeze(payload.bars.map((bar, index) => {
    const normalized = {
      time: typeof bar.time === "number" ? bar.time : Date.parse(bar.time),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number(bar.volume ?? 0)
    };
    if (!Number.isSafeInteger(normalized.time) || normalized.time < priorTime ||
        ![normalized.open, normalized.high, normalized.low, normalized.close, normalized.volume].every(Number.isFinite) ||
        normalized.open <= 0 || normalized.close <= 0 || normalized.high < Math.max(normalized.open, normalized.close) ||
        normalized.low > Math.min(normalized.open, normalized.close) || normalized.low < 0 || normalized.volume < 0) {
      throw new TypeError(`Bar ${index} is invalid or out of order.`);
    }
    priorTime = normalized.time;
    return Object.freeze(normalized);
  }));
  const index = bars.length - 1;
  const indicators = createIndicators(bars);
  const closes = Object.freeze(indicators.closes.slice());
  const params = Object.freeze({ ...(algorithm.params ?? {}), ...(payload.params ?? {}) });
  const position = Object.freeze({ qty: 0, entryPrice: 0, entryIndex: -1, ...(payload.position ?? {}) });
  const empty = Object.freeze([]);
  const state = payload.state !== undefined
    ? payload.state
    : typeof algorithm.init === "function"
      ? algorithm.init({ bars: empty, closes: empty, params, indicators: indicators.at(-1) }) ?? {}
      : {};
  const signal = normalizeSignal(algorithm.signal({
    index,
    bar: bars[index],
    bars,
    closes,
    state,
    params,
    indicators: indicators.at(index),
    position
  }));
  return Object.freeze({
    signal,
    state,
    barTime: bars[index].time,
    close: bars[index].close,
    atr: indicators.at(index).atr(14)[index]
  });
}

export async function executeWorkerTask(kind, payload) {
  if (kind !== "validate" && kind !== "backtest" && kind !== "signal") {
    const error = new TypeError(`Unknown engine worker task: ${kind}.`);
    error.code = "ENGINE_TASK_UNKNOWN";
    throw error;
  }
  const { algorithm, sourceHash: hash } = await loadSource(payload.algorithmSource, payload.filename);
  if (kind === "validate") {
    return Object.freeze({
      ok: true,
      sourceHash: hash,
      name: algorithm.name,
      author: typeof algorithm.author === "string" ? algorithm.author : undefined,
      description: typeof algorithm.description === "string" ? algorithm.description : undefined,
      params: algorithm.params ?? {}
    });
  }
  if (kind === "signal") return evaluateLatestSignal(algorithm, payload);
  return runBacktest({
    ...payload.options,
    bars: payload.bars,
    algorithm,
    params: payload.params ?? payload.options?.params
  });
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? "ENGINE_TASK_FAILED",
    message: error?.message ?? String(error),
    stack: error?.stack
  };
}

if (parentPort) {
  parentPort.on("message", async ({ id, kind, payload }) => {
    try {
      parentPort.postMessage({ id, ok: true, result: await executeWorkerTask(kind, payload) });
    } catch (error) {
      parentPort.postMessage({ id, ok: false, error: serializeError(error) });
    }
  });
}
