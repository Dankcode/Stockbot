#!/usr/bin/env node
/**
 * Experiment runner — a strategy and its control group, on any symbol, from one command.
 *
 * This is the executable form of docs/CONTROL_GROUP.md. Where `horizon:matrix` runs one
 * hard-coded pack against hard-coded controls, this resolves whatever you name, on
 * whatever symbol you name, against either the controls the plugin declares (automated)
 * or the controls you pick (manual), and reports a verdict rather than a table you have
 * to interpret.
 *
 *   # manual: you choose the strategy and the comparison
 *   npm run experiment -- run --symbol NVDA --strategy base-methods/ema-momentum \
 *     --control core-controls/buy-and-hold --control core-controls/random-entry --seeds 20
 *
 *   # automated: controls come from the plugin's own pairings block
 *   npm run experiment -- run --symbol NVDA --strategy base-methods/ema-momentum
 *
 *   # every strategy the installed plugins provide, on one symbol
 *   npm run experiment -- run --symbol NVDA --all-strategies
 *
 *   # let the selector pick the symbol, then run the experiment on it
 *   npm run experiment -- run --auto --strategy base-methods/rsi-mean-reversion
 *
 *   # ranking only, no backtests
 *   npm run experiment -- select --limit 5
 *
 *   # materialise the arms as draft paper sessions you can start from the dashboard
 *   npm run experiment -- sessions --symbol NVDA --strategy base-methods/ema-momentum
 *
 * Like every other Stockbot CLI, this talks to the loopback API with the operator token
 * and never runs the engine itself, so results, caching and provenance are identical to
 * what the dashboard shows.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildExperimentPlan, indexMethods, indexPairings } from "../server/experiments/plan.js";
import { renderExperimentTable, summarizeExperiment } from "../server/experiments/report.js";
import { createApiExecutor, runExperiment } from "../server/experiments/runner.js";
import { recommendSymbols, renderRecommendations } from "../server/experiments/selection.js";
import { cliError, createApiClient, listFlag, loadEnvironment, parseFlags, runMain } from "./lib/cli.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ERROR_CODE = "EXPERIMENT_CLI_ERROR";

const USAGE = `Usage:
  npm run experiment -- run      --symbol SYM (--strategy ID... | --all-strategies [--plugin ID...])
                                 [--control ID...] [--seeds N] [--range 1Y]
                                 [--concurrency 4] [--json]
  npm run experiment -- run      --auto [--universe SYM,SYM] (--strategy ID... | --all-strategies) [...]
  npm run experiment -- plan     --symbol SYM --strategy ID... [--json]     (resolve arms, run nothing)
  npm run experiment -- select   [--universe SYM,SYM] [--limit 5] [--range 1Y] [--json]
  npm run experiment -- sessions --symbol SYM --strategy ID... [--name NAME] [--mode paper|backtest]
  npm run experiment -- methods  [--json]                                   (what is installed)

Common flags: --env-file PATH, --json, --help
`;

/**
 * Pairings live in the plugin files, which the API does not expose. Reading them off
 * disk is safe here — this CLI already runs from the project root with the operator's
 * own permissions — and it keeps the automated path working without a new endpoint.
 * `phase 2` in docs/plan/06 moves this behind /api/v1/experiments so the dashboard can
 * resolve pairings too.
 */
async function loadPairingsFromDisk() {
  const pluginsDir = path.join(ROOT, "plugins");
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".plugin.json")) continue;
    try {
      const raw = JSON.parse(await readFile(path.join(pluginsDir, entry.name), "utf8"));
      plugins.push({ plugin: { id: raw.id }, pairings: raw.pairings ?? [] });
    } catch {
      // A malformed plugin is the plugin loader's problem to report, not this CLI's.
    }
  }
  return plugins;
}

