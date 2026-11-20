# Discover: finding stocks outside the S&P 500

The **Discover** page (`/discover`) screens every listed US common stock for
individual names with **growth potential** or the **quality to hold**, keeps a
watchlist, and queues stocks for research. It finds and ranks candidates; it
does not predict returns and nothing trades from it.

## How a run works

A run is a background job (1–4 minutes). Its progress and every exclusion count
are shown on the page.

1. **Universe.** Alpaca's list of tradable US equities (≈13,500), checked against
   Nasdaq Trader's symbol directories. These are removed:
   - ETFs and test issues;
   - exchange-deficient listings;
   - OTC names;
   - warrants, units, rights, notes and preferred shares;
   - blank-check companies (SPACs; switchable);
   - **S&P 500 members** (switchable), with their other share classes (BRK.A goes with BRK.B).

   The S&P 500 list comes from the SPDR S&P 500 ETF's daily holdings file (SSGA). It is refreshed weekly and stored. If SSGA is unreachable, the stored copy is used, and failing that the bundled copy in `server/discovery/data/sp500-seed.json`. The page says which was used.
2. **Liquidity.** Polygon/Massive whole-market daily bars (one call per day, consolidated volume) for the last 5 sessions are stored in `market_daily`. Stocks below the minimum price or average daily dollar volume are dropped. The most liquid survivors (default 300) are analysed.
3. **Price history.** A year of split-adjusted daily bars from Alpaca (SIP feed, ending 20 minutes ago, which the free plan allows). Stocks with less than about 3 months of trading are set aside.
4. **Quality gates** (on by default, switchable, limits adjustable). Over the last 90 sessions, a stock is dropped when:
   - its daily ATR% is erratic (standard deviation ≥ 5);
   - one day traded ≥ 40% from low to high;
   - its 3 busiest days hold ≥ 30% of the volume. An even tape is about 3%, so this catches pump-and-dumps and one-off news spikes.

   A stock without enough history for a gate is kept and counted as unmeasured.
5. **Price rules.** Your filter rules on price metrics (see below) are applied before any fundamentals are fetched, so the Finnhub budget goes to stocks that can still pass.
6. **Fundamentals.** For the best preliminary candidates (default 60), Finnhub's company profile and metrics: market cap, revenue growth, margins, ROE and debt/equity. These are cached for 7 days.
   - A market-cap range (default ≥ $300M) is applied here.
   - **The market cap is checked against the US price.** Finnhub often reports a foreign filer's market cap in its home currency (Genmab in DKK, ICICI in INR, Canadian Pacific in CAD), and its currency label is unreliable: Genmab is labelled USD, while Ascendis is labelled EUR but is actually in USD. So the reported cap is used only when cap ÷ shares outstanding is within 0.8–1.25× the US trading price. Otherwise it is shown as "unverified", is not compared with the USD limits, and is counted in the run summary. ADRs usually fail the check too, because one ADR is a fraction of a share.
   - Rules on fundamentals metrics are applied after this step.
7. **Scores.** See below.

### Filter rules and presets

A rule is `{metric, condition, value}` with condition `greater_than`, `less_than` or `between` (`value: [low, high]`). Up to 12 rules are allowed, and every rule must pass.

- **Units are as displayed.** A 20% return is written `20`, not `0.2`. `GET /api/v1/discovery/screening` lists the metrics, their units, the presets and the defaults.
- **Missing data fails.** A stock without the metric fails the rule, and the run reports how many failed that way. Rules on fundamentals therefore only pass for stocks whose fundamentals were fetched; raise "Fundamentals for top" when using them.

Price metrics:
- price and 20-day dollar volume;
- returns (3, 6, 12 months and 12-1 momentum);
- distance from the 52-week high;
- 1-year volatility and drawdown;
- RSI(14) and ADX(14);
- price vs the 200-day average;
- ATR% and the three quality measures.

Fundamentals metrics:
- market cap (USD);
- revenue and EPS growth;
- gross and net margin;
- ROE, debt/equity, P/S, P/E and beta.

Presets:
- **Balanced** (the defaults).
- **Strong trends:** ADX > 25, 6-month return > 20%, above the 200-day average.
- **Steady compounders:** volatility < 40%, drawdown no worse than -30%, above the 200-day average.
- **Small and mid-cap growth:** $300M–$10B, ≥ $5M a day traded, revenue growth > 15%.
- **Strict quality:** tighter quality gates.

