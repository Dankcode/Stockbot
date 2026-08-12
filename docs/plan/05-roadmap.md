# Stockbot — Phased Roadmap

Eight phases. Each is independently shippable — the app works at the end of every one. Phases 0 and 1 are strictly ordered; after that there's parallelism.

**The one rule:** Phase 0 before everything. Refactoring on top of wrong numbers means carefully preserving the wrong numbers, and you won't be able to tell afterward whether a change broke something or fixed it.

---

## Phase 0 — Truth & safety

*Small, high leverage, unblocks everything.*

| # | Task | Finding |
|---|---|---|
| 0.1 | Golden-file test harness: freeze a bar fixture, snapshot trades + metrics per algorithm | M4 |
| 0.2 | Fill at **next bar's open** instead of the signal bar's close | C2 |
| 0.3 | `fill-model.js` — slippage + commission, shared by backtest and paper | C3 |
| 0.4 | Metric fixes: real `dayChange`, interval-aware Sharpe, `profitFactor` null not `99`, `winRate` null preserved, one drawdown sign | C7 |
| 0.5 | Delete `getCandles`, `getDiagnostics`, `getAlgorithmTrades`, synthetic `spark`, and the dead `/api/strategies`. Single bar source. | C1 |
| 0.6 | Delete `src/strategy/`, `src/control/` | M2 |
| 0.7 | `HOST=127.0.0.1`, drop `host: "0.0.0.0"` from Vite, shared-secret header on mutating routes | S1, S2 |
| 0.8 | Serialize account mutations through one queue | C6 |
| 0.9 | `git rm -r --cached dist` | M5 |

**Do 0.1 first and literally.** It's what turns 0.2–0.4 from scary into reviewable: you get a diff showing exactly which numbers moved and by how much. Expect returns to drop noticeably once look-ahead and slippage are gone — that drop is the point. Numbers that got worse and became true are worth more than numbers that were flattering and weren't.

**Exit:** every number on screen traces to real market data through one code path. Test suite green.

---

## Phase 1 — Modularize the server

*Mechanical. No behavior change.*

1. `packages/shared` — Zod schemas, metric registry, formatters, range definitions.
2. Split `server/index.js` (2,007 lines) into `config/ http/ market/ engine/ broker/ db/ algorithms/` per `02-architecture.md §1`.
3. Thin route handlers: validate → service → serialize.
4. Error taxonomy with stable codes; consistent `{data, meta}` / `{error}` envelope.
5. Typecheck the server (JSDoc + `checkJs`, or convert to TS).

The golden-file tests from 0.1 are the safety net — they should pass unchanged throughout.

**Exit:** no file over ~300 lines. `engine/` is pure and independently testable.

---

## Phase 2 — SQL persistence

1. `db/client.js` dialect adapter, `db/migrate.js`, `0001_init.sql` (full schema, `02-architecture.md §3`).
2. Repositories for every table.
3. Move `account` off the module-scope object into `accounts` + `position_lots` + `orders` + `fills`.
4. Ledger writes inside transactions — folds 0.8's queue into real transactional integrity.
5. Settings move from `.env` rewriting into the `settings` table.
6. Equity snapshots written per tick.
7. Postgres verification: point `DATABASE_URL` at a throwaway Postgres, run migrations and the test suite. **Do this in Phase 2, not later** — that's the whole reason for the portability constraints, and the cost of finding a leak now versus after twelve migrations is enormous.

**Exit:** restart the server, everything survives. Same test suite passes on both dialects.

---

## Phase 3 — Sandboxed engine & worker pool

1. `engine/worker.js` — algorithms run in `worker_threads` with `resourceLimits`, no `process.env`, hard timeout.
2. Static validation before execution: reject imports, `require`, `process`, `globalThis`.
3. `engine/pool.js` — N workers, queue, cancellation.
4. `backtest_runs` cache keyed on version + params + symbol + window + bars hash + fill model hash.
5. Move `/compare` and `/scan` onto the pool; keep halt/liquidate off it entirely.
6. Atomic upload: temp → validate → rename. Version rows in `algorithm_versions`.

**Exit:** an uploaded infinite loop times out without touching the server. The kill switch responds while a full scan runs. Repeat comparisons are instant.

---

## Phase 4 — Runtime, risk, alerts

1. Session lifecycle state machine + supervisor (`03-runtime-risk-alerts §1`).
2. Market-hours-aware tick loop; bar-boundary alignment.
3. Kill switch: per-session, global, halt-and-liquidate, restart recovery.
4. Risk engine: rule interface, the catalogue in §2, profiles, `risk_events`.
5. Position sizing — replaces hardcoded `cash * 0.95`.
6. Scheduler: market hours, fixed window, cron. No silent backfill.
7. Alert evaluator, in-app channel, cooldowns, `alert_deliveries`.
8. SSE stream.
9. Session export (CSV/JSON) + report renderer.

