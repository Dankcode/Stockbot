import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadAlgorithmRegistry } from "../../server/algorithms/registry.js";
import {
  decodePluginMethodSource,
  PLUGIN_METHOD_SOURCE_PREFIX
} from "../../server/plugins/algorithm-source.js";
import { loadPluginFile } from "../../server/plugins/registry.js";
import { EnginePool } from "../../server/engine/pool.js";
import { deterministicBars } from "../engine/fixtures/bars.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS_DIR = path.join(ROOT, "plugins");

test("random plugin paper state survives consecutive worker round trips", async (t) => {
  const loaded = await loadAlgorithmRegistry({ algorithmsDir: path.join(ROOT, "algorithms"), pluginsDir: PLUGINS_DIR });
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  for (const id of ["core-controls/random-entry", "horizon-pack/horizon-random"]) {
    const method = loaded.algorithms.find((algorithm) => algorithm.id === id);
    assert.ok(method, id);
    const first = await pool.evaluateSignal({ algorithmSource: method.source, bars: deterministicBars.slice(0, 40) });
    const second = await pool.evaluateSignal({ algorithmSource: method.source, bars: deterministicBars.slice(0, 41), state: first.state });
    assert.notEqual(first.state.__plugin.prng.counter, second.state.__plugin.prng.counter);
    const replay = await pool.evaluateSignal({ algorithmSource: method.source, bars: deterministicBars.slice(0, 41), state: first.state });
    assert.deepEqual(second, replay);
  }
});

test("plugin methods load into the live registry as durable sources executed inside the engine worker", async (t) => {
  const loaded = await loadAlgorithmRegistry({
    algorithmsDir: path.join(ROOT, "algorithms"),
    pluginsDir: PLUGINS_DIR
  });
  assert.deepEqual(loaded.errors, []);
  const method = loaded.algorithms.find((algorithm) => algorithm.id === "core-controls/buy-and-hold");
  assert.ok(method);
  assert.equal(method.source.startsWith(PLUGIN_METHOD_SOURCE_PREFIX), true);
  assert.equal(method.sourceHash, method.versionHash);
  assert.equal(decodePluginMethodSource(method.source).id, method.id);

  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const validation = await pool.validateAlgorithm({ algorithmSource: method.source, filename: method.file });
  assert.equal(validation.name, method.name);
  const result = await pool.runBacktest({
    algorithmSource: method.source,
    filename: method.file,
    bars: deterministicBars.slice(0, 8),
    interval: "1day",
    startingCash: 1_000
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].side, "buy");
  assert.equal(result.trades[0].fillIndex, 2);
});

test("plugin research compiles its registered template and typed slots into the plan", async () => {
  const entry = await loadPluginFile(path.join(PLUGINS_DIR, "gov-research.plugin.json"));
  const compiled = entry.research.find((candidate) => candidate.plan.id === "gov-research.edgar");
  const step = compiled.plan.steps.find((candidate) => candidate.id === "edgar-summary");
  assert.deepEqual(
    { promptTemplate: step.promptTemplate, promptSlots: step.promptSlots },
    {
      promptTemplate: "catalyst-summary.v1",
      promptSlots: {
        focus: ["material agreements", "insider transactions", "guidance changes"],
        emphasis: "drivers",
        horizon: "monthly"
      }
    }
  );
  assert.equal(compiled.prompts[step.id].prompt.id, "catalyst-summary.v1");
});
