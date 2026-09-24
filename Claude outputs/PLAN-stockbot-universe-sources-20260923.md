# PLAN-stockbot-universe-sources-20260923

**Mode:** Plan and do not code. This companion to `PLAN-stockbot-symbol-discovery-20260923.md` fixes the plumbing and last mile. This file adds **more ways to find tickers**.
**Owner:** Codex implements the sources the owner approves; Hermes verifies.

## Goal

Replace the single "most-actives" list with a set of pluggable **universe sources**. Each source answers "which symbols are worth looking at, and why", and every candidate carries its provenance ("found by: earnings next week + peer of NVDA").

## Non-goals (these follow the owner's standing decisions)

- Sources decide **who gets considered**, not **how they score**. The Board B score stays tradeability-only. A source's reason is shown as evidence and never adds points.
- No auto-launch and no live rotation. Everything ends at "recommend → owner confirms".
- No paid data tier is assumed. Each source below says what it costs.

---

## 1. The source contract (build this first)

`server/universe/sources/<id>.js`, mirroring the plugin pattern:

```js
export default {
  id: "earnings-calendar",
  label: "Reporting earnings in the next 7 days",
  requires: ["finnhub"],          // providers that must be configured
  pointInTime: false,             // true only if it can answer "as of <date>" without look-ahead
  defaultLimit: 40,
  async fetch({ asOf, limit, ctx }) {
    return [{ symbol: "CRWD", reason: "Earnings 2026-09-29 (after close)", evidence: { date: "…" } }];
  }
};
```

- `server/universe/registry.js` loads the sources and skips any whose `requires` is unmet. The Selection page shows skipped sources as "needs FINNHUB_API_KEY" rather than hiding them.
- `server/universe/blend.js` does the union and dedupe, applies per-source caps so one source can't flood the list, and merges `reasons[]` per symbol. **It is forward-test-only if any contributing source has `pointInTime: false` for a past `asOf`.**
- Every symbol goes through **`master-list` validation** (§2A) before scoring, which drops typos, warrants, units, preferreds and test issues.
- `selection_runs` (from the companion plan) stores `sources[]` and per-symbol provenance.

---

## 2. Source catalogue

Legend. **Cost:** what it needs. **PIT:** can it be used for a historical backtest without look-ahead? **Effort:** S/M/L.

### A. Master lists: "what exists" (validation plus the base for scans)

