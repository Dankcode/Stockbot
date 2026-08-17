import { z } from "zod";

/**
 * stockbot.plugin.v1 — a shareable, executable-free description of trading methods,
 * their controls, and the research they depend on.
 *
 * Design rules, in priority order:
 *
 * 1. A plugin is DATA. It contains no JavaScript, no command, no path, no credential.
 *    Methods are rule trees walked by an interpreter; research steps name code-owned
 *    adapters by id. Installing a stranger's plugin cannot run their code.
 *
 * 2. A plugin DECLARES capabilities, it never SUPPLIES them. `requires` is the first
 *    substantive block in the file and lists the source ids, secret NAMES, prompt
 *    templates, and CLI facilities the plugin needs. The runtime checks that list
 *    against what the operator already configured and refuses to install when something
 *    is missing. Secret values and executable paths stay in the operator's protected env
 *    where they already live.
 *
 * 3. Prompts are server-owned. A plugin selects a registered template id and fills
 *    bounded typed slots. It cannot rewrite the instructions that tell the model to
 *    treat scraped documents as untrusted evidence — which matters because social and
 *    news text is adversarial by default.
 *
 * 4. Every method carries its controls. `pairings` is required for any strategy so a
 *    shared plugin cannot present a result without the null hypothesis attached.
 */

const MAX_NAME = 200;
const MAX_DESCRIPTION = 2_000;
const MAX_TEXT = 500;
const MAX_LIST = 32;

const IdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "Expected a lowercase stable identifier");

/**
 * A method reference that may cross plugin boundaries: either a local id ("horizon-fixed")
 * or a qualified one ("core-controls/buy-and-hold"). Qualified references are what let a
 * strategy pack reuse the canonical control group instead of shipping its own near-copy,
 * and they are resolved once every plugin is loaded.
 */
const MethodRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(257)
  .regex(
    /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/,
    'Expected "<methodId>" or "<pluginId>/<methodId>"'
  );

const SourceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, "Expected a registered research source id");

const SecretNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{2,63}$/, "Expected an environment variable NAME, never a value")
  .refine(
    (name) => !/^(?:.*(?:-----|BEGIN |sk-|ghp_|AKIA))/.test(name),
    "Secret entries must be variable names, not credential material"
  );

const SemverishSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Expected a semantic version such as 1.0.0");

/* ------------------------------------------------------------------ requires --- */

export const PLUGIN_CAPABILITIES = Object.freeze([
  "backtest",      // compile methods and run them through the engine
  "paper",         // eligible to drive a paper session
  "research.web",  // needs web.page.v1 and at least one registered origin
  "research.ai",   // needs the operator's AI CLI summarizer
  "cli"            // exposes CLI skills under `cli.skills`
]);

export const PluginRequirementsSchema = z
  .object({
    capabilities: z.array(z.enum(PLUGIN_CAPABILITIES)).min(1).max(PLUGIN_CAPABILITIES.length),
    // Source ids only. The plugin never says what URL a source maps to — the operator's
    // RESEARCH_WEB_SOURCES_JSON owns that binding, and an unregistered id fails install.
    sources: z.array(SourceIdSchema).max(MAX_LIST).optional().default([]),
    // Names of environment variables the operator must have configured, so a missing
    // model credential is reported at install time instead of as a confusing CLI failure
    // three steps into a research run. Values are never carried here.
    secrets: z.array(SecretNameSchema).max(MAX_LIST).optional().default([]),
    promptTemplates: z.array(IdSchema).max(MAX_LIST).optional().default([]),
    // Marker only: "this plugin needs the operator's AI summarizer configured". The
    // plugin cannot name, locate, or parameterise that executable.
    aiCli: z.boolean().optional().default(false),
    minEngineVersion: SemverishSchema.optional(),
    notes: z.string().trim().max(MAX_DESCRIPTION).optional()
  })
  .strict();

/* -------------------------------------------------------------------- method --- */

/**
 * Expressions are validated structurally here and semantically by
 * collectExpressionReferences() in server/plugins/expression.js, which is where unknown
 * operators and dangling series/state references are caught with a path.
 */
const ExpressionSchema = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().max(MAX_TEXT),
  z.record(z.string().max(64), z.any())
]);

