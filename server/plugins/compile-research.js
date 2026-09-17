/**
 * Lowers a plugin's `research` entries into canonical ResearchPlanV1 documents.
 *
 * The plugin format is the authoring surface; ResearchPlanV1 stays the execution and
 * provenance surface. Everything downstream — the adapter registry, origin pinning,
 * immutable snapshots, session pinning, point-in-time selection — keeps working
 * unchanged, and a plugin gains no reach that a hand-written plan did not already have.
 *
 * The one substantive translation is the prompt. A plugin names a registered template
 * and fills typed slots; the persisted plan retains that declarative selection. The
 * runner renders it with server-authored instructions just before it calls the AI CLI.
 */
import { renderPrompt } from "./prompt-templates.js";

export class ResearchCompileError extends Error {
  constructor(message, { code = "PLUGIN_RESEARCH_COMPILE", planId } = {}) {
    super(planId ? `${planId}: ${message}` : message);
    this.name = "ResearchCompileError";
    this.code = code;
    this.planId = planId;
  }
}

/**
 * Plan ids are namespaced by plugin so two shared plugins can both ship a plan called
 * "sentiment" without colliding in the operator's plan table.
 */
export function qualifiedPlanId(pluginId, planId) {
  return `${pluginId}.${planId}`;
}

export function compileResearchPlan(plugin, plan) {
  const steps = [];
  const prompts = {};

  for (const step of plan.steps) {
    if (step.kind === "scrape") {
      const request = {
        sourceId: step.sourceId,
        pathTemplate: step.pathTemplate,
        format: step.format
      };
      if (step.query && Object.keys(step.query).length > 0) request.query = { ...step.query };
      steps.push({
        id: step.id,
        kind: "scrape",
        adapter: "web.page.v1",
        request,
        limits: { timeoutMs: step.timeoutMs, maxBytes: step.maxBytes }
      });
      continue;
    }

    let rendered;
    try {
      rendered = renderPrompt(step.template, step.slots ?? {});
    } catch (cause) {
      throw new ResearchCompileError(cause.message, { planId: plan.id, code: cause.code });
    }
    prompts[step.id] = rendered;

    steps.push({
      id: step.id,
      kind: "summarize",
      adapter: "ai.cli.summary.v1",
      dependsOn: [...step.dependsOn],
      promptTemplate: step.template,
      responseSchema: "market-summary.v1",
      limits: { timeoutMs: step.timeoutMs, maxInputBytes: step.maxInputBytes }
    });
    if (step.slots && Object.keys(step.slots).length > 0) {
      steps.at(-1).promptSlots = { ...step.slots };
    }
  }

  const compiled = {
    schemaVersion: 1,
    id: qualifiedPlanId(plugin.id, plan.id),
    name: plan.name,
    symbols: [...plan.symbols],
    steps,
    outputStep: plan.outputStep,
    delivery: { ...plan.delivery }
  };
  if (plan.description) compiled.description = plan.description;

  return Object.freeze({
    plan: compiled,
    prompts: Object.freeze(prompts),
    // Surfaced so `plugin inspect` can show the rendered, server-owned prompt alongside
    // the plan's declarative template selection.
    templates: Object.freeze(
      plan.steps
        .filter((step) => step.kind === "summarize")
        .map((step) => Object.freeze({ stepId: step.id, template: step.template, slots: step.slots ?? {} }))
    )
  });
}

export function compilePluginResearch(plugin) {
  return Object.freeze((plugin.research ?? []).map((plan) => compileResearchPlan(plugin, plan)));
}
