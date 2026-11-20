# CHANGES-stockbot-discovery-20261120

Adds **Discover**, a page and API that look for stocks to buy or hold outside the S&P 500. It ranks them, keeps a watchlist, and queues research for an LLM researcher you assign later. Nothing trades from it.

Full documentation is in `docs/DISCOVERY.md`.

## What exists now

- **Pipeline.** The universe is Alpaca's tradable US equities, checked against Nasdaq Trader's directories. Removed:
  - ETFs, test issues, OTC names, deficient listings;
  - warrants, units, rights, notes and preferred shares;
  - SPACs;
  - S&P 500 members and their other share classes (BRK.A goes with BRK.B).

  Then:
  1. Liquidity filter from Polygon whole-market daily bars.
  2. A year of Alpaca SIP bars for the 300 most liquid survivors.
  3. Quality gates.
  4. Price rules.
  5. Finnhub fundamentals for the top 60.
  6. Market-cap range.
  7. Fundamentals rules.
  8. Growth and hold scores (0–100, percentile-based, with a coverage figure and reasons).
- **Ported from Gunbot Quant** (MIT, notice in `server/discovery/indicators.js`):
  - ADX(14);
  - quality gates for volatility consistency, largest daily range and volume concentration (a pump-and-dump guard);
  - the `{metric, condition, value}` filter rule shape;
  - presets.

  Values match its pandas formulas exactly; a test pins them.
- **Presets:** Balanced, Strong trends, Steady compounders, Small and mid-cap growth, Strict quality. The run form has a preset picker, the quality-gate settings and a rule editor.
- **Market-cap check.** Finnhub often reports foreign filers' caps in home currency, and its currency label is unreliable (Genmab is labelled USD but is in DKK; Ascendis is labelled EUR but is in USD). A cap is used only if cap ÷ shares is within 0.8–1.25× the US price. Otherwise it is shown as "unverified" and not used for the cap limits.
- **Watchlist and research queue** with a researcher contract (claim, complete, fail) for the LLM to be assigned. Scrapers must be registered in `researchWebSources`.
- **Schema:** migration `0007_discovery`, additive only.

## QuantPilot

QuantPilot is followed, but **no code was copied**. It is AGPL-3.0, so copying it would bring Stockbot under the AGPL. Ideas to re-implement independently are listed in `docs/DISCOVERY.md`.

## Evidence

- Full suite: 412 pass, 0 fail, 3 skipped (PostgreSQL and Hermes-source tests that need their environment); `tsc` clean.
- On the old laptop:
  - the same suite passes apart from the 3 known Node 22.22 TypeScript-stripping frontend failures;
  - the two PostgreSQL tests pass against PostgreSQL 18 with a throwaway role that was dropped afterwards;
  - `vite build` succeeds.
- **Production run after deploy** took 282 s:
  - 4,669 eligible → 1,843 liquid → 300 analysed → 295 passed quality → 294 scored;
  - 4 S&P share classes excluded;
  - 10 caps unverified (e.g. CP, MFC in CAD).

## Deployment (old laptop, 20 Nov 2026, 00:50 ET, market closed)

- Release `~/stockbot-releases/discovery-20261120b` (commit 9d3276e = 075af2e + this change).
- The script is `~/.local/state/stockbot/deploy/cutover-20261120.sh`.
  - Run 1 rolled back automatically: its session check caught 3 paused sessions turning errored.
  - Run 2 deployed. Sessions were unchanged across the restart (17 running, 7 errored), one supervisor lease, orders still disabled, 0 journal errors.
- **Side effect of run 1.** The engine marks any paused session as errored on every restart ("Session was paused when the server restarted."). The old release does this too; it also happened on 18 Nov. Three paused sessions are now errored:
  - `a8db1957` buy-and-hold;
  - `14c2deb5` daily-ema;
  - `9638d42c` weekly-rsi.

  They can be brought back with `POST /api/v1/sessions/:id/recover`, then paused again. The dump taken before the change has them paused: `~/.local/state/stockbot/cutover/stockbot-precutover-2026-11-20T05-50-02Z.dump`.

## Rollback

Restore the unit backup `~/.local/state/stockbot/deploy/stockbot.service.bak-2026-11-20T05-52-10Z` (it points at `302a749-swarm-20261118`), then `daemon-reload` and restart. Migration 0007 is additive and the old code ignores it.
