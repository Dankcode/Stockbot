import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 250_000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = Object.freeze([
  "application/json",
  "application/ld+json",
  "application/rss+xml",
  "application/xml",
  "text/html",
  "text/plain",
  "text/xml"
]);

const SPECIAL_RESEARCH_IPV4 = new BlockList();
const SPECIAL_RESEARCH_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) SPECIAL_RESEARCH_IPV4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48],
  ["2001:10::", 28], ["2001:20::", 28], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]
]) SPECIAL_RESEARCH_IPV6.addSubnet(network, prefix, "ipv6");

function researchError(message, code, detail) {
  const error = new Error(message);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

/** Rejects non-global, transition, translation, private, and special-use ranges. */
export function isPublicResearchAddress(address) {
  const value = String(address).toLowerCase().split("%", 1)[0];
  const family = isIP(value);
  if (family === 4) return !SPECIAL_RESEARCH_IPV4.check(value, "ipv4");
  if (family === 6) return !SPECIAL_RESEARCH_IPV6.check(value, "ipv6");
  return false;
}

export function normalizeResearchWebSources(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Research web sources must be a record of source ids to HTTPS origins.");
  }
  const sources = Object.create(null);
  for (const [id, raw] of Object.entries(input)) {
    if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) {
      throw new TypeError(`Invalid research web source id: ${id}`);
    }
    const url = new URL(String(raw));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new TypeError(`Research web source ${id} must be a credential-free HTTPS base URL.`);
    }
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    sources[id] = Object.freeze({ id, origin: url.origin, basePath });
  }
  return Object.freeze(sources);
}

function substitute(value, symbol) {
  const rendered = String(value).replaceAll("{{symbol}}", encodeURIComponent(symbol));
  if (/{{|}}/.test(rendered)) {
    throw researchError("Research path contains an unsupported template variable.", "RESEARCH_TEMPLATE_INVALID");
  }
  return rendered;
}

export function researchSourceUrl(source, request, symbol) {
  if (!source) {
    throw researchError(`Research web source ${request.sourceId} is not configured.`, "RESEARCH_SOURCE_NOT_CONFIGURED");
  }
  const path = substitute(request.pathTemplate, symbol);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw researchError("Research source path must be an origin-relative path.", "RESEARCH_SOURCE_PATH_INVALID");
  }
  const url = new URL(`${source.basePath}${path}`, source.origin);
  if (url.origin !== source.origin) {
    throw researchError("Research source path escaped its registered origin.", "RESEARCH_SOURCE_ORIGIN_ESCAPE");
  }
  if (source.basePath && url.pathname !== source.basePath && !url.pathname.startsWith(`${source.basePath}/`)) {
    throw researchError("Research source path escaped its registered base path.", "RESEARCH_SOURCE_PATH_INVALID");
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    url.searchParams.set(key, substitute(value, symbol));
  }
  return url;
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : researchError("Research source request was canceled.", "RESEARCH_SOURCE_ABORTED");
}

async function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

async function pinnedAddress(hostname, lookup = dnsLookup, signal) {
  const addresses = await awaitWithSignal(lookup(hostname, { all: true, verbatim: true }), signal);
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw researchError("Research source hostname did not resolve.", "RESEARCH_SOURCE_DNS_EMPTY");
  }
  if (addresses.some(({ address }) => !isPublicResearchAddress(address))) {
    throw researchError("Research source resolved to a non-public network address.", "RESEARCH_SOURCE_PRIVATE_ADDRESS");
  }
  return addresses[0];
}

