# Stockbot implementation reference

The two concept images in this folder are the visual source of truth for the revised HUD:

- `stockbot-overview-concept.png` — app shell, persistent status rail, Overview hierarchy, risk meters, positions, activity.
- `stockbot-sessions-concept.png` — Sessions list/detail, halt explanation, chart anatomy, event timeline, comparison drawer.

They translate `docs/plan/04-hud-and-chart-spec.md` into an implementation reference. All financial UI remains code-native; the images are never rendered inside the app.

## Token lock

- Canvas: `#070d13`; raised band: `#0b141d`; selected/navigation surface: `#102338`.
- Border/grid: `#22313d`; primary text: `#eef4f8`; secondary text: `#9cabb8`.
- Accent: `#2c95ff`; positive: `#39c461`; warning: `#f0aa2c`; destructive: `#ff5358`.
- Typography: system sans, editorial/neutral, tabular figures for every number. Headings 24–30px; body 13–15px; UI chrome 12–13px.
- Spacing scale: 4, 8, 12, 16, 24, 32px. Corners 6–10px. Hairline borders and near-zero shadow.
- Container model: open bands, rails, aligned rows, tables and charts. Avoid nested cards and floating bento tiles.

## Component inventory

- Shell: `StatusBar`, `Sidebar`, route content, mobile navigation.
- Data display: `Metric`, `MetricMatrix`, `StatusPill`, `BudgetMeter`, `DataTable`, `Timeline`.
- States: `LoadingState`, `EmptyState`, `ErrorState`, `StaleBadge`.
- Controls: primary/secondary/destructive buttons, compact select, search, tabs, checkbox, icon button.
- Charts: static scene, interaction overlay, price/time axes, markers and risk rules; colors only through `--chart-*` properties.
- Icons: Lucide outline icons at 16–20px, roughly 1.75px stroke. Never use an icon when text is clearer.

## First-viewport copy lock

Allowed persistent copy: `Stockbot`, `PAPER`, `Equity`, `Running`, `Risk used`, `Data healthy`, `HALT ALL`, `Overview`, `Markets`, `Strategies`, `Sessions`, `Settings`.

Overview section copy: `Day P&L`, `Realized all-time`, `Active sessions`, `Risk budget`, `Daily loss`, `Drawdown`, `Exposure`, `Orders today`, `Open positions`, `Activity`.

Sessions section copy: `Sessions`, `Status`, `Mode`, `Algorithm`, `Date`, `Compare selected`, `Return`, `Max drawdown`, `Sharpe`, `Win rate`, `Trades`, `vs SPY`, `Trades`, `Events`, `Config`, `Configuration diff`.

Product states and real API errors may add contextual copy. No marketing headings, decorative kicker text, proof badges, or fabricated market claims.

## Responsive continuation

- ≥1200px: fixed sidebar, persistent horizontal HUD, two-column content where shown.
- 760–1199px: collapsed icon sidebar; status items wrap or hide secondary detail; single-column content.
- <760px: bottom destination navigation, stacked status summary, horizontally scrollable tables, chart remains at least 320px tall.
