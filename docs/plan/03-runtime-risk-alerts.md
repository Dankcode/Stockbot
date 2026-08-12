# Stockbot — Bot Runtime, Risk Guardrails & Alerts

These three systems are one system. The runtime decides *when* to act, risk decides *whether* to act, alerts decide *what you hear about it*. Specifying them together keeps the seams honest.

Design stance throughout: **the bot is a thing you supervise, not a thing you launch and hope about.** Every automatic action is logged with its cause, every stop is attributable, and the kill switch works no matter what else is happening.

---

## 1. Session lifecycle

A **session** is one continuous run of one strategy configuration. It's the unit you compare, export, and reason about. Backtests and paper runs share the record type deliberately — that's what makes "did live match the backtest" a query rather than a manual exercise.

### State machine

```
                 ┌──────────┐
                 │  draft   │  configured, never started
                 └────┬─────┘
                      │ start
                 ┌────▼─────┐
                 │  arming  │  preflight: data available? risk profile valid?
                 └────┬─────┘  algorithm loads? market open (or scheduled)?
            fail ─────┤
                      │ ok
                 ┌────▼─────┐  pause    ┌──────────┐
                 │ running  │──────────▶│  paused  │
                 │          │◀──────────│          │
                 └──┬───┬───┘  resume   └────┬─────┘
                    │   │                    │ stop
              stop  │   │ risk halt          │
                    │   └──────────┐         │
               ┌────▼─────┐   ┌────▼─────┐   │
               │ stopping │   │  halted  │◀──┘
               └────┬─────┘   └────┬─────┘
                    │              │
               ┌────▼──────────────▼─────┐
               │        stopped          │  terminal; metrics finalized
               └─────────────────────────┘
                 ┌──────────┐
                 │  errored │  terminal; error_detail populated
                 └──────────┘
```

**Transitions worth calling out:**

- **`arming` is a real state, not a formality.** Preflight catches the failures that are cheap now and expensive later: no bars for a symbol, an algorithm that throws on `init`, a risk profile referencing a deleted rule, a stale-data provider. A bot that fails to arm tells you why; a bot that starts and does nothing does not.
- **`halted` is distinct from `stopped`.** Halted means a guardrail fired. It carries the triggering `risk_event` and is visually distinct everywhere in the UI. You should never have to wonder whether a stopped bot finished or was stopped by a loss limit.
- **`paused` holds positions.** It suspends new signals but keeps risk monitors running — a max-drawdown breach while paused still halts, because the position is still exposed. This surprises people, so the UI should say it plainly.
- **Terminal states finalize metrics** and write the `session_metrics` row. Nothing recomputes a terminal session's numbers unless `metrics_version` changes.

### The tick loop

