import assert from "node:assert/strict";
import test from "node:test";
import { alpacaProvider } from "../../server/market/providers/alpaca.js";
import { getRangeConfig } from "../../packages/shared/ranges.js";

for (const symbol of ["AAPL", "BTCUSD"]) {
  test(`Alpaca keeps the newest bars in chronological order: ${symbol}`, async (t) => {
    const history = Array.from({ length: 200 }, (_, i) => ({
      t: 1_790_000_000_000 + i * 60_000, o: 100, h: 102, l: 99, c: 101, v: 1000
    }));
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      const ordered = url.searchParams.get("sort") === "desc" ? [...history].reverse() : history;
      const bars = ordered.slice(0, Number(url.searchParams.get("limit")));
      return { ok: true, json: async () => ({ bars: symbol === "AAPL" ? bars : { "BTC/USD": bars } }) };
    });
    const provider = alpacaProvider({ alpaca: { key: "test", secret: "test", dataBaseUrl: "https://data.alpaca.markets", stockFeed: "iex" } });
    const bars = await provider.bars(symbol, getRangeConfig("1H"));
    assert.equal(bars.length, 60);
    assert.equal(bars[0].time, history[140].t);
    assert.equal(bars.at(-1).time, history.at(-1).t);
  });
}
