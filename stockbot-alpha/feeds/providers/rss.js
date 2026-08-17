/**
 * Generic RSS/Atom provider — live signal only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * READ THIS BEFORE ADDING FEEDS
 * ─────────────────────────────────────────────────────────────────────────────
 * This provider is a mechanism, not a list of endorsed sources. You choose the
 * feed URLs, and you are responsible for checking that each publisher permits
 * automated retrieval. A feed being technically reachable is not permission.
 * Publishing an RSS feed generally signals an intent to be read by machines,
 * but terms differ per outlet and some explicitly restrict commercial or
 * algorithmic use. Check before you add.
 *
 * The default below is the SEC's own filing RSS, which is unambiguously
 * permitted under the same fair-access policy as the rest of EDGAR.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS CANNOT BE BACKTESTED
 * ─────────────────────────────────────────────────────────────────────────────
 * An RSS feed carries only its current window — typically the last 20–100
 * items. There is no history endpoint. So features built from RSS can drive a
 * live paper session, but a backtest over them is impossible: you would be
 * testing today's headlines against last year's prices.
 *
 * `supportsHistory = false` is enforced by the feature resolver, which refuses
 * to use a non-historical provider in a backtest rather than silently
 * producing a meaningless result.
 */

import { RateLimiter, politeFetch } from "../cache.js";

const limiter = new RateLimiter(2);

export const id = "rss";
export const label = "RSS / Atom feeds (live only)";
export const supportsHistory = false;

export const DEFAULT_FEEDS = [
  // SEC EDGAR — all recent filings. Permitted; same policy as the rest of EDGAR.
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom"
];

export function available(env = process.env) {
  const feeds = parseFeeds(env);
  if (feeds.length === 0) {
    return { ok: false, reason: "No feeds configured. Set RSS_FEEDS to a comma-separated list of URLs." };
  }
  if (feeds.some((url) => url.includes("sec.gov")) && !env.SEC_USER_AGENT) {
    return { ok: false, reason: "SEC feeds require SEC_USER_AGENT (app name + contact email)." };
  }
  return { ok: true };
}

function parseFeeds(env) {
  const configured = String(env.RSS_FEEDS ?? "").trim();
  if (configured) return configured.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_FEEDS;
}

/** Minimal tag extractor. Adequate for well-formed feeds; not a general parser. */
function tag(block, name) {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!match) return "";
  return match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function extractLink(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1];
  return tag(block, "link");
}

/**
 * Fetch current feed items.
 *
 * @param {object} params
 * @param {string[]} [params.symbols] optional filter; matched against title/summary
 * @param {object} [params.env]
 * @returns {Promise<import("./alpaca-news.js").FeedEvent[]>}
 */
export async function fetchEvents({ symbols = [], env = process.env } = {}) {
  const check = available(env);
  if (!check.ok) throw new Error(check.reason);

  const feeds = parseFeeds(env);
  const headers = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" };
  if (env.SEC_USER_AGENT) headers["User-Agent"] = env.SEC_USER_AGENT;

  const events = [];
  const wanted = symbols.map((s) => String(s).toUpperCase());

  for (const url of feeds) {
    let xml;
    try {
      const response = await politeFetch(url, { headers }, { limiter, retries: 1 });
      xml = await response.text();
    } catch (error) {
      // One bad feed should not sink the batch. Surface it and continue.
      events.push({
        id: `rss:error:${url}`,
        source: id,
        publishedAt: Date.now(),
        symbols: [],
        headline: `Feed unavailable: ${url}`,
        summary: error.message,
        url,
        meta: { error: true }
      });
      continue;
    }

    const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) ?? [];
    for (const block of blocks) {
      const title = tag(block, "title");
      const summary = tag(block, "summary") || tag(block, "description");
      const rawDate =
        tag(block, "pubDate") || tag(block, "updated") || tag(block, "published") || tag(block, "dc:date");
      const publishedAt = Date.parse(rawDate);
      if (!Number.isFinite(publishedAt)) continue;

      const haystack = `${title} ${summary}`.toUpperCase();
      const matched = wanted.filter((s) => new RegExp(`\\b${s}\\b`).test(haystack));
      if (wanted.length > 0 && matched.length === 0) continue;

      const link = extractLink(block);
      events.push({
        id: `rss:${Buffer.from(link || title).toString("base64url").slice(0, 32)}`,
        source: id,
        publishedAt,
        symbols: matched,
        headline: title,
        summary,
        url: link,
        meta: { feed: url }
      });
    }
  }

  events.sort((a, b) => a.publishedAt - b.publishedAt);
  return events;
}