`runtime/scheduler.js` drives each running session at its bar interval, aligned to bar boundaries with a small settle delay (a "closed" bar isn't final the instant the clock rolls over).

```
tick(session):
  1. market gate       → open for this asset class? else idle-tick, no signals
  2. refresh quotes    → for session symbols; record quote age
  3. reconcile         → mark-to-market positions, write equity_snapshot
  4. risk monitors     → continuous rules (drawdown, daily loss, exposure)
                         a `halt` verdict short-circuits everything below
  5. bar close?        → if a new bar closed, ask the algorithm for a signal
  6. size              → risk engine converts signal → qty (or rejects)
  7. pre-trade checks  → per-order rules; reject writes a risk_event
  8. submit            → paper broker; fill at NEXT bar open per fill model
  9. persist           → order, fill, position lot, equity snapshot
 10. evaluate alerts   → against the state this tick produced
 11. emit              → SSE frame to any connected client
```

**Step 5 is where finding C2 gets fixed operationally.** The algorithm sees only closed bars. The order it produces fills at the next bar's open. Backtest and live run the identical path with the identical `fill-model.js` — which is the only way "my backtest said 30%" is ever a meaningful sentence.

**Step 4 before step 5** is deliberate: risk gets to stop the session before a new position can be opened, not after.

### The kill switch

`POST /api/v1/sessions/:id/halt` must be the most reliable route in the application. Requirements:

- **Never queued behind engine work.** Today `/api/failsafe/liquidate` sits behind whatever synchronous backtest is running (finding P2). The worker pool fixes this: backtests move off the request thread, and the halt route touches only the supervisor and the ledger.
- **Idempotent.** Halting a halted session succeeds silently. Panic produces double-clicks.
- **Two variants:** *halt* (stop signalling, hold positions) and *halt & liquidate* (stop and flatten). The UI defaults to plain halt and asks before liquidating — flattening is destructive and irreversible.
- **Global kill:** `POST /api/v1/accounts/:id/halt-all` stops every running session at once. This is the button that lives in the persistent status bar.
- **Survives restart.** On boot, the supervisor reads sessions with status `running` and either resumes them or marks them `errored` with a clear reason — never leaves an orphan in an ambiguous state.

### Scheduling

`scheduler.js` supports: run during market hours only, a fixed window, a cron expression, or continuous (crypto). Sessions auto-transition `running → stopped` at window close with `stop_reason: 'schedule'`.

Two properties that matter: schedules are **timezone-explicit** (exchange-local, stored UTC), and a missed window due to downtime **does not** silently backfill — it logs and skips. Backfilled trades against stale prices are exactly the C4 failure mode.

---

## 2. Risk engine

Every rule shares one interface, which is what makes the set extensible without touching the runtime:

```js
{
  id: "max_daily_loss",
  scope: "session" | "account",
  phase: "pre_trade" | "continuous",
  severity: "warn" | "block" | "halt",
  evaluate(ctx) → { triggered, observed, threshold, message }
}
```

Rules live in `risk/rules/`, one file each, registered in `risk/engine.js`. A profile is a JSON blob of enabled rules and thresholds, stored in `risk_profiles`, frozen into `sessions.risk_profile_json` at start so historical sessions stay explainable.

### Rule catalogue

**Pre-trade — evaluated per order, rejection writes a `risk_event` and an `orders` row with `status: 'rejected'` and a reason.** Rejected orders are recorded, not discarded: "the bot didn't trade today" and "the bot tried to trade 40 times and was blocked" are very different situations and the UI must distinguish them.

| Rule | Default | Notes |
|---|---|---|
| `quote_freshness` | 5,000 ms | ★ Fixes C4. Rejects fills on stale quotes. Non-negotiable — it's the difference between paper results that mean something and a weekend of fills at Friday's close. |
| `market_hours` | on | ★ Also C4. Blocks orders outside the session for the asset class. |
| `price_sanity` | ±10% vs prior tick | Catches provider glitches before they become a position. |
| `max_position_size` | 20% of equity | Replaces the hardcoded `cash * 0.95` at `server/index.js:1020`. |
| `max_position_notional` | none | Absolute dollar cap. |
| `max_concurrent_positions` | 5 | |
| `max_symbol_exposure` | 25% | Per-symbol, across lots. |
| `symbol_allowlist` / `blocklist` | off | |
| `min_order_notional` | $10 | Suppresses dust orders that only generate commission. |
| `max_orders_per_minute` | 10 | ★ Runaway guard. A strategy bug that flips signal every tick is the most likely way a bot hurts you. |
| `max_orders_per_day` | 100 | |
| `sufficient_funds` | on | Checked inside the ledger transaction (fixes C6). |

**Continuous — evaluated every tick; `halt` severity stops the session.**

| Rule | Default | Notes |
|---|---|---|
| `max_daily_loss` | 3% of starting equity | ★ Halts. The single most important guardrail. |
| `max_drawdown` | 10% from peak | ★ Halts. Peak tracked per session. |
| `max_account_drawdown` | 15% | Account-scoped — halts *every* session on the account. |
| `position_stop_loss` | 5% per lot | Emits a sell rather than halting. |
| `position_take_profit` | off | Same. |
| `trailing_stop` | off | Ratchets with favourable movement. |
| `max_exposure` | 80% of equity | Warn at 80%, block new entries at 100%. |
| `data_staleness` | 60 s | No fresh quotes for a minute → pause, don't halt. Provider hiccups shouldn't kill a good run. |

### Position sizing

Sizing is the risk engine's job, not the algorithm's — that's why algorithms return `"buy" | "sell" | null` rather than quantities, and it's a good existing decision worth preserving.

```
sizeOrder(signal, ctx) →
  risk_budget   = equity × max_position_size
  volatility    = ATR(14) at the signal bar
  stop_distance = position_stop_loss % (or ATR multiple, if configured)
  qty           = min( risk_budget / price,
                       (equity × per_trade_risk) / stop_distance,   ← risk-parity sizing
                       max_position_notional / price,
                       available_cash / price )
```

The second term is the one that makes the bot behave sensibly across volatility regimes: it risks a constant *fraction of equity per trade* rather than a constant *fraction of capital per position*. Default `per_trade_risk` 1%.

Sizing mode is configurable — `fixed_fractional`, `risk_parity`, `fixed_notional` — and stored with the session so a stored result is reproducible.

### Where risk shows up in the UI

Covered in `04-hud-and-chart-spec.md`, but the contract from this side:

- A **risk budget meter** on the Overview: how much of your daily loss allowance and drawdown allowance is consumed. This is the number that tells you at a glance whether today is going fine.
- Every **halt** renders with its triggering rule, the observed value, and the threshold — never a bare "stopped."
- **Rejected orders** appear in the session timeline, greyed, with the rule that blocked them.

---

## 3. Alerts & reporting

### Trigger types

| Type | Fires on | Example |
|---|---|---|
| `metric_threshold` | A session metric crosses a bound | "Session return below −2%" |
| `risk_event` | Any risk event at/above a severity | "Any halt, on any session" |
| `session_state` | A lifecycle transition | "Session halted or errored" |
| `signal` | An algorithm emits a signal | "EMA Cross fires on NVDA" |
| `schedule` | Cron | "Daily digest at 16:15 ET" |

Conditions are JSON, validated against a shared schema, evaluated in `alerts/evaluator.js` at tick step 10 and on scheduler ticks.

### Delivery

v1 is **in-app only** — an alert feed on the Overview plus an unread count, backed by `alert_deliveries`. That's the right v1 because it needs no credentials, no deliverability concerns, and no failure modes you have to debug at 3am.

`webhook` and `email` slot in behind the same `channels/` interface later. Every attempt writes an `alert_deliveries` row with status, so a channel that quietly stops working is visible rather than invisible.

**Cooldowns are mandatory.** `alerts.cooldown_ms` suppresses re-fires within the window; suppressed attempts still write a row with `status: 'suppressed'` so the count is honest. Without this, a threshold alert on a metric hovering at the bound will fire every tick and you will turn alerts off entirely — which is the real failure mode.

### Reporting

A **session report** renders one session as: header (config, window, algorithm version, fill model), equity curve, metric table, trade list with per-trade P&L, risk event timeline, and a comparison against the SPY and Cash controls over the same window.

Exports: CSV (one file per table, for spreadsheets) and JSON (complete, for re-import). Both from `GET /api/v1/sessions/:id/export`.

The **digest** is a `schedule` alert that renders the report for sessions active in the period. Daily at market close and weekly on Friday are the two that earn their keep.

---

## 4. What this buys you, concretely

Once these three land, questions that are currently unanswerable become one click:

- "How did this week's run compare to last week's, same strategy?" → session compare
- "Why did the bot stop at 11:40?" → risk event with rule, observed value, threshold
- "Did the backtest predict the paper result?" → same fill model, same metrics, side by side
- "How much did slippage cost me?" → `sum(price − reference_price) × qty` over fills
- "Is the bot behaving today?" → risk budget meter on the Overview
- "What did it try to do that it wasn't allowed to?" → rejected orders in the timeline

That set is the actual product. The UI in `04-hud-and-chart-spec.md` exists to surface it.
