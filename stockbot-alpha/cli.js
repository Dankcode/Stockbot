#!/usr/bin/env node
/**
 * stockbot-alpha CLI.
 *
 *   node stockbot-alpha/cli.js status
 *   node stockbot-alpha/cli.js fetch --symbol NVDA --days 90
 *   node stockbot-alpha/cli.js fetch --symbol NVDA --provider sec-edgar --days 365
 *   node stockbot-alpha/cli.js train --symbol NVDA --algorithm news-drift --days 365
 *   node stockbot-alpha/cli.js selftest
 *
 * Reads .env from the repo root, so the Alpaca keys already configured for
 * Stockbot work here with no extra setup.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providerStatus, fetchFeed, resolveFeatures } from "./feeds/index.js";
import { walkForward, formatReport, expandGrid } from "./training/walk-forward.js";
import { runBacktest, runBuyAndHold } from "./training/backtest.js";
import { formatMetric } from "./training/metrics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

// ─── .env loading, without adding a dependency ──────────────────────────────
function loadEnv() {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] != null) continue; // real env wins
    process.env[key] = rawValue.trim().replace(/^["'](.*)["']$/, "$1");
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i += 1;
      }
    } else args._.push(token);
  }
  return args;
}

// ─── Bars: reuse the running Stockbot API so provider fallback is shared ────
async function loadBars({ symbol, days, apiBase }) {
  const range = days <= 5 ? "1D" : days <= 31 ? "1M" : days <= 93 ? "3M" : days <= 400 ? "1Y" : "ALL";
  const url = `${apiBase.replace(/\/$/, "")}/api/v1/market/bars/${encodeURIComponent(symbol)}?range=${range}`;

  let payload;
  try {
    const response = await fetch(url);
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `Could not reach the Stockbot API at ${apiBase} (${error.message}).\n` +
        `Start it with:  npm run server`
    );
  }

  const bars = payload?.data?.bars ?? payload?.bars ?? [];
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error(
      `No bars returned for ${symbol} (${range}). ` +
        `${payload?.error ?? "Check that a market-data provider key is configured."}`
    );
  }

  // Normalize to the shape the harness expects, and drop malformed rows rather
  // than letting a NaN close propagate into a metric.
  const normalized = bars
    .map((bar) => ({
      time: bar.time ?? bar.t,
      open: Number(bar.open ?? bar.o),
      high: Number(bar.high ?? bar.h),
      low: Number(bar.low ?? bar.l),
      close: Number(bar.close ?? bar.c),
      volume: Number(bar.volume ?? bar.v ?? 0)
    }))
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));

  return { bars: normalized, source: payload?.data?.source ?? payload?.source ?? "unknown", range };
}

async function loadAlgorithm(name) {
  const candidates = [
    path.join(here, "algorithms", `${name}.js`),
    path.join(here, "algorithms", name),
    path.join(repoRoot, "algorithms", `${name}.js`),
    path.resolve(name)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const module = await import(`file://${candidate}`);
      if (typeof module.default?.signal !== "function") {
        throw new Error(`${candidate} does not export a default object with a signal() function.`);
      }
      return module.default;
    }
  }
  const available = fs
    .readdirSync(path.join(here, "algorithms"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => f.replace(/\.js$/, ""));
  throw new Error(`Algorithm "${name}" not found. Available here: ${available.join(", ")}`);
}

// ─── Commands ───────────────────────────────────────────────────────────────

function cmdStatus() {
  console.log("\nFeed providers\n" + "─".repeat(72));
  for (const provider of providerStatus()) {
    const mark = provider.ok ? "OK  " : "--  ";
    const history = provider.supportsHistory ? "historical" : "live only ";
    console.log(`${mark}${provider.id.padEnd(14)} ${history}  ${provider.label}`);
    if (!provider.ok) console.log(`    ${provider.reason}`);
  }
  console.log("\nBacktesting a live-only provider is refused by design — it would");
  console.log("score today's events against past prices.\n");
}

async function cmdFetch(args) {
  const symbol = String(args.symbol ?? args.s ?? "").toUpperCase();
  if (!symbol) throw new Error("--symbol is required");
  const days = Number(args.days ?? 90);
  const provider = String(args.provider ?? "alpaca-news");

  const endMs = Date.now();
  const startMs = endMs - days * 86_400_000;

  console.log(`Fetching ${provider} for ${symbol}, last ${days} days...`);
  const { events, fromCache } = await fetchFeed({ provider, symbol, startMs, endMs });

  console.log(`${events.length} events${fromCache ? " (from cache)" : ""}\n`);
  for (const event of events.slice(-15)) {
    const when = new Date(event.publishedAt).toISOString().replace("T", " ").slice(0, 16);
    console.log(`  ${when}  ${event.headline.slice(0, 88)}`);
  }
  if (events.length > 15) console.log(`  ... and ${events.length - 15} earlier`);
}

async function cmdTrain(args) {
  const symbol = String(args.symbol ?? args.s ?? "").toUpperCase();
  if (!symbol) throw new Error("--symbol is required");
  const algorithmName = String(args.algorithm ?? args.a ?? "news-drift");
  const days = Number(args.days ?? 365);
  const apiBase = String(args.api ?? "http://localhost:4000");

  const algorithm = await loadAlgorithm(algorithmName);
  const { bars, source, range } = await loadBars({ symbol, days, apiBase });
  console.log(`Loaded ${bars.length} bars for ${symbol} (${range}, source: ${source})`);

  const needsFeatures = Object.keys(algorithm.features ?? {}).length > 0;
  let features = {};
  if (needsFeatures) {
    console.log("Resolving features...");
    const resolved = await resolveFeatures({ algorithm, bars, symbol, mode: "backtest" });
    features = resolved.features;
    for (const entry of resolved.report) {
      console.log(
        `  ${entry.feature}: ${entry.events.placed} events placed, ` +
          `${entry.events.dropped} dropped, ${entry.events.invalid} invalid` +
          `${entry.fromCache ? " (cached)" : ""}`
      );
    }
  }

  // Grid: explicit --grid '{"key":[1,2]}' or a sensible default from params.
  let grid;
  if (args.grid) {
    grid = JSON.parse(String(args.grid));
  } else if (args.tune) {
    const keys = String(args.tune).split(",").map((s) => s.trim());
    grid = {};
    for (const key of keys) {
      const base = algorithm.params?.[key];
      if (typeof base !== "number") throw new Error(`--tune: "${key}" is not a numeric param`);
      grid[key] = [base * 0.6, base * 0.8, base, base * 1.2, base * 1.5].map((v) =>
        Number.isInteger(base) ? Math.max(1, Math.round(v)) : Number(v.toFixed(3))
      );
    }
  }

  const trainBars = Number(args.train ?? Math.max(60, Math.floor(bars.length * 0.4)));
  const testBars = Number(args.test ?? Math.max(20, Math.floor(bars.length * 0.15)));

  console.log(
    `\nWalk-forward: train=${trainBars} test=${testBars} ` +
      `grid=${grid ? expandGrid(grid).length : 1} combination(s)\n`
  );

  const result = await walkForward({
    bars,
    algorithm,
    symbol,
    features,
    grid,
    trainBars,
    testBars,
    objective: String(args.objective ?? "sharpe"),
    mode: args.anchored ? "anchored" : "rolling",
    embargoBars: Number(args.embargo ?? 0),
    fillModel: {
      slippageBps: Number(args.slippage ?? 5),
      commissionPerOrder: Number(args.commission ?? 0)
    },
    minTradesPerFold: Number(args.minTrades ?? 1)
  });

  console.log(formatReport(result));

  // Full-window single run alongside the control, for context only. This is the
  // number that is easy to fool yourself with, so it is printed last and
  // labelled as such.
  const single = runBacktest({ bars, algorithm, features, fillModel: { slippageBps: Number(args.slippage ?? 5) } });
  const control = runBuyAndHold({ bars, fillModel: { slippageBps: Number(args.slippage ?? 5) } });
  console.log("\nFull-window single run (in-sample — do NOT trust this as an estimate)");
  console.log("─".repeat(72));
  for (const key of ["returnPercent", "maxDrawdown", "sharpe", "winRate", "profitFactor", "totalCosts"]) {
    console.log(
      `  ${key.padEnd(16)} strategy ${String(formatMetric(key, single.metrics[key])).padStart(12)}` +
        `     buy&hold ${String(formatMetric(key, control.metrics[key])).padStart(12)}`
    );
  }
  console.log(`  ${"trades".padEnd(16)} strategy ${String(single.metrics.tradeCount).padStart(12)}`);

  if (args.out) {
    const outPath = path.resolve(String(args.out));
    fs.writeFileSync(outPath, JSON.stringify({ walkForward: result, singleRun: single.metrics }, null, 2));
    console.log(`\nWrote ${outPath}`);
  }
}

function cmdHelp() {
  console.log(`
stockbot-alpha — feeds, features and walk-forward validation

  status                          Which feed providers are configured
  fetch    --symbol S [--days N] [--provider alpaca-news|sec-edgar|rss]
  train    --symbol S [--algorithm news-drift] [--days N]
           [--tune p1,p2 | --grid '{"p":[1,2]}']
           [--train N] [--test N] [--embargo N] [--anchored]
           [--objective sharpe|sortino|return|calmar|returnPerDrawdown]
           [--slippage BPS] [--commission USD] [--minTrades N]
           [--api http://localhost:4000] [--out report.json]
  selftest                        Run the test suite

Env (from repo .env):
  ALPACA_API_KEY / ALPACA_API_SECRET   news feed
  SEC_USER_AGENT="App/1.0 (you@example.com)"   required for EDGAR
  RSS_FEEDS=url1,url2                  optional, live only
`);
}

// ─── Entry ──────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";

  switch (command) {
    case "status": return cmdStatus();
    case "fetch": return cmdFetch(args);
    case "train": return cmdTrain(args);
    case "selftest": {
      const { spawnSync } = await import("node:child_process");
      const files = fs
        .readdirSync(path.join(here, "test"))
        .filter((f) => f.endsWith(".test.js"))
        .map((f) => path.join(here, "test", f));
      const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
      process.exit(result.status ?? 1);
      return undefined;
    }
    default: return cmdHelp();
  }
}

main().catch((error) => {
  console.error(`\nError: ${error.message}\n`);
  process.exitCode = 1;
});