const IndicatorSchema = z
  .object({
    fn: z.enum(["ema", "sma", "rsi", "atr", "highestHigh", "lowestLow"]),
    period: ExpressionSchema
  })
  .strict();

const RuleSchema = z
  .object({
    when: ExpressionSchema,
    action: z.enum(["buy", "sell", "none"]).optional(),
    reason: z.string().trim().min(1).max(MAX_TEXT).optional(),
    confidence: ExpressionSchema.optional(),
    set: z.record(z.string().max(64), ExpressionSchema).optional()
  })
  .strict();

export const MethodBodySchema = z
  .object({
    kind: z.literal("rules.v1"),
    warmup: ExpressionSchema.optional(),
    seed: ExpressionSchema.optional(),
    indicators: z.record(z.string().max(64), IndicatorSchema).optional(),
    derived: z.record(z.string().max(64), ExpressionSchema).optional(),
    state: z.record(z.string().max(64), ExpressionSchema).optional(),
    entry: z.array(RuleSchema).max(32).optional(),
    exit: z.array(RuleSchema).max(32).optional()
  })
  .strict();

const ParamValueSchema = z.union([z.number().finite(), z.string().max(MAX_TEXT), z.boolean()]);

export const PluginMethodSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(MAX_NAME),
    description: z.string().trim().max(MAX_DESCRIPTION).optional(),
    author: z.string().trim().max(MAX_NAME).optional(),
    // "strategy" makes a claim and therefore requires controls. "control" is the null
    // hypothesis and is exempt. "benchmark" is a passive reference such as buy-and-hold.
    role: z.enum(["strategy", "control", "benchmark"]),
    // For a control, which strategy or horizon band it is congruent with. Free-form so a
    // control can name a band ("monthly") rather than a single strategy id.
    controlFor: z.string().trim().max(MAX_TEXT).optional(),
    horizon: z.enum(["daily", "weekly", "monthly", "yearly", "none"]).optional(),
    params: z.record(z.string().max(64), ParamValueSchema).optional().default({}),
    method: MethodBodySchema
  })
  .strict();

/* ------------------------------------------------------------------ research --- */

const ScrapeQuerySchema = z
  .record(z.string().trim().min(1).max(100), z.string().max(1_024))
  .superRefine((query, context) => {
    for (const key of Object.keys(query)) {
      if (/(?:api[-_]?key|access[-_]?token|token|secret|password|passwd|authorization|credential|signature)/i.test(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "Plugins cannot carry credentials or authentication query parameters"
        });
      }
    }
  });

const ScrapeStepSchema = z
  .object({
    id: IdSchema,
    kind: z.literal("scrape"),
    sourceId: SourceIdSchema,
    pathTemplate: z.string().min(1).max(2_048).startsWith("/"),
    query: ScrapeQuerySchema.optional(),
    format: z.enum(["auto", "html", "text", "json"]),
    timeoutMs: z.number().int().min(100).max(120_000),
    maxBytes: z.number().int().positive().max(10 * 1024 * 1024)
  })
  .strict();

/**
 * The plugin picks a registered template and fills typed slots. Every slot value is
 * rendered into server-authored sentences; nothing here becomes raw instruction text,
 * so a shared plugin cannot tell the model to disregard its untrusted-evidence framing.
 */
export const PromptSlotsSchema = z
  .object({
    focus: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    avoid: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
    sector: z.string().trim().min(1).max(120).optional(),
    horizon: z.enum(["daily", "weekly", "monthly", "yearly"]).optional(),
    emphasis: z.enum(["risks", "opportunities", "drivers", "balanced"]).optional(),
    audience: z.enum(["systematic", "discretionary"]).optional()
  })
  .strict();

const SummarizeStepSchema = z
  .object({
    id: IdSchema,
    kind: z.literal("summarize"),
    dependsOn: z.array(IdSchema).min(1).max(20),
    template: IdSchema,
    slots: PromptSlotsSchema.optional(),
    timeoutMs: z.number().int().min(100).max(120_000),
    maxInputBytes: z.number().int().positive().max(2 * 1024 * 1024)
  })
  .strict();

