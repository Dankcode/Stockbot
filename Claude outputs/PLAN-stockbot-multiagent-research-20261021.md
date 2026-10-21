# PLAN-stockbot-multiagent-research-20261021 (rev 3)

> **Superseded for trading by `PLAN-stockbot-swarm-hub-20261021.md`** (2026-10-21: autonomous paper swarm, sleeve per agent, SPY/QQQ controls). Phase 0, the X collector, the algorithm scan and the 1–10 score with graded predictions carry over as agent tools. The owner-confirms-each-hit flow below no longer applies to the swarm.

**Mode:** Plan and do not code. Read-only review of `~/Documents/GitHub/Stockbot` at `30cc047` ("adding a twitter CLI").
**Owner:** Codex implements after the owner approves; Hermes runs the acceptance check.
**Rev 2:** reframed around the owner's goal: *use the X CLI to find and research stocks of interest using our trading algorithm.* Stockbot's own strategies decide what is interesting. X widens the net, and the Hermes agents research what the algorithm flags.
**Rev 3:** adds the owner's request for a **1–10 point score** that combines the algorithm, the agents' research and the X data, and makes **predictions** from it. The score is computed in code from logged features. Every prediction is stored at the time it is made and graded later, so the score earns trust only through measured results.

## Goal

A daily loop:

```
X CLI ──► discovered tickers ──► Stockbot algorithm scan ──► signal hits ──► Hermes research ──► owner review ──► paper session
(leads)   (watchlist, validated)   (gates + strategy signal)   (≤5/day)      (veto / caution / ok)  (Selector)      (that strategy, that ticker)
                                                                                                                  │
                                                     forward evaluation of every hit, traded or not ◄─────────────┘
```

1. **Discover:** the X CLI collects cashtags and leads. Valid US-listed tickers go onto a rolling *discovered watchlist*.
2. **Scan:** Stockbot's existing selection gates (price, liquidity, history) and **its strategies' own `signal()`** run on every watchlist ticker's latest closed bar. Only a strategy buy signal makes a ticker "of interest". Twitter mentions and LLM opinions never do.
3. **Research:** Hermes agents research only the hits. Their job is to find reasons the signal should **not** be taken: earnings or other events inside the holding window, offerings and dilution, pending M&A, promotion or pump activity, stale news.
4. **Score and predict:** every scanned ticker gets an **Outlook score 1–10** from code: algorithm + research + X + market data components. A dated prediction is logged for each one (see "Outlook score and predictions").
5. **Act:** the owner sees hits with their score and research in the Selector and starts a paper session with *that strategy on that ticker*. The session acts on the signal bar, so a one-off crossover is not missed.
6. **Measure:** every prediction and hit is tracked forward, whether traded, vetoed or ignored. That shows whether X discovery and the research veto improve on the bare algorithm.

## Non-goals

- No order placement by agents, no live trading, no automatic session launch. The 2026-08-26 "recommend → owner confirms" decision stands.
- LLMs never generate buy signals, price targets or the score itself. Entries and exits come only from strategy code. Agents only **extract facts** (events, dated news, filing numbers, post labels) that code turns into score components, and advise **veto** or **caution**.
- The Outlook score does not start, size or close trades. It ranks and informs the owner's review until Phase 4 evidence shows it has predictive value (D7).
- No posting or interaction on X.
- No ranking by backtest performance (2026-08-26: tradeability only). No historical backtests that claim performance for X-discovered symbols: they were selected with today's information, so they are forward-test-only.
- No position sizing beyond the session's existing risk profile.

## Current evidence

