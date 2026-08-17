# Research source catalogue

This document covers the shipped scrape sources and research plans. For the pipeline itself — the adapter protocol, AI CLI contract, point-in-time semantics, and provenance model — see [AI research](./AI_RESEARCH.md).

Nothing here changes Stockbot's security model. Every source is an operator-registered HTTPS origin read through the existing code-owned `web.page.v1` adapter, and every plan is inert JSON data.

## What `web.page.v1` can and cannot do

Read this before adding a source. Most source ideas die on one of these four constraints, and it is much cheaper to find out here than after writing a plan.

| Constraint | Consequence |
|---|---|
| **GET only** | Any API whose search endpoint is POST is unreachable. This rules out most of the USAspending award-search surface. |
| **No credentials** | The plan schema rejects query keys matching `api_key`, `token`, `secret`, `authorization`, and friends, and origins may not carry userinfo or a base query string. Any key-gated API is unreachable. |
| **Fixed User-Agent** | The adapter always sends `StockbotResearch/1.0 (+local research pipeline)`. Origins that gate on a browser-like or contact-bearing UA will 403. |
| **Same-origin redirects only** | A source that 302s to a different host fails closed. Register the *final* host, not the vanity one. |

Allowed content types are `application/json`, `application/ld+json`, `application/rss+xml`, `application/xml`, `text/html`, `text/plain`, and `text/xml`. Notably **`application/atom+xml` is not allowed**, which rules out several government ATOM feeds including the FPDS `ezsearch` feed.

## Register the origins

Source ids must match `^[a-z0-9][a-z0-9.-]{1,63}$`. Add to your protected env:

```dotenv
RESEARCH_WEB_SOURCES_JSON='{"sec-edgar":"https://www.sec.gov","sec-edgar-fts":"https://efts.sec.gov","dod-contracts":"https://www.war.gov","usaspending":"https://api.usaspending.gov","nasdaq-news":"https://www.nasdaq.com","finviz":"https://finviz.com"}'
```

Restart Stockbot, then confirm the sources actually work end to end:

```bash
npm run research -- adapters --env-file "$HOME/.config/stockbot/stockbot.env"
npm run research:probe -- --symbol NVDA --env-file "$HOME/.config/stockbot/stockbot.env"
```

`research:probe` issues one real GET per scrape step through the same adapter guardrails the pipeline uses, and names the specific guardrail that rejected anything that failed. Add `--dry-run` to resolve and print every URL without making a single request — useful offline, and for checking a new `pathTemplate` before you point it at a live origin. It does not run the AI CLI, touch the database, or create snapshots. Run it whenever you change the source map, and periodically afterwards — public sites change bot policy, markup, and redirect targets without notice, and a silently failing source starves your plans of snapshots rather than raising an error where you would see it.

## Source status

Read the authorization column as "what you still need to verify," not as legal advice. Stockbot enforces origin, network, redirect, content-type, and byte boundaries; it does not and cannot evaluate a site's terms of service on your behalf. That responsibility stays with you as the operator, as [AI research](./AI_RESEARCH.md) already states.

### Government contracts

| Source id | Origin | Status | Notes |
|---|---|---|---|
| `dod-contracts` | `https://www.war.gov` | Ready | Daily DoD contract announcements, awards ≥ $7.5M, published each business day at 5 p.m. ET. Plain HTML with `?Page=N` paging. **Register `www.war.gov`, not `www.defense.gov`** — defense.gov issues a cross-host 302 to war.gov, and the adapter blocks cross-origin redirects. |
| `usaspending` | `https://api.usaspending.gov` | Ready, but macro-only | Keyless public JSON API. Only its **GET** endpoints are reachable; award search is POST. What you can read is agency-level and reference data (`/api/v2/agency/097/awards/`, `/api/v2/awards/last_updated/`), not per-company award history. |
| SAM.gov | `https://api.sam.gov` | **Not supported** | The Get Opportunities public API requires `api_key` as a **query parameter**. The plan schema rejects credential-bearing query keys by design, and the AI research docs explicitly forbid putting keys in a plan. Reaching SAM.gov needs a separate reviewed, code-owned adapter that holds the credential server-side — it is not a plan-level change. |
| FPDS ATOM feed | `https://www.fpds.gov` | **Not supported** | Serves `application/atom+xml`, which is not in the adapter's allowed content-type list. |

