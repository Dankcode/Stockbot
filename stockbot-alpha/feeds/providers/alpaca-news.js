/**
 * Alpaca Historical News provider.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SOURCE, AND NOT A SCRAPER
 * ─────────────────────────────────────────────────────────────────────────────
 * The instinct for news-driven trading is to scrape a finance portal. Three
 * reasons not to:
 *
 *   1. History. A scraper gets you today's front page. Alpaca's news endpoint
 *      returns articles back to 2015 *with their original publish timestamps*,
 *      which is the only way to backtest a news strategy honestly. Without
 *      timestamped history you cannot validate the idea at all — you can only
 *      run it live and hope.
 *   2. Terms. This is a licensed feed (Benzinga, via Alpaca) that you are
 *      entitled to query with the keys already in your .env. Scraping a portal
 *      whose terms forbid it puts your IP and possibly your account at risk for
 *      strictly worse data.
 *   3. Structure. Symbols already resolved per article, stable IDs for
 *      deduplication, consistent UTC timestamps. A scraper hands you HTML that
 *      breaks on the next redesign.
 *
 * Endpoint:  GET https://data.alpaca.markets/v1beta1/news
 * Auth:      APCA-API-KEY-ID / APCA-API-SECRET-KEY headers
 * Docs:      https://docs.alpaca.markets/us/docs/historical-news-data
 *
 * Requires ALPACA_API_KEY and ALPACA_API_SECRET. If either is missing this
 * provider reports unavailable rather than substituting anything — the same
 * discipline the code review asks for on the price path.
 */

import { RateLimiter, politeFetch } from "../cache.js";

const BASE_URL = "https://data.alpaca.markets/v1beta1/news";

// Alpaca's documented ceiling depends on plan tier; 5/sec is comfortably under
// the free-tier limit and fast enough to page years of history in minutes.
const limiter = new RateLimiter(5);

export const id = "alpaca-news";
export const label = "Alpaca / Benzinga News";
export const supportsHistory = true;

/** @returns {{ok: boolean, reason?: string}} */
export function available(env = process.env) {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) {
    return { ok: false, reason: "ALPACA_API_KEY and ALPACA_API_SECRET are required for the news feed." };
  }
  return { ok: true };
}

function headers(env) {
  return {
    "APCA-API-KEY-ID": env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": env.ALPACA_API_SECRET,
    Accept: "application/json"
  };
}

/**
 * Canonical event shape emitted by every provider in this package.
 *
 * @typedef {object} FeedEvent
 * @property {string}   id           stable, provider-scoped
 * @property {string}   source       provider id
 * @property {number}   publishedAt  epoch ms, UTC
 * @property {string[]} symbols
 * @property {string}   headline
 * @property {string}   summary
 * @property {string}   url
 * @property {object}   meta         provider-specific extras
 */

/** @returns {FeedEvent} */
function normalize(article) {
  return {
    id: `alpaca-news:${article.id}`,
    source: id,
    // created_at is when the article hit the wire. updated_at can be later
    // (corrections, added symbols) and using it would leak revisions backward
    // in time, so created_at is the only safe choice.
    publishedAt: Date.parse(article.created_at),
    symbols: Array.isArray(article.symbols) ? article.symbols : [],
    headline: article.headline ?? "",
    summary: article.summary ?? "",
    url: article.url ?? "",
    meta: {
      author: article.author ?? null,
      newsSource: article.source ?? null,
      updatedAt: article.updated_at ? Date.parse(article.updated_at) : null
    }
  };
}

/**
 * Fetch news for symbols over a window, following pagination to completion.
 *
 * @param {object} params
 * @param {string[]} params.symbols
 * @param {number} params.startMs inclusive
 * @param {number} params.endMs   exclusive
 * @param {number} [params.limit=50] page size (Alpaca max 50)
 * @param {boolean} [params.includeContent=false] full body text; large
 * @param {object} [params.env]
 * @param {number} [params.maxPages=200] guard against unbounded paging
 * @returns {Promise<FeedEvent[]>}
 */
export async function fetchEvents({
  symbols,
  startMs,
  endMs,
  limit = 50,
  includeContent = false,
  env = process.env,
  maxPages = 200
}) {
  const check = available(env);
  if (!check.ok) throw new Error(check.reason);
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("alpaca-news: symbols must be a non-empty array");
  }

  const events = [];
  const seen = new Set();
  let pageToken;
  let pages = 0;

  do {
    const url = new URL(BASE_URL);
    url.searchParams.set("symbols", symbols.join(","));
    url.searchParams.set("start", new Date(startMs).toISOString());
    url.searchParams.set("end", new Date(endMs).toISOString());
    url.searchParams.set("limit", String(Math.min(limit, 50)));
    url.searchParams.set("sort", "asc");
    if (includeContent) url.searchParams.set("include_content", "true");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await politeFetch(url.toString(), { headers: headers(env) }, { limiter });
    const payload = await response.json();

    for (const article of payload.news ?? []) {
      const event = normalize(article);
      if (!Number.isFinite(event.publishedAt)) continue;
      // Alpaca can return an article once per matching symbol across pages.
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }

    pageToken = payload.next_page_token ?? undefined;
    pages += 1;
  } while (pageToken && pages < maxPages);

  events.sort((a, b) => a.publishedAt - b.publishedAt);
  return events;
}