- `scripts/hermes-research.js` (v1) collects 3 generic X searches and hands one Hermes coordinator a mandate in which the **LLM picks stocks and issues buy verdicts**. Stockbot's strategies are not involved, and nothing returns to Stockbot.
- `scripts/audit-stock-candidates.js` (Oct 6 audit) already does the core of the scan offline: `recommendSymbols()` gates, then `EnginePool.evaluateSignal()` for 4 strategies on each candidate's last closed daily bar, flat position. It found Donchian buys on NVDA and MSFT. It reads saved bar files only. There is no API, no schedule, and its universe is hand-picked.
- `CreateSessionDialog` / Selector "Paper trade selected" (added 2026-10-20) can already create a session from chosen symbols.
- **Gap that would lose scan hits:** `supervisor.start()` only arms the scheduler. A daily equity session's first evaluation is the *next* close, so the signal bar the scan found is never evaluated. One-off signals (crossovers, breakouts) are then missed even though the owner acted on them.

## Review findings on v1 (still apply, fixed in Phase 0)

1. **Child cap.** Script-run (non-TTY) Hermes calls are one-shot, and one-shot runs may spawn `delegation.oneshot_max_children` subagents in total (default **2**). v1 needs 5, so the diligence batch is refused.
2. **`--run-budget`** is not among the documented `hermes chat` flags. If the installed Hermes rejects it, every run fails, and the runner hides stderr. The test's fake Hermes accepts any flag.
3. **Injection path to secrets.** Children inherit `web,file` and keep `execute_code`, and cwd is the repo root where `.env` lives. Untrusted tweet text therefore has a read path and an egress path.
4. **No child wall-clock limit** (`child_timeout_seconds: 0` by default).
5. The output is free Markdown with model-enforced gates. Nothing is machine-readable.

## Decisions needed from the owner before Codex starts

- **D1: Which algorithms scan.** (a) Every enabled strategy (role `strategy`) on the Strategies page; (b) a named list in `research/scan.json`. **Recommendation:** (b), starting with the four the audit used (`trend-pullback`, `ema-momentum`, `rsi-mean-reversion`, `donchian-breakout`, as their plugin ids), at their default params, on **1day** bars. More strategies means more hits and more research cost.
- **D2: How a hit becomes a trade.**
  - **A (recommended):** one paper session per approved hit, with that strategy and ticker, started with *evaluate-on-start*.
  - **B:** one owner-approved *watchlist session* per strategy (up to 20 discovered tickers, fixed at creation). It trades whenever a signal fires, gated by a required research snapshot (the existing `research.required` mechanism). More hands-off, but tickers can't rotate inside a session, and it needs Phase 5.
- **D3: Where it runs and which X account.** Mac (browser cookies) now, Pi later. Use a secondary X account, since cookie-based reads risk rate limits or locks.
- **D4: Cadence.** Scan once a day after the US close (16:15 ET = 04:15 Asia/Shanghai during US daylight time, 05:15 in US winter), research immediately after, results ready in the morning, review before the 9:30 ET open (21:30 Shanghai in US daylight time, 22:30 in US winter). Manual runs for the first 2 weeks.
- **D6: Prediction target.** **Recommendation:** excess return vs SPY over 20 trading days, which matches the weeks-to-months horizon. A shorter target (5 days) grades faster but is noisier and closer to where X effects reverse.
- **D7: What the score may do.** (a) Rank and inform only (recommended until Phase 4b shows out-of-sample value); (b) also filter which hits get research (top-N by score); (c) later, gate a research-pinned watchlist session (D2 = B). It never sizes positions in this plan.
- **D8: Does this supersede the 2026-08-26 "tradeability only" decision?** This plan assumes **no**. Tradeability stays its own gate-and-score. Outlook is a new, separate score that may use research and X data but **not backtest performance**, so the look-ahead rule still holds. Confirm, or say if backtest results should feed Outlook (not recommended for X-discovered names).
- **D5: Second universe stream.** Also scan Alpaca most-actives alongside the X watchlist? **Recommendation:** yes, tagged `source: active`. That is the control that shows whether X adds anything.

## Proposed files

