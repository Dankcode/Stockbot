import { z } from "zod";

import { formatMetric, formatMoney } from "../../packages/shared/format.js";
import type { MetricKey } from "../../packages/shared/metrics.js";
import { getRangeConfig, type BarInterval, type RangeDefinition } from "../../packages/shared/ranges.js";
import {
  MetricsSchema,
  SessionSchema,
  createApiEnvelopeSchema,
  type ApiEnvelope,
  type Metrics,
  type Session
} from "../../packages/shared/schemas.js";

const metricKey: MetricKey = "maxDrawdown";
const formatted: string = formatMetric(metricKey, 4.2);
const money: string = formatMoney(12_345);
const interval: BarInterval = "5min";
const range: RangeDefinition = getRangeConfig("1D");

const metrics: Metrics = MetricsSchema.parse({
  returnPercent: null,
  finalEquity: null,
  maxDrawdown: 0,
  sharpe: null,
  sortino: null,
  profitFactor: null,
  winRate: null,
  tradeCount: 0,
  exposurePercent: null,
  avgTradePercent: null
});

const session: Session = SessionSchema.parse({
  id: "session-1",
  accountId: "account-1",
  name: "Typed session",
  mode: "backtest",
  status: "draft",
  algorithmVersionId: null,
  params: {},
  symbols: ["SPY"],
  barInterval: interval,
  windowStart: null,
  windowEnd: null,
  fillModel: {},
  riskProfile: {},
  schedule: { type: "manual", timezone: "UTC" },
  startingEquity: 10_000_000,
  endingEquity: null,
  startedAt: null,
  endedAt: null,
  stopReason: null,
  errorDetail: null,
  createdAt: 1
});

const envelopeSchema = createApiEnvelopeSchema(z.object({ session: SessionSchema }).strict());
const envelope: ApiEnvelope<{ session: Session }> = envelopeSchema.parse({ data: { session }, meta: {} });

void [formatted, money, range, metrics, envelope];