/**
 * The API is the source of truth for `role` — `publicAlgorithm` resolves it from the
 * plugin's declaration, falling back to the `control-` filename convention for
 * hand-written .js algorithms.
 *
 * The local fallback here exists only for an older server that predates that field, and
 * it is deliberately loud rather than silent: before the API exposed role, every plugin
 * control came back looking like a strategy, `--all-strategies` swept the entire control
 * group into treatment arms, and the role guard in plan.js never fired. A default that
 * quietly guesses "strategy" is worse than no guard at all, so an unlabelled method is
 * reported instead of assumed.
 */
function methodsFromApi(payload) {
  const algorithms = payload?.algorithms ?? payload ?? [];
  const unlabelled = [];
  const methods = algorithms.map((algorithm) => {
    if (typeof algorithm.role === "string") return algorithm;
    unlabelled.push(algorithm.id);
    return { ...algorithm, role: /(^|\/)control-/.test(algorithm.id) ? "control" : "strategy" };
  });
  if (unlabelled.length > 0) {
    process.stderr.write(
      `Warning: the API returned no role for ${unlabelled.length} method(s); ` +
      "falling back to the filename convention. Update the server so controls cannot be " +
      "mistaken for strategies.\n"
    );
  }
  return methods;
}

function requireSymbol(flags) {
  const symbol = String(flags.symbol ?? "").trim().toUpperCase();
  if (!symbol) throw cliError("--symbol is required.", ERROR_CODE);
  return symbol;
}

async function resolveSelection({ flags, methods, pairings, api }) {
  const index = indexMethods(methods);
  let strategies = listFlag(flags.strategy);
  const explicitControls = listFlag(flags.control);

  if (flags["all-strategies"]) {
    const plugins = new Set(listFlag(flags.plugin));
    const candidates = [...index.values()].filter((method) =>
      method.role === "strategy" && (plugins.size === 0 || plugins.has(method.pluginId))
    );
    if (candidates.length === 0) {
      throw cliError(
        plugins.size > 0
          ? `No strategy-role methods belong to: ${[...plugins].join(", ")}.`
          : "No strategy-role methods are installed.",
        ERROR_CODE
      );
    }
    // A sweep means "everything you can measure properly", not "everything or nothing".
    // The hand-written .js algorithms in algorithms/ declare no pairings, so including
    // them aborted the entire plan on the first one. Skipping them is reported, never
    // silent — an unmeasurable strategy is information, and dropping it quietly would
    // let a sweep look complete when it covered half the repo.
    const withControls = explicitControls.length > 0
      ? candidates
      : candidates.filter((method) => pairings.has(method.id));
    const skipped = candidates.length - withControls.length;
    if (withControls.length === 0) {
      throw cliError(
        `None of the ${candidates.length} installed strategies declare a control pairing. ` +
        "Pass --control to choose the comparison yourself.",
        "EXPERIMENT_CONTROLS_MISSING"
      );
    }
    if (skipped > 0) {
      process.stderr.write(
        `Skipping ${skipped} strategy method(s) with no declared control pairing ` +
        "(pass --control to include them). Sweeping the remaining " +
        `${withControls.length}.\n`
      );
    }
    strategies = withControls.map((method) => method.id);
  }

  if (strategies.length === 0) {
    throw cliError("Name at least one --strategy, or pass --all-strategies.", ERROR_CODE);
  }

  let symbol;
  let selectionReport = null;
  if (flags.auto) {
    const universe = listFlag(flags.universe);
    selectionReport = await selectSymbols({ api, flags, universe, limit: 1 });
    const best = selectionReport.recommended[0];
    if (!best) throw cliError("The selector found no symbol that passed its gates.", "EXPERIMENT_NO_CANDIDATE");
    symbol = best.symbol;
  } else {
    symbol = requireSymbol(flags);
  }

  return {
    selectionReport,
    selection: {
      symbol,
      range: String(flags.range ?? "1Y").toUpperCase(),
      strategies,
      controls: explicitControls.length > 0 ? explicitControls : "auto",
      seeds: flags.seeds == null ? null : Number(flags.seeds)
    },
    index,
    pairings
  };
}

