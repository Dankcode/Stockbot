/**
 * SEC EDGAR filings provider — 8-K material events and Form 4 insider trades.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FAIR-ACCESS COMPLIANCE
 * ─────────────────────────────────────────────────────────────────────────────
 * The SEC publishes explicit rules for automated access
 * (https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data):
 *
 *   • Max 10 requests/second. Enforced here by a RateLimiter set to 8/sec, so
 *     concurrent callers still stay under the ceiling.
 *   • You must declare a User-Agent containing an app or organization name and
 *     a working contact email. A generic library default gets you 403'd and
 *     your IP blocked for roughly ten minutes.
 *   • "The SEC does not allow botnets or automated tools to crawl the site."
 *     Fetch specific documents you need; do not walk the archive.
 *
 * Set SEC_USER_AGENT in .env, e.g.
 *     SEC_USER_AGENT=Stockbot/0.1 (you@example.com)
 * This provider refuses to run without it, rather than sending something
 * generic and getting the IP blocked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY FILINGS ARE A BETTER SIGNAL THAN NEWS
 * ─────────────────────────────────────────────────────────────────────────────
 * A filing has a legally mandated timestamp and an unambiguous meaning. An
 * 8-K item 5.02 *is* an executive departure; a headline about one is somebody's
 * interpretation of it. Form 4 open-market purchases by officers are among the
 * better-documented public signals in the literature. Both are free, both are
 * point-in-time exact, and neither requires scraping anything.
 *
 * Caveat worth knowing: `acceptanceDateTime` (when EDGAR accepted the
 * submission) is the moment the market could first see it, and it is often
 * hours after `filingDate`. This provider uses acceptance time. Using
 * filingDate would grant same-day look-ahead on every evening filing.
 */

import { RateLimiter, politeFetch } from "../cache.js";

const SUBMISSIONS_URL = "https://data.sec.gov/submissions";
const TICKER_MAP_URL = "https://www.sec.gov/files/company_tickers.json";

// SEC ceiling is 10/sec; 8 leaves headroom for other callers in-process.
const limiter = new RateLimiter(8);

export const id = "sec-edgar";
export const label = "SEC EDGAR filings";
export const supportsHistory = true;

/** Material-event form types worth reacting to, with plain-language labels. */
export const FORM_LABELS = {
  "8-K": "Material event",
  "8-K/A": "Material event (amended)",
  4: "Insider transaction",
  "4/A": "Insider transaction (amended)",
  "10-Q": "Quarterly report",
  "10-K": "Annual report",
  "13D": "Activist stake",
  "SC 13D": "Activist stake",
  "SC 13D/A": "Activist stake (amended)",
  "SC 13G": "Passive stake"
};

export function available(env = process.env) {
  if (!env.SEC_USER_AGENT || !env.SEC_USER_AGENT.includes("@")) {
    return {
      ok: false,
      reason:
        "SEC_USER_AGENT must be set to an app name plus contact email, " +
        'e.g. SEC_USER_AGENT="Stockbot/0.1 (you@example.com)". ' +
        "The SEC fair-access policy requires it and will block requests without it."
    };
  }
  return { ok: true };
}

function headers(env) {
  return {
    "User-Agent": env.SEC_USER_AGENT,
    "Accept-Encoding": "gzip, deflate",
    Accept: "application/json"
  };
}

let tickerMapPromise;

/**
 * Ticker → zero-padded CIK. Cached in-process; the file is ~1 MB and changes
 * rarely, so one fetch per process is the right granularity.
 *
 * @returns {Promise<Map<string, string>>}
 */
export async function tickerToCik(env = process.env) {
  if (!tickerMapPromise) {
    tickerMapPromise = (async () => {
      const response = await politeFetch(TICKER_MAP_URL, { headers: headers(env) }, { limiter });
      const payload = await response.json();
      const map = new Map();
      for (const row of Object.values(payload)) {
        if (row?.ticker && row?.cik_str != null) {
          map.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, "0"));
        }
      }
      return map;
    })().catch((error) => {
      // Don't cache a failure forever — let the next call retry.
      tickerMapPromise = undefined;
      throw error;
    });
  }
  return tickerMapPromise;
}

/**
 * Fetch recent filings for one symbol.
 *
 * Uses the submissions API, which returns the most recent ~1000 filings in a
 * single request — efficient, and well within fair-access norms. Deeper
 * history lives in the paginated `files` entries; this provider reads the
 * recent block only, which covers several years for a typical issuer.
 *
 * @param {object} params
 * @param {string} params.symbol
 * @param {number} params.startMs
 * @param {number} params.endMs
 * @param {string[]} [params.forms] form types to keep; defaults to material events
 * @param {object} [params.env]
 * @returns {Promise<import("./alpaca-news.js").FeedEvent[]>}
 */
export async function fetchEvents({
  symbol,
  startMs,
  endMs,
  forms = ["8-K", "4", "SC 13D", "SC 13D/A"],
  env = process.env
}) {
  const check = available(env);
  if (!check.ok) throw new Error(check.reason);

  const map = await tickerToCik(env);
  const cik = map.get(String(symbol).toUpperCase());
  if (!cik) {
    // Not every tradable symbol is an SEC filer — ETFs, ADRs and crypto pairs
    // legitimately have no CIK. Empty is the correct answer, not an error.
    return [];
  }

  const response = await politeFetch(
    `${SUBMISSIONS_URL}/CIK${cik}.json`,
    { headers: headers(env) },
    { limiter }
  );
  const payload = await response.json();
  const recent = payload.filings?.recent;
  if (!recent?.accessionNumber) return [];

  const keep = new Set(forms.map((f) => String(f).toUpperCase()));
  const events = [];

  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const form = String(recent.form[i] ?? "").toUpperCase();
    if (!keep.has(form)) continue;

    // Acceptance time is when the filing became publicly visible. Fall back to
    // filingDate only if acceptance is missing, and when we do, push to end of
    // day so we never claim to have seen it earlier than we could have.
    const acceptance = recent.acceptanceDateTime?.[i];
    const publishedAt = acceptance
      ? Date.parse(acceptance)
      : Date.parse(`${recent.filingDate[i]}T23:59:59Z`);
    if (!Number.isFinite(publishedAt) || publishedAt < startMs || publishedAt >= endMs) continue;

    const accession = recent.accessionNumber[i];
    const accessionPlain = accession.replace(/-/g, "");
    const primaryDoc = recent.primaryDocument?.[i] ?? "";

    events.push({
      id: `sec-edgar:${accession}`,
      source: id,
      publishedAt,
      symbols: [String(symbol).toUpperCase()],
      headline: `${FORM_LABELS[form] ?? form} — ${payload.name ?? symbol} (${form})`,
      summary: recent.primaryDocDescription?.[i] ?? recent.items?.[i] ?? "",
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPlain}/${primaryDoc}`,
      meta: {
        form,
        cik,
        accession,
        // 8-K item codes, e.g. "5.02,9.01" — the actual event taxonomy, and
        // far more useful than the headline for gating a strategy.
        items: recent.items?.[i] ?? "",
        filingDate: recent.filingDate?.[i] ?? null,
        reportDate: recent.reportDate?.[i] ?? null
      }
    });
  }

  events.sort((a, b) => a.publishedAt - b.publishedAt);
  return events;
}
