import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { adxComponents, qualityMetrics } from "../../server/discovery/indicators.js";
import { applyFilterRules, applyQualityGates, PRESETS } from "../../server/discovery/screen.js";
import { createDiscoveryService, RunParamsSchema, verifyMarketCap } from "../../server/discovery/service.js";
import { createDiscoverySources } from "../../server/discovery/sources.js";
import { buildUniverse } from "../../server/discovery/universe.js";
import { bootStockbot } from "../swarm/fixture.js";
import { fakeSources, makeBars } from "./fixtures.js";

const NOW = Date.UTC(2026, 10, 20, 5, 0);

/** The same seeded random walk used to compute the reference values with pandas 2.3.3 and Gunbot Quant's formulas. */
function referenceBars() {
  let seed = 7;
  const random = () => { seed = (seed * 16_807) % 2_147_483_647; return seed / 2_147_483_647; };
  const bars = [];
  let price = 30;
  for (let index = 0; index < 260; index += 1) {
    price *= 1 + (random() - 0.48) * 0.04;
    const high = price * (1 + random() * 0.03);
    const low = price * (1 - random() * 0.03);
    bars.push({ high, low, close: low + (high - low) * random(), volume: Math.round(1e6 * (0.5 + random() * 2)) });
  }
  return bars;
}

test("ADX and the quality heuristics match Gunbot Quant's pandas implementation", () => {
  const metrics = qualityMetrics(referenceBars());
  assert.deepEqual(
    { adx14: metrics.adx14, atrPct14: metrics.atrPct14, volatilityConsistency: metrics.volatilityConsistency, maxDailySpikePct: metrics.maxDailySpikePct, volumeConcentrationPct: metrics.volumeConcentrationPct },
    { adx14: 14.08, atrPct14: 3.134, volatilityConsistency: 0.203, maxDailySpikePct: 5.49, volumeConcentrationPct: 5.43 }
  );
  const { adx, plusDi } = adxComponents(referenceBars().slice(0, 30), 14);
  assert.equal(adx[12], null, "ADX is missing during warm-up, never NaN");
  assert.ok(Number.isFinite(plusDi.at(-1)));
});

test("quality metrics flag pumped volume and single-day spikes, and stay null without enough data", () => {
  const even = qualityMetrics(makeBars({}));
  assert.ok(even.volumeConcentrationPct < 4 && even.maxDailySpikePct < 3);
  assert.ok(qualityMetrics(makeBars({ pumpDays: 3 })).volumeConcentrationPct > 50);
  assert.ok(qualityMetrics(makeBars({ spikeDay: true })).maxDailySpikePct > 55);
  const rising = qualityMetrics(makeBars({ drift: 0.004, wiggle: 0.001 }));
  assert.ok(rising.adx14 > 25 && rising.priceVsSma200Pct > 0, "a steady climb is a strong trend");
  assert.deepEqual(Object.values(qualityMetrics(makeBars({ days: 10 }))), [null, null, null, null, null, null]);
});

test("quality gates remove only measured failures, and count them by reason", () => {
  const candidate = (symbol, inputs) => ({ symbol, inputs: { volatilityConsistency: 1, maxDailySpikePct: 5, volumeConcentrationPct: 4, ...inputs } });
  const gates = RunParamsSchema.parse({}).qualityGates;
  const { kept, stats } = applyQualityGates([
    candidate("OK"), candidate("PUMP", { volumeConcentrationPct: 45 }), candidate("SPIKE", { maxDailySpikePct: 40 }),
    candidate("WILD", { volatilityConsistency: 9 }), candidate("YOUNG", { volatilityConsistency: null })
  ], gates);
  assert.deepEqual(kept.map((item) => item.symbol), ["OK", "YOUNG"]);
  assert.deepEqual(stats.removed, { "volume concentrated in a few days": 1, "extreme single-day move": 1, "erratic volatility": 1 });
  assert.equal(stats.unmeasured, 1);
  assert.equal(applyQualityGates([candidate("PUMP", { volumeConcentrationPct: 45 })], { ...gates, enabled: false }).kept.length, 1);
});

