# Stockbot — HUD, Navigation & Chart Renderer

This is the information-architecture and interaction spec. It stops short of visual design on purpose — tokens, type scale, color, spacing, and component styling are your `/design:design-system` pass. §5 lists exactly what that pass needs to cover so the two halves meet cleanly.

**The brief in one line:** professional-looking, easy to navigate, easy to see what happened in each trading session, and not complicated. Those last two pull against each other, so §1 starts with the rules that resolve the tension.

---

## 1. Six rules that keep this from getting complicated

Everything below follows from these. When a future feature is ambiguous, these decide it.

**1. One metric vocabulary.** A metric has exactly one label, one unit, one precision, one sign convention, and one null rendering — defined once in `packages/shared/metrics.ts`, consumed everywhere. Today "Drawdown" renders as a negative number in the methods matrix (`src/main.tsx:31`) while "no closed trades" silently becomes "0% win rate" (`:2079`). Two panels, two lies. One registry, and the class of bug disappears.

**2. Progressive disclosure, by default 5.** Every panel shows at most five numbers at rest, with the full matrix behind an expand. The current dashboard shows strategy metrics in five separate places — `MethodBoard` (`:1236`), `PerformancePanel` (`:1296`), `ProfitBoard` (`:1421`), `AlgorithmTradesRail` (`:1530`), `StatsSheet` (`:1624`) — with different columns and different names for the same quantities. Density isn't the problem; *undifferentiated* density is.

**3. Never more than two levels deep.** Destination → detail. If something needs a third level it's a modal or a drawer, not a route. This is the single biggest guard against the app becoming hard to navigate.

**4. One primary action per screen.** Overview: halt. Markets: open a chart. Strategies: run a backtest. Sessions: compare. Everything else is secondary.

**5. States are designed, not defaulted.** Every data surface has an explicit loading, empty, error, and stale rendering. `DataLoadError` (`:659`) exists today but most panels render nothing on failure, which reads as "zero" — the worst possible failure mode in a financial tool.

**6. Presets, not construction kits.** Replace the six draggable/closable panels (`panelOrder` / `closedPanels`, `:2020–2021`) with two or three named layout presets. Panel choreography is a feature you configure once and then fight with forever; it's cost with almost no payoff for a single-user tool.

---

## 2. Information architecture

### Five destinations

Down from a 2-view sidebar plus 3 home tabs plus 6 draggable panels.

```
┌──────────────────────────────────────────────────────────────────────┐
│  STATUS BAR  (persistent, every screen)                              │
│  [PAPER] Equity $104,230 ▲1.2%  │  ● Running · 2 sessions           │
│  Risk 34% used  │  ⬤ Data OK    │           [ HALT ALL ]            │
└──────────────────────────────────────────────────────────────────────┘
┌────────────┬─────────────────────────────────────────────────────────┐
│ ⊙ Overview │                                                         │
│ ▤ Markets  │                    content                              │
│ ƒ Strategies│                                                        │
│ ⧉ Sessions │                                                         │
│ ⚙ Settings │                                                         │
└────────────┴─────────────────────────────────────────────────────────┘
```

**The status bar is the HUD.** It's always present, always live (SSE), and answers the four questions you actually have while a bot runs: how much money, is it running, how much risk is used, is the data good. The kill switch is in it because a control you have to navigate to is not a kill switch.

`mode` renders as a hard-to-miss `PAPER` badge. When live trading eventually exists, that badge is the thing standing between you and an expensive mistake — design it accordingly.

---

### 2.1 Overview — the HUD

