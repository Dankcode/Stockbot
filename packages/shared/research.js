import { z } from "zod";

const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 10_000;
const MAX_LIST_ITEMS = 20;
const MAX_URL_LENGTH = 2_048;
const MAX_QUERY_ENTRIES = 32;
const MAX_QUERY_VALUE_LENGTH = 1_024;
const MAX_STEP_TIMEOUT_MS = 120_000;
const MAX_SCRAPE_BYTES = 10 * 1024 * 1024;
const MAX_SUMMARY_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DELIVERY_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const NonnegativeEpochMsSchema = z.number().int().safe().nonnegative();
const NonemptyTextSchema = z.string().trim().min(1).max(MAX_TEXT_LENGTH);
const IdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Expected a stable identifier");
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 hash");
const ConcreteSymbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9./-]*$/, "Expected an uppercase market symbol");
const PlanSymbolSchema = z.union([ConcreteSymbolSchema, z.literal("*")]);

export const SymbolOrWildcardSchema = PlanSymbolSchema;

function addDuplicateIssues(values, context, path, label) {
  const firstIndexes = new Map();
  values.forEach((value, index) => {
    if (firstIndexes.has(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: `Duplicate ${label}: ${value}`
      });
      return;
    }
    firstIndexes.set(value, index);
  });
}

function validateTemplate(value, context) {
  if (/{{|}}/.test(value.replaceAll("{{symbol}}", ""))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "{{symbol}} is the only supported research template variable"
    });
  }
}

function freezeDeep(value, seen = new WeakSet()) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key], seen);
  return Object.freeze(value);
}

export const ResearchSourceProvenanceSchema = z
  .object({
    stepId: IdSchema,
    sourceId: IdSchema,
    url: z
      .string()
      .trim()
      .min(1)
      .max(MAX_URL_LENGTH)
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "https:" || protocol === "http:";
      }, "Expected an HTTP(S) URL"),
    title: z.string().trim().min(1).max(500).nullable(),
    fetchedAt: NonnegativeEpochMsSchema,
    publishedAt: NonnegativeEpochMsSchema.nullable(),
    contentType: z.string().trim().min(1).max(200),
    contentHash: HashSchema
  })
  .strict()
  .superRefine((source, context) => {
    if (source.publishedAt !== null && source.publishedAt > source.fetchedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["publishedAt"],
        message: "publishedAt cannot follow fetchedAt"
      });
    }
  });

const ScrapeQuerySchema = z
  .record(
    z.string().trim().min(1).max(100),
    z.string().max(MAX_QUERY_VALUE_LENGTH).superRefine(validateTemplate)
  )
  .superRefine((query, context) => {
    if (Object.keys(query).length > MAX_QUERY_ENTRIES) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_QUERY_ENTRIES,
        origin: "object",
        inclusive: true,
        path: [],
        message: `query cannot contain more than ${MAX_QUERY_ENTRIES} entries`
      });
    }
    Object.keys(query).forEach((key) => {
      if (/(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|signature)/i.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Research plans cannot contain credentials or authentication query parameters"
        });
      }
    });
  });

export const ScrapeResearchStepSchema = z
  .object({
    id: IdSchema,
    kind: z.literal("scrape"),
    adapter: z.literal("web.page.v1"),
    request: z
      .object({
        sourceId: IdSchema,
        pathTemplate: z
          .string()
          .min(1)
          .max(MAX_URL_LENGTH)
          .startsWith("/")
          .superRefine(validateTemplate),
        query: ScrapeQuerySchema.optional(),
        format: z.enum(["auto", "html", "text", "json"])
      })
      .strict(),
    limits: z
      .object({
        timeoutMs: z.number().int().safe().min(100).max(MAX_STEP_TIMEOUT_MS),
        maxBytes: z.number().int().safe().positive().max(MAX_SCRAPE_BYTES)
      })
      .strict()
  })
  .strict();

export const SummarizeResearchStepSchema = z
  .object({
    id: IdSchema,
    kind: z.literal("summarize"),
    adapter: z.literal("ai.cli.summary.v1"),
    dependsOn: z.array(IdSchema).min(1).max(MAX_LIST_ITEMS),
    promptTemplate: z.literal("market-summary.v1"),
    responseSchema: z.literal("market-summary.v1"),
    limits: z
      .object({
        timeoutMs: z.number().int().safe().min(100).max(MAX_STEP_TIMEOUT_MS),
        maxInputBytes: z.number().int().safe().positive().max(MAX_SUMMARY_INPUT_BYTES)
      })
      .strict()
  })
  .strict()
  .superRefine((step, context) => {
    addDuplicateIssues(step.dependsOn, context, ["dependsOn"], "dependency");
  });

export const ResearchStepSchema = z.discriminatedUnion("kind", [
  ScrapeResearchStepSchema,
  SummarizeResearchStepSchema
]);

