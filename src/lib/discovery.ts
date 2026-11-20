import { api } from "./api";

export type Lens = "growth" | "hold";
export type WatchStatus = "watching" | "researching" | "shortlisted" | "holding" | "rejected";
export const WATCH_STATUSES: WatchStatus[] = ["watching", "researching", "shortlisted", "holding", "rejected"];

export type FilterCondition = "greater_than" | "less_than" | "between";
export type FilterRule = { metric: string; condition: FilterCondition; value: number | [number, number] };
export type QualityGates = { enabled: boolean; maxVolatilityConsistency: number; maxDailySpikePct: number; maxVolumeConcentrationPct: number };

export type DiscoveryParams = {
  minPrice: number;
  minDollarVolume: number;
  maxAnalyzed: number;
  fundamentalsTop: number;
  minMarketCapMillions: number;
  maxMarketCapMillions: number | null;
  excludeSp500: boolean;
  excludeBlankCheck: boolean;
  qualityGates: QualityGates;
  filters: FilterRule[];
};

export const DEFAULT_QUALITY_GATES: QualityGates = { enabled: true, maxVolatilityConsistency: 5, maxDailySpikePct: 40, maxVolumeConcentrationPct: 30 };

export const DEFAULT_PARAMS: DiscoveryParams = {
  minPrice: 5,
  minDollarVolume: 10_000_000,
  maxAnalyzed: 300,
  fundamentalsTop: 60,
  minMarketCapMillions: 300,
  maxMarketCapMillions: null,
  excludeSp500: true,
  excludeBlankCheck: true,
  qualityGates: DEFAULT_QUALITY_GATES,
  filters: []
};

export type MetricInfo = { label: string; unit: string; scale: number; source: "price" | "fundamentals" };
export type ScreeningPreset = { id: string; name: string; description: string; params: Partial<DiscoveryParams> };
export type ScreeningOptions = { presets: ScreeningPreset[]; metrics: Record<string, MetricInfo>; defaults: DiscoveryParams };

/** A preset applied over the defaults, so switching presets never keeps stale settings. */
export function applyPreset(preset: ScreeningPreset, defaults: DiscoveryParams = DEFAULT_PARAMS): DiscoveryParams {
  return { ...defaults, ...preset.params, qualityGates: { ...defaults.qualityGates, ...(preset.params.qualityGates ?? {}) }, filters: preset.params.filters ?? [] };
}

export type LensScore = { score: number | null; coverage: number | null; strengths: string[]; concerns: string[] };

export type DiscoveryCandidate = {
  runId: string;
  symbol: string;
  name: string | null;
  exchange: string | null;
  growthScore: number | null;
  holdScore: number | null;
  metricsJson: {
    price: number | null; mom12m: number | null; mom6m: number | null; mom3m: number | null; fromHigh: number | null;
    vol1y: number | null; maxDrawdown1y: number | null; trend: boolean | null; bars: number; avgDollarVolume5d: number | null;
    adx14?: number | null; atrPct14?: number | null; volatilityConsistency?: number | null; maxDailySpikePct?: number | null;
    volumeConcentrationPct?: number | null; priceVsSma200Pct?: number | null;
  };
  fundamentalsJson: null | {
    industry: string | null; marketCapMillions: number | null; marketCapReportedMillions?: number | null; reportedCurrency?: string | null; marketCapVerified?: boolean; marketCapNote?: string | null; revenueGrowthTTM: number | null; revenueGrowth3Y: number | null;
    netMarginTTM: number | null; grossMarginTTM: number | null; roeTTM: number | null; psTTM: number | null;
  };
  scoresJson: { growth: LensScore; hold: LensScore };
  watchStatus: WatchStatus | null;
};

export type DiscoveryRunRecord = {
  id: string;
  status: "running" | "completed" | "failed";
  paramsJson: DiscoveryParams;
  progressJson: { stage?: string; at?: number };
  statsJson: {
    sp500?: { count: number; asOf: string | null; source: string };
    universe?: { considered: number; eligible: number; excluded: Record<string, number> };
    liquidity?: { dates: string[]; passed: number; belowMinPrice: number; belowMinDollarVolume: number; noRecentTrades: number; analyzed: number };
    bars?: { scored: number; tooShortHistory: number };
    quality?: { enabled: boolean; limits: Record<string, number>; removed: Record<string, number>; unmeasured: number; passed: number };
    filters?: { rule: string; removed: number; missingData: number; remaining: number }[];
    fundamentals?: { fetched: number; failed: number; outsideMarketCap: number; marketCapUnverified?: number };
    candidates?: number;
  };
  error: string | null;
  createdAt: number;
  completedAt: number | null;
};

export type DiscoveryRun = { run: DiscoveryRunRecord; candidates: DiscoveryCandidate[] };

export type ResearchRequest = {
  id: string; symbol: string; status: "pending" | "claimed" | "completed" | "failed" | "cancelled";
  question: string | null; researcher: string | null; scrapersJson: string[];
  resultJson: null | { summary: string; verdict?: string; evidence?: { title: string; url?: string; note?: string }[] };
  error: string | null; createdAt: number; completedAt: number | null;
};

export type WatchEntry = {
  symbol: string; status: WatchStatus; note: string | null; addedAt: number; updatedAt: number;
  latest: null | { runId: string; growthScore: number | null; holdScore: number | null; metrics: DiscoveryCandidate["metricsJson"]; fundamentals: DiscoveryCandidate["fundamentalsJson"] };
  research: ResearchRequest | null;
};

export type ResearchConfig = {
  researchers: { id: string; label?: string }[];
  scrapers: { id: string; origin: string | null; kind: string }[];
  note: string | null;
};

export const fetchLatestDiscovery = (lens: Lens) => api.get<DiscoveryRun | null>(`/discovery/runs/latest?lens=${lens}&limit=300`);
export const fetchDiscoveryRun = (id: string, lens: Lens) => api.get<DiscoveryRun>(`/discovery/runs/${encodeURIComponent(id)}?lens=${lens}&limit=300`);
export const startDiscoveryRun = (params: DiscoveryParams) => api.post<DiscoveryRunRecord>("/discovery/runs", params);
export const fetchScreeningOptions = () => api.get<ScreeningOptions>("/discovery/screening");
export const fetchWatchlist = () => api.get<WatchEntry[]>("/discovery/watchlist");
export const setWatch = (symbol: string, body: { status?: WatchStatus; note?: string; sourceRunId?: string }) => api.put<WatchEntry>(`/discovery/watchlist/${encodeURIComponent(symbol)}`, body);
export const removeWatch = (symbol: string) => api.delete<{ removed: boolean }>(`/discovery/watchlist/${encodeURIComponent(symbol)}`);
export const fetchResearchConfig = () => api.get<ResearchConfig>("/discovery/research/config");
export const requestResearch = (body: { symbol: string; question?: string; scrapers?: string[] }) => api.post<ResearchRequest>("/discovery/research", body);
export const cancelResearch = (id: string) => api.post<ResearchRequest>(`/discovery/research/${encodeURIComponent(id)}/cancel`);