async function selectSymbols({ api, flags, universe, limit }) {
  let symbols = universe;
  if (symbols.length === 0) {
    // No universe given: rank the catalogue the market service already knows about.
    const assets = await api.get("/market/search?q=&limit=50");
    symbols = (assets ?? []).map((asset) => asset.symbol).filter(Boolean);
  }
  if (symbols.length === 0) throw cliError("No candidate symbols to rank.", "EXPERIMENT_NO_CANDIDATE");
  return recommendSymbols({
    universe: symbols,
    range: String(flags.range ?? "1Y").toUpperCase(),
    limit: limit ?? Math.max(1, Number(flags.limit) || 5),
    getBars: async (symbol, range) => api.get(`/market/bars/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}`)
    // getResearch is intentionally omitted until the operator has registered sources in
    // RESEARCH_WEB_SOURCES_JSON. Wiring it unconditionally would make every selection
    // run fail closed on an unconfigured install; see docs/plan/06 phase 4.
  });
}

async function commandSelect({ api, flags }) {
  const result = await selectSymbols({ api, flags, universe: listFlag(flags.universe) });
  process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderRecommendations(result)}\n`);
  return 0;
}

async function commandMethods({ api, flags }) {
  const methods = methodsFromApi(await api.get("/algorithms"));
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(methods, null, 2)}\n`);
    return 0;
  }
  const pairings = indexPairings(await loadPairingsFromDisk());
  process.stdout.write(`\n${methods.length} methods installed\n\n`);
  for (const method of methods.filter((entry) => entry.role === "strategy")) {
    const pairing = pairings.get(method.id);
    process.stdout.write(`  ${method.id.padEnd(38)} strategy   ${pairing ? `${pairing.controls.length} declared controls, ${pairing.seeds ?? 10} seeds` : "no pairing — controls must be named manually"}\n`);
  }
  for (const method of methods.filter((entry) => entry.role !== "strategy")) {
    process.stdout.write(`  ${method.id.padEnd(38)} ${String(method.role).padEnd(10)} ${method.plugin?.controlFor ?? ""}\n`);
  }
  return 0;
}

async function commandPlan({ api, flags }) {
  const methods = methodsFromApi(await api.get("/algorithms"));
  const pairings = indexPairings(await loadPairingsFromDisk());
  const { selection, selectionReport } = await resolveSelection({ flags, methods, pairings, api });
  const plan = buildExperimentPlan({ methods, plugins: pairings, selection });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ plan, selectionReport }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`\nExperiment plan — ${plan.symbol} over ${plan.range}\n`);
  process.stdout.write(`${plan.arms.length} arms to execute (${plan.savedRuns} duplicate runs shared between groups)\n`);
  for (const group of plan.groups) {
    process.stdout.write(`\n  ${group.strategy.id}  (controls: ${group.controlSource}, ${group.seeds} seeds)\n`);
    if (group.notes) process.stdout.write(`    note: ${group.notes}\n`);
    for (const control of group.controls) process.stdout.write(`    · ${control.id}\n`);
  }
  return 0;
}