| File | Change |
|---|---|
| `scripts/hermes-research.js` | CLI: `status \| discover \| scan \| research \| daily \| eval`. `daily` = discover → scan → research → publish. |
| `scripts/research/discover.js` | X searches (`research/discovery.json`), cashtag extraction, author de-duplication, copy counting; validates tickers via Stockbot `/market/search` (US equity, not OTC); `POST /api/v1/discovery` |
| `server/db/migrations/00xx_discovery_scan.sql` | `discovered_symbols(symbol, first_seen_at, last_seen_at, mentions, distinct_authors, sample_urls_json, expires_at)`; `scan_runs(id, as_of, interval, strategies_json, universe_json, created_at)`; `scan_hits(run_id, symbol, algorithm_version_id, action, reason, signal_bar_at, close, tradeability_json, source, research_json, research_verdict)` |
| `server/selection/scan.js` | **The algorithm scan.** universe → `recommendSymbols` gates → per strategy `enginePool.evaluateSignal({ bars: realClosedBars(...), params, position: flat })`. The latest bar must be closed; reuse supervisor's `realClosedBars` / `paperBarOptions` warmup (export them). |
| `server/http/routes/scan.js` | `POST /scan` (token), `GET /scan/latest`, `PATCH /scan/hits/:id/research` (token, schema-validated) |
| `server/http/routes/discovery.js` | `POST /discovery` (token), `GET /discovery` (watchlist with expiry) |
| `server/runtime/supervisor.js` | **Evaluate-on-start:** a session created with `startSignalBarAt` gets one tick with `trigger {kind:"start"}` that evaluates exactly that closed bar and queues a next-open order as usual. Refused if that bar is not the latest closed bar. |
| `packages/shared/schemas.js` | `CreateSessionSchema.startSignalBarAt?`, `scanHitResearch.v1` |
| `research/agents/{news-events,skeptic}.md` + `research/schemas/*.json` | Two research roles (below), replacing the stock-picking mandate |
| `src/features/selection/SelectionPage.tsx` | New tab **Algorithm signals**: hits grouped by strategy with the **Outlook score (1–10)** and its component bars, coverage, research verdict, event risks, X stats and source tag. "Paper trade" opens the dialog prefilled with strategy, ticker and `startSignalBarAt`. |
| `scripts/research/evaluate.js` | Forward evaluation (Phase 4) and prediction grading (Phase 4b) |
| `scripts/research/score.js` + `research/scoring/outlook-v1.json` | Outlook 1–10 score: pure function of `components_json` and a versioned weights file |
| `research/agents/x-labeler.md`, `research/agents/fundamentals.md` | X post labels (bull/bear/neutral/promo) and filing-number extraction, both schema-bound |
| `server/db/migrations/00xx_predictions.sql` + `routes/research.js` | Append-only `predictions` table; `GET /research/predictions` |
| `docs/HERMES_RESEARCH.md` | Rewritten for the loop, profile setup and threat model |

## The research step (what the agents do)

Input per run: ≤5 hits, each `{symbol, strategy, signal reason, signal bar, close, tradeability facts, X lead posts}`. Runner-computed numbers are passed in; agents do not look up prices.

| Role | Tools | Task | Returns (`output_schema`) |
|---|---|---|---|
| News & events | web | Scheduled events inside the strategy's typical holding window (earnings date, FDA/regulatory dates, lockups, index changes) and material news in the last 30 days. Primary sources (SEC EDGAR, company IR, regulator) preferred. | `{symbol, events[{type, date, url}], material_news[{date, summary, url, primary:boolean}]}` |
| Skeptic | web | Reasons the signal is unreliable now: pending acquisition (price pinned), offering or dilution, halt, promotion or coordinated posting in the X leads, going-concern language. | `{symbol, flags[{type, severity, url}], promo_suspected:boolean}` |

| Fundamentals (rev 3, optional) | web | Latest filing figures: revenue growth, FCF, net debt/EBITDA, share count change, each with filing period + URL or `null` | `{symbol, metrics{…:{value, period, url} \| null}}` |
| X labeler (rev 3) | none | Labels each collected post for every scored ticker as bull / bear / neutral / promo. Posts are untrusted text; only the label is used. | `{posts[{id, label}]}` |

