import { z } from "zod";
import {
  BarIntervalSchema,
  BarSchema,
  EpochMsSchema,
  FillSchema,
  IdSchema,
  MarketQuoteSchema,
  MetricsSchema,
  MoneySchema,
  NonnegativeMoneySchema,
  OrderSchema,
  RangeKeySchema,
  SessionMetricsSchema,
  SessionModeSchema,
  SessionStatusSchema,
  StopReasonSchema,
  SymbolSchema
} from "../../packages/shared/schemas.js";

const FiniteNumberSchema = z.number().finite();
const NonnegativeNumberSchema = FiniteNumberSchema.nonnegative();
const NonnegativeIntegerSchema = z.number().int().safe().nonnegative();
const NonemptyStringSchema = z.string().trim().min(1);
const ResourceRecordSchema = z.record(z.string(), z.unknown());

export const SessionSummarySchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  name: z.string().trim().min(1).max(200),
  mode: SessionModeSchema,
  status: SessionStatusSchema,
  algorithmVersionId: IdSchema.nullable(),
  params: ResourceRecordSchema,
  symbols: z.array(SymbolSchema).min(1),
  barInterval: BarIntervalSchema,
  windowStart: EpochMsSchema.nullable(),
  windowEnd: EpochMsSchema.nullable(),
  fillModel: ResourceRecordSchema,
  riskProfile: ResourceRecordSchema,
  schedule: ResourceRecordSchema,
  startingEquity: NonnegativeMoneySchema,
  endingEquity: NonnegativeMoneySchema.nullable(),
  startedAt: EpochMsSchema.nullable(),
  endedAt: EpochMsSchema.nullable(),
  stopReason: StopReasonSchema.nullable(),
  errorDetail: NonemptyStringSchema.nullable(),
  createdAt: EpochMsSchema,
  metrics: SessionMetricsSchema.nullable().optional()
}).strict();

export const SessionListSchema = z.array(SessionSummarySchema);

export const SessionDetailResponseSchema = z.object({
  session: SessionSummarySchema.omit({ metrics: true }),
  metrics: SessionMetricsSchema.nullable()
}).strict();

export const EquitySnapshotSchema = z.object({
  sessionId: IdSchema,
  at: EpochMsSchema,
  equity: NonnegativeMoneySchema,
  cash: MoneySchema,
  positionValue: NonnegativeMoneySchema,
  drawdownPercent: NonnegativeNumberSchema
}).strict();

export const EquitySeriesSchema = z.array(EquitySnapshotSchema);

export const SessionOrderSchema = z.object({
  id: IdSchema,
  clientOrderId: IdSchema,
  sessionId: IdSchema.nullable(),
  accountId: IdSchema,
  symbol: SymbolSchema,
  side: z.enum(["buy", "sell"]),
  orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
  qty: z.number().int().safe().positive(),
  limitPrice: NonnegativeMoneySchema.nullable(),
  status: z.enum(["pending", "filled", "partial", "rejected", "canceled"]),
  rejectReason: NonemptyStringSchema.nullable(),
  signalReason: NonemptyStringSchema.nullable(),
  signalBarAt: EpochMsSchema.nullable(),
  submittedAt: EpochMsSchema,
  resolvedAt: EpochMsSchema.nullable(),
  fills: z.array(FillSchema)
}).strict();

export const SessionOrdersSchema = z.array(SessionOrderSchema);

const AuditEventSchema = z.object({
  type: z.literal("audit"),
  id: IdSchema,
  at: EpochMsSchema,
  actor: NonemptyStringSchema,
  action: NonemptyStringSchema,
  entity: NonemptyStringSchema,
  entityId: IdSchema.nullable(),
  detailJson: ResourceRecordSchema.nullable()
}).strict();

const RiskEventSchema = z.object({
  type: z.literal("risk"),
  id: IdSchema,
  sessionId: IdSchema.nullable(),
  accountId: IdSchema,
  at: EpochMsSchema,
  ruleId: IdSchema,
  severity: z.enum(["warn", "block", "halt"]),
  actionTaken: NonemptyStringSchema,
  detailJson: ResourceRecordSchema,
  orderId: IdSchema.nullable()
}).strict();

const SessionStateEventSchema = z.object({
  type: NonemptyStringSchema,
  id: IdSchema,
  sessionId: IdSchema,
  at: EpochMsSchema,
  fromStatus: SessionStatusSchema.nullable(),
  toStatus: SessionStatusSchema.nullable(),
  detailJson: ResourceRecordSchema
}).strict();

export const SessionEventSchema = z.union([
  AuditEventSchema,
  RiskEventSchema,
  SessionStateEventSchema
]);