export const ResearchPlanV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
    description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH).optional(),
    symbols: z.array(PlanSymbolSchema).min(1).max(100),
    steps: z.array(ResearchStepSchema).min(1).max(MAX_LIST_ITEMS),
    outputStep: IdSchema,
    delivery: z
      .object({
        strategy: z.boolean(),
        required: z.boolean(),
        maxAgeMs: z.number().int().safe().nonnegative().max(MAX_DELIVERY_AGE_MS)
      })
      .strict()
  })
  .strict()
  .superRefine((plan, context) => {
    addDuplicateIssues(plan.symbols, context, ["symbols"], "symbol");
    if (plan.symbols.includes("*") && plan.symbols.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbols"],
        message: "The wildcard symbol must be used by itself"
      });
    }

    const seenStepIds = new Set();
    const stepKinds = new Map();
    plan.steps.forEach((step, index) => {
      if (seenStepIds.has(step.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["steps", index, "id"],
          message: `Duplicate step id: ${step.id}`
        });
      }

      if (step.kind === "summarize") {
        step.dependsOn.forEach((dependency, dependencyIndex) => {
          if (!seenStepIds.has(dependency)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["steps", index, "dependsOn", dependencyIndex],
              message: `Dependency must reference an earlier step: ${dependency}`
            });
          }
        });
      }

      seenStepIds.add(step.id);
      if (!stepKinds.has(step.id)) stepKinds.set(step.id, step.kind);
    });

    if (!stepKinds.has(plan.outputStep)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputStep"],
        message: `Unknown output step: ${plan.outputStep}`
      });
    } else if (stepKinds.get(plan.outputStep) !== "summarize") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outputStep"],
        message: "outputStep must reference a summarize step"
      });
    }
  });

export const ResearchPlanSchema = ResearchPlanV1Schema;

export const MarketResearchSummarySchema = z
  .object({
    overview: NonemptyTextSchema,
    keyDrivers: z.array(NonemptyTextSchema).max(MAX_LIST_ITEMS),
    risks: z.array(NonemptyTextSchema).max(MAX_LIST_ITEMS),
    opportunities: z.array(NonemptyTextSchema).max(MAX_LIST_ITEMS),
    sentiment: z.enum(["bearish", "neutral", "bullish", "mixed"]),
    confidence: z.number().finite().min(0).max(1)
  })
  .strict();

export const ResearchInputDocumentSchema = z
  .object({
    stepId: IdSchema,
    sourceId: IdSchema,
    contentHash: HashSchema,
    sourceBytes: z.number().int().safe().nonnegative(),
    includedBytes: z.number().int().safe().nonnegative(),
    truncated: z.boolean()
  })
  .strict()
  .superRefine((document, context) => {
    if (document.includedBytes > document.sourceBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["includedBytes"],
        message: "includedBytes cannot exceed sourceBytes"
      });
    }
    if (document.truncated !== (document.includedBytes < document.sourceBytes)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["truncated"],
        message: "truncated must describe the included/source byte counts"
      });
    }
  });

const ResearchSnapshotObjectSchema = z
  .object({
    id: IdSchema,
    runId: IdSchema,
    planId: IdSchema,
    planVersionId: IdSchema,
    schemaVersion: z.literal(1),
    symbol: ConcreteSymbolSchema,
    asOf: NonnegativeEpochMsSchema,
    availableAt: NonnegativeEpochMsSchema,
    expiresAt: NonnegativeEpochMsSchema.nullable(),
    summary: MarketResearchSummarySchema,
    sources: z.array(ResearchSourceProvenanceSchema).min(1).max(100),
    sourceBundleHash: HashSchema,
    aiInputHash: HashSchema,
    summarizerConfigHash: HashSchema,
    inputDocuments: z.array(ResearchInputDocumentSchema).min(1).max(100),
    promptHash: HashSchema,
    model: z.string().trim().min(1).max(200),
    contentHash: HashSchema
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.asOf > snapshot.availableAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableAt"],
        message: "availableAt cannot precede asOf"
      });
    }
    if (snapshot.expiresAt !== null && snapshot.expiresAt <= snapshot.availableAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "expiresAt must follow availableAt"
      });
    }
    snapshot.sources.forEach((source, index) => {
      if (source.fetchedAt > snapshot.availableAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", index, "fetchedAt"],
          message: "A source cannot be fetched after the snapshot becomes available"
        });
      }
    });
    snapshot.inputDocuments.forEach((document, index) => {
      const source = snapshot.sources.find((candidate) =>
        candidate.stepId === document.stepId &&
        candidate.sourceId === document.sourceId &&
        candidate.contentHash === document.contentHash
      );
      if (!source) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputDocuments", index],
          message: "AI input document must reconcile to snapshot source provenance"
        });
      }
    });
  });

export const ResearchSnapshotSchema = ResearchSnapshotObjectSchema.transform((snapshot) =>
  freezeDeep(snapshot)
);

const AvailableResearchFrameObjectSchema = z
  .object({
    status: z.literal("available"),
    symbol: ConcreteSymbolSchema,
    decisionAt: NonnegativeEpochMsSchema,
    snapshot: ResearchSnapshotObjectSchema
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.snapshot.symbol !== frame.symbol) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "symbol"],
        message: "snapshot symbol must match frame symbol"
      });
    }
    if (frame.snapshot.availableAt > frame.decisionAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "availableAt"],
        message: "snapshot is not available at decisionAt"
      });
    }
    if (frame.snapshot.expiresAt !== null && frame.snapshot.expiresAt <= frame.decisionAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["snapshot", "expiresAt"],
        message: "snapshot is expired at decisionAt"
      });
    }
  });

const UnavailableResearchFrameObjectSchema = z
  .object({
    status: z.literal("unavailable"),
    symbol: ConcreteSymbolSchema,
    decisionAt: NonnegativeEpochMsSchema,
    reason: z.string().trim().min(1).max(500)
  })
  .strict();

export const AvailableResearchFrameSchema = AvailableResearchFrameObjectSchema.transform((frame) =>
  freezeDeep(frame)
);
export const UnavailableResearchFrameSchema = UnavailableResearchFrameObjectSchema.transform((frame) =>
  freezeDeep(frame)
);
export const ResearchFrameSchema = z
  .union([AvailableResearchFrameObjectSchema, UnavailableResearchFrameObjectSchema])
  .transform((frame) => freezeDeep(frame));
