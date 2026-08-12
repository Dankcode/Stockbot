import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_ASSETS, searchCatalog } from "../../server/market/catalog.js";
import { normalizeBar, normalizeQuote } from "../../server/market/normalize.js";

test("catalog search supports exact, alias, and fuzzy matches", () => {
  assert.equal(searchCatalog(LOCAL_ASSETS, "NVDA")[0].symbol, "NVDA");
  assert.equal(searchCatalog(LOCAL_ASSETS, "digital gold")[0].symbol, "BTCUSD");
  assert.equal(searchCatalog(LOCAL_ASSETS, "mcrsft")[0].symbol, "MSFT");
});

test("provider values normalize to the shared epoch-ms contracts", () => {
  const quote = normalizeQuote("AAPL", { price: 101, previousClose: 100, quoteAt: 1_700_000_000_000 }, "fixture");
  assert.equal(quote.at, 1_700_000_000_000);
  assert.equal(quote.changePercent, 1);
  assert.equal(quote.volume, null);
  const bar = normalizeBar({ t: 1_700_000_000, o: 100, h: 105, l: 99, c: 103, v: 10 }, "fixture");
  assert.equal(bar.time, 1_700_000_000_000);
  assert.deepEqual(Object.keys(bar), ["time", "open", "high", "low", "close", "volume"]);
});

test("impossible provider bars fail loudly", () => {
  assert.throws(() => normalizeBar({ t: Date.now(), o: 100, h: 90, l: 80, c: 95, v: 1 }, "fixture"), /invalid bar/);
  assert.throws(() => normalizeBar({ t: Date.now(), o: 100, h: 105, l: 95, c: 101 }, "fixture"), /invalid bar/);
});

test("quotes without provider timestamps fail instead of appearing fresh", () => {
  assert.throws(() => normalizeQuote("AAPL", { price: 101, previousClose: 100 }, "fixture"), /invalid quote/);
});