The default landing. Answers "what is happening right now" in under three seconds.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Equity                      Day P&L            Realized (all-time)  │
│ $104,230.18                 ▲ $1,247.02        ▲ $4,230.18          │
│ ▁▂▃▅▆▇█ sparkline, today                       +1.21%               │
├──────────────────────────────┬──────────────────────────────────────┤
│ ACTIVE SESSIONS              │ RISK BUDGET                          │
│ ● EMA Cross · NVDA,AAPL      │ Daily loss   ▓▓▓░░░░░░░  34% of 3%   │
│   +$412 · 2h14m  [pause][■]  │ Drawdown     ▓▓░░░░░░░░  18% of 10%  │
│ ● RSI Reversion · SPY        │ Exposure     ▓▓▓▓▓░░░░░  52% of 80%  │
│   −$88 · 45m     [pause][■]  │ Orders today 12 / 100                │
├──────────────────────────────┼──────────────────────────────────────┤
│ OPEN POSITIONS          (4)  │ ACTIVITY                             │
│ NVDA  12  $1,842  ▲ +$96     │ 14:32 ● FILL  buy NVDA ×4 @ 178.20   │
│ AAPL  30  $6,180  ▼ −$44     │       EMA9 crossed above EMA21       │
│ …                    [all →] │ 14:28 ⚠ BLOCK sell SPY — quote stale │
│                              │ 14:15 ● FILL  sell AAPL ×10 @ 206.10 │
│                              │ 13:50 ⓘ  RSI Reversion started       │
└──────────────────────────────┴──────────────────────────────────────┘
```

**Design notes.**

The **risk budget meter** is the highest-value new element on this screen. It converts an abstract question ("am I okay?") into a glanceable proportion. It's also the honest answer to "make the bot easy to understand" — you don't need to read the strategy to know whether it's behaving.

The **activity feed merges fills, blocks, risk events, and state changes into one timeline.** Separating them into tabs would be tidier and much worse: causality lives in the interleaving. Seeing `BLOCK sell SPY — quote stale` directly above a fill is how you learn what your bot is actually doing. Blocked and rejected items are visually distinct but never hidden.

Every fill carries its **`signal_reason`** underneath. That single line is the thread from a number on screen back to the strategy code that caused it.

**Day P&L is real** — equity now minus equity at prior session close, from `equity_snapshots`. Not the `× 0.18` invention at `server/index.js:1433`.

---

### 2.2 Markets — the chart cockpit

Your current Stocks view, cleaned up. It's the strongest part of the existing app; the work here is subtraction.

- **Keep:** symbol tabs, search with the fuzzy scoring (`server/index.js:1254` is good), range controls, overlays, the mini tab charts, click-to-save-candle.
- **Change:** one chart, full width, with a right-side inspector rail instead of six competing panels. The rail is tabbed: **Signals** (algorithm markers on this symbol, with reasons) / **Indicators** (real values from real bars) / **Notes** (saved candles).
- **Remove:** the fabricated diagnostics panel (`getDiagnostics`, `server/index.js:380`) and the fabricated trade markers (`getAlgorithmTrades`, `:1205`). Replace with real values from real bars, or an explicit unavailable state.
- **Add:** an inline "run this strategy on this symbol" affordance that creates a draft session pre-filled with the current symbol and range — the bridge from looking at a chart to testing an idea, which doesn't currently exist.

---

### 2.3 Strategies

Library and detail. Two levels, no more.

**List:** each algorithm as a card — name, description, enabled toggle, current params, and its last backtest headline (return vs. SPY control). Sorted by whatever matters to you; default is return vs. control, because beating the control is the only ranking that means anything.

**Detail:** params editor with inline validation, version history (from `algorithm_versions` — every edit is a version, so you can see whether your tweak helped), backtest runner, and results vs. both controls. Source code viewer, read-only.

**Upload** gets the sandbox-validation feedback from finding S1: parse errors, disallowed imports, and timeout failures reported clearly rather than as a generic 400.

---

### 2.4 Sessions — the comparison surface

The destination that doesn't exist today and does the most work for "easy to view the data from each trading session."

**List.** One row per session: status pill, name, algorithm + version, symbols, window, return, max drawdown, trade count. Filters on status/mode/algorithm/date. Multi-select checkboxes feed the compare action.

Halted sessions are visually distinct and carry their halt reason inline. You should never have to open a session to find out why it stopped.

**Detail.**

```
┌─────────────────────────────────────────────────────────────────────┐
│ ← Sessions      EMA Cross · NVDA,AAPL          ● HALTED             │
│ Halted 14:32 — max_daily_loss: −3.2% observed vs −3.0% threshold    │
│ 1H bars · Aug 8 09:30 – Aug 8 14:32 · v3 (a1f9c2) · slip 5bps       │
├─────────────────────────────────────────────────────────────────────┤
│  Return    Max DD    Sharpe   Win rate   Trades   vs SPY            │
│  −3.20%    4.10%     −0.82    33%        12       −4.8pp            │
├─────────────────────────────────────────────────────────────────────┤
│  [equity curve, session strategy vs SPY control vs Cash control,    │
│   fills as markers, risk events as vertical rules, drawdown band]   │
├─────────────────────────────────────────────────────────────────────┤
│  Trades │ Events │ Config                                           │
│  ▸ 14:32  SELL NVDA ×4 @ 178.20   −$96   stop_loss triggered        │
│  ▸ 14:28  BLOCKED sell SPY        —      quote_freshness (8.2s)     │
└─────────────────────────────────────────────────────────────────────┘
```

The halt banner states rule, observed, and threshold. Six headline metrics, expandable to the full matrix. The chart puts strategy, both controls, fills, and risk events on one timeline — the whole session as a single readable object.

**Compare.** Select 2–4 sessions:

- **Normalized equity curves** overlaid, all rebased to 100 so different starting capital doesn't distort the shape.
- **Metric matrix**, sessions as columns, with per-row winner highlighting. The `metricWinner` helper at `src/main.tsx:715` is already the right idea — promote it to a real component driven by the metric registry's "higher is better" flag.
- **Config diff**, and this is the part most tools omit: what was actually *different* between these runs — algorithm version, params, symbols, window, fill model, risk profile. A comparison without a diff tells you *that* they differ, not *why*, and "why" is the entire point of running two of them.

---

### 2.5 Settings

Sections: Account, Data Providers (with live health per provider, from `/api/v1/market/health`), Risk Profiles, Alerts, Database, About. Credentials write to the `settings` table, not to `.env` (finding S3).

---

## 3. Chart renderer

The current `CandlestickChart` (`src/main.tsx:384–559`) recomputes its whole scene on every mouse move (finding P3). That's the stutter. The fix is structural, not incremental.

### 3.1 Split the scene from the interaction

```
src/charts/
├─ ChartCanvas.tsx        # static scene. Memoized on (bars, viewport, overlays, theme).
├─ ChartInteraction.tsx   # crosshair, tooltip, hover. Re-renders freely — it's cheap.
├─ useChartScene.ts       # bars + viewport → geometry. Pure, memoized, testable.
├─ useViewport.ts         # pan/zoom state as {startIndex, endIndex}
├─ scales.ts              # linear + log price scale, time scale, tick selection
├─ overlays/              # ma, vwap, bands, volume, trades, riskEvents, drawdown
└─ renderers/
   ├─ svg.ts              # ≤ ~1,500 bars
   └─ canvas.ts           # above that
