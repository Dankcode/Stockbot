/**
 * Ticker discovery: finds liquid US common stocks outside the S&P 500, scores
 * them for growth and for holding, and keeps the results, a watchlist, and a
 * research queue that an assigned LLM researcher works through later.
 *
 * A run is a background job. Each stage records progress, and a failure ends
 * the run as "failed" with the reason; nothing is retried silently.
 */
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppError } from "../http/errors.js";
import { barMetrics, scoreCandidates } from "./scoring.js";
import { buildUniverse, liquidityFrom } from "./universe.js";
import { applyFilterRules, applyQualityGates, FilterRuleSchema, METRICS, PRESETS, QualityGatesSchema } from "./screen.js";

const SP500_LIST = "sp500";
const SP500_MAX_AGE_MS = 7 * 86_400_000;
const FUNDAMENTALS_MAX_AGE_MS = 7 * 86_400_000;
const LISTING_CACHE_MS = 12 * 3_600_000;
const LIQUIDITY_DAYS = 5;
const MIN_BARS = 60;
const SEED_URL = new URL("./data/sp500-seed.json", import.meta.url);

export const RunParamsSchema = z.object({
  minPrice: z.number().min(1).max(1_000).default(5),
  minDollarVolume: z.number().min(100_000).max(1_000_000_000).default(10_000_000),
  maxAnalyzed: z.number().int().min(20).max(800).default(300),
  fundamentalsTop: z.number().int().min(0).max(150).default(60),
  minMarketCapMillions: z.number().min(0).max(5_000_000).default(300),
  maxMarketCapMillions: z.number().min(0).max(5_000_000).nullable().default(null),
  excludeSp500: z.boolean().default(true),
  excludeBlankCheck: z.boolean().default(true),
  qualityGates: QualityGatesSchema.prefault({}),
  filters: z.array(FilterRuleSchema).max(12).default([])
}).strict();

// Bumped when the fundamentals payload shape changes; older cache entries are refetched.
export const FUNDAMENTALS_VERSION = 2;

/**
 * Turns Finnhub's reported market cap into a USD figure only when it agrees
 * with the US trading price: reported cap / shares outstanding must be within
 * 0.8–1.25x the price. Foreign filers (reported in DKK, INR, CAD...) and ADRs
 * (one ADR is a fraction of a share) fail this, so their cap is shown as
 * reported but not used for the USD market-cap limits.
 */
export function verifyMarketCap(fundamentals, price) {
  const reported = fundamentals?.marketCapReportedMillions;
  if (reported === null || reported === undefined) return { ...fundamentals, marketCapMillions: null, marketCapVerified: false, marketCapNote: null };
  const shares = fundamentals.sharesOutstandingMillions;
  if (shares && Number.isFinite(price) && price > 0) {
    const perShare = reported / shares;
    const ratio = perShare / price;
    if (ratio >= 0.8 && ratio <= 1.25) return { ...fundamentals, marketCapMillions: reported, marketCapVerified: true, marketCapNote: null };
    const currency = fundamentals.reportedCurrency ?? "unknown currency";
    return { ...fundamentals, marketCapMillions: null, marketCapVerified: false, marketCapNote: `Finnhub's figure (${currency}) implies ${perShare.toFixed(2)} a share against $${price.toFixed(2)} traded here, so it is not in USD per US share and the market-cap limits were not applied.` };
  }
  const usd = fundamentals.reportedCurrency === null || fundamentals.reportedCurrency === "USD";
  return { ...fundamentals, marketCapMillions: usd ? reported : null, marketCapVerified: false, marketCapNote: usd ? "Not checked against the trading price." : `Reported in ${fundamentals.reportedCurrency}; the market-cap limits were not applied.` };
}

export const WATCH_STATUSES = Object.freeze(["watching", "researching", "shortlisted", "holding", "rejected"]);
const SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;

/** Most recent weekdays strictly before `now` in New York, newest first. */
export function recentWeekdays(now, count) {
  const dates = [];
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" });
  for (let back = 1; dates.length < count && back < count * 3 + 10; back += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(now - back * 86_400_000).map((part) => [part.type, part.value]));
    if (parts.weekday === "Sat" || parts.weekday === "Sun") continue;
    dates.push(`${parts.year}-${parts.month}-${parts.day}`);
  }
  return dates;
}