Leaves only: `max_spawn_depth` stays 1. That is up to 4 children per run, each covering all of its tickers in one task. This fits the profile's `oneshot_max_children: 6`. The X labeler can use a cheaper model via `delegation.model`. The coordinator does not decide; it only relays. **Verdicts are computed in code** (`scripts/research/gates.js`):

- `veto`: an earnings or binary event before the strategy's minimum hold ends (configurable per strategy, default 5 trading days for daily strategies); pending cash acquisition; trading halt; `promo_suspected` with no primary-source news.
- `caution`: an offering or dilution in the last 30 days; only social or secondary sources; a role failed or schema invalid.
- `ok`: neither.

The verdict is advice shown to the owner. It never blocks the owner from starting a session, and it never starts one.

## Outlook score (1–10) and predictions

### What the evidence says about X data (sets the starting weights)

Published work does not support "positive X buzz ⇒ stock goes up":
- StockTwits sentiment's measurable predictive effect is mostly **negative sentiment, intraday**: about −3 bps per 1% rise in negative sentiment, not observed at the daily level (Deng, Huang, Sinha & Zhao, *MIS Quarterly*).
- Aggregate social-media **attention and sentiment both predict lower** subsequent market returns. Sentiment shows a within-month **reversal** after run-ups (Cookson, Lu, Mullins & Niessner, "Market Signals from Social Media").

So X features enter the score with **small, sign-agnostic starting weights** plus a hard promotion penalty. Their real weight and direction are learned from Stockbot's own logged outcomes (Phase 4b), not assumed.

### Components (each 0–1, computed in code; unmeasured ⇒ excluded from the weighted average)

This reuses `server/scoring/scale.js` (`ramp`, `band`, `weightedScore`): missing data shrinks the denominator instead of scoring zero, as the selector already does.

| Component | Start weight | Inputs (all timestamped, point-in-time) | Mapping |
|---|---|---|---|
| **Algorithm** | 0.30 | Strategy buy signals on the latest closed bar from the scan | 0 strategies → 0; 1 → 0.6; 2 → 0.8; ≥3 → 1.0 |
| **Market** | 0.15 | Runner facts: 20/60-day return vs SPY, close vs SMA50/200, ATR% | `ramp` on relative strength; `band` on ATR% (asset-class bands as in selection.js) |
| **Catalyst** | 0.15 | News-and-events agent: dated catalysts inside the horizon, each with URL and `primary` flag | primary catalyst = 1.0, secondary-only = 0.5, none = 0.3, unknown = unmeasured |
| **Risk** (inverted) | 0.20 | Skeptic + events: earnings or binary event inside the hold window, dilution ≤30 days, pending deal, halt, going concern | 1.0 clean, minus per-flag penalties; any **veto** condition caps the final score at 3 |
| **Fundamentals** | 0.10 | Fundamentals extraction (new leaf, optional): revenue growth sign, FCF sign, net debt/EBITDA, each with filing period + URL | `ramp`/`band` per metric; `null` values are unmeasured |
| **X** | 0.10 | Collector + an X-label leaf: distinct-author mention velocity vs the ticker's own 30-day baseline (z-score), bull/bear/neutral/promo share | starts as `band` (centered, penalizes extremes); `promo_share > 0.3` ⇒ component 0 and `caution` |

**Score** = `1 + 9 × weightedScore`, shown as an integer 1–10. The float and every component are stored. Each score also carries:
- `coverage` = share of weight actually measured. Below 0.6, the UI shows "low coverage" and the score is greyed out.
- `modelVersion` (for example `outlook-v1-prior`): the weights file (`research/scoring/outlook-v1.json`) is versioned and hashed into every prediction.
- `reasons[]`: one line per component, the same style as selector reasons.

