import assert from "node:assert/strict";
import test from "node:test";

import { createAiCliAdapter } from "../../server/research/adapters/ai-cli.js";
import { createResearchAdapterRegistry } from "../../server/research/adapters/registry.js";
import {
  createWebPageAdapter,
  extractResearchText,
  isPublicResearchAddress,
  normalizeResearchWebSources,
  requestResearchPage,
  researchSourceUrl
} from "../../server/research/adapters/web-page.js";

const summary = Object.freeze({
  overview: "Revenue growth slowed while margins improved.",
  keyDrivers: ["Margin expansion"],
  risks: ["Slower demand"],
  opportunities: ["New product cycle"],
  sentiment: "mixed",
  confidence: 0.75
});

test("research adapter registry is code-owned and rejects duplicate or wrong-kind lookups", () => {
  const scraper = { id: "web.page.v1", kind: "scrape", version: "1", execute() {} };
  const registry = createResearchAdapterRegistry([scraper]);
  assert.equal(registry.resolve("scrape", scraper.id), scraper);
  assert.throws(() => registry.resolve("summarize", scraper.id), (error) => error.code === "RESEARCH_ADAPTER_NOT_FOUND");
  assert.throws(() => registry.register(scraper), (error) => error.code === "RESEARCH_ADAPTER_DUPLICATE");
});

test("web source adapter pins registered HTTPS origins and rejects private networks", async () => {
  assert.equal(isPublicResearchAddress("8.8.8.8"), true);
  for (const address of [
    "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "::1", "fd00::1",
    "2001:db8::1", "::ffff:7f00:1", "::ffff:0a00:1", "64:ff9b::7f00:1",
    "2002:7f00:1::", "fec0::1"
  ]) {
    assert.equal(isPublicResearchAddress(address), false, address);
  }
  assert.throws(() => normalizeResearchWebSources({ unsafe: "http://127.0.0.1" }), /HTTPS/);
  const sources = normalizeResearchWebSources({ filings: "https://example.com/base" });
  const url = researchSourceUrl(sources.filings, {
    sourceId: "filings",
    pathTemplate: "/companies/{{symbol}}",
    query: { view: "latest", symbol: "{{symbol}}" }
  }, "AAPL");
  assert.equal(url.toString(), "https://example.com/base/companies/AAPL?view=latest&symbol=AAPL");

  const requests = [];
  const adapter = createWebPageAdapter({
    sources: { filings: "https://example.com" },
    clock: () => 1_700_000_000_000,
    async requestPage(requested, options) {
      requests.push({ requested: requested.toString(), options });
      return {
        finalUrl: requested.toString(),
        contentType: "text/html",
        body: Buffer.from("<title>Quarterly update</title><script>ignore()</script><p>Revenue rose 8%.</p>")
      };
    }
  });
  const output = await adapter.execute({
    symbol: "AAPL",
    step: {
      id: "filings",
      request: { sourceId: "filings", pathTemplate: "/{{symbol}}", format: "html" },
      limits: { timeoutMs: 5000, maxBytes: 10000 }
    }
  });
  assert.equal(requests[0].requested, "https://example.com/AAPL");
  assert.equal(output.documents[0].title, "Quarterly update");
  assert.equal(output.documents[0].text, "Revenue rose 8%.");
  assert.equal(output.documents[0].fetchedAt, 1_700_000_000_000);
  assert.match(output.documents[0].contentHash, /^[a-f0-9]{64}$/);
});

test("web source URLs cannot traverse outside an operator-registered base path", () => {
  const sources = normalizeResearchWebSources({ news: "https://example.com/market-data" });
  assert.equal(
    researchSourceUrl(sources.news, {
      sourceId: "news",
      pathTemplate: "/stocks/{{symbol}}",
      format: "html"
    }, "AAPL").toString(),
    "https://example.com/market-data/stocks/AAPL"
  );
  assert.throws(
    () => researchSourceUrl(sources.news, {
      sourceId: "news",
      pathTemplate: "/../admin",
      format: "html"
    }, "AAPL"),
    (error) => error.code === "RESEARCH_SOURCE_PATH_INVALID"
  );
});

test("unconfigured source ids cannot resolve inherited object properties", async () => {
  const adapter = createWebPageAdapter({ sources: {} });
  await assert.rejects(
    adapter.execute({
      symbol: "AAPL",
      step: {
        id: "source",
        request: { sourceId: "constructor", pathTemplate: "/{{symbol}}", format: "html" },
        limits: { timeoutMs: 1_000, maxBytes: 1_000 }
      }
    }),
    (error) => error.code === "RESEARCH_SOURCE_NOT_CONFIGURED"
  );
});

