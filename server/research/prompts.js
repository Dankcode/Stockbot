import { renderPrompt } from "../plugins/prompt-templates.js";

const defaultPrompt = renderPrompt("market-summary.v1");

export const MARKET_SUMMARY_PROMPT = defaultPrompt.prompt;

export const MARKET_SUMMARY_PROMPT_HASH = defaultPrompt.hash;

export function resolveResearchPrompt(step) {
  try {
    return renderPrompt(step.promptTemplate, step.promptSlots ?? {});
  } catch (cause) {
    const error = new Error(cause.message);
    error.code = "RESEARCH_TEMPLATE_INVALID";
    error.detail = { template: step.promptTemplate, causeCode: cause.code };
    error.cause = cause;
    throw error;
  }
}