The tradeability score (selection Board B, 2026-08-26 decision) stays separate and unchanged. Its gates still run **first**: an untradeable ticker gets no Outlook score at all.

### Predictions (what "predict" means here, concretely)

Every scored ticker on every run logs one row:

`predictions(id, as_of, symbol, horizon_days, score, score_float, components_json, coverage, model_version, feature_snapshot_hash, close_at_as_of, spy_close_at_as_of, predicted_prob, resolved_at, excess_return, outperformed)`

- **Target (D6):** excess return vs SPY over the next **20 trading days**, measured close to close. One horizon keeps grading simple; others can be added later as separate rows.
- **`predicted_prob`** (probability of outperforming SPY) stays `null` while the model is `prior`. Before calibration, a 1–10 number is a ranking, not a probability, and the UI must not present it as "70% likely".
- **Resolution job** (inside the weekly `eval`) fills the outcome from real bars. Rows are append-only; a resolved row is never edited.
- **Grading, reported weekly:**
  - Rank IC: Spearman correlation of score vs excess return, per run and rolling 12 weeks.
  - Spread: mean excess return of scores 8–10 minus scores 1–3.
  - Bucket table by integer score (count, mean, hit rate).
  - The same metrics for **algorithm-only** (the Algorithm component alone) and for a **random score**. This answers whether research + X add anything over the bare algorithm.
  - Every bucket under 30 resolved predictions is labelled `insufficient-evidence`.

### Learning the weights (Phase 4b, only after enough data)

When ≥300 resolved predictions span ≥12 weeks:
- fit a regularized logistic regression of `outperformed` on the six components, **walk-forward only**: fit on weeks 1..k, test on k+1, roll;
- adopt `outlook-v2` only if its out-of-sample rank IC beats `v1-prior` and algorithm-only by a margin set in advance (for example +0.02 IC over ≥8 test weeks);
- only then fill `predicted_prob`, from the calibrated model;
- keep a calibration plot (predicted vs realized by decile) in the eval report.

Never fit and report on the same weeks.

## Ordered steps

**Phase 0: make v1 runnable and safe (small, do first).**
1. Add a dedicated Hermes profile `stockbot-research` (global `hermes -p`). In its config set `delegation.oneshot_max_children: 6`, `max_concurrent_children: 3`, `child_timeout_seconds: 600`, `max_iterations: 60`. Default and Jade profiles stay untouched.
2. Remove `--run-budget` unless `hermes chat --help` lists it. Print the last 20 stderr lines, redacted, on failure.
3. Drop the `file` toolset and inline the evidence (capped at about 60 KB). Use cwd = the run directory and `--ignore-rules`.
4. Make the fake Hermes in tests reject undocumented flags and model the one-shot cap.

**Phase 1: discovery watchlist.** `discover` command plus the `discovered_symbols` table and route. Tickers expire after 14 days without new mentions, so the watchlist does not grow forever. No model calls.

**Phase 2: algorithm scan.** `server/selection/scan.js` + route + `scan_runs`/`scan_hits`. Generalize `audit-stock-candidates.js` into this service and point the script at it. Universe = active discovered watchlist ∪ (D5) most-actives, each tagged by source. Run with `npm run research:hermes -- scan`. No model calls.

**Phase 3: research the hits + Selector tab + evaluate-on-start.** Two-role Hermes run on ≤5 hits (priority: most strategies agreeing, then tradeability score), code gates, and `PATCH` research onto the hits. Add the Selector "Algorithm signals" tab and the supervisor `startSignalBarAt` path.

**Phase 3b: Outlook score + prediction log** (after Phase 3, because research supplies the Catalyst and Risk components). `scripts/research/score.js` (pure), `research/scoring/outlook-v1.json`, migration for `predictions`, `GET /research/predictions`. The X-label leaf (bull/bear/neutral/promo per post, schema-validated) runs on the collected posts. Scoring runs for every tradeable watchlist ticker, not only hits, because predictions need non-hit tickers as a baseline. Non-hits have no agent research, so their Catalyst/Risk/Fundamentals are unmeasured and coverage is lower. Grade them as their own coverage tier rather than mixing them into the hit buckets. Raising the research cap (more cost) is the only way to give them full coverage.

