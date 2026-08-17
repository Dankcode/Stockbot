#!/usr/bin/env node
/**
 * Research source probe.
 *
 * Registering an origin in RESEARCH_WEB_SOURCES_JSON is not the same as that origin
 * actually being reachable through web.page.v1. The adapter enforces HTTPS-only,
 * public-DNS-only, identity encoding, an allowed content-type list, same-origin
 * redirects, and byte/time budgets. A source can pass `npm run research -- validate`
 * and still fail every run because it 403s a non-browser user agent, returns
 * application/atom+xml, or redirects to another host.
 *
 * This probe issues one real GET per configured path through the SAME adapter code
 * the pipeline uses, and reports exactly which guardrail rejected it. It never runs
 * the AI CLI, never writes to the database, and never creates a snapshot.
 *
 *   node scripts/research-probe.js
 *   node scripts/research-probe.js --symbol NVDA
 *   node scripts/research-probe.js --plan research-plans/catalyst-composite.json
 *   node scripts/research-probe.js --env-file "$HOME/.config/stockbot/stockbot.env"
 *   node scripts/research-probe.js --dry-run   # resolve URLs only, no requests
 *
 * Run it after changing RESEARCH_WEB_SOURCES_JSON, and again periodically: public
 * sites change their bot policy, their markup, and their redirect targets without
 * notice, and a source that silently starts failing will quietly starve your
 * research plans of snapshots.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  normalizeResearchWebSources,
  requestResearchPage,
  researchSourceUrl,
  extractResearchText
} from "../server/research/adapters/web-page.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PLANS = [
  "research-plans/sec-edgar-filings.json",
  "research-plans/gov-contracts-defense.json",
  "research-plans/market-news-sentiment.json",
  "research-plans/catalyst-composite.json",
  "research-plans/social-sentiment.json",
  "research-plans/news-social-analysis.json",
  "research-plans/example-market-summary.json"
];

function parseArguments(argv) {
  const options = { symbol: "AAPL", plans: [], envFile: null, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--symbol" && value) {
      options.symbol = value.trim().toUpperCase();
      index += 1;
    } else if (flag === "--plan" && value) {
      options.plans.push(value);
      index += 1;
    } else if (flag === "--env-file" && value) {
      options.envFile = value;
      index += 1;
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    }
  }
  if (options.plans.length === 0) options.plans = DEFAULT_PLANS;
  return options;
}

async function loadEnvFile(envFile) {
  if (!envFile) return;
  const contents = await readFile(envFile, "utf8");
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/s, "$2");
  }
}

async function loadPlans(planPaths) {
  const plans = [];
  for (const planPath of planPaths) {
    const absolute = path.isAbsolute(planPath) ? planPath : path.join(ROOT, planPath);
    try {
      plans.push({ file: planPath, plan: JSON.parse(await readFile(absolute, "utf8")) });
    } catch (cause) {
      if (cause?.code === "ENOENT") continue;
      throw new Error(`Could not read plan ${planPath}: ${cause.message}`);
    }
  }
  return plans;
}

function collectSteps(plans) {
  const steps = [];
  const seen = new Set();
  for (const { file, plan } of plans) {
    for (const step of plan.steps ?? []) {
      if (step.kind !== "scrape") continue;
      const key = JSON.stringify([step.request.sourceId, step.request.pathTemplate, step.request.query ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push({ planId: plan.id, planFile: file, step });
    }
  }
  return steps;
}

function shorten(value, limit = 110) {
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      "Usage: node scripts/research-probe.js [--symbol SYM] [--plan FILE] [--env-file PATH] [--dry-run]\n"
    );
    return 0;
  }

  await loadEnvFile(options.envFile);

  let sources;
  try {
    sources = normalizeResearchWebSources(JSON.parse(process.env.RESEARCH_WEB_SOURCES_JSON ?? "{}"));
  } catch (cause) {
    process.stderr.write(`RESEARCH_WEB_SOURCES_JSON is not usable: ${cause.message}\n`);
    return 1;
  }

  const registered = Object.keys(sources);
  if (registered.length === 0) {
    process.stderr.write(
      "No research web sources are registered. Set RESEARCH_WEB_SOURCES_JSON before probing.\n"
    );
    return 1;
  }

  const plans = await loadPlans(options.plans);
  const steps = collectSteps(plans);
  if (steps.length === 0) {
    process.stderr.write("No scrape steps were found in the selected plans.\n");
    return 1;
  }

  process.stdout.write(
    `${options.dryRun ? "Resolving" : "Probing"} ${steps.length} scrape step(s) for symbol ${options.symbol}.\n`
  );
  process.stdout.write(`Registered sources: ${registered.join(", ")}\n\n`);

  let failures = 0;
  let skipped = 0;

  for (const { planId, step } of steps) {
    const label = `${planId} › ${step.id} (${step.request.sourceId})`;
    const source = sources[step.request.sourceId];
    if (!source) {
      skipped += 1;
      process.stdout.write(`SKIP  ${label}\n      source id is not registered in RESEARCH_WEB_SOURCES_JSON\n\n`);
      continue;
    }

    let url;
    try {
      url = researchSourceUrl(source, step.request, options.symbol);
    } catch (cause) {
      failures += 1;
      process.stdout.write(`FAIL  ${label}\n      ${cause.code ?? "URL_INVALID"}: ${cause.message}\n\n`);
      continue;
    }

    if (options.dryRun) {
      process.stdout.write(`URL   ${label}\n      ${url.toString()}\n\n`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const response = await requestResearchPage(url, {
        timeoutMs: step.limits?.timeoutMs ?? 10_000,
        maxBytes: step.limits?.maxBytes ?? 250_000,
        allowedBasePath: source.basePath
      });
      const extracted = extractResearchText(response.body, response.contentType, step.request.format);
      const elapsed = Date.now() - startedAt;
      const bytes = Buffer.byteLength(extracted.text, "utf8");
      const budget = step.limits?.maxBytes ?? 250_000;
      const note = bytes >= budget * 0.95 ? "  [near byte budget — raise maxBytes or expect truncation]" : "";
      process.stdout.write(`OK    ${label}\n`);
      process.stdout.write(`      ${url.toString()}\n`);
      process.stdout.write(
        `      ${response.contentType} · ${bytes} extracted bytes · ${elapsed} ms${note}\n`
      );
      process.stdout.write(`      ${shorten(extracted.title ?? extracted.text)}\n\n`);
    } catch (cause) {
      failures += 1;
      process.stdout.write(`FAIL  ${label}\n`);
      process.stdout.write(`      ${url.toString()}\n`);
      process.stdout.write(`      ${cause.code ?? "ERROR"}: ${cause.message}\n`);
      if (cause.code === "RESEARCH_SOURCE_HTTP" && cause.detail?.status === 403) {
        process.stdout.write(
          "      403 usually means the origin rejects the fixed StockbotResearch user agent.\n"
        );
      }
      if (cause.code === "RESEARCH_SOURCE_CONTENT_TYPE") {
        process.stdout.write(
          "      web.page.v1 accepts only json, ld+json, rss+xml, xml, html, and plain text.\n"
        );
      }
      if (cause.code === "RESEARCH_SOURCE_REDIRECT_BLOCKED") {
        process.stdout.write(
          "      The origin redirected off-host. Register the redirect target as the origin instead.\n"
        );
      }
      process.stdout.write("\n");
    }
  }

  const passed = steps.length - failures - skipped;
  process.stdout.write(`${passed} ok · ${failures} failed · ${skipped} skipped\n`);
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
