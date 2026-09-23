import assert from "node:assert/strict";
import test from "node:test";

import { createSelectionService } from "../../server/selection/service.js";

const bars = Array.from({ length: 140 }, (_, index) => {
  const close = 100 + index * 0.4;
  return { time: index * 86_400_000, open: close - 1, high: close + 2, low: close - 2, close, volume: 7_000_000 };
});

test("selection returns tradeability scores and preserves the forward-test-only universe guard", async () => {
  const marked = [];
  const service = createSelectionService({
    market: {
      selectionUniverse: async () => ({
        symbols: ["MEGA"], source: "alpaca-most-actives", forwardTestOnly: true, fallback: false,
        survivorshipWarning: "Live screen universes omit delisted names."
      }),
      markForwardTestOnly: (symbols) => marked.push(...symbols),
      getBars: async () => ({ bars })
    }
  });
  const result = await service.recommend({ range: "3M" });
  assert.equal(result.universe.forwardTestOnly, true);
  assert.equal(result.recommended[0].forwardTestOnly, true);
  assert.ok(result.recommended[0].board.score !== null);
  assert.equal(result.recommended[0].board.reasons.length > 0, true);
  assert.deepEqual(marked, ["MEGA"]);
});