| Source | What it gives | Cost | PIT | Effort |
|---|---|---|---|---|
| **Nasdaq Trader symbol directory** (`nasdaqlisted.txt`, `otherlisted.txt`) | Every US-listed symbol, with ETF and test-issue flags, updated daily | Free, no key | No (today's list) | S |
| **SEC `company_tickers_exchange.json`** | Ticker → CIK → exchange for operating companies (no ETFs); the CIK links to filings | Free; needs a `User-Agent` header; ≤10 req/s | No | S |
| **Alpaca `/v2/assets`** (exists) | Tradable and shortable flags for your actual broker | Alpaca key | No | done |

Recommendation: a nightly job writes one `universe_master` table from Nasdaq Trader and Alpaca, keeping only symbols that are tradable on Alpaca, excluding test issues, and excluding suffixed classes such as `.W`, `.U` and `.R`. That table becomes the catalogue, which also retires the 17 `LOCAL_ASSETS` as the default.

### B. Activity screens: "what's moving now"

| Source | What it gives | Cost | PIT | Effort |
|---|---|---|---|---|
| **Alpaca most-actives** (exists) | Top 100 by volume or trade count | Alpaca key | No | done |
| **Alpaca movers** `v1beta1/screener/{stocks\|crypto}/movers?top=50` | Top gainers and losers (SIP), **plus crypto** | Alpaca key | No | S |
| **Relative-volume spike** (computed) | Today's volume divided by the 20-day average, above 3× | Bars for the base list | Yes, if computed from grouped daily | M |

### C. Whole-market daily snapshot: the backtest-safe unlock

| Source | What it gives | Cost | PIT | Effort |
|---|---|---|---|---|
| **Massive (ex-Polygon) grouped daily aggregates** | OHLCV for *every* US stock for one date in **one call** | Free Basic tier: 5 calls/min, about 2 years of EOD history | **Yes** | M |

This is the most valuable item in the plan. A nightly job stores one row per symbol per day in `daily_snapshot`. From that local table, every scan in §D can run **as of any past date** with no look-ahead. That makes discovered symbols backtestable, which answers D2 in the companion plan.

⚠ `providers/polygon.js` hardcodes `api.polygon.io`. Massive says existing keys stay valid, but the docs don't confirm the old domain. Codex must verify the base URL first and make it configurable (`POLYGON_BASE_URL`).

### D. Technical scans over the snapshot (local, deterministic, point-in-time)

Each scan is a small pure function over `daily_snapshot`, so each one is cheap to add:

- **52-week-high breakouts**: close above the prior 252-day high.
- **Momentum leaders**: 12-month return excluding the last month, top decile.
- **Gap up or down**: open vs. prior close by more than 4%, with liquidity above the gate.
- **Volatility squeeze**: 20-day ATR% at a 6-month low.
- **Mean-reversion candidates**: 3-day RSI below 10 on names above their 200-day average.
- **New liquidity**: names whose 20-day dollar volume just crossed the liquidity gate (they are becoming tradeable).

⚠ These scans look like signals. They are allowed here only because they choose *who is considered*. Their output must never feed Board B. Keep them in `universe/`, not `scoring/`. A test should assert that `selection.js` imports nothing from `universe/`.

### E. Event calendars: "something is about to happen"

| Source | What it gives | Cost | PIT | Effort |
|---|---|---|---|---|
| **Finnhub earnings calendar** `/calendar/earnings?from&to` | Who reports in the next N days | Free key | Partly (historical dates exist) | S |
| **Finnhub IPO calendar** `/calendar/ipo` | New listings, which feed a "recently IPO'd, now liquid" watch | Free key | No | S |
| **SEC EDGAR recent filings** (8-K, S-1, 13D) | Material events and activist stakes | Free | Yes (filings are timestamped) | M |

### F. Relationship expansion: "more like this"

| Source | What it gives | Cost | PIT | Effort |
|---|---|---|---|---|
| **Finnhub peers** `/stock/peers?symbol=NVDA` | Same-industry peers of a seed symbol | Free key | No | S |
| **Correlation neighbours** (computed) | The 10 names most correlated with a seed over 6 months, from `daily_snapshot` | Local | Yes | M |
| **ETF constituents** (SPDR sector ETFs, iShares) | Members of XLK, XLE, SMH, IWM and so on, which the UI can present as "browse a sector" | Free CSV downloads | **No, survivorship bias** | M |

UI: add a "Find more like this" button on any symbol in Markets, Selection or a session.

### G. Your own history

- **Watchlist**: symbols you saved (companion plan, Step 4).
- **Past sessions and experiments**: symbols you have already traded, so you can re-screen them.
- **Research runs**: symbols that already have `research_runs` rows. The Evidence stage has something to say about these.
- **CSV / paste import**: paste a list from anywhere; it is validated against the master list.

### H. News and text (lowest priority; noisy)

- **Finnhub market news**: count ticker mentions over 24 hours and surface unusual spikes. Extract tickers only through the master list, so a bare word like "IT" or "ALL" becomes a symbol only when the news item tags it as a ticker.
- **Social (Reddit, StockTwits)**: not recommended. There are ToS and API-access questions, the data is very noisy, and it invites pump-and-dump names. If it is ever added, it should be forward-test-only and paired with a stricter liquidity gate.

---

## 3. Suggested build order

| Phase | Sources | Why first |
|---|---|---|
| **1** | Source contract, blend, **Nasdaq Trader master list**, Alpaca movers (stocks and crypto), watchlist, CSV import | Cheap. It makes "any real ticker" work and doubles live discovery. |
| **2** | **Massive grouped-daily → `daily_snapshot`**, then scans D1–D3 | The step that makes discovered names backtestable. |
| **3** | Finnhub earnings and IPO calendars, peers, "Find more like this" | Free, and adds reasons you can read. |
| **4** | Correlation neighbours, remaining scans, EDGAR filings | Nice-to-have. |
| **5** | News mentions, and ETF constituents with a survivorship warning | Noisy or biased, so they come last. |

## 4. Tests (write each failing test first)

- **Contract:** a source with an unmet `requires` is listed as skipped with a clear reason and never throws.
- **Blend:** per-source caps hold; a symbol found by two sources has two `reasons`; mixing in any `pointInTime:false` source for a past `asOf` makes the run forward-test-only.
- **Master list:** the fixture contains `ABC.W`, `ABCU`, a test issue `ZVZZT` and a typo `APPL`. All four are rejected; `AAPL` passes.
- **Snapshot PIT (falsifiable):** a 52-week-high scan as of `2025-06-02` must *not* return a symbol whose breakout happens on `2025-06-03` in the fixture.
- **Isolation:** `server/experiments/selection.js` has no import path to `server/universe/`.
- **Rate limits:** the grouped-daily backfill stays at 5 calls/min or fewer (fake clock), and a resumed backfill does not re-fetch dates it already stored.

## 5. Acceptance check (Hermes, end to end)

1. Run the Nasdaq Trader import. `universe_master` holds more than 5,000 tradable symbols.
2. Selection with sources `movers + earnings + watchlist` shows candidates outside `LOCAL_ASSETS`, and each one has a readable "found by" line.
3. Backfill 30 days of grouped daily. A `momentum` scan as of 20 days ago returns symbols, and **Backtest is enabled** for that run.
4. "Find more like this" on NVDA returns peers that are all present in `universe_master`.

## 6. Risks

- **Look-ahead and survivorship:** a PIT flag on each source, and the blend inherits the worst flag. ETF constituents and news are never PIT.
- **Free-tier limits:** Massive allows 5 calls/min, which is fine for one grouped call per day but slow to backfill (2 years ≈ 500 calls ≈ 100 minutes, so run it once overnight). Finnhub's free tier is 60 calls/min.
- **Finnhub bars:** users have reported since 2025 that US stock candles return "You don't have access" on the free plan. The existing `providers/finnhub.js` bars fallback may silently fail. Verify it, and if confirmed, mark Finnhub as quotes, calendars and peers only.
- **Storage:** `daily_snapshot` at about 11k symbols × 500 days ≈ 5.5M rows. That is fine in Postgres on oldlaptop (see `PLAN-tailscale-postgres`). In SQLite, index `(date, symbol)` and prune anything older than 2 years.

## 7. Rollback

Each source is its own file and registry entry, so removing one is a one-line revert. The two new tables (`universe_master`, `daily_snapshot`) are additive and are not read by existing code paths.

## Decisions for the owner

- **U1:** Approve Phase 1 alone, or Phases 1 + 2 together? (Phase 2 is what makes discovered names backtestable.)
- **U2:** Get a Massive/Polygon key? The free Basic tier is enough for grouped daily.
- **U3:** Include crypto movers, or keep discovery to stocks for now?

## Sources

- [Alpaca: top market movers](https://docs.alpaca.markets/us/reference/movers-1) · [Alpaca: most active stocks](https://docs.alpaca.markets/reference/mostactives-1)
- [Massive provider notes (free tier 5 calls/min, Polygon keys still valid)](https://www.ml4trading.io/docs/data/providers/massive/) · [massive.com](https://massive.com/)
- [Nasdaq Trader symbol directory](https://www.nasdaqtrader.com/trader.aspx?id=symbollookup) · [field definitions](https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs)
- [SEC: Accessing EDGAR data (User-Agent, rate limits)](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
- [Finnhub earnings calendar](https://finnhub.io/docs/api/earnings-calendar) · [Finnhub issue #546: free plan US candles](https://github.com/finnhubio/Finnhub-API/issues/546)
