import assert from "node:assert/strict";
import test from "node:test";

import { runBacktest } from "../../server/engine/backtest.js";
import { EnginePool } from "../../server/engine/pool.js";
import {
  normalizeResearchTimeline,
  researchTimelineHash,
  selectResearchFrame
} from "../../server/research/timeline.js";

const bars = Object.freeze([
  { time: 1_000, open: 10, high: 11, low: 9, close: 10, volume: 100 },
  { time: 2_000, open: 12, high: 13, low: 11, close: 12, volume: 110 },
  { time: 3_000, open: 15, high: 16, low: 14, close: 15, volume: 120 },
  { time: 4_000, open: 18, high: 19, low: 17, close: 18, volume: 130 }
]);

function researchSnapshot({
  id = "snapshot-a",
  symbol = "AAPL",
  availableAt = 2_000,
  asOf = availableAt,
  expiresAt = null,
  sentiment = "mixed"
} = {}) {
  return {
    id,
    runId: `run-${id}`,
    planId: "plan-fixture",
    planVersionId: "plan-fixture-v1",
    schemaVersion: 1,
    symbol,
    asOf,
    availableAt,
    expiresAt,
    summary: {
      overview: "Validated point-in-time fixture.",
      keyDrivers: ["Demand"],
      risks: ["Competition"],
      opportunities: ["Expansion"],
      sentiment,
      confidence: 0.8
    },
    sources: [{
      stepId: "source-step",
      sourceId: "source-fixture",
      url: "https://example.com/research",
      title: null,
      fetchedAt: availableAt,
      publishedAt: null,
      contentType: "text/plain",
      contentHash: "a".repeat(64)
    }],
    sourceBundleHash: "b".repeat(64),
    aiInputHash: "e".repeat(64),
    summarizerConfigHash: "f".repeat(64),
    inputDocuments: [{
      stepId: "source-step",
      sourceId: "source-fixture",
      contentHash: "a".repeat(64),
      sourceBytes: 10,
      includedBytes: 10,
      truncated: false
    }],
    promptHash: "c".repeat(64),
    model: "fixture-model",
    contentHash: "d".repeat(64)
  };
}

test("research selection hides future, expired, and cross-symbol snapshots", () => {
  const eligibleA = researchSnapshot({ id: "eligible-a", availableAt: 2_000 });
  const eligibleB = researchSnapshot({ id: "eligible-b", availableAt: 2_000 });
  const future = researchSnapshot({ id: "future", availableAt: 3_001 });
  const expired = researchSnapshot({ id: "expired", availableAt: 1_000, expiresAt: 3_000 });
  const otherSymbol = researchSnapshot({ id: "other-symbol", symbol: "MSFT", availableAt: 3_000 });
  const timeline = normalizeResearchTimeline([future, eligibleA, expired, otherSymbol, eligibleB]);

  const frame = selectResearchFrame({ timeline, symbol: "AAPL", decisionAt: 3_000 });
  assert.equal(frame.status, "available");
  assert.equal(frame.snapshot.id, "eligible-b", "latest id wins an availableAt tie");
  assert.equal(frame.decisionAt, 3_000);
  assert.equal(Object.isFrozen(timeline), true);
  assert.equal(Object.isFrozen(timeline[0]), true);

  const unavailable = selectResearchFrame({
    timeline: [future, expired, otherSymbol],
    symbol: "AAPL",
    decisionAt: 3_000
  });
  assert.deepEqual(unavailable, {
    status: "unavailable",
    symbol: "AAPL",
    decisionAt: 3_000,
    reason: "no_eligible_snapshot"
  });
});

test("research availability is inclusive while expiry is exclusive at decisionAt", () => {
  const exact = researchSnapshot({ id: "exact", availableAt: 2_000, expiresAt: 3_000 });
  assert.equal(
    selectResearchFrame({ timeline: [exact], symbol: "AAPL", decisionAt: 2_000 }).status,
    "available"
  );
  assert.equal(
    selectResearchFrame({ timeline: [exact], symbol: "AAPL", decisionAt: 3_000 }).status,
    "unavailable"
  );
  assert.equal(
    researchTimelineHash([exact]),
    researchTimelineHash(normalizeResearchTimeline([exact]))
  );
});

