import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_ALGORITHM_BYTES,
  strategyUploadFrom
} from "../../src/features/strategies/algorithmFiles.ts";

test("strategy upload accepts a portable JavaScript file", () => {
  const source = 'export default { name: "Test", signal() { return null; } };';
  assert.deepEqual(strategyUploadFrom("folder/my-strategy.js", source, source.length), {
    filename: "my-strategy.js",
    source
  });
});

test("strategy upload rejects unsafe names, empty files, and oversized files", () => {
  assert.throws(() => strategyUploadFrom("strategy.ts", "export default {};", 18), /ends in \.js/);
  assert.throws(() => strategyUploadFrom("../strategy.js", "", 0), /1–500,000 bytes/);
  assert.throws(() => strategyUploadFrom("strategy.js", "export default {};", MAX_ALGORITHM_BYTES + 1), /1–500,000 bytes/);
});
