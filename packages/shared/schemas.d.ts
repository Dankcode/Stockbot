import type { z } from "zod";
import type { BarInterval } from "./ranges.js";

export type RangeKey = "1H" | "1D" | "1W" | "1M" | "3M" | "1Y" | "ALL";
export type QuoteStatus = "real" | "stale";
export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit" | "stop" | "stop_limit";
export type OrderStatus = "pending" | "filled" | "partial" | "rejected" | "canceled";
export type SessionMode = "backtest" | "paper";
export type SessionStatus =
  | "draft"
  | "arming"
  | "running"
  | "paused"
  | "stopping"
  | "halted"
  | "stopped"
  | "errored";
export type StopReason = "user" | "schedule" | "risk_halt" | "error" | "completed";
export type RiskRuleScope = "session" | "account";
export type RiskRulePhase = "pre_trade" | "continuous";
export type RiskRuleSeverity = "warn" | "block" | "halt";

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  status: QuoteStatus;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number | null;
  at: number;
  source: string;
}

export interface UnavailableQuote {
  symbol: string;
  status: "unavailable";
  error: string;
  checkedAt: number;
  source?: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  sessionId: string | null;
  researchSnapshotId: string | null;
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: number;
  limitPrice: number | null;
  status: OrderStatus;
  rejectReason: string | null;
  signalReason: string | null;
  signalBarAt: number | null;
  submittedAt: number;
  resolvedAt: number | null;
}

export interface Fill {
  id: string;
  orderId: string;
  qty: number;
  price: number;
  referencePrice: number;
  commission: number;
  filledAt: number;
  quoteAgeMs: number | null;
}

export interface Metrics {
  returnPercent: number | null;
  finalEquity: number | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  sortino: number | null;
  profitFactor: number | null;
  winRate: number | null;
  tradeCount: number;
  exposurePercent: number | null;
  avgTradePercent: number | null;
}

export interface SessionMetrics extends Metrics {
  id: string;
  sessionId: string;
  computedAt: number;
  metricsVersion: string;
}

export interface Session {
  id: string;
  accountId: string;
  name: string;
  mode: SessionMode;
  status: SessionStatus;
  algorithmVersionId: string | null;
  researchPlanVersionId: string | null;
  params: Record<string, unknown>;
  symbols: string[];
  barInterval: BarInterval;
  windowStart: number | null;
  windowEnd: number | null;
  fillModel: Record<string, unknown>;
  riskProfile: Record<string, unknown>;
  schedule: Record<string, unknown>;
  startingEquity: number;
  endingEquity: number | null;
  startedAt: number | null;
  endedAt: number | null;
  stopReason: StopReason | null;
  errorDetail: string | null;
  createdAt: number;
}

export interface RiskRule {
  id: string;
  scope: RiskRuleScope;
  phase: RiskRulePhase;
  severity: RiskRuleSeverity;
  enabled: boolean;
  threshold?: number;
  config: Record<string, unknown>;
}

export interface RiskRuleResult {
  triggered: boolean;
  observed: unknown;
  threshold: unknown;
  message: string;
}

export interface ApiMeta {
  requestId?: string;
  cursor?: string | null;
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
  [key: string]: unknown;
}

export interface ApiError<Detail = unknown> {
  code: string;
  message: string;
  detail?: Detail;
}

export interface ApiSuccessEnvelope<Data, Meta = ApiMeta> {
  data: Data;
  meta: Meta;
}

export interface ApiErrorEnvelope<Detail = unknown> {
  error: ApiError<Detail>;
}

export type ApiEnvelope<Data, Meta = ApiMeta, Detail = unknown> =
  | ApiSuccessEnvelope<Data, Meta>
  | ApiErrorEnvelope<Detail>;

export const IdSchema: z.ZodType<string>;
export const SymbolSchema: z.ZodType<string>;
export const EpochMsSchema: z.ZodType<number>;
export const MoneySchema: z.ZodType<number>;
export const NonnegativeMoneySchema: z.ZodType<number>;
export const QuantitySchema: z.ZodType<number>;
export const BarIntervalSchema: z.ZodType<BarInterval>;
export const RangeKeySchema: z.ZodType<RangeKey>;
export const BarSchema: z.ZodType<Bar>;
export const QuoteStatusSchema: z.ZodType<QuoteStatus>;
export const QuoteSchema: z.ZodType<Quote>;
export const UnavailableQuoteSchema: z.ZodType<UnavailableQuote>;
export const MarketQuoteSchema: z.ZodType<Quote | UnavailableQuote>;
export const OrderSideSchema: z.ZodType<OrderSide>;
export const OrderTypeSchema: z.ZodType<OrderType>;
export const OrderStatusSchema: z.ZodType<OrderStatus>;
export const OrderSchema: z.ZodType<Order>;
export const FillSchema: z.ZodType<Fill>;
export const MetricsSchema: z.ZodType<Metrics>;
export const SessionMetricsSchema: z.ZodType<SessionMetrics>;
export const SessionModeSchema: z.ZodType<SessionMode>;
export const SessionStatusSchema: z.ZodType<SessionStatus>;
export const StopReasonSchema: z.ZodType<StopReason>;
export const SessionSchema: z.ZodType<Session>;
export const RiskRuleScopeSchema: z.ZodType<RiskRuleScope>;
export const RiskRulePhaseSchema: z.ZodType<RiskRulePhase>;
export const RiskRuleSeveritySchema: z.ZodType<RiskRuleSeverity>;
export const RiskRuleSchema: z.ZodType<RiskRule>;
export const RiskRuleResultSchema: z.ZodType<RiskRuleResult>;
export const ApiMetaSchema: z.ZodType<ApiMeta>;
export const ApiErrorSchema: z.ZodType<ApiError>;
export const SuccessEnvelopeSchema: z.ZodType<ApiSuccessEnvelope<unknown>>;
export const ErrorEnvelopeSchema: z.ZodType<ApiErrorEnvelope>;
export const ApiEnvelopeSchema: z.ZodType<ApiEnvelope<unknown>>;

export function createSuccessEnvelopeSchema<
  DataSchema extends z.ZodTypeAny,
  MetaSchema extends z.ZodTypeAny = typeof ApiMetaSchema
>(dataSchema: DataSchema, metaSchema?: MetaSchema): z.ZodType<ApiSuccessEnvelope<z.output<DataSchema>, z.output<MetaSchema>>>;

export function createErrorEnvelopeSchema<DetailSchema extends z.ZodTypeAny = z.ZodUnknown>(
  detailSchema?: DetailSchema
): z.ZodType<ApiErrorEnvelope<z.output<DetailSchema>>>;

export function createApiEnvelopeSchema<
  DataSchema extends z.ZodTypeAny,
  MetaSchema extends z.ZodTypeAny = typeof ApiMetaSchema,
  DetailSchema extends z.ZodTypeAny = z.ZodUnknown
>(
  dataSchema: DataSchema,
  metaSchema?: MetaSchema,
  detailSchema?: DetailSchema
): z.ZodType<ApiEnvelope<z.output<DataSchema>, z.output<MetaSchema>, z.output<DetailSchema>>>;