export function createDiscoveryService({
  repositories,
  sources,
  researchAdapters = null,
  webSources = {},
  researchers = [],
  clock = () => Date.now(),
  idFactory = () => crypto.randomUUID(),
  logger = console
}) {
  const repo = repositories.discovery;
  let listingCache = null;
  let active = null;

  async function sp500Members() {
    const stored = await repo.getReferenceList(SP500_LIST);
    if (stored && clock() - stored.fetchedAt < SP500_MAX_AGE_MS) return { symbols: stored.symbolsJson, asOf: stored.asOf, source: stored.source };
    try {
      const fresh = await sources.sp500();
      await repo.putReferenceList({ name: SP500_LIST, source: "SSGA SPY holdings", asOf: fresh.asOf, symbols: fresh.symbols, fetchedAt: clock() });
      return { symbols: fresh.symbols, asOf: fresh.asOf, source: "SSGA SPY holdings" };
    } catch (error) {
      if (stored) return { symbols: stored.symbolsJson, asOf: stored.asOf, source: `${stored.source} (stored; refresh failed: ${error.message})` };
      const seed = JSON.parse(await readFile(SEED_URL, "utf8"));
      return { symbols: seed.symbols, asOf: seed.asOf, source: `bundled list ${seed.asOf} (refresh failed: ${error.message})` };
    }
  }

  async function listings() {
    if (listingCache && clock() - listingCache.at < LISTING_CACHE_MS) return listingCache;
    const [assets, directory] = await Promise.all([sources.stockAssets(), sources.nasdaqDirectory()]);
    listingCache = { assets, directory, at: clock() };
    return listingCache;
  }

  /** Ensures the last LIQUIDITY_DAYS trading days of whole-market rows are stored. */
  async function marketDays(progress) {
    const wanted = recentWeekdays(clock(), LIQUIDITY_DAYS + 4);
    const tradingDates = [];
    for (const date of wanted) {
      if (tradingDates.length >= LIQUIDITY_DAYS) break;
      if (!(await repo.hasMarketDate(date))) {
        progress(`Fetching whole-market daily data for ${date}`);
        const rows = await sources.groupedDaily(date);
        await repo.storeMarketDay({ date, rows, source: "polygon-grouped-daily", fetchedAt: clock() });
      }
      const [rows] = await repo.marketRows([date]);
      if (rows.length) tradingDates.push(date);
    }
    if (!tradingDates.length) throw new Error("No whole-market daily data is available for the last two weeks.");
    return { dates: tradingDates, rows: await repo.marketRows(tradingDates) };
  }

  async function fundamentalsFor(symbol) {
    const cached = await repo.getFundamentals(symbol, "finnhub", FUNDAMENTALS_MAX_AGE_MS, clock());
    if (cached && cached.version === FUNDAMENTALS_VERSION) return cached;
    const fresh = { ...(await sources.fundamentals(symbol)), version: FUNDAMENTALS_VERSION };
    await repo.putFundamentals({ symbol, source: "finnhub", payload: fresh, fetchedAt: clock() });
    return fresh;
  }

  async function execute(run, params) {
    const stats = { stages: {} };
    const progress = (stage) => {
      stats.stage = stage;
      void repo.updateRunProgress(run.id, { stage, at: clock() }).catch(() => undefined);
    };

    progress("Loading the S&P 500 membership list");
    const sp500 = await sp500Members();
    stats.sp500 = { count: sp500.symbols.length, asOf: sp500.asOf, source: sp500.source };

    progress("Loading every listed US stock");
    const { assets, directory } = await listings();
    const universe = buildUniverse({ assets, directory, sp500: sp500.symbols, rules: { excludeSp500: params.excludeSp500, excludeBlankCheck: params.excludeBlankCheck } });
    stats.universe = { considered: universe.considered, eligible: universe.members.length, excluded: universe.excluded };

    const market = await marketDays(progress);
    const liquidity = liquidityFrom(market.rows);
    stats.liquidity = { dates: market.dates };
    const liquid = [];
    let tooCheap = 0;
    let tooThin = 0;
    let noData = 0;
    for (const member of universe.members) {
      const stat = liquidity.get(member.symbol);
      if (!stat) { noData += 1; continue; }
      if (stat.close < params.minPrice) { tooCheap += 1; continue; }
      if (stat.dollarVolume < params.minDollarVolume) { tooThin += 1; continue; }
      liquid.push({ ...member, close: stat.close, dollarVolume: stat.dollarVolume });
    }
    liquid.sort((left, right) => right.dollarVolume - left.dollarVolume);
    const analyzed = liquid.slice(0, params.maxAnalyzed);
    stats.liquidity = { ...stats.liquidity, passed: liquid.length, belowMinPrice: tooCheap, belowMinDollarVolume: tooThin, noRecentTrades: noData, analyzed: analyzed.length };

    progress(`Fetching a year of daily bars for ${analyzed.length} stocks`);
    const bars = await sources.dailyBars(analyzed.map((member) => member.symbol));
    let candidates = [];
    let shortHistory = 0;
    for (const member of analyzed) {
      const metrics = barMetrics(bars[member.symbol]);
      if (!metrics || metrics.bars < MIN_BARS) { shortHistory += 1; continue; }
      candidates.push({ symbol: member.symbol, name: member.name, exchange: member.exchange, metrics: { ...metrics, avgDollarVolume5d: Math.round(member.dollarVolume) }, inputs: { ...metrics } });
    }
    stats.bars = { scored: candidates.length, tooShortHistory: shortHistory };

    progress("Applying quality gates and price filters");
    const quality = applyQualityGates(candidates, params.qualityGates);
    stats.quality = { ...quality.stats, passed: quality.kept.length };
    const priceRules = applyFilterRules(quality.kept, params.filters, "price");
    candidates = priceRules.kept;
    stats.filters = priceRules.applied;

    let fundamentalsFetched = 0;
    let fundamentalsFailed = 0;
    let outsideMarketCap = 0;
    if (params.fundamentalsTop > 0 && sources.configured?.finnhub !== false) {
      const preliminary = scoreCandidates(candidates)
        .sort((a, b) => Math.max(b.scores.growth.score ?? 0, b.scores.hold.score ?? 0) - Math.max(a.scores.growth.score ?? 0, a.scores.hold.score ?? 0))
        .slice(0, params.fundamentalsTop);
      const chosen = new Set(preliminary.map((candidate) => candidate.symbol));
      let done = 0;
      for (const candidate of candidates) {
        if (!chosen.has(candidate.symbol)) continue;
        done += 1;
        progress(`Fetching fundamentals (${done}/${chosen.size}): ${candidate.symbol}`);
        try {
          candidate.fundamentals = verifyMarketCap(await fundamentalsFor(candidate.symbol), candidate.metrics.price);
          Object.assign(candidate.inputs, candidate.fundamentals);
          fundamentalsFetched += 1;
        } catch (error) {
          fundamentalsFailed += 1;
          candidate.fundamentalsError = error.message;
        }
      }
      candidates = candidates.filter((candidate) => {
        // Null when the reported cap does not match the US price (foreign filers, ADRs);
        // such stocks are kept and flagged rather than filtered on a wrong number.
        const cap = candidate.fundamentals?.marketCapMillions;
        if (cap === null || cap === undefined) return true;
        const outside = cap < params.minMarketCapMillions || (params.maxMarketCapMillions !== null && cap > params.maxMarketCapMillions);
        if (outside) outsideMarketCap += 1;
        return !outside;
      });
    }
    const unverifiedCap = candidates.filter((candidate) => candidate.fundamentals && candidate.fundamentals.marketCapMillions === null && candidate.fundamentals.marketCapReportedMillions !== null && candidate.fundamentals.marketCapReportedMillions !== undefined).length;
    stats.fundamentals = { fetched: fundamentalsFetched, failed: fundamentalsFailed, outsideMarketCap, marketCapUnverified: unverifiedCap };
    const fundamentalRules = applyFilterRules(candidates, params.filters, "fundamentals");
    candidates = fundamentalRules.kept;
    stats.filters = [...stats.filters, ...fundamentalRules.applied];

    progress("Scoring");
    const scored = scoreCandidates(candidates).map(({ inputs, ...candidate }) => candidate);
    await repo.insertCandidates(run.id, scored);
    stats.candidates = scored.length;
    delete stats.stage;
    return stats;
  }

  async function startRun(input = {}) {
    const parsed = RunParamsSchema.safeParse(input);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", "Discovery settings are invalid.", 400, parsed.error.flatten());
    if (!sources.configured?.alpaca || !sources.configured?.polygon) {
      throw new AppError("DISCOVERY_SOURCES_MISSING", "Discovery needs ALPACA_API_KEY/ALPACA_API_SECRET and POLYGON_API_KEY on the server.", 503);
    }
    if (active || await repo.runningRun()) throw new AppError("DISCOVERY_RUN_ACTIVE", "A discovery run is already in progress.", 409);
    const run = await repo.createRun({ id: idFactory(), params: parsed.data, createdAt: clock() });
    active = execute(run, parsed.data)
      .then((stats) => repo.finishRun(run.id, { status: "completed", stats, completedAt: clock() }))
      .catch(async (error) => {
        logger.error?.(`Discovery run ${run.id} failed:`, error);
        await repo.finishRun(run.id, { status: "failed", error: error.message, completedAt: clock() });
      })
      .finally(() => { active = null; });
    return run;
  }

  async function waitForActive() { await active; }

  async function getRun(id, options) {
    const run = await repo.getRun(id);
    if (!run) throw new AppError("NOT_FOUND", `No discovery run ${id}.`, 404);
    const watch = new Map((await repo.listWatchlist()).map((row) => [row.symbol, row.status]));
    const candidates = run.status === "completed" ? await repo.listCandidates(id, options) : [];
    return { run, candidates: candidates.map((candidate) => ({ ...candidate, watchStatus: watch.get(candidate.symbol) ?? null })) };
  }

  function normalizeSymbol(value) {
    const symbol = String(value ?? "").trim().toUpperCase();
    if (!SYMBOL.test(symbol)) throw new AppError("VALIDATION_ERROR", "A US ticker symbol is required.", 400);
    return symbol;
  }

  async function watch(symbol, { status = "watching", note, sourceRunId } = {}) {
    if (!WATCH_STATUSES.includes(status)) throw new AppError("VALIDATION_ERROR", `status must be one of ${WATCH_STATUSES.join(", ")}.`, 400);
    return repo.upsertWatch({ symbol: normalizeSymbol(symbol), status, note, sourceRunId, at: clock() });
  }

  async function watchlist() {
    const rows = await repo.listWatchlist();
    return Promise.all(rows.map(async (row) => {
      const candidate = await repo.latestCandidate(row.symbol);
      const [research] = await repo.listResearchRequests({ symbol: row.symbol, limit: 1 });
      return { ...row, latest: candidate ? { runId: candidate.runId, growthScore: candidate.growthScore, holdScore: candidate.holdScore, metrics: candidate.metricsJson, fundamentals: candidate.fundamentalsJson } : null, research: research ?? null };
    }));
  }

  function researchConfig() {
    return {
      researchers,
      scrapers: Object.keys(webSources).map((id) => ({ id, origin: webSources[id]?.origin ?? null, kind: "web.page.v1" })),
      adapters: researchAdapters?.list?.() ?? [],
      note: researchers.length
        ? null
        : "No LLM researcher is assigned yet. Research requests wait in the queue until one is; nothing is lost."
    };
  }

  async function requestResearch({ symbol, question, scrapers = [] }) {
    const ticker = normalizeSymbol(symbol);
    const unknown = scrapers.filter((id) => !(id in webSources));
    if (unknown.length) throw new AppError("VALIDATION_ERROR", `Unknown scraper(s): ${unknown.join(", ")}. Register them in RESEARCH_WEB_SOURCES_JSON first.`, 400);
    const [open] = (await repo.listResearchRequests({ symbol: ticker, limit: 5 })).filter((request) => ["pending", "claimed"].includes(request.status));
    if (open) throw new AppError("DISCOVERY_RESEARCH_OPEN", `${ticker} already has an open research request.`, 409, { id: open.id });
    const request = await repo.createResearchRequest({ id: idFactory(), symbol: ticker, question, scrapers, createdAt: clock() });
    const current = await repo.getWatch(ticker);
    if (!current || ["watching", "rejected"].includes(current.status)) await watch(ticker, { status: "researching" });
    return request;
  }

  async function transition(id, from, changes, code) {
    const ok = await repo.transitionResearch(id, from, changes);
    const request = await repo.getResearchRequest(id);
    if (!request) throw new AppError("NOT_FOUND", `No research request ${id}.`, 404);
    if (!ok) throw new AppError(code, `Research request is ${request.status}.`, 409);
    return request;
  }

  return Object.freeze({
    startRun,
    waitForActive,
    getRun,
    listRuns: (limit) => repo.listRuns(limit),
    latestRun: async () => (await repo.listRuns(1))[0] ?? null,
    watch,
    unwatch: async (symbol) => repo.removeWatch(normalizeSymbol(symbol)),
    watchlist,
    researchConfig,
    screeningOptions: () => ({ presets: PRESETS, metrics: METRICS, defaults: RunParamsSchema.parse({}) }),
    requestResearch,
    listResearch: (options) => repo.listResearchRequests(options),
    claimResearch: (id, researcher) => transition(id, ["pending"], { status: "claimed", researcher, claimedAt: clock() }, "DISCOVERY_RESEARCH_STATE"),
    completeResearch: (id, result) => transition(id, ["claimed"], { status: "completed", result, completedAt: clock() }, "DISCOVERY_RESEARCH_STATE"),
    failResearch: (id, error) => transition(id, ["claimed"], { status: "failed", error: String(error).slice(0, 2_000), completedAt: clock() }, "DISCOVERY_RESEARCH_STATE"),
    cancelResearch: (id) => transition(id, ["pending", "claimed"], { status: "cancelled", completedAt: clock() }, "DISCOVERY_RESEARCH_STATE"),
    recover: async () => repo.failAbandonedRuns(clock())
  });
}