### Scores
Each score (0–100) is a weighted average of percentile ranks within the run:

| Lens | Inputs (weight) |
|---|---|
| Growth potential | 12-1 month momentum (22), 6-month return (16), closeness to 52-week high (12), uptrend 50 > 200-day (10), revenue growth TTM (25), 3-year revenue growth (15) |
| Quality to hold | low 1-year volatility (18), small 1-year drawdown (17), above 200-day average (10), 12-month return (10), net margin (17), ROE (10), low debt/equity (8), 3-year revenue growth (10) |

A missing input is left out of the weights rather than counted as zero. The page then shows "N% measured". Each stock lists the strongest reasons behind its score and its main concerns.

## Watchlist and research

- Tick stocks and choose **Watch**. Each watched stock moves through the stages `watching → researching → shortlisted → holding`, or `rejected`.
- **Request research** queues a request, with an optional question. It moves the stock to `researching`.
- **No LLM researcher is assigned yet.** Requests wait in the queue (`discovery_research_requests`), and the page says so.

### Researcher contract (for the LLM you assign later)

Operator-token endpoints under `/api/v1/discovery/research`:

| Call | Purpose |
|---|---|
| `GET /research?status=pending` | Requests waiting for a researcher |
| `POST /research/:id/claim {"researcher": "llm:<name>"}` | Take one (pending → claimed; only one researcher wins) |
| `POST /research/:id/complete {"result": {"summary", "verdict"?, "evidence"?: [{title, url?, note?}]}}` | Record the finding. `verdict` is one of `buy_candidate`, `hold_candidate`, `watch` or `avoid`. |
| `POST /research/:id/fail {"error"}` | Give up with a reason |
| `POST /research/:id/cancel` | Withdraw a request (owner) |

A request's `scrapersJson` lists the scraper ids the owner chose for it.

**Scrapers** are the registered web sources in `RESEARCH_WEB_SOURCES_JSON` (fetched by `web.page.v1`, restricted to each source's origin). `GET /discovery/research/config` lists them along with any assigned researchers.

Wiring a researcher next means one of two things:

- a scoped token and worker for that LLM, the same pattern as the swarm agents (`docs/SWARM_AGENTS.md`), so it can only claim and complete research; or
- making each research request a swarm task, so evidence comes from Stockbot-performed retrievals with receipts.

## Data and configuration

- **Keys:** `ALPACA_API_KEY`/`SECRET` and `POLYGON_API_KEY` are required. `FINNHUB_API_KEY` is optional (without it there are no fundamentals, and coverage is lower).
- **Optional settings:**
  - `POLYGON_BASE_URL` (default `https://api.polygon.io`; `https://api.massive.com` also works);
  - `DISCOVERY_HISTORICAL_FEED` (default `sip`).
- **Free-tier limits** are respected:
  - Polygon at 5 calls/min. The first run stores 5 days (about 1 minute); later runs reuse them.
  - Finnhub at 55 calls/min, 2 calls per stock.
- **Tables** (migration `0007_discovery`): `reference_lists`, `market_daily`, `market_daily_dates`, `fundamentals_cache`, `discovery_runs`, `discovery_candidates`, `discovery_watchlist`, `discovery_research_requests`.

## Known limits

- **Survivorship.** The universe is today's listings, so a stock found today was not necessarily findable in the past. Do not backtest "would discovery have picked this" without a point-in-time universe. `market_daily` accumulates one row per stock per day, which is the base for that later.
- **Free fundamentals.** Finnhub's free fundamentals have gaps, especially for recent IPOs and foreign filers.

## Credits and related projects

- **[Gunbot Quant](https://github.com/GuntharDeNiro/gunbot-quant)** (MIT, © 2025 The Gunbot Team). Ported from it, with the licence notice in `server/discovery/indicators.js`:
  - ADX(14) and the three quality heuristics;
  - the `{metric, condition, value}` rule shape;
  - the idea of named screener presets.

  The ADX and heuristic values are checked against its pandas formulas in `test/discovery/screening.test.js`.
- **[QuantPilot](https://github.com/Ben05-sys/QuantPilot)** is followed as an upstream to watch, but **none of its code is copied**. It is AGPL-3.0, and copying it into Stockbot would bring Stockbot under the AGPL. Candidate ideas to re-implement independently are:
  - SEC EDGAR filings and company facts as a research scraper;
  - Nasdaq's screener JSON (whole-universe sector and market cap in one call);
  - IPO and dividend calendars.
