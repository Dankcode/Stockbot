import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createClient } from "../../server/db/client.js";
import { migrate } from "../../server/db/migrate.js";
import { createRepositories } from "../../server/db/repositories/index.js";
import { createDiscoveryService, recentWeekdays } from "../../server/discovery/service.js";
import { OPERATOR_TOKEN, bootStockbot } from "../swarm/fixture.js";
import { fakeSources } from "./fixtures.js";

const NOW = Date.UTC(2026, 10, 20, 5, 0); // Friday 20 Nov 2026, 00:00 in New York

async function harness(t, sourceOptions = {}, serviceOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "stockbot-discovery-"));
  const client = await createClient(pathToFileURL(join(directory, "stockbot.db")).href);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(client);
  const repositories = createRepositories(client);
  const sources = fakeSources(sourceOptions);
  let now = NOW;
  const service = createDiscoveryService({ repositories, sources, clock: () => now, logger: { error() {} }, webSources: { sec: { origin: "https://www.sec.gov" } }, ...serviceOptions });
  return { client, repositories, sources, service, advance: (ms) => { now += ms; } };
}

async function runToEnd(service, params = {}) {
  const run = await service.startRun(params);
  await service.waitForActive();
  return service.getRun(run.id, { lens: "growth" });
}

test("recent weekdays skip weekends and today, in New York time", () => {
  assert.deepEqual(recentWeekdays(NOW, 6), ["2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16", "2026-11-13", "2026-11-12"]);
});

test("a run finds only liquid non-S&P common stocks with enough history, and explains every exclusion", async (t) => {
  const h = await harness(t);
  const { run, candidates } = await runToEnd(h.service);
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(candidates.map((candidate) => candidate.symbol).sort(), ["GROW", "SLOW", "STDY"]);
  assert.equal(candidates[0].symbol, "GROW", "growth lens ranks the grower first");
  assert.equal((await h.service.getRun(run.id, { lens: "hold" })).candidates[0].symbol, "STDY", "hold lens ranks the steady compounder first");
  const stats = run.statsJson;
  assert.equal(stats.universe.excluded["S&P 500 member"], 1);
  assert.equal(stats.universe.excluded.ETF, 1);
  assert.equal(stats.universe.excluded["blank-check company (SPAC)"], 1);
  assert.equal(stats.liquidity.belowMinPrice, 1, "PENNY");
  assert.equal(stats.liquidity.belowMinDollarVolume, 1, "THIN");
  assert.equal(stats.bars.tooShortHistory, 1, "NEWCO");
  assert.equal(stats.fundamentals.outsideMarketCap, 1, "TINY is below the $300M floor");
  assert.equal(stats.sp500.count, 3);
  assert.deepEqual(stats.liquidity.dates, ["2026-11-19", "2026-11-18", "2026-11-17", "2026-11-16", "2026-11-13"]);
  assert.ok(!h.sources.calls.barSymbols.includes("NVDA") && !h.sources.calls.barSymbols.includes("PENNY"), "excluded names are never fetched");
  const grow = candidates[0];
  assert.equal(grow.fundamentalsJson.revenueGrowthTTM, 60);
  assert.ok(grow.scoresJson.growth.strengths.length > 0);
  assert.equal(grow.metricsJson.avgDollarVolume5d, 80_000_000);
});

test("a second run reuses stored market days and cached fundamentals instead of refetching", async (t) => {
  const h = await harness(t);
  await runToEnd(h.service);
  const first = { ...h.sources.calls };
  h.advance(60_000);
  await runToEnd(h.service);
  assert.equal(h.sources.calls.groupedDaily, first.groupedDaily, "no new whole-market calls for days already stored");
  assert.equal(h.sources.calls.fundamentals, first.fundamentals, "fundamentals come from the 7-day cache");
  assert.equal(h.sources.calls.sp500, 1, "the S&P list is refreshed weekly, not every run");
});

test("when SSGA is unreachable the bundled S&P list is used and labelled; a failure ends the run visibly", async (t) => {
  const h = await harness(t, { failSp500: true });
  const { run } = await runToEnd(h.service);
  assert.equal(run.status, "completed");
  assert.match(run.statsJson.sp500.source, /bundled list .*\(refresh failed: SSGA unreachable\)/);
  assert.ok(run.statsJson.sp500.count > 450);

  const broken = await harness(t);
  broken.sources.dailyBars = async () => { throw new Error("Alpaca daily bars failed (HTTP 429)."); };
  const failed = await runToEnd(broken.service);
  assert.equal(failed.run.status, "failed");
  assert.match(failed.run.error, /HTTP 429/);
});

