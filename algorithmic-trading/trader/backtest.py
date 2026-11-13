"""Walk-forward backtest of the rotation strategy.

At every rebalance date the screener is re-run on data available up to that
day only, the allocator sets target weights, and the portfolio is traded to
those weights with slippage.  A per-position trailing stop is checked daily.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from .allocator import target_weights
from .data import Market
from .screener import ScreenConfig, screen


@dataclass
class BacktestConfig:
    initial_cash: float = 100_000.0
    rebalance_every: int = 5          # trading days (5 = weekly)
    slippage_bps: float = 5.0
    trailing_stop: float = 0.15       # 15% from the high since entry; 0 disables
    rebalance_band: float = 0.02      # skip weight adjustments smaller than this (of equity)
    warmup: int = 260                 # days of history needed before first trade
    screen: ScreenConfig = field(default_factory=ScreenConfig)


@dataclass
class BacktestResult:
    equity: pd.Series
    benchmark: pd.Series
    trades: pd.DataFrame
    weights: pd.DataFrame          # weights held after each rebalance
    rebalances: List[dict]
    stats: Dict[str, float]
    config: BacktestConfig


def run_backtest(market: Market, cfg: Optional[BacktestConfig] = None) -> BacktestResult:
    cfg = cfg or BacktestConfig()
    close = market.close
    dates = close.index
    bench_sym = cfg.screen.benchmark
    slip = cfg.slippage_bps / 1e4

    cash = cfg.initial_cash
    shares: Dict[str, float] = {}
    entry_high: Dict[str, float] = {}
    entry_px: Dict[str, float] = {}
    entry_dt: Dict[str, pd.Timestamp] = {}
    equity = []
    trades: List[dict] = []
    weight_rows = []
    rebalances = []

    def portfolio_value(i):
        px = close.iloc[i]
        return cash + sum(q * px[s] for s, q in shares.items() if not np.isnan(px[s]))

    def execute(i, sym, qty, reason):
        nonlocal cash
        px = float(close.iloc[i][sym])
        if np.isnan(px) or qty == 0:
            return
        fill = px * (1 + slip) if qty > 0 else px * (1 - slip)
        cash -= qty * fill
        prev = shares.get(sym, 0.0)
        new = prev + qty
        pnl = None
        if qty > 0 and prev == 0:
            entry_px[sym], entry_high[sym], entry_dt[sym] = fill, px, dates[i]
        if new <= 1e-9:
            if sym in entry_px:
                pnl = (fill / entry_px[sym] - 1.0)
            shares.pop(sym, None); entry_px.pop(sym, None); entry_high.pop(sym, None); entry_dt.pop(sym, None)
        else:
            shares[sym] = new
        trades.append({"date": dates[i], "symbol": sym, "side": "buy" if qty > 0 else "sell",
                       "qty": round(abs(qty), 4), "price": round(fill, 4),
                       "notional": round(abs(qty) * fill, 2), "reason": reason,
                       "return": None if pnl is None else round(pnl, 4)})

    last_rebalance = None
    for i, d in enumerate(dates):
        if i < cfg.warmup:
            equity.append(np.nan)
            continue
        px = close.iloc[i]

        # ---- daily trailing stop ----------------------------------------
        if cfg.trailing_stop > 0:
            for sym in list(shares):
                if np.isnan(px[sym]):
                    continue
                entry_high[sym] = max(entry_high.get(sym, px[sym]), px[sym])
                if px[sym] < entry_high[sym] * (1 - cfg.trailing_stop):
                    execute(i, sym, -shares[sym], "trailing_stop")

        # ---- periodic rebalance -----------------------------------------
        due = last_rebalance is None or (i - last_rebalance) >= cfg.rebalance_every
        if due:
            res = screen(market, cfg.screen, as_of=d)
            tgt = target_weights(res)
            value = portfolio_value(i)
            cur = {s: q * px[s] / value for s, q in shares.items()}
            # sells first
            for s in list(shares):
                if s not in tgt:
                    execute(i, s, -shares[s], "rotation_out")
            value = portfolio_value(i)
            for s, w in tgt.items():
                if np.isnan(px[s]):
                    continue
                target_q = w * value / px[s]
                diff = target_q - shares.get(s, 0.0)
                is_new = s not in shares
                if is_new or abs(diff * px[s]) > cfg.rebalance_band * value:
                    execute(i, s, diff, "rotation_in" if is_new else "rebalance")
            last_rebalance = i
            rebalances.append({"date": d, "risk_on": res.risk_on, "selected": res.selected,
                               "targets": tgt, "regime": res.regime})
            weight_rows.append(pd.Series(tgt, name=d))
        equity.append(portfolio_value(i))

    eq = pd.Series(equity, index=dates, name="strategy").dropna()
    bench = close[bench_sym].loc[eq.index]
    bench = bench / bench.iloc[0] * cfg.initial_cash
    bench.name = "benchmark"
    trades_df = pd.DataFrame(trades)
    weights_df = pd.DataFrame(weight_rows).fillna(0.0) if weight_rows else pd.DataFrame()
    stats = performance_stats(eq, bench, trades_df)
    return BacktestResult(eq, bench, trades_df, weights_df, rebalances, stats, cfg)


def performance_stats(eq: pd.Series, bench: pd.Series, trades: pd.DataFrame) -> Dict[str, float]:
    def _stats(s: pd.Series, prefix: str):
        r = s.pct_change().dropna()
        years = max((s.index[-1] - s.index[0]).days / 365.25, 1e-9)
        total = s.iloc[-1] / s.iloc[0] - 1
        cagr = (1 + total) ** (1 / years) - 1
        vol = r.std() * np.sqrt(252)
        sharpe = (r.mean() / r.std() * np.sqrt(252)) if r.std() > 0 else 0.0
        dd = (s / s.cummax() - 1).min()
        return {f"{prefix}_total_return": total, f"{prefix}_cagr": cagr, f"{prefix}_vol": vol,
                f"{prefix}_sharpe": sharpe, f"{prefix}_max_drawdown": dd}

    out = {**_stats(eq, "strategy"), **_stats(bench, "benchmark")}
    closed = trades[trades["return"].notna()] if not trades.empty and "return" in trades else pd.DataFrame()
    out["trades"] = int(len(trades))
    out["closed_trades"] = int(len(closed))
    out["win_rate"] = float((closed["return"] > 0).mean()) if len(closed) else float("nan")
    out["avg_trade_return"] = float(closed["return"].mean()) if len(closed) else float("nan")
    out["start"] = str(eq.index[0].date())
    out["end"] = str(eq.index[-1].date())
    return {k: (float(v) if isinstance(v, (float, np.floating)) else v) for k, v in out.items()}