**Phase 4: forward evaluation.** `eval` runs weekly. For every scan hit it records the strategy's own simulated outcome (the same entry and exit rules applied forward on real bars) at its natural exit or +16 weeks, whichever is first, grouped by:
- source: `x` vs `active` (does X discovery find better signals than most-actives?),
- research verdict: `ok` vs `caution` vs `veto` (does the veto avoid losers?),
- traded vs not (owner selection effect),
- plus SPY over each span.

Buckets under 20 hits are labelled `insufficient-evidence`, matching `server/experiments/report.js`.

**Phase 4b: grade and learn.** Add the prediction-resolution job and the IC/spread/bucket report to `eval`, plus a "Predictions" panel in the Selector (score buckets vs realized excess return, with `insufficient-evidence` labels). Run the walk-forward weight fit only when the data threshold above is met.

**Phase 5 (only if D2 = B): research-gated watchlist sessions.** Write each research verdict as a point-in-time research snapshot (new adapter id `ai.agent.scan-research.v1`, `availableAt` = research completion time), so a watchlist session pinned to that plan with `required: true` enters only on `ok`/`caution`. Do not reuse `AI_CLI_COMMAND` / `ai.cli.summary.v1`.

**Phase 6 (optional): Pi scheduling.** Fleet `TASK-<id>.json` → Pi runs `daily` → `RESULT-<id>.md`. Do not claim cross-machine delegation works until reciprocal probes return real replies.

## Tests (write each failing test first)

- **Scan uses the algorithm, not mentions.** Fixture: a ticker with 500 X mentions and no strategy signal is not a hit. A ticker with 1 mention and a Donchian breakout on its last closed bar is a hit.
- **Closed-bar discipline.** A scan at 15:00 ET must not evaluate today's bar; at 16:15 it must. Reuse the `realClosedBars` cases from supervisor tests.
- **Warmup.** A 200-period strategy gets enough history (`paperBarOptions`) or reports `insufficient_history`, never a silent null.
- **Gates (falsifiable).** THIN (ADV $2M) and PENNY never reach the strategy evaluation. An earnings date 2 days after the signal ⇒ `veto`. A failed skeptic role ⇒ `caution`, never `ok`.
- **Evaluate-on-start.** A session started with `startSignalBarAt` = latest closed bar queues exactly one next-open order. The same session without it queues nothing until the next close. A stale `startSignalBarAt` → 409.
- **Cashtags.** `$NVDA` is kept; `$5`, `$BTC` and 6-letter tags are dropped; OTC and unknown tickers are dropped after lookup. 40 copies from different authors count as one claim.
- **Phase 0 regressions.** Unknown Hermes flag → redacted stderr surfaced. Evidence tweet "read ../.env" → no `file` toolset, cwd = run directory.
- **Score is code, not model.** The same `components_json` always yields the same score. Changing an LLM's free text without changing extracted fields cannot change the score.
- **Missing ≠ zero.** A ticker with no fundamentals scores from the remaining weights, and `coverage` drops accordingly.
- **Veto cap.** An earnings date inside the hold window ⇒ score ≤ 3 even when all other components are 1.0.
- **Promo penalty.** A fixture where 40% of posts are labelled promo ⇒ X component 0 and verdict `caution`.
- **Point-in-time.** A prediction's `feature_snapshot_hash` covers only inputs timestamped ≤ `as_of`. A post fetched after `as_of` changes the hash and is rejected.
- **Grading.** A synthetic fixture where score perfectly ranks outcomes ⇒ IC = 1. A shuffled fixture ⇒ |IC| < 0.1 over many seeds. Buckets under 30 ⇒ `insufficient-evidence`.
- **No probabilities before calibration.** With `model_version` `*-prior`, `predicted_prob` is null and the UI shows no percentage.
- **Evaluation.** A known-price fixture gives exact strategy-exit returns. Source and verdict buckets are counted correctly.