test("filter rules use display units, drop stocks without the metric, and report each rule", () => {
  const rows = [
    { symbol: "A", inputs: { mom6m: 0.35, adx14: 30, revenueGrowthTTM: 40 } },
    { symbol: "B", inputs: { mom6m: 0.1, adx14: 18, revenueGrowthTTM: null } },
    { symbol: "C", inputs: { mom6m: 0.25, adx14: 50 } }
  ];
  const rules = [
    { metric: "mom6m", condition: "greater_than", value: 20 },
    { metric: "adx14", condition: "between", value: [20, 40] },
    { metric: "revenueGrowthTTM", condition: "greater_than", value: 15 }
  ];
  const price = applyFilterRules(rows, rules, "price");
  assert.deepEqual(price.kept.map((row) => row.symbol), ["A"]);
  assert.deepEqual(price.applied.map(({ removed, remaining }) => [removed, remaining]), [[1, 2], [1, 1]]);
  assert.match(price.applied[0].rule, /6-month return > 20%/);
  const fundamentals = applyFilterRules(rows, rules, "fundamentals");
  assert.deepEqual(fundamentals.kept.map((row) => row.symbol), ["A"]);
  assert.deepEqual([fundamentals.applied[0].removed, fundamentals.applied[0].missingData], [0, 2]);
});

test("run settings reject malformed rules; every preset is a valid run", () => {
  for (const preset of PRESETS) assert.equal(RunParamsSchema.safeParse(preset.params).success, true, preset.id);
  const bad = (filters) => RunParamsSchema.safeParse({ filters }).success;
  assert.equal(bad([{ metric: "mom6m", condition: "between", value: [30, 10] }]), false);
  assert.equal(bad([{ metric: "mom6m", condition: "less_than", value: [1, 2] }]), false);
  assert.equal(bad([{ metric: "eval('x')", condition: "less_than", value: 1 }]), false);
  assert.equal(bad(Array.from({ length: 13 }, () => ({ metric: "adx14", condition: "greater_than", value: 1 }))), false);
  assert.deepEqual(RunParamsSchema.parse({ qualityGates: { maxDailySpikePct: 25 } }).qualityGates, { enabled: true, maxVolatilityConsistency: 5, maxDailySpikePct: 25, maxVolumeConcentrationPct: 30 });
});

test("other share classes of S&P 500 members are excluded; unrelated class shares are kept", () => {
  const listing = (symbol, name) => ({ symbol, name, exchange: "NYSE", tradable: true });
  const assets = [listing("BRK.A", "Berkshire Hathaway Inc Class A"), listing("BF.A", "Brown-Forman Corp Class A"), listing("LEN.B", "Lennar Corp Class B"), listing("HEI.A", "HEICO Corp Class A")];
  const directory = new Map(assets.map((asset) => [asset.symbol, { name: asset.name, exchange: "NYSE", etf: false, testIssue: false, financialStatus: "N" }]));
  const universe = buildUniverse({ assets, directory, sp500: ["BRK.B", "BF.B", "LEN"] });
  assert.deepEqual(universe.members.map((member) => member.symbol), ["HEI.A"]);
  assert.equal(universe.excluded["share class of an S&P 500 member"], 3);
});

test("a reported market cap is used only when it matches the US trading price", async () => {
  // Live Finnhub values from 20 Nov 2026: GMAB says USD but is DKK per ordinary share; ASND says EUR but is USD.
  const profiles = {
    GMAB: { name: "Genmab A/S", currency: "USD", marketCapitalization: 209_520.8, shareOutstanding: 62.41 },
    ASND: { name: "Ascendis Pharma", currency: "EUR", marketCapitalization: 16_789.7, shareOutstanding: 66.4 },
    CP: { name: "Canadian Pacific Kansas City", currency: "CAD", marketCapitalization: 124_000, shareOutstanding: 928.2 },
    CRWD: { name: "CrowdStrike", currency: "USD", marketCapitalization: 249_287.2, shareOutstanding: 1_023.93 }
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const symbol = parsed.searchParams.get("symbol");
    const body = parsed.pathname.endsWith("profile2") ? profiles[symbol] : { metric: { revenueGrowthTTMYoy: 18 } };
    return { ok: true, json: async () => body };
  };
  const sources = createDiscoverySources(
    { alpaca: { key: "k", secret: "s" }, polygon: { key: "p" }, finnhub: { key: "f" } },
    { fetchImpl, finnhubLimiter: async () => undefined, polygonLimiter: async () => undefined }
  );
  const prices = { GMAB: 51.35, ASND: 255.96, CP: 91.4, CRWD: 243.46 };
  const checked = {};
  for (const symbol of Object.keys(profiles)) checked[symbol] = verifyMarketCap(await sources.fundamentals(symbol), prices[symbol]);
  assert.deepEqual([checked.CRWD.marketCapMillions, checked.CRWD.marketCapVerified], [249_287.2, true]);
  assert.deepEqual([checked.ASND.marketCapMillions, checked.ASND.marketCapVerified], [16_789.7, true], "the currency label is wrong; the price check decides");
  assert.equal(checked.GMAB.marketCapMillions, null);
  assert.match(checked.GMAB.marketCapNote, /3357\.\d\d a share against \$51\.35/);
  assert.equal(checked.CP.marketCapMillions, null, "a CAD figure is 1.46x the USD price, outside 0.8-1.25");
  assert.equal(checked.CRWD.revenueGrowthTTM, 18);
  assert.deepEqual(
    [verifyMarketCap({ marketCapReportedMillions: 500, reportedCurrency: "USD" }, 10).marketCapMillions, verifyMarketCap({ marketCapReportedMillions: 500, reportedCurrency: "INR" }, 10).marketCapMillions],
    [500, null], "without a share count only a USD-labelled figure is used"
  );
});

