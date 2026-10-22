import { z } from "zod";

/**
 * Agent-swarm contracts. Everything an agent sends Stockbot is data, validated
 * strictly: unknown keys fail, so an agent cannot smuggle in fields the hub
 * would otherwise trust (a provenance claim, a limit override, code).
 */

export const SWARM_CEILINGS = Object.freeze({
  maxAgents: 8,
  sleeveStartingCashCents: 10_000_000,
  maxPositionPercent: 15,
  maxOpenPositions: 10,
  maxIntentsPerDay: 20,
  maxStopLossPercent: 15,
  maxHoldDays: 120,
  maxReportAgeMs: 24 * 60 * 60 * 1_000,
  maxQuoteFutureSkewMs: 1_000
});

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;
const SymbolSchema = z.string().trim().toUpperCase().regex(SYMBOL_PATTERN, "Expected a US-listed ticker.");
const IdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9:._-]+$/);
const TextSchema = (max) => z.string().trim().min(1).max(max);

export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;
export const AgentCreateSchema = z.object({
  name: z.string().trim().regex(AGENT_NAME_PATTERN, "Use lowercase letters, digits and dashes."),
  description: z.string().trim().max(2_000).optional(),
  hermesProfile: z.string().trim().regex(/^[a-z][a-z0-9_-]{1,63}$/).optional()
}).strict();

const DailyScheduleSchema = z.object({
  type: z.literal("daily"),
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.enum(["America/New_York", "UTC"]),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5])
}).strict();
const IntervalScheduleSchema = z.object({
  type: z.literal("interval"),
  minutes: z.number().int().min(15).max(1_440)
}).strict();

export const AGENT_SOURCE_KINDS = Object.freeze(["market.quote", "market.bars", "web.page"]);

export const AgentPlanSchema = z.object({
  kind: z.literal("stockbot.agent-plan.v1"),
  name: TextSchema(200),
  description: z.string().trim().max(2_000).optional(),
  universe: z.object({ symbols: z.array(SymbolSchema).min(1).max(25) }).strict(),
  cadence: z.array(z.object({
    task: z.literal("research"),
    schedule: z.discriminatedUnion("type", [DailyScheduleSchema, IntervalScheduleSchema]),
    expiresAfterMinutes: z.number().int().min(5).max(720).default(60)
  }).strict()).min(1).max(4),
  sources: z.array(z.enum(AGENT_SOURCE_KINDS)).min(1).max(AGENT_SOURCE_KINDS.length),
  decision: z.object({
    minScore: z.number().int().min(1).max(10),
    positionPercent: z.number().positive().max(SWARM_CEILINGS.maxPositionPercent),
    stopLossPercent: z.number().positive().max(SWARM_CEILINGS.maxStopLossPercent),
    maxHoldDays: z.number().int().positive().max(SWARM_CEILINGS.maxHoldDays)
  }).strict(),
  requestedLimits: z.object({
    maxPositions: z.number().int().positive().max(SWARM_CEILINGS.maxOpenPositions).optional(),
    maxIntentsPerDay: z.number().int().positive().max(SWARM_CEILINGS.maxIntentsPerDay).optional()
  }).strict().optional()
}).strict();

export const BAR_RANGES = Object.freeze(["1D", "1W", "1M", "3M", "1Y"]);
export const RetrievalRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("market.quote"), symbol: SymbolSchema }).strict(),
  z.object({ kind: z.literal("market.bars"), symbol: SymbolSchema, range: z.enum(BAR_RANGES).default("3M") }).strict(),
  z.object({
    kind: z.literal("web.page"),
    sourceId: IdSchema,
    path: z.string().max(512).regex(/^\/(?!\/)[A-Za-z0-9._~\/-]*$/, "Use an origin-relative path without a query."),
    symbol: SymbolSchema.optional()
  }).strict()
]);

export const ReportSubmissionSchema = z.object({
  summary: TextSchema(4_000),
  decisions: z.array(z.object({
    symbol: SymbolSchema,
    action: z.enum(["hold", "buy", "sell"]),
    score: z.number().int().min(1).max(10).optional(),
    rationale: TextSchema(2_000),
    evidence: z.array(IdSchema).min(1).max(20)
  }).strict()).min(1).max(25)
}).strict();

export const IntentSubmissionSchema = z.object({
  idempotencyKey: z.string().trim().regex(/^[A-Za-z0-9:._-]{8,128}$/),
  decisionId: IdSchema,
  symbol: SymbolSchema,
  side: z.enum(["buy", "sell"]),
  notional: z.number().positive().max(1_000_000).optional()
}).strict().superRefine((value, context) => {
  if (value.side === "buy" && value.notional === undefined) {
    context.addIssue({ code: "custom", path: ["notional"], message: "A buy needs a dollar notional." });
  }
});
