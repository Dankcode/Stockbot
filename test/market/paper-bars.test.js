import assert from "node:assert/strict";
import test from "node:test";
import { createMarketService } from "../../server/market/chain.js";
import { loadConfig } from "../../server/config/index.js";

test("paper history supports EMA200 warmup and bypasses stale cached bars", async (t) => {
  let requests = 0;
  let newest = Date.UTC(2026, 9, 5);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v2/assets") return { ok: true, json: async () => [] };
    requests += 1;
    const count = Number(url.searchParams.get("limit"));
    assert.ok(Date.parse(url.searchParams.get("start")) < newest - count * 86_400_000);
    return { ok: true, json: async () => ({ bars: Array.from({ length: count }, (_, i) => ({
      t: newest - i * 86_400_000, o: 100, h: 102, l: 99, c: 101, v: 1_000_000
    })) }) };
  });
  const config = loadConfig();
  const market = createMarketService({ ...config,
    alpaca: { ...config.alpaca, key: "fixture", secret: "fixture" },
    polygon: { key: "" }, finnhub: { key: "" }
  });
  const history = await market.getBars("AAPL", "3M", { minBars: 220 });
  assert.equal(history.bars.length, 220);
  newest += 86_400_000;
  const cached = await market.getBars("AAPL", "3M", { minBars: 220 });
  assert.equal(cached.bars.at(-1).time, history.bars.at(-1).time);
  assert.equal(requests, 1);
  const fresh = await market.getBars("AAPL", "3M", { minBars: 220, fresh: true });
  assert.equal(fresh.bars.at(-1).time, newest);
  assert.equal(requests, 2);
  const simultaneous = await Promise.all(Array.from({ length: 10 }, () => market.getBars("AAPL", "3M", { minBars: 220, fresh: true })));
  assert.equal(requests, 3, "one fresh provider call serves simultaneous session ticks");
  assert.ok(simultaneous.every((item) => item === simultaneous[0]));
});
