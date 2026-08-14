import type { Bar, Metrics, Quote, Session, UnavailableQuote } from "../../packages/shared/schemas.js";
import type { BarInterval, RangeKey } from "../../packages/shared/ranges.js";

export type NullableNumber = number | null | undefined;

export type Position = {
  symbol: string;
  side?: "long" | "short";
  qty: number;
  avgPrice: number;
  price: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  dataStatus?: "real" | "unavailable";
  dataSource?: string;
  dataError?: string;
};

export type EquityPoint = { at: number; equity: number };

export type Portfolio = {
  accountId?: string;
  mode?: "paper" | "live";
  equity?: number | null;
  cash?: number;
  buyingPower?: number;
  dayChange?: number | null;
  dayChangePercent?: number | null;
  realizedPnl?: number | null;
  riskUsedPercent?: number | null;
  positions: Position[];
  equityHistory?: EquityPoint[];
};

export type SessionSummary = Session & {
  metrics?: Partial<Metrics> & { vsSpy?: number | null };
};

export type SessionDetail = SessionSummary;

export type ActivityItem = {
  id: string;
  at: number;
  type: string;
  severity?: "info" | "warn" | "block" | "halt";
  title?: string;
  detail?: string;
  signalReason?: string;
  symbol?: string;
};

export type RiskBudgetItem = {
  id: string;
  label: string;
  observed: number | null;
  limit: number | null;
  percent?: number | null;
  unit: "money" | "percent" | "count";
};

export type RiskSummary = {
  usedPercent?: number | null;
  budgets: RiskBudgetItem[];
};

export type ProviderHealth = {
  id: string;
  name?: string;
  configured?: boolean;
  status: "healthy" | "degraded" | "unavailable" | "unconfigured" | "unknown";
  latencyMs?: number | null;
  lastSuccessAt?: number | null;
  lastErrorAt?: number | null;
  message?: string | null;
};

export type Algorithm = {
  id: string;
  name: string;
  description?: string;
  author?: string;
  enabled?: boolean;
  params?: Record<string, number | string | boolean>;
  version?: { id: string; hash: string; createdAt: number } | null;
  source?: string;
  sourceHash?: string;
  file?: string;
  uploaded?: boolean;
};

export type AlgorithmVersion = {
  id: string;
  sourceHash?: string;
  createdAt: number;
  params?: Record<string, unknown>;
  paramsJson?: Record<string, unknown>;
  sourceCode?: string;
};

export type NormalizedEquityPoint = { at: number; value: number };

export type SessionComparisonEntry = {
  session: SessionSummary;
  metrics?: Partial<Metrics> | null;
  equity: EquityPoint[];
  normalizedEquity: NormalizedEquityPoint[];
};

export type SessionCompare = {
  sessions: SessionComparisonEntry[];
  metricMatrix?: Record<string, Record<string, number | null>>;
  configDiff?: Record<string, Record<string, unknown>>;
};

export type SettingField = {
  key: string;
  label: string;
  secret: boolean;
  readOnly: boolean;
  hasValue: boolean;
  value: string | number | boolean | null;
};

export type SettingGroup = {
  id: string;
  label: string;
  fields: SettingField[];
};

export type SystemSettings = {
  encryptionReady: boolean;
  groups: SettingGroup[];
};

export type DatabaseLocation = "local" | "remote";

export type DatabaseTlsMode = "disable" | "require" | "verify-full";

export type DatabaseConnectionProfile = {
  location: DatabaseLocation;
  hostname: string;
  connectAddress?: string;
  port: number;
  database: string;
  username: string;
  sslMode: DatabaseTlsMode;
  passwordConfigured: boolean;
};

export type DatabaseConnectionSettings = {
  configuration: DatabaseConnectionProfile | null;
  active: {
    dialect: "postgres";
    hostname: string;
    connectAddress?: string;
    port: number;
    database: string;
    username: string;
    sslMode: DatabaseTlsMode;
  } | { dialect: "sqlite" };
  restartRequired: boolean;
};

export type DatabaseConnectionInput = Omit<DatabaseConnectionProfile, "passwordConfigured"> & {
  password?: string;
};

export type DatabaseConnectionTestResult = {
  ok: boolean;
  message?: string;
  user?: string;
  database?: string;
  tls?: boolean;
};

export type DatabaseConnectionSaveResult = DatabaseConnectionSettings;

export type MarketAsset = {
  symbol: string;
  name: string;
  sector?: string;
  aliases?: string[];
  matchReason?: string;
  quote?: Quote | UnavailableQuote;
};

export type MarketDiagnostics = {
  rsi: number | null;
  emaFast: number | null;
  emaSlow: number | null;
  atr: number | null;
  vwap: number | null;
};

export type MarketBars = {
  symbol: string;
  range: RangeKey;
  interval: BarInterval;
  source: string;
  bars: Bar[];
  diagnostics: MarketDiagnostics;
};

export type OverviewAggregate = {
  portfolio?: Portfolio;
  activeSessions: SessionSummary[];
  riskBudget?: RiskSummary;
  activity: ActivityItem[];
  alerts: ActivityItem[];
  dataHealth: ProviderHealth[];
};