The honest limitation: **per-company federal award history is not reachable through `web.page.v1`.** USAspending puts it behind POST, SAM.gov behind an API key, and FPDS behind an unsupported content type. What the `gov-contracts-defense` plan actually delivers is *procurement regime context* — who is winning DoD awards right now, at what scale, and how fresh the federal spending data is — which the summarizer can connect to a specific symbol when that symbol's name appears in the announcements. That is a real signal for defense and aerospace names and close to noise for a consumer software company. Size your expectations accordingly.

### SEC filings

| Source id | Origin | Status | Notes |
|---|---|---|---|
| `sec-edgar` | `https://www.sec.gov` | Ready, with a caveat | `browse-edgar` accepts `ticker=` directly, so it templates cleanly from `{{symbol}}` and returns `text/html`. The `data.sec.gov` submissions API is *not* used because it keys on zero-padded CIK, and a plan cannot chain a ticker→CIK lookup into a second step. |
| `sec-edgar-fts` | `https://efts.sec.gov` | Ready, with a caveat | Undocumented but stable full-text search JSON: `/LATEST/search-index?q=…&forms=…&from=…&size=…`. Returns `application/json`. |

**The caveat matters.** The SEC requires automated clients to declare a User-Agent containing a company name and contact email, and returns an "Undeclared Automated Tool" error otherwise. The adapter's fixed UA has no contact address, so EDGAR may reject these requests. If `research:probe` reports 403 or an undeclared-tool body for the EDGAR steps, the fix is one line in `server/research/adapters/web-page.js`:

```js
"user-agent": "StockbotResearch/1.0 (+local research pipeline)"
// becomes, with your real contact address:
"user-agent": "Stockbot Research your-name your-email@example.com"
```

That is a deliberate, reviewed change to code-owned server behaviour, so it is left to you rather than made silently. The SEC's stated limit is 10 requests/second; the research service admits at most two concurrent runs, so you are well inside it.

### Market news and sentiment

| Source id | Origin | Status | Notes |
|---|---|---|---|
| `bluesky` | `https://public.api.bsky.app` | Ready | `app.bsky.feed.searchPosts` on the public AppView — no API key, no auth token, GET, JSON. Detailed in [Sentiment pack](./SENTIMENT_PACK.md). |
| `stocktwits` | `https://api.stocktwits.com` | Verify before enabling | `/api/2/streams/symbol/{SYMBOL}.json`. Purpose-built cashtag streams; access has been tightening. |
| `reddit` | `https://www.reddit.com` | Verify before enabling | `/r/{sub}/search.json`. Blocks many non-authenticated client UAs. Register `www.reddit.com` — the bare domain redirects cross-host and fails closed. |
| X / Twitter | `https://x.com` | **Not supported** | Requires paid API authentication. The plan schema rejects credential query keys and the adapter cannot send custom headers, so no configuration of this pipeline reads X. Bluesky is the working substitute. |
| `nasdaq-news` | `https://www.nasdaq.com` | Verify before enabling | `/market-activity/stocks/{SYMBOL}/news-headlines` and `/press-releases`. `robots.txt` disallows only the option-chain subpath, so these paths are robots-permitted. The site sits behind a CDN that may still refuse a non-browser UA. |
| `finviz` | `https://finviz.com` | Verify before enabling | `/quote.ashx?t={SYMBOL}`. `robots.txt` disallows `/export`, `/chart`, `/screener?*`, and `/search`, but **not** `/quote.ashx`. Bot protection may still return 403. Check Finviz's terms of use for automated access before registering this origin. |

