import { z } from "zod";

const FiniteNumberSchema = z.number().finite();
const NonnegativeNumberSchema = FiniteNumberSchema.nonnegative();
const PositiveNumberSchema = FiniteNumberSchema.positive();
const NonnegativeIntegerSchema = z.number().int().safe().nonnegative();
const PositiveIntegerSchema = z.number().int().safe().positive();
const RecordSchema = z.record(z.string(), z.unknown());

export const IdSchema = z.string().trim().min(1).max(128);
export const SymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9./-]*$/, "Expected an uppercase market symbol");
export const EpochMsSchema = NonnegativeIntegerSchema;
export const MoneySchema = z.number().int().safe();
export const NonnegativeMoneySchema = NonnegativeIntegerSchema;
export const QuantitySchema = PositiveIntegerSchema;
export const BarIntervalSchema = z.enum(["1min", "5min", "1hour", "1day", "1week", "1month"]);
export const RangeKeySchema = z.enum(["1H", "1D", "1W", "1M", "3M", "1Y", "ALL"]);

export const BarSchema = z
  .object({
    time: EpochMsSchema,
    open: PositiveNumberSchema,
    high: PositiveNumberSchema,
    low: NonnegativeNumberSchema,
    close: PositiveNumberSchema,
    volume: NonnegativeNumberSchema
  })
  .strict()
  .superRefine((bar, context) => {
    const observedHigh = Math.max(bar.open, bar.close, bar.low);
    const observedLow = Math.min(bar.open, bar.close, bar.high);
    if (bar.high < observedHigh) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["high"],
        message: "high must be greater than or equal to open, low, and close"
      });
    }
    if (bar.low > observedLow) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["low"],
        message: "low must be less than or equal to open, high, and close"
      });
    }
  });

export const QuoteStatusSchema = z.enum(["real", "stale"]);
export const QuoteSchema = z
  .object({
    symbol: SymbolSchema,
    status: QuoteStatusSchema,
    price: PositiveNumberSchema,
    previousClose: PositiveNumberSchema,
    change: FiniteNumberSchema,
    changePercent: FiniteNumberSchema,
    volume: NonnegativeNumberSchema.nullable(),
    at: EpochMsSchema,
    source: z.string().trim().min(1)
  })
  .strict();

export const UnavailableQuoteSchema = z
  .object({
    symbol: SymbolSchema,
    status: z.literal("unavailable"),
    error: z.string().trim().min(1),
    checkedAt: EpochMsSchema,
    source: z.string().trim().min(1).optional()
  })
  .strict();

export const MarketQuoteSchema = z.union([QuoteSchema, UnavailableQuoteSchema]);

export const OrderSideSchema = z.enum(["buy", "sell"]);
export const OrderTypeSchema = z.enum(["market", "limit", "stop", "stop_limit"]);
export const OrderStatusSchema = z.enum(["pending", "filled", "partial", "rejected", "canceled"]);
export const OrderSchema = z
  .object({
    id: IdSchema,
    clientOrderId: IdSchema,
    sessionId: IdSchema.nullable(),
    researchSnapshotId: IdSchema.nullable(),
    accountId: IdSchema,
    symbol: SymbolSchema,
    side: OrderSideSchema,
    orderType: OrderTypeSchema,
    qty: QuantitySchema,
    limitPrice: NonnegativeMoneySchema.nullable(),
    status: OrderStatusSchema,
    rejectReason: z.string().trim().min(1).nullable(),
    signalReason: z.string().trim().min(1).nullable(),
    signalBarAt: EpochMsSchema.nullable(),
    submittedAt: EpochMsSchema,
    resolvedAt: EpochMsSchema.nullable()
  })
  .strict()
  .superRefine((order, context) => {
    if ((order.orderType === "limit" || order.orderType === "stop_limit") && order.limitPrice === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["limitPrice"],
        message: `${order.orderType} orders require limitPrice`
      });
    }
    if (order.resolvedAt !== null && order.resolvedAt < order.submittedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolvedAt"],
        message: "resolvedAt cannot precede submittedAt"
      });
    }
    if (order.signalBarAt !== null && order.signalBarAt > order.submittedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signalBarAt"],
        message: "signalBarAt cannot follow submittedAt"
      });
    }
  });

export const FillSchema = z
  .object({
    id: IdSchema,
    orderId: IdSchema,
    qty: QuantitySchema,
    price: NonnegativeMoneySchema,
    referencePrice: NonnegativeMoneySchema,
    commission: NonnegativeMoneySchema,
    filledAt: EpochMsSchema,
    quoteAgeMs: NonnegativeIntegerSchema.nullable()
  })
  .strict();