export const SessionEventsSchema = z.array(SessionEventSchema);

const NormalizedEquityPointSchema = z.object({
  at: EpochMsSchema,
  value: FiniteNumberSchema,
  equity: NonnegativeMoneySchema
}).strict();

const ComparisonDetailSchema = z.object({
  session: SessionSummarySchema.omit({ metrics: true }),
  metrics: SessionMetricsSchema.nullable(),
  equity: EquitySeriesSchema,
  normalizedEquity: z.array(NormalizedEquityPointSchema)
}).strict();

const ComparisonCurveSchema = z.object({
  sessionId: IdSchema,
  points: z.array(z.object({ at: EpochMsSchema, equity: FiniteNumberSchema }).strict())
}).strict();

export const SessionComparisonSchema = z.object({
  ids: z.array(IdSchema).min(2).max(4),
  sessions: z.array(SessionSummarySchema).min(2).max(4),
  curves: z.array(ComparisonCurveSchema),
  normalizedCurves: z.array(ComparisonCurveSchema),
  metricMatrix: z.record(z.string(), z.record(z.string(), FiniteNumberSchema.nullable())),
  configDiff: z.record(z.string(), z.record(z.string(), z.unknown())),
  details: z.array(ComparisonDetailSchema).min(2).max(4)
}).strict();

export const PositionSchema = z.object({
  symbol: SymbolSchema,
  qty: z.number().int().safe().positive(),
  avgPrice: NonnegativeMoneySchema,
  price: NonnegativeMoneySchema.nullable(),
  marketValue: NonnegativeMoneySchema.nullable(),
  unrealizedPnl: MoneySchema.nullable(),
  unrealizedPnlPercent: FiniteNumberSchema.nullable(),
  dataStatus: z.enum(["real", "unavailable"]),
  dataSource: NonemptyStringSchema.optional(),
  dataError: NonemptyStringSchema.optional(),
  quoteAt: EpochMsSchema.optional(),
  quoteAgeMs: NonnegativeIntegerSchema.optional()
}).strict();

export const PortfolioSchema = z.object({
  accountId: IdSchema,
  sessionId: IdSchema.nullable(),
  cash: NonnegativeMoneySchema,
  accountCash: NonnegativeMoneySchema,
  buyingPower: NonnegativeMoneySchema,
  equity: NonnegativeMoneySchema.nullable(),
  dayChange: MoneySchema.nullable(),
  dayStartEquity: NonnegativeMoneySchema.nullable(),
  realizedPnl: MoneySchema,
  positionValue: NonnegativeMoneySchema.nullable(),
  positions: z.array(PositionSchema),
  orders: z.array(OrderSchema),
  dataStatus: z.enum(["real", "unavailable"]),
  at: EpochMsSchema,
  equityHistory: z.array(z.object({ at: EpochMsSchema, equity: NonnegativeMoneySchema }).strict())
}).strict();

const RiskBudgetSliceSchema = z.object({
  used: NonnegativeNumberSchema,
  limit: NonnegativeNumberSchema,
  percent: NonnegativeNumberSchema.nullable()
}).strict();

const RiskPercentBudgetSliceSchema = z.object({
  usedPercent: NonnegativeNumberSchema.nullable(),
  limitPercent: NonnegativeNumberSchema,
  percent: NonnegativeNumberSchema.nullable()
}).strict();

export const OverviewRiskBudgetSchema = z.object({
  dailyLoss: RiskBudgetSliceSchema.extend({ used: NonnegativeNumberSchema.nullable() }),
  drawdown: RiskPercentBudgetSliceSchema,
  exposure: RiskPercentBudgetSliceSchema,
  ordersToday: RiskBudgetSliceSchema
}).strict();

export const AuditActivitySchema = AuditEventSchema.omit({ type: true });

export const AlertDeliverySchema = z.object({
  id: IdSchema,
  alertId: IdSchema,
  sessionId: IdSchema.nullable(),
  at: EpochMsSchema,
  status: z.enum(["sent", "failed", "suppressed"]),
  payloadJson: ResourceRecordSchema,
  errorDetail: NonemptyStringSchema.nullable(),
  readAt: EpochMsSchema.nullable(),
  alertName: NonemptyStringSchema,
  triggerType: NonemptyStringSchema,
  channel: NonemptyStringSchema
}).strict();

export const ProviderHealthSchema = z.object({
  id: IdSchema,
  name: NonemptyStringSchema.optional(),
  configured: z.boolean(),
  status: z.enum(["healthy", "degraded", "unavailable", "unconfigured", "unknown"]),
  latencyMs: NonnegativeNumberSchema.nullable(),
  lastSuccessAt: EpochMsSchema.nullable(),
  lastErrorAt: EpochMsSchema.nullable(),
  message: z.string().nullable()
}).strict();

