#!/usr/bin/env node
/**
 * Momentum rotation from the command line, against a running Stockbot API.
 *
 *   npm run rotation -- screen   [--top 10] [--weighting inverse_vol|equal] [--json]
 *   npm run rotation -- backtest [--years 3] [--rebalance 5] [--stop 0.15] [--top 10] [--json]
 *
 * Read-only: it ranks and backtests over real provider bars and places no orders.
 * To trade the picks, create a paper session with the rotation-momentum strategy.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { cliError, createApiClient, loadEnvironment, parseFlags, runMain } from "./lib/cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `Usage:
  npm run rotation -- screen   [--top 10] [--weighting inverse_vol|equal] [--json] [--env-file PATH]
  npm run rotation -- backtest [--years 3] [--rebalance 5] [--stop 0.15] [--top 10] [--json] [--env-file PATH]`;

const pct = (value, digits = 1) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`);

function query(flags, keys) {
  const params = new URLSearchParams();
  for (const key of keys) if (flags[key] !== undefined) params.set(key, String(flags[key]));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function renderScreen(result) {
  if (!result.available) return `Rotation unavailable: ${result.reason}\n${result.errors.length} of ${result.requested} symbols returned no bars.`;
  const regime = result.regime;
  const lines = [
    `\nMomentum rotation — as of ${new Date(result.asOf).toISOString().slice(0, 10)} (${result.sources.join(", ")})`,
    `${result.scored}/${result.requested} symbols with bars, ${result.eligibleCount} passed the gates.`,
    `Regime: ${regime.benchmark} ${regime.close?.toFixed(2)} vs ${regime.window}-day mean ${regime.sma?.toFixed(2)} → ${regime.riskOn ? "RISK ON" : regime.riskOn === false ? "RISK OFF (cash)" : "unmeasured (cash)"}`,
    "",
    `${"#".padStart(3)}  ${"symbol".padEnd(7)}${"sector".padEnd(24)}${"score".padStart(7)}${"12-1m".padStart(8)}${"6m".padStart(7)}${"vol".padStart(7)}${"rsi".padStart(5)}  status`
  ];
  for (const row of result.rows.slice(0, 25)) {
    const status = row.selected ? (row.weight > 0 ? `selected ${pct(row.weight)}` : "top pick, held in cash (risk off)") : row.blockers[0] ?? row.note ?? "";
    lines.push(`${String(row.rank).padStart(3)}  ${row.symbol.padEnd(7)}${row.sector.slice(0, 23).padEnd(24)}${(row.score === null ? "—" : row.score.toFixed(2)).padStart(7)}${pct(row.mom12_1, 0).padStart(8)}${pct(row.mom6m, 0).padStart(7)}${pct(row.vol20, 0).padStart(7)}${String(row.rsi14 === null ? "—" : row.rsi14.toFixed(0)).padStart(5)}  ${status}`);
  }
  lines.push("", "Target book:");
  for (const [symbol, weight] of Object.entries(result.targets).sort((a, b) => b[1] - a[1])) lines.push(`  ${symbol.padEnd(7)}${pct(weight).padStart(7)}`);
  lines.push(`  ${"CASH".padEnd(7)}${pct(result.cashWeight).padStart(7)}`);
  if (result.errors.length) lines.push("", `${result.errors.length} symbols returned no bars and were left out (first: ${result.errors[0].symbol} — ${result.errors[0].message}).`);
  lines.push("", result.survivorshipWarning, result.caption);
  return lines.join("\n");
}

function renderBacktest(result) {
  if (!result.available) return `Backtest unavailable: ${result.reason}`;
  const day = (time) => new Date(time).toISOString().slice(0, 10);
  const methods = Object.keys(result.metrics);
  const rows = [["return %", "returnPercent"], ["max drawdown %", "maxDrawdown"], ["sharpe", "sharpe"], ["sortino", "sortino"], ["exposure %", "exposurePercent"], ["trades", "tradeCount"], ["win rate %", "winRate"]];
  const lines = [
    `\nRotation backtest ${day(result.start)} → ${day(result.end)} — rebalance every ${result.settings.rebalanceEvery} days, ${pct(result.settings.trailingStop, 0)} trailing stop, ${result.settings.fillModel.slippageBps}bps, fills at next open`,
    `${"".padEnd(16)}${methods.map((method) => method.padStart(12)).join("")}`
  ];
  for (const [label, key] of rows) {
    lines.push(`${label.padEnd(16)}${methods.map((method) => {
      const value = result.metrics[method][key];
      return (value === null || value === undefined ? "—" : Number(value).toFixed(key === "tradeCount" ? 0 : 2)).padStart(12);
    }).join("")}`);
  }
  if (result.unfilledRebalance) lines.push("", `Rebalance decided on ${day(result.unfilledRebalance.time)} is unfilled: no next open.`);
  lines.push("", result.survivorshipWarning);
  return lines.join("\n");
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2), { booleans: ["json"], errorCode: "ROTATION_USAGE" });
  const command = positional[0];
  if (flags.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command || flags.help ? 0 : 2;
  }
  if (!["screen", "backtest"].includes(command)) throw cliError(`Unknown command "${command}".\n${USAGE}`, "ROTATION_USAGE");
  const environment = await loadEnvironment(flags["env-file"], ROOT);
  const api = createApiClient(environment, { errorCode: "ROTATION_API", timeoutMs: 600_000 });
  const result = command === "screen"
    ? await api.get(`/rotation${query(flags, ["top", "weighting"])}`)
    : await api.get(`/rotation/backtest${query(flags, ["top", "weighting", "years", "rebalance", "stop"])}`);
  process.stdout.write(`${flags.json ? JSON.stringify(result, null, 2) : command === "screen" ? renderScreen(result) : renderBacktest(result)}\n`);
  return result.available ? 0 : 1;
}

runMain(main);