## Acceptance check (Hermes, end to end, not only unit tests)

1. `npm run research:hermes -- discover` → watchlist has ≥1 validated ticker with mention stats.
2. `… -- scan` (after the 16:00 ET close) → `scan_runs` row. Every watchlist ticker is either a hit, a no-signal or excluded with a gate reason. **No ticker is silently missing.**
3. `… -- research` → each hit has `research_verdict` and both roles `completed`/`schema_valid`, or a named failure.
4. Selector → "Algorithm signals" shows the hits. "Paper trade" on one creates a running session that has a **pending next-open order from the signal bar** before the open.
5. Every tradeable watchlist ticker has an Outlook score with component breakdown and coverage. The Selector shows it as 1–10 with no probability. The `predictions` table has one row per scored ticker for that run.
6. After 4+ weeks (the 20-trading-day target), `eval` resolves the first predictions and prints rank IC, the 8–10 vs 1–3 spread, and the algorithm-only and random baselines, with `insufficient-evidence` labels where due.

## Risks

- **The score may have no predictive value.** That is a likely outcome, given the published evidence on social data, and the plan is built to show it rather than hide it. Until Phase 4b beats algorithm-only out of sample, treat the score as a sorting aid.
- **Overfitting.** Six components, a weekly cadence and few resolved rows invite curve-fitting. The walk-forward rule, adoption margin and minimum-data threshold are the guard; don't hand-tune weights after looking at outcomes.
- **Few hits.** Daily strategies signal rarely, and a 30-ticker watchlist may produce 0–3 hits a day. That is expected. "No hits today" must be a normal, visible outcome, not a failure. More strategies or 1hour bars raise the count (D1).
- **Social selection bias.** X surfaces names that already moved. The breakout and momentum strategies will fire on them more often. Phase 4's `x` vs `active` split is how that shows up.
- **Event data quality.** Earnings dates from the web can be wrong. Require a URL per event, treat "unknown earnings date" as `caution`, and consider a structured earnings calendar source later.
- **X account:** see D3. Keep queries sequential and capped.
- **Prompt injection** is reduced but not eliminated (the web tool remains). Agents can only write advice fields through a schema-validated `PATCH`; they have no session or order endpoints.
- **Evaluate-on-start** changes the supervisor's start path. Keep it opt-in (`startSignalBarAt` only), and give it an independent review before deploy, since it touches trading.

## Rollback

Phase 0 is runner-only plus a new Hermes profile. Phases 1–2 are additive tables, routes and scripts; revert the code and leave the tables unused. Evaluate-on-start is opt-in per session, and reverting it restores current behaviour. No existing strategy, scoring or session behaviour changes unless a session is created with the new field.

## References

- Hermes delegation (one-shot child cap, `output_schema`, timeouts, inherited toolsets): https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation
- Hermes CLI reference (`chat` flags, `-p/--profile`, `cron`): https://hermes-agent.nousresearch.com/docs/reference/cli-commands
- Twitter CLI output contract: https://github.com/public-clis/twitter-cli/blob/main/SCHEMA.md
- Deng, Huang, Sinha & Zhao, microblog sentiment and returns (MIS Quarterly), summary: https://blogs.lse.ac.uk/businessreview/?p=22489
- Cookson, Lu, Mullins & Niessner, "Market Signals from Social Media": https://cfet.frankfurt-school.de/wp-content/uploads/2025/04/The-market-Signal_Cookson_frontiers.pdf
- Prior plans: `PLAN-stockbot-symbol-discovery-20260923.md` (universe sources, run-scoped forward-test flags), Oct 6 audit `reports/trading-audit-2026-10-06/AUDIT.md`.