async function requestOnce(url, { timeoutMs, maxBytes, signal, lookup }) {
  const pinned = await pinnedAddress(url.hostname, lookup, signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const fail = (error) => finish(reject, error);
    const abort = () => request.destroy(abortError(signal));
    const request = https.request(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1",
        "accept-encoding": "identity",
        "user-agent": "StockbotResearch/1.0 (+local research pipeline)"
      },
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
      servername: url.hostname
    }, (response) => {
      const status = Number(response.statusCode ?? 0);
      if ([301, 302, 303, 307, 308].includes(status)) {
        finish(resolve, { status, location: response.headers.location ?? null, headers: response.headers, body: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      const contentLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy(researchError("Research source response exceeds its byte budget.", "RESEARCH_SOURCE_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(researchError("Research source response exceeds its byte budget.", "RESEARCH_SOURCE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(resolve, {
        status,
        headers: response.headers,
        body: Buffer.concat(chunks, bytes),
        location: null
      }));
      response.on("error", fail);
    });
    request.on("error", fail);
    request.setTimeout(timeoutMs, () => request.destroy(
      researchError("Research source request timed out.", "RESEARCH_SOURCE_TIMEOUT", { timeoutMs })
    ));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    request.end();
  });
}

export async function requestResearchPage(url, options = {}) {
  const origin = url.origin;
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes ?? DEFAULT_MAX_BYTES);
  const allowedBasePath = String(options.allowedBasePath ?? "");
  const controller = new AbortController();
  const callerAbort = () => controller.abort(
    researchError("Research source request was canceled.", "RESEARCH_SOURCE_ABORTED")
  );
  if (options.signal?.aborted) callerAbort();
  else options.signal?.addEventListener("abort", callerAbort, { once: true });
  const deadline = setTimeout(() => controller.abort(
    researchError("Research source request timed out.", "RESEARCH_SOURCE_TIMEOUT", { timeoutMs })
  ), timeoutMs);
  const requestPage = options.requestOnce ?? requestOnce;
  let current = new URL(url);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await requestPage(current, {
        ...options,
        timeoutMs,
        maxBytes,
        signal: controller.signal
      });
      if (response.location) {
        if (redirects === MAX_REDIRECTS) {
          throw researchError("Research source exceeded the redirect limit.", "RESEARCH_SOURCE_REDIRECT_LIMIT");
        }
        const next = new URL(response.location, current);
        if (next.protocol !== "https:" || next.origin !== origin || next.username || next.password) {
          throw researchError("Research source redirected outside its registered HTTPS origin.", "RESEARCH_SOURCE_REDIRECT_BLOCKED");
        }
        if (allowedBasePath && next.pathname !== allowedBasePath && !next.pathname.startsWith(`${allowedBasePath}/`)) {
          throw researchError("Research source redirected outside its registered base path.", "RESEARCH_SOURCE_REDIRECT_BLOCKED");
        }
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw researchError(`Research source returned HTTP ${response.status}.`, "RESEARCH_SOURCE_HTTP", {
          status: response.status
        });
      }
      const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase();
      if (encoding !== "identity") {
        throw researchError("Research source returned unsupported content encoding.", "RESEARCH_SOURCE_ENCODING");
      }
      const contentType = String(response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw researchError(`Research source content type ${contentType || "unknown"} is not allowed.`, "RESEARCH_SOURCE_CONTENT_TYPE");
      }
      return Object.freeze({ finalUrl: current.toString(), contentType, body: response.body });
    }
    throw researchError("Research source redirect processing failed.", "RESEARCH_SOURCE_REDIRECT_LIMIT");
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", callerAbort);
  }
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, number) => String.fromCodePoint(Number.parseInt(number, 16)));
}

export function extractResearchText(body, contentType, format = "auto") {
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  const selected = format === "auto"
    ? contentType.includes("json") ? "json" : contentType.includes("html") ? "html" : "text"
    : format;
  if (selected === "json") {
    try {
      return Object.freeze({ title: null, text: JSON.stringify(JSON.parse(raw)) });
    } catch (cause) {
      throw researchError("Research source returned invalid JSON.", "RESEARCH_SOURCE_JSON_INVALID", { cause });
    }
  }
  if (selected === "html") {
    const titleMatch = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const withoutInactive = raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
      .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, " ")
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\/?(p|div|section|article|main|header|footer|li|tr|h[1-6]|br)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    const normalize = (value) => decodeEntities(value).replace(/\r/g, "").replace(/[\t ]+/g, " ").replace(/\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return Object.freeze({ title: titleMatch ? normalize(titleMatch[1]) : null, text: normalize(withoutInactive) });
  }
  return Object.freeze({ title: null, text: raw.replace(/\r/g, "").trim() });
}

export function createWebPageAdapter({ sources = {}, requestPage = requestResearchPage, clock = Date.now, lookup } = {}) {
  const registeredSources = normalizeResearchWebSources(sources);
  return Object.freeze({
    id: "web.page.v1",
    kind: "scrape",
    version: "1",
    available: Object.keys(registeredSources).length > 0,
    async execute({ step, symbol, signal }) {
      const source = registeredSources[step.request.sourceId];
      const requested = researchSourceUrl(source, step.request, symbol);
      const response = await requestPage(requested, {
        timeoutMs: step.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: step.limits?.maxBytes ?? DEFAULT_MAX_BYTES,
        signal,
        lookup,
        allowedBasePath: source.basePath
      });
      const fetchedAt = clock();
      const extracted = extractResearchText(response.body, response.contentType, step.request.format);
      if (!extracted.text) {
        throw researchError("Research source produced no extractable text.", "RESEARCH_SOURCE_EMPTY");
      }
      return Object.freeze({
        kind: "documents",
        documents: Object.freeze([Object.freeze({
          stepId: step.id,
          sourceId: step.request.sourceId,
          requestedUrl: requested.toString(),
          finalUrl: response.finalUrl,
          title: extracted.title,
          fetchedAt,
          publishedAt: null,
          contentType: response.contentType,
          contentHash: createHash("sha256").update(extracted.text, "utf8").digest("hex"),
          byteCount: Buffer.byteLength(extracted.text, "utf8"),
          text: extracted.text
        })])
      });
    }
  });
}
