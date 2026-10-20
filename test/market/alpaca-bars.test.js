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

test("Alpaca quotes use the newer of the last trade and a sane bid/ask midpoint", async () => {
  const { freshestPrice } = await import("../../server/market/providers/alpaca.js");
  const trade = { p: 64_000, t: "2026-10-19T10:00:00Z" };
  const fresher = { bp: 64_100, ap: 64_110, t: "2026-10-19T10:00:30Z" };
  assert.deepEqual(
    { price: freshestPrice({ latestTrade: trade, latestQuote: fresher }).price, time: freshestPrice({ latestTrade: trade, latestQuote: fresher }).time },
    { price: 64_105, time: fresher.t }
  );
  const older = { bp: 63_000, ap: 63_010, t: "2026-10-19T09:59:00Z" };
  assert.equal(freshestPrice({ latestTrade: trade, latestQuote: older }).price, 64_000);
  const wide = { bp: 60_000, ap: 70_000, t: "2026-10-19T10:01:00Z" };
  assert.equal(freshestPrice({ latestTrade: trade, latestQuote: wide }).price, 64_000, "a wide spread is ignored");
  assert.equal(freshestPrice({}), null);
});

test("Alpaca crypto quote reads the BTC/USD snapshot with the fresher bid/ask", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get("symbols"), "BTC/USD");
    return {
      ok: true,
      json: async () => ({
        snapshots: {
          "BTC/USD": {
            latestTrade: { p: 64_000, t: "2026-10-19T10:00:00Z" },
            latestQuote: { bp: 64_100, ap: 64_110, t: "2026-10-19T10:00:30Z" },
            dailyBar: { o: 63_000, c: 64_000, v: 12 },
            prevDailyBar: { c: 62_500 }
          }
        }
      })
    };
  });
  const provider = alpacaProvider({ alpaca: { key: "test", secret: "test", dataBaseUrl: "https://data.alpaca.markets", stockFeed: "iex" } });
  const quote = await provider.quote("BTCUSD");
  assert.equal(quote.price, 64_105);
  assert.equal(quote.at, Date.parse("2026-10-19T10:00:30Z"));
  assert.equal(quote.status, "real");
});
