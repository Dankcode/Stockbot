"""Serialize everything the dashboard needs into output/state.json."""
from __future__ import annotations

import datetime as dt
import json
import math
import os
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from .backtest import BacktestResult
from .data import Market
from .screener import ScreenResult

OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "output")
STATE_PATH = os.path.join(OUTPUT_DIR, "state.json")


def _clean(v):
    if isinstance(v, (np.bool_,)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if (v is None or math.isnan(float(v)) or math.isinf(float(v))) else float(v)
    if isinstance(v, (pd.Timestamp, dt.date, dt.datetime)):
        return str(pd.Timestamp(v).date())
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, np.ndarray, pd.Index)):
        return [_clean(x) for x in v]
    return v


def _sparkline(close: pd.DataFrame, sym: str, n: int = 60) -> List[float]:
    s = close[sym].dropna().iloc[-n:]
    if s.empty:
        return []
    return [round(float(x / s.iloc[0]), 4) for x in s]


def _downsample(s: pd.Series, max_points: int = 400) -> pd.Series:
    if len(s) <= max_points:
        return s
    step = int(math.ceil(len(s) / max_points))
    return pd.concat([s.iloc[::step], s.iloc[[-1]]])


def build_state(market: Market, res: ScreenResult, targets: Dict[str, float],
                backtest: Optional[BacktestResult] = None, account: Optional[dict] = None,
                orders: Optional[list] = None, mode: str = "screen") -> Dict[str, Any]:
    close = market.close
    cols = ["rank", "sector", "price", "score", "mom_12_1", "mom_6m", "mom_3m", "mom_1m", "vol_20",
            "from_high", "rsi_14", "adv_20", "rs_6m", "trend", "passes", "selected",
            "f_price", "f_liquid", "f_trend", "f_rsi", "f_data"]
    rankings = []
    for sym, row in res.table.iterrows():
        rec = {"symbol": sym, **{c: _clean(row[c]) for c in cols if c in row}}
        rec["weight"] = targets.get(sym, 0.0)
        rec["spark"] = _sparkline(close, sym)
        rankings.append(rec)

    bench = close[res.config.benchmark].dropna()
    regime_series = bench.iloc[-260:]
    sma = bench.rolling(res.config.regime_sma).mean().loc[regime_series.index]

    state: Dict[str, Any] = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "mode": mode,
        "data_source": market.source,
        "as_of": _clean(res.as_of),
        "universe_size": int(len(res.table)),
        "passing": int(res.table["passes"].sum()),
        "regime": _clean(res.regime),
        "config": _clean(res.config.to_dict()),
        "selected": res.selected,
        "targets": targets,
        "cash_weight": round(1.0 - sum(targets.values()), 6),
        "rankings": rankings,
        "benchmark_series": {"dates": _clean(regime_series.index), "close": _clean(regime_series.values),
                             "sma": _clean(sma.values)},
        "sector_counts": _clean(res.table[res.table["selected"]]["sector"].value_counts().to_dict()),
        "account": account,
        "orders": _clean(orders) if orders else [],
    }
    if backtest is not None:
        eq = _downsample(backtest.equity)
        bm = backtest.benchmark.loc[eq.index]
        dd = (backtest.equity / backtest.equity.cummax() - 1.0).loc[eq.index]
        tr = backtest.trades.tail(60).iloc[::-1] if not backtest.trades.empty else pd.DataFrame()
        state["backtest"] = {
            "stats": _clean(backtest.stats),
            "equity": {"dates": _clean(eq.index), "strategy": _clean(eq.values),
                       "benchmark": _clean(bm.values), "drawdown": _clean(dd.values)},
            "trades": _clean(tr.to_dict(orient="records")) if not tr.empty else [],
            "rebalances": _clean([{"date": r["date"], "risk_on": r["risk_on"], "selected": r["selected"]}
                                  for r in backtest.rebalances[-30:]][::-1]),
            "config": {"initial_cash": backtest.config.initial_cash,
                       "rebalance_every": backtest.config.rebalance_every,
                       "slippage_bps": backtest.config.slippage_bps,
                       "trailing_stop": backtest.config.trailing_stop},
        }
    return state


def write_state(state: Dict[str, Any], path: str = STATE_PATH) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        json.dump(state, fh, indent=1, default=_clean)
    return path


def read_state(path: str = STATE_PATH) -> Optional[Dict[str, Any]]:
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)
