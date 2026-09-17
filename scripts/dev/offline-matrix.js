#!/usr/bin/env node
/**
 * Offline experiment harness — SYNTHETIC BARS, NOT MARKET DATA.
 *
 * Why this exists: the experiment CLI is the real thing and talks to the API, which
 * needs a market-data provider. That makes it impossible to verify the plan/run/report
 * wiring anywhere a provider is unreachable — CI, a sandbox, an aeroplane — which is
 * exactly when you most want to know whether the control group is plumbed correctly.
 *
 * So this runs the identical plan, report and verdict code against a deterministic
 * synthetic price series, through the real `runBacktest`, the real fill model and the
 * real metrics. Everything downstream of "where did the bars come from" is genuinely
 * exercised.
 *
 * The numbers it prints are meaningless as trading evidence and are labelled as such on
 * every run. What they prove is mechanical, and it is the property CONTROL_GROUP.md
 * names: a control that produces an impossible result — buy-and-hold trading twice,
 * random seeds returning identical numbers — is an engine bug, and this catches it
 * without a network.
 *
 *   node scripts/dev/offline-matrix.js [--bars 600] [--seeds 20] [--json]
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runBacktest } from "../../server/engine/backtest.js";
import { buildExperimentPlan } from "../../server/experiments/plan.js";
import { renderExperimentTable, summarizeExperiment } from "../../server/experiments/report.js";
import { runExperiment } from "../../server/experiments/runner.js";
import { loadPluginRegistry } from "../../server/plugins/registry.js";
import { parseFlags, runMain } from "../lib/cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * A seeded series with three deliberate regimes — trend up, chop, trend down — so a
 * momentum method, a mean-reversion method and a breakout method each have a stretch
 * they should do well in and a stretch they should not. A single random walk would let
 * all three look equally mediocre, which tells you nothing about whether the rules ran.
 *
 * SplitMix32 over a counter, the same mixer the controls use, so the series is identical
 * on every machine and every run.
 */
export function syntheticBars({ count = 600, seed = 20260824, startPrice = 100 } = {}) {
  let counter = seed >>> 0;
  const next = () => {
    counter = (counter + 0x9e3779b9) >>> 0;
    let mixed = counter;
    mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
    mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
    return ((mixed ^ (mixed >>> 15)) >>> 0) / 4294967296;
  };
  const gaussian = () => {
    // Box-Muller from two uniforms; cheaper alternatives here would correlate with the
    // control PRNG and could manufacture a spurious edge for the random control.
    const u1 = Math.max(1e-9, next());
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const bars = [];
  let price = startPrice;
  const start = Date.UTC(2023, 0, 3);
  for (let index = 0; index < count; index += 1) {
    const phase = index / count;
    const drift = phase < 0.4 ? 0.0011 : phase < 0.7 ? -0.0002 : -0.0008;
    const vol = phase < 0.4 ? 0.014 : phase < 0.7 ? 0.020 : 0.017;
    const open = price;
    price = Math.max(1, price * (1 + drift + vol * gaussian()));
    const close = Number(price.toFixed(4));
    const wick = Math.abs(close - open) * 0.5 + close * 0.004 * next();
    bars.push({
      time: start + index * 86_400_000,
      open: Number(open.toFixed(4)),
      high: Number((Math.max(open, close) + wick).toFixed(4)),
      low: Number(Math.max(0.01, Math.min(open, close) - wick).toFixed(4)),
      close,
      volume: Math.round(1_000_000 + next() * 4_000_000)
    });
  }
  return Object.freeze(bars);
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2), { booleans: ["json"], errorCode: "OFFLINE_MATRIX_ERROR" });
  const barCount = Math.max(120, Number(flags.bars) || 600);
  const seeds = Math.max(1, Number(flags.seeds) || 20);

  const registry = await loadPluginRegistry(path.join(ROOT, "plugins"));
  for (const error of registry.errors) {
    process.stderr.write(`plugin error — ${error.file}: ${error.message}\n`);
  }
  const methods = registry.plugins.flatMap((entry) =>
    entry.methods.map((method) => ({
      id: method.id,
      name: method.name,
      params: method.params,
      role: method.role,
      horizon: method.horizon,
      pluginId: method.pluginId,
      algorithm: method.algorithm
    }))
  );
  const byId = new Map(methods.map((method) => [method.id, method]));

  const plan = buildExperimentPlan({
    methods,
    plugins: registry.plugins,
    selection: {
      // The symbol is a label only — no provider is contacted. Named so nobody mistakes
      // this output for a real AAPL or NVDA result in a scrollback.
      symbol: "SYNTH",
      range: "1Y",
      seeds,
      strategies: ["base-methods/ema-momentum", "base-methods/rsi-mean-reversion", "base-methods/donchian-breakout"],
      controls: "auto"
    }
  });

  const bars = syntheticBars({ count: barCount });
  const execute = async (arm) => {
    const method = byId.get(arm.algorithmId);
    if (!method) throw new Error(`method not loaded: ${arm.algorithmId}`);
    const result = runBacktest({
      bars,
      algorithm: method.algorithm,
      params: arm.params,
      interval: "1day",
      fillModel: { slippageBps: 5, fixedCommission: 0, perShareCommission: 0 }
    });
    return { metrics: result.metrics, trades: result.trades.length };
  };

  process.stderr.write(`Running ${plan.arms.length} arms over ${bars.length} synthetic bars (${plan.savedRuns} duplicate runs shared)…\n`);
  const results = await runExperiment({ plan, execute, concurrency: 1 });
  const report = summarizeExperiment({ plan, results });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const banner = "═".repeat(78);
  process.stdout.write(`\n${banner}\n SYNTHETIC DATA — these numbers are not market results and are not evidence\n of anything about any real symbol. This harness verifies wiring, not edge.\n${banner}\n`);
  process.stdout.write(`${renderExperimentTable(report)}\n`);

  // The mechanical invariants CONTROL_GROUP.md calls out. A failure here is an engine
  // bug, and it should fail the command rather than print quietly.
  const problems = [];
  for (const [, entry] of results) {
    if (entry.arm.algorithmId.endsWith("buy-and-hold") && Number(entry.metrics?.tradeCount) > 1) {
      problems.push(`${entry.arm.id} made ${entry.metrics.tradeCount} trades; buy-and-hold must make exactly one.`);
    }
  }
  const randomReturns = [...results.values()]
    .filter((entry) => Object.hasOwn(entry.arm.params ?? {}, "seed") && entry.metrics)
    .map((entry) => entry.metrics.returnPercent);
  if (randomReturns.length > 1 && new Set(randomReturns).size === 1) {
    problems.push("Every random-control seed returned the same number; the seed is not reaching the PRNG.");
  }
  if (problems.length > 0) {
    process.stderr.write(`\nInvariant failures:\n${problems.map((line) => `  ✗ ${line}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(`\nInvariants held: buy-and-hold trades once, ${randomReturns.length} random seeds produced ${new Set(randomReturns).size} distinct outcomes.\n`);
  return 0;
}

runMain(main);