Largest phase. Split it if you want a shipping checkpoint: **4a** = lifecycle + kill switch + risk (the safety-critical half), **4b** = scheduler + alerts + export.

**Exit:** start a paper session, watch it trade, watch a guardrail halt it, read why, export it.

---

## Phase 5 — Frontend structure

*Mechanical, mirrors Phase 1. Can start once Phase 1 lands — doesn't need 2–4.*

1. Router + app shell; break up the 1,190-line `App()`.
2. Feature folders: `overview/ markets/ strategies/ sessions/ risk/ settings/`.
3. `lib/api.ts` typed against shared schemas; `lib/query.ts` cache.
4. One polling coordinator with `visibilitychange` pause and failure backoff → replaced by SSE once Phase 4 lands.
5. Split `styles.css` (3,049 lines) into `tokens.css` + per-feature sheets. **Tokens as placeholders only** — your design pass fills them.

**Exit:** no component over ~200 lines. State colocated with the feature that owns it.

---

## Phase 6 — Chart renderer

*Independent of 2–4. Can run parallel to Phase 5.*

1. Extract `src/charts/`; split static scene from interaction layer.
2. `useChartScene` memoized on `(bars, viewport, overlays, theme)`.
3. Viewport `{startIndex, endIndex}`; wheel-zoom at cursor, drag-pan, drag-select.
4. Single-pass extrema; minimum bar width with aggregation.
5. Canvas renderer above ~1,500 bars, SVG overlays on top.
6. Real time axis, right-edge price scale, log toggle.
7. All color via `--chart-*` custom properties.
8. Session replay scrubber.

**Exit:** 10,000 bars pan and zoom smoothly. Hover doesn't re-render the scene.

---

## Phase 7 — HUD & IA

*Needs Phase 4 (data) and Phase 5 (structure).*

1. Persistent status bar with equity, session state, risk budget, data health, HALT ALL.
2. Five destinations; retire panel drag-and-drop for presets.
3. Overview: equity header, active sessions, risk budget meter, positions, merged activity feed.
4. Sessions: list → detail → compare (curves + metric matrix + **config diff**).
5. Markets cleanup; inspector rail; "run this strategy here."
6. Strategies list + detail with version history.
7. Loading / empty / error / stale states everywhere.
8. Keyboard shortcuts and command palette.

**Exit:** the six questions in `03-runtime-risk-alerts.md §4` are each one click.

---

## Phase 8 — Yours: design system

`/design:design-system`, then `/design:accessibility-review`. `04-hud-and-chart-spec.md §5` is the handoff list.

Two decisions to make before you start, since everything inherits them: dark-first or light-first, and one compact density scale applied consistently.

---

## Dependencies

```
Phase 0 ──▶ Phase 1 ──┬──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──┐
                      │                                       ├──▶ Phase 7 ──▶ Phase 8
                      └──▶ Phase 5 ──────────────────────────┘
                      └──▶ Phase 6 ─────────────────────────┘
```

Phases 5 and 6 only need Phase 1. If you want visible progress early, run 5 and 6 alongside 2–4 — the chart work in particular is self-contained and is the most immediately satisfying thing to fix.

---

## Suggested order if you want value early

1. **Phase 0** — nothing is trustworthy until this lands.
2. **Phase 6** — self-contained, fixes the stutter you can feel, immediately visible.
3. **Phase 1 → 2** — modularize, then persist. Sessions become real.
4. **Phase 3 → 4** — sandbox, then runtime and risk. The bot becomes a bot.
5. **Phase 5 → 7** — restructure the frontend, then rebuild the HUD on real data.
6. **Phase 8** — your design pass, over a stable structure.

---

## Risks to watch

**Phase 0 will make your numbers worse.** Removing look-ahead and adding slippage lowers every backtest return. That's correct and expected. Keep the golden files from before the change so you can quantify the delta — it's a genuinely useful number to know about your own strategies.

**Phase 4 is the big one.** If it starts sprawling, ship 4a (lifecycle + kill switch + risk) on its own. A bot with guardrails and no scheduler is useful; a bot with a scheduler and no guardrails is not.

**Verify Postgres in Phase 2.** Not Phase 6, not "before launch." Dialect leaks compound.

**Resist re-adding panel configurability.** It will feel like a loss in Phase 7. It isn't — it's the main thing standing between this and "too complicated."

---

## Definition of done

- Every displayed number traces to real market data through one code path.
- Backtest and paper use one fill model; results are directly comparable.
- Server restart loses nothing.
- Every session is a durable record with metrics, orders, fills, equity curve, and risk events.
- Two sessions compare side by side with a config diff explaining the difference.
- A guardrail can halt a session, and the UI says which rule, what value, what threshold.
- The kill switch works while the engine is saturated.
- The chart handles 10,000 bars without stutter.
- `DATABASE_URL` is the only line that changes to move to Postgres.
- Golden-file tests cover the engine; the boundary is schema-validated.
