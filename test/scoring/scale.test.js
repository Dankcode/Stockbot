import assert from "node:assert/strict";
import test from "node:test";

import { applyNineGate, band, ramp, weightedScore } from "../../server/scoring/scale.js";

test("shared scale preserves the selection ramps and excludes null components from the denominator", () => {
  assert.equal(ramp(null, 0, 1), null);
  assert.equal(band(2.75, 2.75, 2.6), 1);
  assert.equal(band(9, 2.75, 2.6), 0);
  const weighted = weightedScore({ strong: 1, missing: null }, { strong: 0.4, missing: 0.6 });
  assert.equal(weighted.score, 1, "null must not quietly become a zero-valued component");
  assert.deepEqual(weighted.unmeasured, ["missing"]);
});

test("the nine gate prevents unreplicated scores from reaching the replicated band", () => {
  assert.equal(applyNineGate(9.5, { replicated: false }), 8);
  assert.equal(applyNineGate(9.5, { replicated: true }), 9.5);
});