```

Hover state moves out of the scene component. Moving the mouse re-renders one crosshair line and one tooltip — not 800 candle bodies, three overlay paths, and a moving average.

### 3.2 Specific fixes

**Viewport, not zoom-count.** Today `zoom` is a number and `getVisibleCandles` (`:300`) slices the tail. That can only ever zoom toward the right edge — you cannot pan back to look at last Tuesday. Replace with `{ startIndex, endIndex }` supporting wheel-zoom at the cursor, drag-to-pan, and drag-to-select a range.

**Single-pass extrema.** `Math.max(...candles.map(c => c.high))` (`:408–410`, repeated at `:309–310` and `:1211–1212`) spreads the array into function arguments and throws `RangeError` past roughly 100k elements. Replace with a reducer that computes high, low, and max volume in one pass.

**Minimum bar width.** `step = chart.width / candles.length` (`:416`) with no floor renders sub-pixel bodies that alias into a grey smear on dense ranges. Enforce a minimum step; when bars exceed available pixels, aggregate rather than overdraw.

**Canvas above ~1,500 bars.** SVG node count is the wall. Render candles and volume to canvas, keep overlays, markers, and the crosshair in SVG on top — you keep hit-testing and accessibility where they matter and lose the node explosion where it hurts.

**Real time axis.** Currently only the first and last labels are drawn (`:551–556`). Needs proper tick selection by interval, with sensible boundaries (session opens on intraday, month starts on daily) and no label collisions.

**Right-edge price scale** with the live price badge anchored to it, plus a log-scale toggle for long windows where linear compresses early history into a flat line.

### 3.3 New capability: session replay

This reuses the viewport model, so it's much cheaper than it looks — and it's the feature that makes a session *legible*.

```
┌──────────────────────────────────────────────────────────┐
│ [◀◀] [▶] [▶▶]   09:30 ─────●────────────── 16:00   2× ▾  │
└──────────────────────────────────────────────────────────┘
```

Scrub a completed session forward and back. The chart, the position panel, the equity figure, and the activity feed all reflect the scrubbed moment. Play at 1×/2×/10×; step bar-by-bar with arrow keys; click any fill or risk event in the timeline to jump to it.

Watching a session play back is how you notice that your strategy always enters late, or that a halt fired on a one-tick spike. No metric table communicates that.

### 3.4 Theming contract

The chart reads **only** CSS custom properties — no hardcoded colors, no inline hex. Currently `strategyPalette` (`:174`) hardcodes six hex values in the component file.

```css
--chart-bg, --chart-grid, --chart-axis, --chart-crosshair
--chart-candle-up, --chart-candle-down, --chart-volume
--chart-line, --chart-area-from, --chart-area-to
--chart-ma, --chart-vwap, --chart-band
--chart-marker-buy, --chart-marker-sell, --chart-marker-blocked
--chart-risk-event, --chart-drawdown-band
--chart-series-1 … --chart-series-6      /* multi-strategy comparison */
```

This is the seam. Your design-system pass sets these; chart code never changes.

---

## 4. Interaction and accessibility baseline

- **Keyboard:** `⌘K` command palette (jump to symbol, session, algorithm), `1–5` for destinations, `Space` play/pause replay, `←/→` step bars, `Esc` closes overlays. A trading tool people use daily earns its keyboard shortcuts fast.
- **Focus is visible everywhere.** The chart hitboxes already set `tabIndex={0}` (`src/main.tsx:485`) but have no focus styling — currently a keyboard user is lost inside the chart.
- **Never color alone.** Gains and losses carry a sign or an arrow as well as color. Roughly 1 in 12 men has a red/green deficiency, and this is a red/green application.
- **Numbers are tabular-figure aligned and right-aligned in tables.** Cheap, and it's most of what makes a data table look professional rather than homemade.
- **Live regions** announce fills and halts to screen readers. Halts are `role="alert"`.
- Full audit is your `/design:accessibility-review` pass; this is the floor to build against.

---

## 5. Handoff — what `/design:design-system` needs to cover

Ordered by how much of the UI each unblocks.

**Tokens** (`src/styles/tokens.css`) — color (surface/border/text/accent/semantic, both themes), a type scale including a **tabular numeric** family, spacing, radii, elevation, motion durations. Plus the `--chart-*` set in §3.4.

**Data-display primitives** — these carry the product:
- `<Metric>` — label, value, delta, direction; reads the metric registry for format and sign convention. Used in every panel; this is the component that enforces Rule 1.
- `<MetricMatrix>` — the comparison table with winner highlighting.
- `<StatusPill>` — the seven session states, each visually distinct, halted unmistakable.
- `<Sparkline>`, `<BudgetMeter>`, `<Timeline>`, `<DataTable>` (sortable, sticky header, tabular figures).

**State components** — `<Loading>` (skeletons, not spinners, for known-shape data), `<Empty>` (with the action that fills it), `<ErrorState>` (cause + retry), `<StaleBadge>` (data age). Rule 5 depends entirely on these existing.

**Controls** — button hierarchy including a **destructive** variant for halt/liquidate, toggle, select, range picker, search with results, param inputs with inline validation.

**Layout** — app shell, status bar, sidebar, panel/card, drawer, modal, tabs.

**Two decisions worth making early**, because everything downstream inherits them:
1. **Dark-first or light-first?** Trading tools default dark, and the existing `styles.css` is dark. Pick and commit — a half-converted theme is worse than either.
2. **Density?** This is a data-dense tool for one expert user. Compact is right, but define one compact scale and apply it consistently rather than tuning per panel.

---

## 6. What gets deleted

Worth stating plainly, because the amount of removal here is a feature:

- Panel drag-and-drop and close/reopen (`panelOrder`, `closedPanels`, `draggedPanel` — `src/main.tsx:2020, 2021, 2052`) → layout presets.
- Four of the five strategy-metric tables → one `<MetricMatrix>` used everywhere.
- The Home view's three tabs (`homeTab`, `:2040`) → absorbed into Overview and Sessions.
- Frontend strategy duplicates (`src/strategy/`, `src/control/` — finding M2).
- Fabricated diagnostics and trade markers, and the dead hardcoded `/api/strategies` endpoint (finding C1).

The result is fewer screens, fewer components, and more answered questions.
