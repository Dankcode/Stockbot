# Stockbot — Revision Plan

Planning docs for the modularization, SQL persistence, bot runtime, and HUD rebuild. Written against commit `d7edaf8`. **No source files were changed** — this is the plan you asked for before implementation.

## Read in this order

| Doc | What it covers |
|---|---|
| [01-code-review.md](./01-code-review.md) | Severity-ranked findings with `file:line` references and fixes. **Start here.** |
| [02-architecture.md](./02-architecture.md) | Target module layout, SQLite→Postgres persistence strategy, full schema, API surface |
| [03-runtime-risk-alerts.md](./03-runtime-risk-alerts.md) | Session lifecycle, tick loop, kill switch, risk rule catalogue, position sizing, alerts |
| [04-hud-and-chart-spec.md](./04-hud-and-chart-spec.md) | Information architecture, screen specs, chart renderer rework, design-system handoff |
| [05-roadmap.md](./05-roadmap.md) | Eight phases with dependencies and sequencing |

## The short version

**What's good:** the indicator math, the pluggable algorithm format, the provider fallback chain, and the control-group comparison are all sound. The bones are right.

**What isn't:** a synthetic data path runs in parallel with the real one and is labelled `"real"` (`server/index.js:347`, `:380`, `:1205`, `:1343`), the backtest fills on the signal bar's own close (`:1020`) which is look-ahead, and backtest and paper use different fill models — so the comparison the app exists to provide isn't apples-to-apples. Account state is in-memory (`:60`) so a restart erases everything.

**The three highest-value fixes**, in order:

1. Fill at the **next bar's open** — ~15 lines, removes look-ahead bias from every strategy.
2. **Golden-file tests first**, so fix #1 and the metric corrections produce a reviewable diff rather than a leap of faith.
3. **Delete the synthetic data path** — the largest single deletion, and it makes every number on screen honest.

Expect returns to drop once look-ahead and slippage are gone. That drop is the point.

## Answers to what you asked

**Modular** — `02-architecture.md §1`. Server splits into `config/ http/ market/ engine/ broker/ runtime/ risk/ alerts/ db/`; frontend into feature folders. `engine/` becomes pure and testable; `db/repositories/` is the only place SQL appears.

**SQL, linked later** — `02-architecture.md §2–3`. SQLite now with four portability constraints (epoch-ms integers, money in cents, no dialect-specific SQL, app-generated UUIDs), a client adapter, and forward-only migrations. `DATABASE_URL` is the only line that changes for Postgres. Verify against real Postgres in Phase 2, not later.

**Paper money** — `03-runtime-risk-alerts.md`. Session lifecycle, market-hours gate, quote-freshness rejection (the fix for weekend fills at Friday's close), risk-based position sizing, and a kill switch that works while the engine is saturated.

**Easier UI, not more complicated** — `04-hud-and-chart-spec.md §1` opens with six rules that resolve that tension. Net effect is subtraction: five destinations instead of a 2-view sidebar plus 3 home tabs plus 6 draggable panels; one metric component instead of five inconsistent tables; layout presets instead of drag-and-drop.

**Session data comparison** — `04-hud-and-chart-spec.md §2.4`. Sessions list → detail → compare, with normalized equity curves, a metric matrix with winner highlighting, and a **config diff** showing what actually differed between runs. Most tools skip the diff, and it's the part that tells you *why*.

**Chart renderer** ("video formater") — `04-hud-and-chart-spec.md §3`. The stutter is `CandlestickChart` recomputing its entire scene on every mouse move (`src/main.tsx:405`). Fix is to split the static scene from the interaction layer, memoize geometry, add a real pan/zoom viewport, and switch to canvas above ~1,500 bars. Plus a session replay scrubber, which reuses the same viewport model.

**Design system** — deliberately not designed here. `04-hud-and-chart-spec.md §5` lists what your `/design:design-system` pass needs to cover, including the `--chart-*` custom property contract so retheming the chart never touches chart code.