test("one run at a time; a failed fundamentals call degrades coverage instead of failing the run", async (t) => {
  const h = await harness(t, { failFundamentals: new Set(["STDY"]) });
  await h.service.startRun();
  await assert.rejects(h.service.startRun(), { code: "DISCOVERY_RUN_ACTIVE" });
  await h.service.waitForActive();
  const { run, candidates } = await h.service.getRun((await h.service.latestRun()).id, {});
  assert.equal(run.statsJson.fundamentals.failed, 1);
  const steady = candidates.find((candidate) => candidate.symbol === "STDY");
  assert.equal(steady.fundamentalsJson, null);
  assert.ok(steady.scoresJson.growth.coverage < 1);
  await assert.rejects(h.service.startRun({ maxAnalyzed: 5 }), { code: "VALIDATION_ERROR" });
});

test("a run left 'running' by a restart is failed with a reason on startup", async (t) => {
  const h = await harness(t);
  await h.repositories.discovery.createRun({ id: "orphan", params: {}, createdAt: NOW });
  assert.equal(await h.service.recover(), 1);
  const { run } = await h.service.getRun("orphan", {});
  assert.deepEqual([run.status, run.error], ["failed", "The server restarted while this run was in progress."]);
});

test("watchlist and research queue: request → claim → complete, one open request per symbol, scrapers must be registered", async (t) => {
  const h = await harness(t);
  await runToEnd(h.service);
  await h.service.watch("grow", { status: "watching", note: "Strong revenue growth" });
  await assert.rejects(h.service.watch("GROW", { status: "bought" }), { code: "VALIDATION_ERROR" });
  await assert.rejects(h.service.requestResearch({ symbol: "GROW", scrapers: ["random-blog"] }), /Unknown scraper/);
  const request = await h.service.requestResearch({ symbol: "GROW", question: "Is the growth durable?", scrapers: ["sec"] });
  assert.equal(request.status, "pending");
  await assert.rejects(h.service.requestResearch({ symbol: "GROW" }), { code: "DISCOVERY_RESEARCH_OPEN" });
  const [entry] = await h.service.watchlist();
  assert.equal(entry.status, "researching", "requesting research moves a watched symbol to researching");
  assert.equal(entry.note, "Strong revenue growth");
  assert.equal(entry.latest.growthScore > 50, true);
  assert.equal(entry.research.id, request.id);

  await assert.rejects(h.service.completeResearch(request.id, { summary: "x" }), { code: "DISCOVERY_RESEARCH_STATE" }, "must be claimed first");
  const claimed = await h.service.claimResearch(request.id, "llm:future-researcher");
  assert.equal(claimed.researcher, "llm:future-researcher");
  await assert.rejects(h.service.claimResearch(request.id, "someone-else"), { code: "DISCOVERY_RESEARCH_STATE" });
  const done = await h.service.completeResearch(request.id, { summary: "Durable, contracted revenue.", verdict: "hold_candidate" });
  assert.deepEqual([done.status, done.resultJson.verdict], ["completed", "hold_candidate"]);
  const config = h.service.researchConfig();
  assert.deepEqual(config.researchers, []);
  assert.match(config.note, /No LLM researcher is assigned yet/);
  assert.deepEqual(config.scrapers.map((scraper) => scraper.id), ["sec"]);
});

test("over HTTP: runs and changes need the operator token; reads work; the researcher side is operator-only", async (t) => {
  const sources = fakeSources();
  const hub = await bootStockbot(t, { stockbotOptions: { discoverySources: sources } });
  assert.equal((await hub.call("POST", "/discovery/runs", { body: {} })).status, 401);
  const started = await hub.operator("POST", "/discovery/runs", {});
  assert.equal(started.status, 202, JSON.stringify(started.error));
  await hub.runtime.discovery.waitForActive();
  const latest = await hub.call("GET", "/discovery/runs/latest?lens=hold");
  assert.equal(latest.status, 200);
  assert.equal(latest.data.run.status, "completed", latest.data.run.error);
  assert.ok(latest.data.candidates.length >= 3);
  assert.equal((await hub.call("PUT", "/discovery/watchlist/GROW", { body: { status: "shortlisted" } })).status, 401);
  assert.equal((await hub.operator("PUT", "/discovery/watchlist/GROW", { status: "shortlisted" })).data.status, "shortlisted");
  const request = await hub.operator("POST", "/discovery/research", { symbol: "GROW" });
  assert.equal(request.status, 201);
  assert.equal((await hub.call("POST", `/discovery/research/${request.data.id}/claim`, { body: { researcher: "x" } })).status, 401);
  assert.equal((await hub.operator("POST", `/discovery/research/${request.data.id}/claim`, { researcher: "llm:test" })).data.status, "claimed");
  assert.equal((await hub.call("GET", "/discovery/research?status=claimed")).data.length, 1);
  assert.equal((await hub.call("GET", "/discovery/watchlist")).data[0].symbol, "GROW");
});
