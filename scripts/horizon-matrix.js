#!/usr/bin/env node
/**
 * Horizon matrix runner.
 *
 * Backtests every horizon-pack strategy and its congruent controls over one symbol
 * and window, then prints a comparison table grouped by horizon. It calls the loopback
 * Stockbot API with the operator token, exactly like scripts/research.js — it never
 * runs the engine itself, so results, caching, and provenance stay identical to what
 * the dashboard shows.
 *
 *   npm run horizon:matrix -- --symbol NVDA --range 1Y
 *   npm run horizon:matrix -- --symbol NVDA --range 1Y --seeds 20
 *   npm run horizon:matrix -- --symbol NVDA --range 1Y --env-file "$HOME/.config/stockbot/stockbot.env"
 *   npm run horizon:matrix -- --symbol NVDA --range 1Y --json > matrix.json
 *
 * Reading the output: a strategy row is interesting only when it beats BOTH its
 * exposure-matched fixed control and the top of its random-control distribution at
 * the same horizon. The `pctile` column is the strategy's percentile against that
 * horizon's random seeds; anything under ~90 is inside the noise.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parse as parseEnv } from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "algorithms", "horizon-pack.json");
const HORIZON_ORDER = ["daily", "weekly", "monthly", "yearly"];

function cliError(message, code = "HORIZON_CLI_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const options = { symbol: "", range: "1Y", seeds: 10, json: false, envFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") { options.json = true; continue; }
    if (token === "--help" || token === "-h") { options.help = true; continue; }
    if (!token.startsWith("--")) throw cliError(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split("=", 2);
    const value = inline ?? argv[++index];
    if (value == null || String(value).startsWith("--")) throw cliError(`--${name} requires a value.`);
    if (name === "symbol") options.symbol = String(value).trim().toUpperCase();
    else if (name === "range") options.range = String(value).trim().toUpperCase();
    else if (name === "seeds") options.seeds = Math.max(1, Math.trunc(Number(value)));
    else if (name === "env-file") options.envFile = String(value);
    else throw cliError(`Unknown flag: --${name}`);
  }
  return options;
}

async function loadEnvironment(envFile) {
  if (!envFile) {
    try {
      return { ...parseEnv(await readFile(path.resolve(ROOT, ".env"), "utf8")), ...process.env };
    } catch (error) {
      if (error?.code === "ENOENT") return process.env;
      throw cliError("The project .env file cannot be read.", "ERR_ENV_FILE_INVALID");
    }
  }
  const resolved = path.resolve(envFile);
  let metadata;
  try { metadata = await stat(resolved); }
  catch { throw cliError("The requested environment file cannot be read.", "ERR_ENV_FILE_NOT_FOUND"); }
  if (!metadata.isFile()) throw cliError("--env-file must identify a regular file.", "ERR_ENV_FILE_INVALID");
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw cliError("The environment file must have owner-only permissions (chmod 600).", "ERR_ENV_FILE_PERMISSIONS");
  }
  return { ...parseEnv(await readFile(resolved, "utf8")), ...process.env };
}

async function backtest(baseUrl, token, algorithmId, body) {
  const response = await fetch(new URL(`/api/v1/algorithms/${encodeURIComponent(algorithmId)}/backtest`, baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-stockbot-token": token
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000)
  });
  let payload;
  try { payload = await response.json(); }
  catch { throw cliError(`Stockbot API returned non-JSON HTTP ${response.status}.`, "HORIZON_API_INVALID_RESPONSE"); }
  if (!response.ok || payload?.error) {
    throw cliError(
      payload?.error?.message ?? `Stockbot API returned HTTP ${response.status}.`,
      payload?.error?.code ?? "HORIZON_API_ERROR"
    );
  }
  return payload.data;
}

function metricsOf(result) {
  // The backtest envelope carries the strategy result plus SPY/Cash benchmarks. Accept
  // either a flat metrics object or a nested strategy result so this keeps working if
  // the response envelope grows another wrapper.
  const metrics = result?.metrics ?? result?.strategy?.metrics ?? result?.result?.metrics;
  if (!metrics) throw cliError("Backtest response did not contain metrics.", "HORIZON_API_SHAPE");
  return metrics;
}

function percentile(value, distribution) {
  if (distribution.length === 0) return null;
  const below = distribution.filter((entry) => entry < value).length;
  return Math.round((below / distribution.length) * 100);
}

function fixed(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—";
}

function pad(value, width, right = false) {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help || !options.symbol) {
    process.stdout.write(
      "Usage: npm run horizon:matrix -- --symbol SYM [--range 1Y] [--seeds 10] [--json] [--env-file PATH]\n"
    );
    return options.help ? 0 : 1;
  }

  const environment = await loadEnvironment(options.envFile);
  const token = String(environment.STOCKBOT_API_TOKEN ?? "");
  if (token.length < 32) throw cliError("STOCKBOT_API_TOKEN must be configured.", "AUTH_NOT_CONFIGURED");
  const port = Number(environment.PORT || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw cliError("PORT must be 1-65535.");
  const baseUrl = `http://127.0.0.1:${port}/`;

  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const base = { symbol: options.symbol, range: options.range };
  const report = { symbol: options.symbol, range: options.range, seeds: options.seeds, horizons: {} };

  process.stderr.write(
    `Running ${manifest.pairings.length} strategies + ${HORIZON_ORDER.length} fixed controls + ${HORIZON_ORDER.length * options.seeds} random controls on ${options.symbol} (${options.range}).\n`
  );

  // Passive control is horizon-independent, so it is run once and reused.
  let passive = null;
  try {
    passive = metricsOf(await backtest(baseUrl, token, "control-buy-and-hold", base));
  } catch (cause) {
    process.stderr.write(`  buy-and-hold control failed: ${cause.message}\n`);
  }

  for (const horizon of HORIZON_ORDER) {
    const entry = { strategies: [], fixedControl: null, randomDistribution: [] };

    try {
      entry.fixedControl = metricsOf(await backtest(baseUrl, token, "control-horizon-fixed", {
        ...base,
        params: { horizon }
      }));
    } catch (cause) {
      process.stderr.write(`  ${horizon} fixed control failed: ${cause.message}\n`);
    }

    for (let seed = 1; seed <= options.seeds; seed += 1) {
      try {
        const metrics = metricsOf(await backtest(baseUrl, token, "control-horizon-random", {
          ...base,
          params: { horizon, seed }
        }));
        entry.randomDistribution.push(Number(metrics.returnPercent));
      } catch (cause) {
        process.stderr.write(`  ${horizon} random seed ${seed} failed: ${cause.message}\n`);
      }
    }

    for (const pairing of manifest.pairings.filter((item) => item.horizon === horizon)) {
      const algorithmId = pairing.strategy.replace(/\.js$/, "");
      try {
        const metrics = metricsOf(await backtest(baseUrl, token, algorithmId, base));
        entry.strategies.push({ id: algorithmId, method: pairing.method, metrics });
      } catch (cause) {
        process.stderr.write(`  ${algorithmId} failed: ${cause.message}\n`);
      }
    }

    report.horizons[horizon] = entry;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, passive }, null, 2)}\n`);
    return 0;
  }

  const head = `${pad("method", 26)}${pad("return%", 10, true)}${pad("sharpe", 9, true)}${pad("maxDD%", 9, true)}${pad("expo%", 8, true)}${pad("trades", 8, true)}${pad("pctile", 8, true)}`;
  process.stdout.write(`\nHorizon matrix — ${options.symbol} over ${options.range}\n`);
  if (passive) {
    process.stdout.write(
      `Passive buy-and-hold: return ${fixed(passive.returnPercent)}%  sharpe ${fixed(passive.sharpe)}  maxDD ${fixed(passive.maxDrawdown)}%\n`
    );
  }

  for (const horizon of HORIZON_ORDER) {
    const entry = report.horizons[horizon];
    const distribution = entry.randomDistribution;
    const sorted = [...distribution].sort((a, b) => a - b);
    process.stdout.write(`\n── ${horizon} (~${manifest.horizons[horizon].targetHoldBars} bars held) ${"─".repeat(Math.max(0, 44 - horizon.length))}\n`);
    process.stdout.write(`${head}\n`);

    for (const strategy of entry.strategies) {
      const metrics = strategy.metrics;
      process.stdout.write(
        pad(strategy.method, 26) +
        pad(fixed(metrics.returnPercent), 10, true) +
        pad(fixed(metrics.sharpe), 9, true) +
        pad(fixed(metrics.maxDrawdown), 9, true) +
        pad(fixed(metrics.exposurePercent, 1), 8, true) +
        pad(metrics.tradeCount ?? "—", 8, true) +
        pad(percentile(Number(metrics.returnPercent), distribution) ?? "—", 8, true) +
        "\n"
      );
    }

    if (entry.fixedControl) {
      const metrics = entry.fixedControl;
      process.stdout.write(
        pad("· control fixed", 26) +
        pad(fixed(metrics.returnPercent), 10, true) +
        pad(fixed(metrics.sharpe), 9, true) +
        pad(fixed(metrics.maxDrawdown), 9, true) +
        pad(fixed(metrics.exposurePercent, 1), 8, true) +
        pad(metrics.tradeCount ?? "—", 8, true) +
        pad("—", 8, true) +
        "\n"
      );
    }
    if (sorted.length > 0) {
      const median = sorted[Math.floor(sorted.length / 2)];
      process.stdout.write(
        `${pad("· control random", 26)}${pad(fixed(median), 10, true)}${pad("—", 9, true)}${pad("—", 9, true)}${pad("—", 8, true)}${pad("—", 8, true)}${pad("median", 8, true)}\n`
      );
      process.stdout.write(
        `${pad("", 26)}${pad(`${fixed(sorted[0])} … ${fixed(sorted.at(-1))}`, 34, true)}   range over ${sorted.length} seeds\n`
      );
    }
  }

  process.stdout.write(
    "\nA row is interesting only if it beats its own horizon's fixed control AND sits above\nthe top of that horizon's random range. Percentile under ~90 is inside the noise.\n"
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.code ? `${error.code}: ` : ""}${error?.message ?? error}\n`);
    process.exit(1);
  }
);