async function harness(t, sourceOptions) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-screening-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const sources = fakeSources(sourceOptions);
  const service = createDiscoveryService({ repositories, sources, clock: () => NOW, logger: { error() {} } });
  const run = async (params = {}) => {
    const started = await service.startRun(params);
    await service.waitForActive();
    return service.getRun(started.id, { lens: "growth" });
  };
  return { repositories, sources, service, run };
}

test("a run applies the quality gates, share-class exclusion and currency handling, and explains each", async (t) => {
  const h = await harness(t, { extra: ["PUMP", "SPKE", "FORN", "BRK.A"], extraSp500: ["BRK.B"] });
  const { run, candidates } = await h.run();
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(candidates.map((candidate) => candidate.symbol).sort(), ["FORN", "GROW", "SLOW", "STDY"]);
  const stats = run.statsJson;
  assert.equal(stats.universe.excluded["share class of an S&P 500 member"], 1, "BRK.A");
  assert.deepEqual(stats.quality.removed, { "volume concentrated in a few days": 1, "extreme single-day move": 1 });
  assert.equal(stats.quality.passed, 5, "GROW, STDY, SLOW, FORN and TINY (TINY leaves later on market cap)");
  assert.equal(stats.fundamentals.marketCapUnverified, 1);
  const forn = candidates.find((candidate) => candidate.symbol === "FORN");
  assert.deepEqual([forn.fundamentalsJson.marketCapMillions, forn.fundamentalsJson.marketCapReportedMillions], [null, 209_521]);
  assert.match(forn.fundamentalsJson.marketCapNote, /market-cap limits were not applied/);
  assert.ok(Number.isFinite(candidates[0].metricsJson.adx14), "ADX is stored with each candidate");

  const open = await h.run({ qualityGates: { enabled: false } });
  assert.ok(["PUMP", "SPKE"].every((symbol) => open.candidates.some((candidate) => candidate.symbol === symbol)), "the gates can be switched off");
});

test("a run applies price rules before fundamentals are fetched and fundamentals rules after", async (t) => {
  const h = await harness(t, {});
  const trending = await h.run({ filters: [{ metric: "mom6m", condition: "greater_than", value: 20 }] });
  assert.deepEqual(trending.candidates.map((candidate) => candidate.symbol), ["GROW"]);
  assert.deepEqual(h.sources.calls.fundamentalSymbols, ["GROW", "TINY"], "fundamentals are fetched only for stocks that passed the price rules");
  assert.equal(trending.run.statsJson.filters[0].removed, 2);

  const growing = await h.run({ filters: [{ metric: "revenueGrowthTTM", condition: "greater_than", value: 15 }] });
  assert.deepEqual(growing.candidates.map((candidate) => candidate.symbol), ["GROW"]);
  assert.match(growing.run.statsJson.filters[0].rule, /Revenue growth, year over year > 15%/);
});

test("fundamentals cached before the market-cap check are refetched", async (t) => {
  const h = await harness(t, {});
  await h.repositories.discovery.putFundamentals({ symbol: "GROW", source: "finnhub", payload: { marketCapMillions: 4_000 }, fetchedAt: NOW - 1_000 }); // pre-fix shape, no version
  await h.run();
  assert.ok(h.sources.calls.fundamentalSymbols.includes("GROW"));
  const before = h.sources.calls.fundamentals;
  await h.run();
  assert.equal(h.sources.calls.fundamentals, before, "entries written with the current version are reused");
});

test("over HTTP: screening options list presets and metrics; a bad rule is a 400", async (t) => {
  const hub = await bootStockbot(t, { stockbotOptions: { discoverySources: fakeSources() } });
  const options = await hub.call("GET", "/discovery/screening");
  assert.equal(options.status, 200);
  assert.ok(options.data.presets.some((preset) => preset.id === "strong-trends"));
  assert.equal(options.data.metrics.adx14.label, "ADX(14) trend strength");
  assert.equal(options.data.defaults.qualityGates.maxVolumeConcentrationPct, 30);
  const bad = await hub.operator("POST", "/discovery/runs", { filters: [{ metric: "adx14", condition: "between", value: 5 }] });
  assert.equal(bad.status, 400);
});
