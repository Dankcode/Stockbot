import assert from "node:assert/strict";
import test from "node:test";

import { readFirstSheet } from "../../server/discovery/xlsx.js";
import { createRateLimiter, parseNasdaqDirectory, parseSp500Holdings } from "../../server/discovery/sources.js";
import { makeXlsx } from "./fixtures.js";

const tickers = (count) => Array.from({ length: count }, (_, index) => `T${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + Math.floor(index / 26) % 26)}`);

test("the xlsx reader returns cell text and numbers in column order", () => {
  const rows = readFirstSheet(makeXlsx([["Name", "Ticker", "Weight"], ["Apple & Co <A>", "AAPL", 6.5]]));
  assert.deepEqual(rows, [["Name", "Ticker", "Weight"], ["Apple & Co <A>", "AAPL", "6.5"]]);
  assert.throws(() => readFirstSheet(Buffer.from("not a zip")), /zip/);
});

test("S&P 500 holdings: the Ticker column below the header, class shares kept, cash and partial lists refused", () => {
  const symbols = [...tickers(500), "BRK.B", "BF.B"];
  const sheet = [["Fund Name:", "SPDR S&P 500"], ["Holdings:", "As of 18-Nov-2026"], [], ["Name", "Ticker", "Identifier", "Weight"],
    ...symbols.map((symbol) => [`${symbol} Inc`, symbol, "x", 0.1]), ["US DOLLAR", "USD", "x", 0.01], [], ["Disclaimer text"]];
  const parsed = parseSp500Holdings(makeXlsx(sheet));
  assert.equal(parsed.symbols.length, 502);
  assert.ok(parsed.symbols.includes("BRK.B"));
  assert.ok(!parsed.symbols.includes("USD"));
  assert.equal(parsed.asOf, "As of 18-Nov-2026");
  assert.throws(() => parseSp500Holdings(makeXlsx([["Name", "Ticker"], ...tickers(100).map((symbol) => ["x", symbol])])), /refusing a partial list/);
  assert.throws(() => parseSp500Holdings(makeXlsx([["Name", "Symbol"], ["x", "AAPL"]])), /no Ticker column/);
});

test("Nasdaq Trader directories merge into one map with ETF and test-issue flags", () => {
  const filler = Array.from({ length: 5_000 }, (_, index) => `F${index}|Filler ${index} Inc|Q|N|N|100|N|N`);
  const listed = ["Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares",
    "CRWD|CrowdStrike - Class A Common Stock|Q|N|N|100|N|N", "QQQ|Invesco QQQ Trust|G|N|N|100|Y|N",
    "ZVZZT|NASDAQ TEST STOCK|G|Y|N|100|N|N", "DEFI|Deficient Co|S|N|D|100|N|N", ...filler, "File Creation Time: 1120202608:00|||||||"].join("\r\n");
  const other = ["ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol",
    "BRK.B|Berkshire Hathaway Inc. New Common Stock|N|BRK.B|N|100|N|BRK=B", "SPY|SPDR S&P 500|P|SPY|Y|100|N|SPY"].join("\r\n");
  const directory = parseNasdaqDirectory(listed, other);
  assert.deepEqual(directory.get("CRWD"), { name: "CrowdStrike - Class A Common Stock", exchange: "NASDAQ", etf: false, testIssue: false, financialStatus: "N" });
  assert.equal(directory.get("QQQ").etf, true);
  assert.equal(directory.get("ZVZZT").testIssue, true);
  assert.equal(directory.get("DEFI").financialStatus, "D");
  assert.equal(directory.get("BRK.B").exchange, "NYSE");
  assert.equal(directory.get("SPY").etf, true);
  assert.ok(!directory.has("File Creation Time: 1120202608:00"));
  assert.throws(() => parseNasdaqDirectory(listed.split("\r\n").slice(0, 3).join("\n"), other), /partial list/);
});

test("the rate limiter spaces calls to the per-minute budget", async () => {
  let now = 0;
  const waits = [];
  const limit = createRateLimiter(5, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  for (let index = 0; index < 6; index += 1) await limit();
  assert.deepEqual(waits, [12_000, 12_000, 12_000, 12_000, 12_000], "6 calls at 5/min take a minute; the first is free");
});