These two are deliberately last in the pipeline's value ordering. Filing and procurement data is primary-source and timestamped; retail news pages are secondary, heavily editorialised, and the most likely of any source here to carry prompt-injection text into the summarizer. The fixed `market-summary.v1` prompt already instructs the model to treat document text as untrusted evidence, and the response schema has no action, quantity, or execution field — but that is a bound on blast radius, not a guarantee of signal quality.

If you would rather not run these at all, simply leave `nasdaq-news` and `finviz` out of `RESEARCH_WEB_SOURCES_JSON`. `market-news-sentiment` will then fail closed with `RESEARCH_SOURCE_NOT_CONFIGURED`, and `catalyst-composite` will fail on its Nasdaq step. Unregistering the origin is the intended off switch; you do not need to edit the plans.

## The shipped plans

| Plan | Sources | Symbols | Snapshot lifetime | Purpose |
|---|---|---|---|---|
| `sec-edgar-filings` | `sec-edgar`, `sec-edgar-fts` | `*` | 24 h | 8-K catalysts, Form 4 insider activity, and full-text hits for the symbol. |
| `gov-contracts-defense` | `dod-contracts`, `usaspending` | `*` | 48 h | Two pages of daily DoD awards plus agency-level federal spending context. |
| `market-news-sentiment` | `nasdaq-news`, `finviz` | `*` | 6 h | Retail headlines, press releases, and quote-page metrics. |
| `catalyst-composite` | all four above | `*` | 12 h | One summary across disclosure, procurement, and news. |
| `social-sentiment` | `bluesky`, `stocktwits`, `reddit` | `*` | 4 h | Public social posts about the symbol. Shortest lifetime here — social decays fastest. |
| `news-social-analysis` | `nasdaq-news`, `sec-edgar`, `bluesky`, `stocktwits`, `reddit` | `*` | 6 h | Recent news, latest disclosure, and social chatter as one trade analysis. **This is the plan intended for session pinning by `sentiment-gated-momentum.js`.** |

The three single-source plans exist so you can attribute a result. If a research-aware strategy outperforms while pinned to `catalyst-composite`, rerun it pinned to each single-source plan: that tells you whether the edge came from filings, from contracts, from news, or from none of them. Pinning is per-session and permanently recorded, so these are four cleanly separable experiments rather than four variations of one.

Snapshot lifetimes are deliberately unequal and reflect how fast each source decays. A Form 4 is still meaningful tomorrow; a sentiment read on a news page is not. `maxAgeMs` is capped at 30 days by schema, but a long lifetime on a fast-decaying source quietly turns stale context into a live trading input.

## Import and run

```bash
ENVFILE="$HOME/.config/stockbot/stockbot.env"

npm run research -- validate --file research-plans/catalyst-composite.json --env-file "$ENVFILE"
npm run research -- import   --file research-plans/catalyst-composite.json --env-file "$ENVFILE"
npm run research -- run --plan catalyst-composite --symbol NVDA --env-file "$ENVFILE"
npm run research -- list --limit 20 --env-file "$ENVFILE"
```

Importing does not execute anything, and neither does pinning. Snapshots exist only where a `run` succeeded, and backtests read only previously archived snapshots — Stockbot will never rerun today's scraper to manufacture historical knowledge for a past bar. A plan you import today produces no usable history for a backtest over last year, and that is the correct behaviour, not a gap to work around.

If you want recurring research, invoke the fixed CLI command above from a trusted host scheduler (launchd, cron). Never place a scheduler command inside a plan; the schema has no field for it, by design.

## Adding your own source

1. Confirm the endpoint is **GET**, keyless, HTTPS, and returns an allowed content type.
2. Follow the URL manually and note the *final* host after redirects. Register that one.
3. Check `robots.txt` and the site's terms for automated access.
4. Add the id → origin pair to `RESEARCH_WEB_SOURCES_JSON` and restart.
5. Write the plan step, then run `npm run research:probe` before `npm run research -- import`.

If a source needs a credential, an authenticated header, or a POST body, stop. That is a new code-owned adapter with its own review, not a plan change — and the plan schema will reject every attempt to smuggle it in as data.