export const PluginResearchSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(MAX_NAME),
    description: z.string().trim().max(MAX_DESCRIPTION).optional(),
    symbols: z.array(z.union([z.string().regex(/^[A-Z0-9][A-Z0-9./-]*$/).max(32), z.literal("*")])).min(1).max(100),
    steps: z.array(z.discriminatedUnion("kind", [ScrapeStepSchema, SummarizeStepSchema])).min(1).max(20),
    outputStep: IdSchema,
    delivery: z
      .object({
        strategy: z.boolean(),
        required: z.boolean(),
        maxAgeMs: z.number().int().nonnegative().max(30 * 24 * 60 * 60 * 1_000)
      })
      .strict()
  })
  .strict();

/* ----------------------------------------------------------------- cli skills --- */

/**
 * A CLI skill is a named, parameterised gather recipe: "collect this evidence for this
 * symbol using these research plans, and report what came back." It is how the CLI
 * builds up the information a plugin's methods later consume.
 *
 * A skill names research plans defined in the same plugin. It cannot name an
 * executable, a shell fragment, a file path, or an environment variable — a skill
 * schedules code the operator already installed and reviewed, nothing else.
 */
export const PluginCliSkillSchema = z
  .object({
    id: IdSchema,
    name: z.string().trim().min(1).max(MAX_NAME),
    description: z.string().trim().max(MAX_DESCRIPTION).optional(),
    // Research plan ids from this plugin's `research` array, run in order.
    gather: z.array(IdSchema).min(1).max(20),
    // Symbols the skill defaults to when the caller does not pass --symbol.
    defaultSymbols: z.array(z.string().regex(/^[A-Z0-9][A-Z0-9./-]*$/).max(32)).max(100).optional().default([]),
    // Advisory cadence for the operator's own scheduler. Stockbot never schedules from
    // a plugin: the docs are explicit that a scheduler command must not live in plan
    // data, and the same rule applies here.
    suggestedCadence: z.enum(["hourly", "daily", "weekly", "manual"]).optional().default("manual"),
    // Fail the skill when fewer than this many gather steps produced a snapshot.
    minSnapshots: z.number().int().min(0).max(20).optional().default(1)
  })
  .strict();

/* -------------------------------------------------------------------- plugin --- */

export const PluginPairingSchema = z
  .object({
    strategy: IdSchema,
    controls: z.array(MethodRefSchema).min(1).max(MAX_LIST),
    // Params to apply to each control so it is congruent with the strategy. Keyed by
    // control id; this is what stops a monthly strategy being compared with a daily
    // control, which measures turnover rather than skill.
    controlParams: z.record(MethodRefSchema, z.record(z.string().max(64), ParamValueSchema)).optional().default({}),
    seeds: z.number().int().min(1).max(100).optional().default(10),
    notes: z.string().trim().max(MAX_DESCRIPTION).optional()
  })
  .strict();