export const MetricsSchema = z
  .object({
    returnPercent: FiniteNumberSchema.nullable(),
    finalEquity: NonnegativeMoneySchema.nullable(),
    maxDrawdown: NonnegativeNumberSchema.nullable(),
    sharpe: FiniteNumberSchema.nullable(),
    sortino: FiniteNumberSchema.nullable(),
    profitFactor: NonnegativeNumberSchema.nullable(),
    winRate: NonnegativeNumberSchema.max(100).nullable(),
    tradeCount: NonnegativeIntegerSchema,
    exposurePercent: NonnegativeNumberSchema.nullable(),
    avgTradePercent: FiniteNumberSchema.nullable()
  })
  .strict();

export const SessionMetricsSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    computedAt: EpochMsSchema,
    metricsVersion: z.string().trim().min(1),
    ...MetricsSchema.shape
  })
  .strict();

export const SessionModeSchema = z.enum(["backtest", "paper"]);
export const SessionStatusSchema = z.enum([
  "draft",
  "arming",
  "running",
  "paused",
  "stopping",
  "halted",
  "stopped",
  "errored"
]);
export const StopReasonSchema = z.enum(["user", "schedule", "risk_halt", "error", "completed"]);
export const SessionSchema = z
  .object({
    id: IdSchema,
    accountId: IdSchema,
    name: z.string().trim().min(1).max(200),
    mode: SessionModeSchema,
    status: SessionStatusSchema,
    algorithmVersionId: IdSchema.nullable(),
    researchPlanVersionId: IdSchema.nullable(),
    params: RecordSchema,
    symbols: z.array(SymbolSchema).min(1),
    barInterval: BarIntervalSchema,
    windowStart: EpochMsSchema.nullable(),
    windowEnd: EpochMsSchema.nullable(),
    fillModel: RecordSchema,
    riskProfile: RecordSchema,
    schedule: RecordSchema,
    startingEquity: NonnegativeMoneySchema,
    endingEquity: NonnegativeMoneySchema.nullable(),
    startedAt: EpochMsSchema.nullable(),
    endedAt: EpochMsSchema.nullable(),
    stopReason: StopReasonSchema.nullable(),
    errorDetail: z.string().trim().min(1).nullable(),
    createdAt: EpochMsSchema
  })
  .strict()
  .superRefine((session, context) => {
    if (
      session.windowStart !== null &&
      session.windowEnd !== null &&
      session.windowEnd < session.windowStart
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowEnd"],
        message: "windowEnd cannot precede windowStart"
      });
    }
    if (session.startedAt !== null && session.endedAt !== null && session.endedAt < session.startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endedAt"],
        message: "endedAt cannot precede startedAt"
      });
    }
  });

export const RiskRuleScopeSchema = z.enum(["session", "account"]);
export const RiskRulePhaseSchema = z.enum(["pre_trade", "continuous"]);
export const RiskRuleSeveritySchema = z.enum(["warn", "block", "halt"]);
export const RiskRuleSchema = z
  .object({
    id: z.string().trim().min(1),
    scope: RiskRuleScopeSchema,
    phase: RiskRulePhaseSchema,
    severity: RiskRuleSeveritySchema,
    enabled: z.boolean(),
    threshold: FiniteNumberSchema.optional(),
    config: RecordSchema
  })
  .strict();

export const RiskRuleResultSchema = z
  .object({
    triggered: z.boolean(),
    observed: z.unknown(),
    threshold: z.unknown(),
    message: z.string().trim().min(1)
  })
  .strict();

export const ApiMetaSchema = z
  .object({
    requestId: z.string().trim().min(1).optional(),
    cursor: z.string().nullable().optional(),
    nextCursor: z.string().nullable().optional(),
    hasMore: z.boolean().optional(),
    total: NonnegativeIntegerSchema.optional()
  })
  .catchall(z.unknown());

export const ApiErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    detail: z.unknown().optional()
  })
  .strict();

export const SuccessEnvelopeSchema = z.object({ data: z.unknown(), meta: ApiMetaSchema }).strict();
export const ErrorEnvelopeSchema = z.object({ error: ApiErrorSchema }).strict();
export const ApiEnvelopeSchema = z.union([SuccessEnvelopeSchema, ErrorEnvelopeSchema]);

export function createSuccessEnvelopeSchema(dataSchema, metaSchema = ApiMetaSchema) {
  return z.object({ data: dataSchema, meta: metaSchema }).strict();
}

export function createErrorEnvelopeSchema(detailSchema = z.unknown()) {
  return z
    .object({
      error: z
        .object({
          code: z.string().trim().min(1),
          message: z.string().trim().min(1),
          detail: detailSchema.optional()
        })
        .strict()
    })
    .strict();
}

export function createApiEnvelopeSchema(dataSchema, metaSchema = ApiMetaSchema, detailSchema = z.unknown()) {
  return z.union([
    createSuccessEnvelopeSchema(dataSchema, metaSchema),
    createErrorEnvelopeSchema(detailSchema)
  ]);
}