test("web requests enforce one wall-clock deadline and base path across redirects", async () => {
  await assert.rejects(
    requestResearchPage(new URL("https://example.com/base/start"), {
      timeoutMs: 1_000,
      allowedBasePath: "/base",
      async requestOnce() {
        return { status: 302, location: "/admin", headers: {}, body: Buffer.alloc(0) };
      }
    }),
    (error) => error.code === "RESEARCH_SOURCE_REDIRECT_BLOCKED"
  );

  await assert.rejects(
    requestResearchPage(new URL("https://example.com/base/slow"), {
      timeoutMs: 5,
      allowedBasePath: "/base",
      requestOnce(_url, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    }),
    (error) => error.code === "RESEARCH_SOURCE_TIMEOUT"
  );
});

test("web extraction normalizes HTML and rejects malformed JSON", () => {
  assert.deepEqual(
    extractResearchText(Buffer.from("<h1>A &amp; B</h1><style>hidden</style><p>Fact</p>"), "text/html", "auto"),
    { title: null, text: "A & B\nFact" }
  );
  assert.throws(
    () => extractResearchText(Buffer.from("{"), "application/json", "json"),
    (error) => error.code === "RESEARCH_SOURCE_JSON_INVALID"
  );
});

test("AI CLI receives bounded JSON on stdin and returns a validated structured summary", async () => {
  const childScript = `
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      if (payload.protocolVersion !== 1 || !payload.prompt.instructions.includes("untrusted evidence")) process.exit(4);
      process.stdout.write(JSON.stringify({ summary: ${JSON.stringify(summary)}, model: "fixture-model" }));
    });
  `;
  const adapter = createAiCliAdapter({ command: process.execPath, args: ["-e", childScript], timeoutMs: 2_000 });
  const output = await adapter.execute({
    symbol: "AAPL",
    step: { limits: { timeoutMs: 1_000, maxInputBytes: 20_000 } },
    inputs: [{ documents: [{
      stepId: "news",
      sourceId: "news",
      finalUrl: "https://example.com/aapl",
      title: "Update",
      fetchedAt: 1_700_000_000_000,
      publishedAt: null,
      contentHash: "a".repeat(64),
      text: "Quarterly revenue rose."
    }] }]
  });
  assert.deepEqual(output.summary, summary);
  assert.equal(output.model, "fixture-model");
  assert.match(output.promptHash, /^[a-f0-9]{64}$/);
  assert.match(output.aiInputHash, /^[a-f0-9]{64}$/);
  assert.match(output.summarizerConfigHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(output.inputDocuments, [{
    stepId: "news",
    sourceId: "news",
    contentHash: "a".repeat(64),
    sourceBytes: 23,
    includedBytes: 23,
    truncated: false
  }]);

  const truncated = await adapter.execute({
    symbol: "AAPL",
    step: { limits: { timeoutMs: 1_000, maxInputBytes: 3_000 } },
    inputs: [{ documents: [{
      stepId: "long-news",
      sourceId: "news",
      finalUrl: "https://example.com/aapl/long",
      title: null,
      fetchedAt: 1_700_000_000_000,
      publishedAt: null,
      contentHash: "b".repeat(64),
      text: "Evidence sentence. ".repeat(1_000)
    }] }]
  });
  assert.equal(truncated.inputDocuments[0].truncated, true);
  assert.ok(truncated.inputDocuments[0].includedBytes < truncated.inputDocuments[0].sourceBytes);
  assert.notEqual(truncated.aiInputHash, output.aiInputHash);
});

test("AI CLI fails closed when absent or when output violates the summary contract", async () => {
  assert.throws(() => createAiCliAdapter({ command: "path-search-is-not-allowed" }), /absolute/);
  await assert.rejects(
    () => createAiCliAdapter().execute({ step: {}, symbol: "AAPL", inputs: [{ documents: [{}] }] }),
    (error) => error.code === "AI_CLI_UNCONFIGURED"
  );
  const adapter = createAiCliAdapter({
    command: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'))"],
    timeoutMs: 2_000
  });
  await assert.rejects(
    () => adapter.execute({
      step: {},
      symbol: "AAPL",
      inputs: [{ documents: [{ text: "fact", stepId: "x", sourceId: "x", finalUrl: "https://example.com", contentHash: "a" }] }]
    }),
    (error) => error.code === "AI_CLI_OUTPUT_INVALID"
  );
});
