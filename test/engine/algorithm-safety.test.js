import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hashAlgorithmSource,
  installAlgorithmAtomically,
  normalizeAlgorithmFilename
} from "../../server/algorithms/registry.js";
import {
  AlgorithmValidationError,
  validateAlgorithm,
  validateAlgorithmSource
} from "../../server/algorithms/validator.js";
import { EnginePool } from "../../server/engine/pool.js";
import { deterministicBars } from "./fixtures/bars.js";

const safeSource = `
// The words process and import in comments are documentation, not capabilities.
export default {
  name: "Safe fixture",
  description: "Processes closed bars without imports.",
  params: { threshold: 2 },
  signal({ index }) { return index === 1 ? "buy" : null; }
};
`;

test("static validation accepts bundled-style modules and ignores literals/comments", () => {
  assert.equal(validateAlgorithmSource(safeSource).ok, true);
  assert.equal(
    validateAlgorithm({ name: "Safe", params: {}, signal() {} }).name,
    "Safe"
  );
});

test("static validation rejects privileged identifiers before module execution", () => {
  const cases = [
    ['import fs from "node:fs";', "import"],
    ["const fs = require('node:fs');", "require"],
    ["const secret = process.env.KEY;", "process"],
    ["const root = globalThis;", "globalThis"],
    ["eval('1 + 1');", "eval"],
    ["const Ctor = Function;", "Function"],
    ["const secret = `${process.env.KEY}`;", "process"]
  ];
  for (const [body, identifier] of cases) {
    assert.throws(
      () => validateAlgorithmSource(`${body}\nexport default { name: "Bad", signal() {} };`, { file: "bad.js" }),
      (error) =>
        error instanceof AlgorithmValidationError &&
        error.code === "ALGORITHM_FORBIDDEN_CAPABILITY" &&
        error.identifier === identifier,
      identifier
    );
  }
});

test("atomic upload normalizes collisions, preserves the old file on rejection, and returns hashes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stockbot-algorithms-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(normalizeAlgorithmFilename("my strategy.js"), "my-strategy.js");
  const installed = await installAlgorithmAtomically({
    uploadsDir: directory,
    filename: "my strategy.js",
    source: safeSource
  });
  assert.equal(installed.sourceHash, hashAlgorithmSource(safeSource));
  assert.equal(installed.versionHash, installed.sourceHash);
  assert.equal(await readFile(installed.path, "utf8"), safeSource);

  await assert.rejects(
    installAlgorithmAtomically({ uploadsDir: directory, filename: "my/strategy.js", source: safeSource }),
    (error) => error.code === "ALGORITHM_EXISTS"
  );

  const forbiddenReplacement = `export default { name: "Bad", signal() { return process.env.KEY; } };`;
  await assert.rejects(
    installAlgorithmAtomically({
      uploadsDir: directory,
      filename: "my strategy.js",
      source: forbiddenReplacement,
      overwrite: true
    }),
    (error) => error.code === "ALGORITHM_FORBIDDEN_CAPABILITY"
  );
  assert.equal(await readFile(installed.path, "utf8"), safeSource);

  const invalidShape = `export default { name: "Missing signal" };`;
  await assert.rejects(
    installAlgorithmAtomically({
      uploadsDir: directory,
      filename: "my strategy.js",
      source: invalidShape,
      overwrite: true
    }),
    (error) => error.code === "ALGORITHM_INVALID"
  );
  assert.equal(await readFile(installed.path, "utf8"), safeSource);

  const replacement = safeSource.replace("Safe fixture", "Safe fixture v2");
  const overwritten = await installAlgorithmAtomically({
    uploadsDir: directory,
    filename: "my strategy.js",
    source: replacement,
    overwrite: true
  });
  assert.equal(overwritten.overwritten, true);
  assert.equal(overwritten.previousHash, installed.sourceHash);
  assert.equal(await readFile(installed.path, "utf8"), replacement);
});

test("worker pool validates and runs source with resource limits", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  assert.equal(pool.resourceLimits.maxOldGenerationSizeMb, 64);

  const validation = await pool.validateAlgorithm({ algorithmSource: safeSource, filename: "safe.js" });
  assert.equal(validation.ok, true);
  assert.equal(validation.name, "Safe fixture");
  assert.equal(validation.sourceHash, hashAlgorithmSource(safeSource));

  const result = await pool.runBacktest({
    algorithmSource: safeSource,
    filename: "safe.js",
    bars: deterministicBars.slice(0, 5),
    interval: "1day",
    startingCash: 1_000
  });
  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].signalIndex, 1);
  assert.equal(result.trades[0].fillIndex, 2);
});

test("isolated paper signal evaluation round-trips deterministic algorithm state", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const stateful = `
    export default {
      name: "Stateful",
      init() { return { ticks: 0 }; },
      signal({ state }) {
        state.ticks += 1;
        return state.ticks === 2 ? "buy" : null;
      }
    };
  `;
  const first = await pool.evaluateSignal({
    algorithmSource: stateful,
    bars: deterministicBars.slice(0, 3),
    position: { qty: 0 }
  });
  assert.equal(first.signal, null);
  assert.deepEqual(first.state, { ticks: 1 });
  const second = await pool.evaluateSignal({
    algorithmSource: stateful,
    bars: deterministicBars.slice(0, 4),
    position: { qty: 0 },
    state: first.state
  });
  assert.equal(second.signal.action, "buy");
  assert.deepEqual(second.state, { ticks: 2 });
});

test("worker timeout terminates a runaway strategy and the pool recovers", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const runaway = `
    export default {
      name: "Runaway",
      signal() { while (true) {} }
    };
  `;

  await assert.rejects(
    pool.runBacktest(
      {
        algorithmSource: runaway,
        filename: "runaway.js",
        bars: deterministicBars.slice(0, 5),
        interval: "1day"
      },
      { timeoutMs: 250 }
    ),
    (error) => error.code === "ENGINE_TIMEOUT"
  );

  const recovered = await pool.validateAlgorithm(
    { algorithmSource: safeSource, filename: "safe-after-timeout.js" },
    { timeoutMs: 2_000 }
  );
  assert.equal(recovered.ok, true);
});

test("worker VM disables string code generation used to escape through constructors", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const constructorEscape = `
    export default {
      name: "Constructor escape",
      signal() {
        this.constructor.constructor("return process")();
        return null;
      }
    };
  `;
  await assert.rejects(
    pool.runBacktest({
      algorithmSource: constructorEscape,
      filename: "constructor-escape.js",
      bars: deterministicBars.slice(0, 3),
      interval: "1day"
    }),
    (error) => error.name === "EvalError" || /code generation/i.test(error.message)
  );
});