test("worker validates and recursively freezes the research frame", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const frozenFrame = selectResearchFrame({
    timeline: [researchSnapshot()],
    symbol: "AAPL",
    decisionAt: 2_000
  });
  const mutableFrame = structuredClone(frozenFrame);
  assert.equal(Object.isFrozen(mutableFrame.snapshot.summary), false);

  const algorithmSource = `
    export default {
      name: "Research freeze probe",
      init({ research }) {
        if (research !== null) throw new Error("init received future research");
        return {};
      },
      signal({ research }) {
        const frozen = [
          research,
          research.snapshot,
          research.snapshot.summary,
          research.snapshot.sources,
          research.snapshot.sources[0]
        ].every(Object.isFrozen);
        let mutationBlocked = false;
        try { research.snapshot.summary.overview = "mutated"; }
        catch { mutationBlocked = true; }
        return frozen && mutationBlocked
          ? { action: "buy", reason: "deeply frozen" }
          : null;
      }
    };
  `;
  const result = await pool.evaluateSignal({
    algorithmSource,
    bars: bars.slice(0, 2),
    position: { qty: 0, entryPrice: 0, entryIndex: -1 },
    research: mutableFrame
  });
  assert.deepEqual(result.signal, { action: "buy", reason: "deeply frozen", confidence: undefined });
  assert.equal(mutableFrame.snapshot.summary.overview, "Validated point-in-time fixture.");
});

test("research-driven backtest signals at availability and fills at the next open", () => {
  const snapshot = researchSnapshot({ availableAt: bars[1].time });
  const result = runBacktest({
    bars,
    symbol: "AAPL",
    researchTimeline: [snapshot],
    algorithm: {
      name: "Research entry",
      init({ research }) {
        assert.equal(research, null);
        return {};
      },
      signal({ research, position }) {
        assert.equal(Array.isArray(research), false, "the full timeline must not enter strategy context");
        if (position.qty === 0 && research.status === "available") {
          return { action: "buy", reason: research.snapshot.id };
        }
        return null;
      }
    },
    startingCash: 1_000,
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 }
  });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].signalIndex, 1);
  assert.equal(result.trades[0].fillIndex, 2);
  assert.equal(result.trades[0].referencePrice, bars[2].open);
  assert.equal(result.trades[0].rule, snapshot.id);
  assert.equal(result.trades[0].researchSnapshotId, snapshot.id);
  assert.equal(result.researchTimelineHash, researchTimelineHash([snapshot]));
  assert.equal(result.config.researchTimelineHash, result.researchTimelineHash);
});

test("worker-pool backtests forward only the research timeline inputs", async (t) => {
  const pool = new EnginePool({ size: 1, timeoutMs: 2_000 });
  t.after(() => pool.close());
  const snapshot = researchSnapshot({ availableAt: bars[1].time });
  const result = await pool.runBacktest({
    algorithmSource: `
      export default {
        name: "Worker research entry",
        init({ research }) {
          if (research !== null) throw new Error("init received research");
          return {};
        },
        signal({ research, position }) {
          return position.qty === 0 && research?.status === "available"
            ? { action: "buy", reason: research.snapshot.id }
            : null;
        }
      };
    `,
    bars,
    symbol: "AAPL",
    researchTimeline: [snapshot],
    startingCash: 1_000,
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 }
  });
  assert.equal(result.trades[0].signalIndex, 1);
  assert.equal(result.trades[0].fillIndex, 2);
  assert.equal(result.researchTimelineHash, researchTimelineHash([snapshot]));
});

test("required research skips signal evaluation and attributes terminal signals at signal time", () => {
  const snapshot = researchSnapshot({ id: "required-frame", availableAt: bars[2].time });
  const observations = [];
  const result = runBacktest({
    bars,
    symbol: "AAPL",
    researchTimeline: [snapshot],
    researchRequired: true,
    algorithm: {
      name: "Required research entry",
      signal({ index, research, position }) {
        observations.push({ index, status: research.status });
        if (position.qty === 0) return { action: "buy", reason: research.snapshot.id };
        return { action: "sell", reason: research.snapshot.id };
      }
    },
    startingCash: 1_000,
    fillModel: { slippageBps: 0, fixedCommission: 0, perShareCommission: 0 }
  });

  assert.deepEqual(observations, [
    { index: 2, status: "available" },
    { index: 3, status: "available" }
  ]);
  assert.equal(result.trades[0].signalIndex, 2);
  assert.equal(result.trades[0].researchSnapshotId, snapshot.id);
  assert.equal(result.unfilledSignal.action, "sell");
  assert.equal(result.unfilledSignal.researchSnapshotId, snapshot.id);
  assert.equal(result.config.researchRequired, true);
});
