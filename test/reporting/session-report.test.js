import assert from "node:assert/strict";
import test from "node:test";
import { buildConfigDiff, downsampleEquity, normalizeEquity, rowsToCsv } from "../../server/reporting/session-report.js";

test("equity comparison rebases each run to 100 and downsamples endpoints", () => {
  const points = Array.from({ length: 20 }, (_, index) => ({ at: index, equity: 1_000 + index * 10 }));
  assert.equal(normalizeEquity(points)[0].value, 100);
  const sampled = downsampleEquity(points, 5);
  assert.equal(sampled.length, 5);
  assert.equal(sampled[0], points[0]);
  assert.equal(sampled.at(-1), points.at(-1));
});

test("config diff includes only fields that differ", () => {
  const diff = buildConfigDiff([
    { algorithmVersionId: "v1", paramsJson: { fast: 9 }, symbolsJson: ["AAPL"], barInterval: "1day", fillModelJson: { slippageBps: 5 }, riskProfileJson: {} },
    { algorithmVersionId: "v2", paramsJson: { fast: 9 }, symbolsJson: ["AAPL"], barInterval: "1day", fillModelJson: { slippageBps: 5 }, riskProfileJson: {} }
  ]);
  assert.deepEqual(diff.map((item) => item.key), ["algorithmVersionId"]);
});

test("CSV escapes commas and quotes", () => {
  assert.equal(rowsToCsv([{ id: "1", note: 'a, "quote"' }]), 'id,note\r\n1,"a, ""quote"""\r\n');
});
