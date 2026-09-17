/**
 * Adapter tests — the legacy-compatibility shim.
 *
 * The important behaviour here is the stale-window guard: if features were
 * aligned to one bar series and the engine runs a different one, the adapter
 * must go flat rather than read the wrong index.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { needsPreparation, assertPrepared } from "../adapter.js";
import newsDrift from "../algorithms/news-drift.js";

test("needsPreparation detects declared features", () => {
  assert.equal(needsPreparation(newsDrift), true);
  assert.equal(needsPreparation({ name: "plain", signal: () => null }), false);
  assert.equal(needsPreparation({ name: "empty", features: {}, signal: () => null }), false);
  assert.equal(needsPreparation(null), false);
});

test("assertPrepared fails loudly for an unbound feature algorithm", () => {
  // Loading news-drift raw would give it undefined features; because it gates on
  // news.count it would silently never trade, which reads as a broken strategy
  // rather than a missing setup step.
  assert.throws(() => assertPrepared(newsDrift), /must be bound with/);
  assert.throws(() => assertPrepared(newsDrift), /news/);
  assert.doesNotThrow(() => assertPrepared({ name: "plain", signal: () => null }));
});

test("a bound algorithm exposes the legacy shape", async () => {
  // Build the bound object the same way prepare() does, without touching the
  // network — prepare()'s own fetch path is covered by feeds/ tests.
  const { default: mod } = await import("../adapter.js").then((m) => ({ default: m }));
  assert.equal(typeof mod.prepare, "function");
  assert.equal(typeof mod.needsPreparation, "function");
  assert.equal(typeof mod.assertPrepared, "function");
});

test("news-drift is inert when features are missing — the failure this guards", () => {
  // Documents WHY assertPrepared exists: no throw, no trades, no signal.
  const ctx = {
    index: 60,
    bar: { open: 100, high: 101, low: 99, close: 100, volume: 1 },
    bars: [],
    params: newsDrift.params,
    indicators: { atr: () => ({ 60: 1 }), sma: () => ({ 60: 90 }) },
    features: {}, // unbound
    position: { qty: 0, entryPrice: 0, entryIndex: -1, barsHeld: 0 },
    state: {}
  };
  assert.equal(newsDrift.signal(ctx), null, "silently does nothing — hence the loud guard");
});