export const StockbotPluginV1Schema = z
  .object({
    kind: z.literal("stockbot.plugin.v1"),
    schemaVersion: z.literal(1),
    id: IdSchema,
    name: z.string().trim().min(1).max(MAX_NAME),
    version: SemverishSchema,
    description: z.string().trim().max(MAX_DESCRIPTION).optional(),
    author: z.string().trim().max(MAX_NAME).optional(),
    license: z.string().trim().max(64).optional(),
    homepage: z.string().trim().url().max(2_048).optional(),

    // Declared up front, before anything else substantive: what this plugin needs from
    // the operator before it can do anything at all.
    requires: PluginRequirementsSchema,

    methods: z.array(PluginMethodSchema).max(64).optional().default([]),
    research: z.array(PluginResearchSchema).max(20).optional().default([]),
    cli: z
      .object({ skills: z.array(PluginCliSkillSchema).max(20).optional().default([]) })
      .strict()
      .optional(),
    pairings: z.array(PluginPairingSchema).max(64).optional().default([])
  })
  .strict()
  .superRefine((plugin, context) => {
    const methodIds = new Set();
    for (const [index, method] of plugin.methods.entries()) {
      if (methodIds.has(method.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["methods", index, "id"], message: `Duplicate method id: ${method.id}` });
      }
      methodIds.add(method.id);
    }

    const researchIds = new Set();
    for (const [index, plan] of plugin.research.entries()) {
      if (researchIds.has(plan.id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["research", index, "id"], message: `Duplicate research id: ${plan.id}` });
      }
      researchIds.add(plan.id);

      const stepIds = new Set();
      plan.steps.forEach((step, stepIndex) => {
        if (stepIds.has(step.id)) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: ["research", index, "steps", stepIndex, "id"], message: `Duplicate step id: ${step.id}` });
        }
        if (step.kind === "summarize") {
          for (const dependency of step.dependsOn) {
            if (!stepIds.has(dependency)) {
              context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["research", index, "steps", stepIndex, "dependsOn"],
                message: `Dependency "${dependency}" must be an earlier step`
              });
            }
          }
        }
        stepIds.add(step.id);

        // A step may only read a source the plugin declared up front, so `requires`
        // stays an honest manifest rather than documentation that drifts.
        if (step.kind === "scrape" && !plugin.requires.sources.includes(step.sourceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["research", index, "steps", stepIndex, "sourceId"],
            message: `Source "${step.sourceId}" is used but not listed in requires.sources`
          });
        }
        if (step.kind === "summarize") {
          if (!plugin.requires.promptTemplates.includes(step.template)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["research", index, "steps", stepIndex, "template"],
              message: `Template "${step.template}" is used but not listed in requires.promptTemplates`
            });
          }
          if (!plugin.requires.aiCli) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["research", index, "steps", stepIndex],
              message: "A summarize step requires requires.aiCli to be true"
            });
          }
        }
      });

      const output = plan.steps.find((step) => step.id === plan.outputStep);
      if (!output) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["research", index, "outputStep"], message: "outputStep must name a step in this plan" });
      } else if (output.kind !== "summarize") {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["research", index, "outputStep"], message: "outputStep must name a summarize step" });
      }
    }

    if (plugin.research.length > 0 && !plugin.requires.capabilities.includes("research.web")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requires", "capabilities"], message: "Plugins with research plans must declare the research.web capability" });
    }
    if (plugin.methods.length > 0 && !plugin.requires.capabilities.includes("backtest")) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requires", "capabilities"], message: "Plugins with methods must declare the backtest capability" });
    }

    for (const [index, skill] of (plugin.cli?.skills ?? []).entries()) {
      if (!plugin.requires.capabilities.includes("cli")) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["requires", "capabilities"], message: "Plugins with CLI skills must declare the cli capability" });
      }
      for (const planId of skill.gather) {
        if (!researchIds.has(planId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["cli", "skills", index, "gather"],
            message: `Skill gathers unknown research plan "${planId}"`
          });
        }
      }
      if (skill.minSnapshots > skill.gather.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cli", "skills", index, "minSnapshots"],
          message: `minSnapshots (${skill.minSnapshots}) exceeds the ${skill.gather.length} gather step(s)`
        });
      }
    }

    // Every strategy must ship with at least one control. This is the whole reason the
    // format exists: a shared trading method that arrives without its null hypothesis is
    // a marketing claim, not a result.
    const paired = new Set(plugin.pairings.map((pairing) => pairing.strategy));
    for (const [index, method] of plugin.methods.entries()) {
      if (method.role === "strategy" && !paired.has(method.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["methods", index, "id"],
          message: `Strategy "${method.id}" has no entry in pairings; every strategy must declare its controls`
        });
      }
    }
    for (const [index, pairing] of plugin.pairings.entries()) {
      if (!methodIds.has(pairing.strategy)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["pairings", index, "strategy"], message: `Unknown strategy "${pairing.strategy}"` });
      }
      for (const control of pairing.controls) {
        // A control may be defined in this plugin or supplied by an already-installed
        // one; cross-plugin references are resolved at install time, not here.
        if (!methodIds.has(control) && !control.includes("/")) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pairings", index, "controls"],
            message: `Unknown control "${control}". Use "<pluginId>/<methodId>" to reference another plugin.`
          });
        }
      }
    }
  });

export function parsePlugin(input) {
  return StockbotPluginV1Schema.parse(input);
}

export function safeParsePlugin(input) {
  return StockbotPluginV1Schema.safeParse(input);
}
