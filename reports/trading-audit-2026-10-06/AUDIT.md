# Paper-trading inactivity audit — 6 October 2026

## Result and deployment status

The active service on `oldlaptop-aspire-vn7-591g.tailc83ddb.ts.net` is healthy, but its paper execution is not. Read-only API evidence shows 24 sessions: 19 running, five errored, all configured for SPY. The account holds $100,000 cash and no positions. The overview's recent-order sample contains four pending orders and 13 rejected orders; every rejection is `missed_next_bar_open`. These counts describe the returned sample, not a full lifetime order export.

Fixes are implemented and tested in this checkout. **They are not deployed.** SSH authentication as `lx` was denied. No production sessions, account balances, risk limits, orders, or configuration were changed. The operational repair remains incomplete until host access is supplied and a real scheduled paper fill is observed.

## Findings

| Area | Evidence and consequence | Resolution |
|---|---|---|
| Opening fills | An October 2 signal expected the October 5 13:30 UTC open, but was rejected at 20:00 UTC. Opening equity snapshots show that the scheduler did wake. The code makes one opening attempt, then waits until close when the opening aggregate is absent. Bar absence at that exact moment is inferred; it is not logged by production. | Added minute-spaced opening retries through five minutes and fresh bar requests. The fill acceptance window matches this bounded publication allowance. Orders submitted too late and fills attempted at the close remain rejected. |
| Market data | Alpaca requests ascending bars with a small page cap and no pagination. Intraday lookbacks can therefore return an old page instead of the latest bars. | Request the newest page, then sort chronologically for the engine. Regression tests cover equities and crypto. |
| Stock selection | Production scored all 100 candidates successfully but admitted none. Examples explicitly fail because 60 weekly bars are compared with an 80-bar response cap over 420 calendar days. | Estimate available periods from the requested calendar window; preserve price, liquidity and coverage gates. Tests cover realistic weekly, monthly and daily counts. |
| Slow strategy warmup | The daily paper path requests only 120 calendar days, about 83 trading bars. The active yearly EMA strategy requires 200 bars, so it cannot produce its intended signal. | Paper requests now include history for configured indicator periods and holding periods, with additional warmup. Chart/backtest requests retain their existing windows. |
| Random controls | Two production sessions failed with `DataCloneError`: a PRNG function in plugin state cannot be returned from an engine worker. The same error was reproduced locally. | Store the PRNG counter as serializable data, preserving the deterministic sequence. Consecutive worker-round-trip and replay tests pass. |
| Engine timeouts | Three sessions terminated after 10-second engine deadlines: sentiment gated momentum, sentiment blind momentum, weekly EMA. | Confirmed symptom; root cause not established without host CPU/process/log inspection. Deadlines were not disabled or blindly increased. |
| Cohort configuration | All 24 sessions use SPY and share one account. Their one-position limit is evaluated against account positions. A single fill can prevent other strategies from entering. | Prepared a conservative NVDA/MSFT candidate-session payload, retaining the one-position cap and reducing sizing to $500. Do not interpret this shared-account cohort as an independent strategy comparison. |
| Research gates | The sentiment-gated session has no pinned research plan. Its research-dependent entry cannot be treated as operational just because the session was started. | Requires a configured, pinned research pipeline before reactivation, or leave it out of the recovered cohort. |
| Restart behavior | Production audit events show restart resumption is enabled there. The separate local SQLite ledger stopped its prior trader on restart. | The local restart failure does not explain the active remote deployment. Default restart policy was not changed. |

Fresh requests for identical symbol/history combinations are shared while in flight to reduce the synchronized provider load. Risk checks for price, freshness, cash, exposure and market hours remain active.

## Stocks found from current provider data

Twelve stock histories were fetched through the service, each containing 83 daily bars. The corrected daily suitability screen admitted all twelve. Four existing methods were evaluated with no position against the latest closed daily bar, October 5, 2026: trend pullback, EMA momentum, RSI mean reversion and Donchian breakout.

| Candidate | Suitability score (0–1) | Latest closed-bar entry signal |
|---|---:|---|
| NVDA | 0.6449 | Donchian breakout: buy |
| MSFT | 0.6405 | Donchian breakout: buy |
| META | 0.5965 | None from the four tested methods |
| AMD | 0.5850 | None |
| NFLX | 0.5354 | None |
| GOOGL | 0.5096 | None |
| AAPL | 0.4908 | None |
| AMZN | 0.4560 | None |

NKE, JPM, INTC and WBD also passed suitability but had no tested entry signal. Scores measure tradeability, not expected profit. This is a selected twelve-stock sample, not an exhaustive market ranking. Research coverage was unmeasured. Current-universe selection is for forward paper testing, not evidence of historical outperformance. Re-evaluate signals and quotes before activation; do not fabricate a fill against an earlier open.

`candidates.json` contains scores, blockers, provider identity, bar timestamps and signal results. The individual symbol JSON files preserve the input bars. `candidate-session.json` is a prepared, **unsubmitted** paper-session configuration using the deployed Donchian version, NVDA/MSFT, $500 fixed notional sizing and the existing account guardrails. Only one position may be open under that profile. Starting a session arms future decisions; this payload does not enqueue today's historical signal.

Reproduce the local screen:

```sh
node scripts/audit-stock-candidates.js reports/trading-audit-2026-10-06
```

## Verification

`npm run check` passed: TypeScript checks, **318 tests**, and production build. `git diff --check` passed. New regression coverage verifies newest-page selection, calendar-sized history eligibility, EMA200 history, fresh-cache bypass, shared concurrent fetches, delayed opening publication followed by one fill, bounded retry scheduling, and cloneable deterministic plugin state. Existing missed-open rejection tests remain green.

The five-minute opening allowance changes paper execution timing: a pre-open order may consume the provider's opening price when published within the allowance. It is not a guarantee of a real-market fill at that price. Deployment validation must check actual provider publication latency and retain the recorded observation/fill timestamps.

## Remaining operational work

1. Obtain the actual SSH username/key or deployment method. Inspect deployed source differences, service manager, process count, logs and CPU/memory pressure before replacing anything. Repeated close/restart audit events warrant checking for multiple scheduler processes; they do not prove that diagnosis.
2. Back up the deployed code and database using existing deployment procedures, then install the tested changes and restart the correct single service with its existing restart policy.
3. Verify current provider bars, quote timestamps, recovery status and research prerequisites. Do not automatically revive halted or errored sessions. Recreate only selected verified methods and preserve old histories.
4. Re-evaluate NVDA/MSFT and activate the intended paper cohort with the existing risk limits. Resolve shared-account/control contention deliberately before expecting multiple simultaneous positions.
5. Observe the next qualifying signal, pending order, opening retry and fill in the durable ledger. If no signal qualifies, report that condition rather than forcing a buy.

Further limitations: holiday handling is a static 2026–2027 full-day calendar, with no early-close support; weekly/monthly suitability inputs are still expressed with some daily labels; custom strategies can request more history than providers return; algorithm state is held in memory and is not durably restored on restart. These require follow-up design rather than claiming this patch resolves every operational risk.

Reference: Alpaca's [single-symbol historical bars documentation](https://docs.alpaca.markets/us/reference/stockbarsingle-1) documents response limits, sort direction and pagination. Runtime evidence is stored alongside this report in `overview.json`, `sessions.json` and `selection.json`.