async function commandRun({ api, flags }) {
  const methods = methodsFromApi(await api.get("/algorithms"));
  const pairings = indexPairings(await loadPairingsFromDisk());
  const { selection, selectionReport } = await resolveSelection({ flags, methods, pairings, api });
  const plan = buildExperimentPlan({ methods, plugins: pairings, selection });

  if (selectionReport) {
    const best = selectionReport.recommended[0];
    process.stderr.write(`Selector chose ${best.symbol} (score ${best.score.toFixed(3)}): ${best.reasons[0]}\n`);
    if (selectionReport.separation !== null && selectionReport.separation < 0.05) {
      process.stderr.write("  Warning: the top two candidates were effectively tied.\n");
    }
  }
  process.stderr.write(`Running ${plan.arms.length} arms on ${plan.symbol} (${plan.range})…\n`);

  const execute = createApiExecutor({ baseUrl: api.baseUrl, token: api.token });
  const results = await runExperiment({
    plan,
    execute,
    concurrency: Number(flags.concurrency) || 4,
    onProgress: ({ completed, total, arm, ok }) => {
      if (!flags.json) process.stderr.write(`  [${String(completed).padStart(3)}/${total}] ${ok ? "ok  " : "FAIL"} ${arm.id}\n`);
    }
  });

  const report = summarizeExperiment({ plan, results });
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ report, selectionReport }, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderExperimentTable(report)}\n`);
  }
  // A run where nothing cleared its controls is a successful experiment, not a failed
  // command, so this exits 0. Only an execution failure is a non-zero exit.
  return report.executedCount === 0 ? 1 : 0;
}

/**
 * Materialises a durable experiment cohort. The service creates sibling draft sessions
 * under one experiment id while preserving the one-session-one-algorithm-version rule.
 */
async function commandSessions({ api, flags }) {
  const methods = methodsFromApi(await api.get("/algorithms"));
  const pairings = indexPairings(await loadPairingsFromDisk());
  const { selection } = await resolveSelection({ flags, methods, pairings, api });
  const plan = buildExperimentPlan({ methods, plugins: pairings, selection });
  const mode = String(flags.mode ?? "paper");
  if (!["paper", "backtest"].includes(mode)) throw cliError("--mode must be paper or backtest.", ERROR_CODE);
  const label = String(flags.name ?? `exp-${plan.symbol}-${new Date(plan.createdAt).toISOString().slice(0, 10)}`);

  /**
   * Every arm of one experiment must experience the same fill costs, or the comparison
   * measures slippage rather than skill. The session schema defaults `fillModel` to zero
   * slippage while `/algorithms/:id/backtest` defaults to 5 bps, so leaving this unset
   * produced a cohort whose paper arms traded free and whose backtest arms did not.
   */
  const fillModel = {
    slippageBps: 5,
    fixedCommission: 0,
    perShareCommission: 0,
    ...(plan.fillModel ?? {})
  };

  const createdExperiment = await api.post("/experiments", {
    name: label,
    mode,
    plan,
    barInterval: "1day",
    fillModel
  });
  const created = createdExperiment.sessions.map((session) => ({
    id: session.id,
    name: session.name,
    arm: session.experimentArmId,
    kind: session.experimentArm
  }));
  for (const session of created) process.stderr.write(`  created ${session.id}  ${session.arm}\n`);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ experiment: createdExperiment.experiment, sessions: created }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`\nExperiment ${createdExperiment.experiment.id}: ${created.length} draft sessions created under "${label}".\n`);
  process.stdout.write(`All arms use the same fill model: ${fillModel.slippageBps} bps slippage.\n`);
  process.stdout.write("They are drafts: nothing trades until each is started from the dashboard or POST /sessions/:id/start.\n");
  // SessionComparePage caps at four. Lead with the strategy arms so a cohort with more
  // than three controls does not hand back a compare link containing no treatment arm.
  const forCompare = [...created].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "strategy" ? -1 : 1));
  process.stdout.write(`Compare them at /sessions/compare?ids=${forCompare.slice(0, 4).map((entry) => entry.id).join(",")}\n`);
  return 0;
}

const COMMANDS = Object.freeze({
  run: commandRun,
  plan: commandPlan,
  select: commandSelect,
  sessions: commandSessions,
  methods: commandMethods
});

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2), {
    booleans: ["json", "auto", "all-strategies"],
    repeatable: ["strategy", "control", "universe", "plugin"],
    errorCode: ERROR_CODE
  });
  const command = positional[0];

  if (flags.help || !command) {
    process.stdout.write(USAGE);
    return flags.help ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) throw cliError(`Unknown subcommand: ${command}\n\n${USAGE}`, ERROR_CODE);

  const environment = await loadEnvironment(flags["env-file"], ROOT);
  const api = createApiClient(environment, { errorCode: "EXPERIMENT_API_ERROR" });
  return handler({ api, flags, environment });
}

runMain(main);