export const ProviderHealthListSchema = z.array(ProviderHealthSchema);

export const OverviewResponseSchema = z.object({
  portfolio: PortfolioSchema,
  activeSessions: SessionListSchema,
  riskBudget: OverviewRiskBudgetSchema,
  activity: z.array(AuditActivitySchema),
  alerts: z.object({
    items: z.array(AlertDeliverySchema),
    unread: NonnegativeIntegerSchema
  }).strict(),
  dataHealth: ProviderHealthListSchema
}).strict();

export const MarketAssetSchema = z.object({
  symbol: SymbolSchema,
  name: NonemptyStringSchema,
  sector: NonemptyStringSchema.optional(),
  aliases: z.array(NonemptyStringSchema).optional(),
  matchReason: NonemptyStringSchema.optional(),
  tradable: z.boolean().optional(),
  quote: MarketQuoteSchema.optional()
}).strict();

export const MarketSearchSchema = z.array(MarketAssetSchema);

const DiagnosticSchema = FiniteNumberSchema.nullable();
export const MarketBarsSchema = z.object({
  symbol: SymbolSchema,
  range: RangeKeySchema,
  interval: BarIntervalSchema,
  source: NonemptyStringSchema,
  bars: z.array(BarSchema).min(1),
  diagnostics: z.object({
    rsi: DiagnosticSchema,
    emaFast: DiagnosticSchema,
    emaSlow: DiagnosticSchema,
    atr: DiagnosticSchema,
    vwap: DiagnosticSchema
  }).strict()
}).strict();

const AlgorithmParameterSchema = z.union([z.number().finite(), z.string(), z.boolean()]);
const AlgorithmVersionSummarySchema = z.object({
  id: IdSchema,
  hash: NonemptyStringSchema,
  createdAt: EpochMsSchema
}).strict();

export const AlgorithmSchema = z.object({
  id: IdSchema,
  name: NonemptyStringSchema,
  author: z.string().nullable(),
  description: z.string().nullable(),
  file: NonemptyStringSchema,
  uploaded: z.boolean(),
  enabled: z.boolean(),
  params: z.record(z.string(), AlgorithmParameterSchema),
  sourceHash: NonemptyStringSchema,
  version: AlgorithmVersionSummarySchema.nullable(),
  source: z.string().optional()
}).strict();

export const AlgorithmListResponseSchema = z.object({
  algorithms: z.array(AlgorithmSchema),
  errors: z.array(z.object({
    id: IdSchema,
    file: NonemptyStringSchema,
    code: NonemptyStringSchema,
    error: NonemptyStringSchema
  }).strict())
}).strict();

export const AlgorithmVersionSchema = z.object({
  id: IdSchema,
  algorithmId: IdSchema,
  sourceHash: NonemptyStringSchema,
  sourceCode: z.string(),
  paramsJson: ResourceRecordSchema,
  createdAt: EpochMsSchema
}).strict();

export const AlgorithmVersionsSchema = z.array(AlgorithmVersionSchema);

export const SettingFieldSchema = z.object({
  key: NonemptyStringSchema,
  label: NonemptyStringSchema,
  secret: z.boolean(),
  readOnly: z.boolean(),
  hasValue: z.boolean(),
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
}).strict();

export const SettingGroupSchema = z.object({
  id: IdSchema,
  label: NonemptyStringSchema,
  fields: z.array(SettingFieldSchema)
}).strict();

export const SystemSettingsSchema = z.object({
  encryptionReady: z.boolean(),
  groups: z.array(SettingGroupSchema)
}).strict();

export const RiskProfileSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  name: NonemptyStringSchema,
  rulesJson: ResourceRecordSchema,
  isDefault: z.boolean(),
  updatedAt: EpochMsSchema
}).strict();

export const RiskProfilesSchema = z.array(RiskProfileSchema);

export const AlertSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  name: NonemptyStringSchema,
  triggerType: NonemptyStringSchema,
  conditionJson: ResourceRecordSchema,
  channel: NonemptyStringSchema,
  channelConfigJson: ResourceRecordSchema.nullable(),
  enabled: z.boolean(),
  cooldownMs: NonnegativeIntegerSchema,
  lastFiredAt: EpochMsSchema.nullable(),
  createdAt: EpochMsSchema
}).strict();

export const AlertsSchema = z.array(AlertSchema);

export const MetricsOnlyBacktestSchema = z.object({
  metrics: MetricsSchema
}).passthrough();
