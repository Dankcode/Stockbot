"""Turn a screen result into target portfolio weights."""
from __future__ import annotations

from typing import Dict

import numpy as np
import pandas as pd

from .screener import ScreenResult


def target_weights(res: ScreenResult) -> Dict[str, float]:
    """Weights sum to <= 1.  Remainder is cash.

    * risk-off regime  -> all cash
    * inverse-volatility weighting (or equal), capped at ``max_weight``
    """
    cfg = res.config
    if not res.risk_on or not res.selected:
        return {}
    tbl = res.selected_table
    if cfg.weighting == "equal":
        raw = pd.Series(1.0, index=tbl.index)
    else:
        vol = tbl["vol_20"].replace(0, np.nan).fillna(tbl["vol_20"].median())
        raw = 1.0 / vol
    w = raw / raw.sum()
    # iterative cap: excess weight is spread over the uncapped names
    for _ in range(10):
        over = w > cfg.max_weight
        if not over.any():
            break
        excess = (w[over] - cfg.max_weight).sum()
        w[over] = cfg.max_weight
        under = ~over
        if under.any():
            w[under] = w[under] + excess * w[under] / w[under].sum()
    return {s: float(round(x, 6)) for s, x in w.items() if x > 0}


def rebalance_orders(current: Dict[str, float], target: Dict[str, float], equity: float,
                     prices: Dict[str, float], band: float = 0.01) -> pd.DataFrame:
    """Diff current weights against target and produce notional orders.

    ``band`` suppresses tiny trades (weight change below 1% of equity).
    Sells come first so cash is available for buys.
    """
    rows = []
    for sym in sorted(set(current) | set(target)):
        cur, tgt = current.get(sym, 0.0), target.get(sym, 0.0)
        diff = tgt - cur
        if abs(diff) < band and not (tgt == 0 and cur > 0):
            continue
        notional = diff * equity
        px = prices.get(sym, np.nan)
        rows.append({
            "symbol": sym, "side": "buy" if notional > 0 else "sell",
            "notional": round(abs(notional), 2), "qty": (abs(notional) / px) if px else np.nan,
            "from_weight": round(cur, 4), "to_weight": round(tgt, 4), "price": px,
            "close_position": tgt == 0 and cur > 0,
        })
    df = pd.DataFrame(rows, columns=["symbol", "side", "notional", "qty", "from_weight",
                                     "to_weight", "price", "close_position"])
    if df.empty:
        return df
    return pd.concat([df[df.side == "sell"], df[df.side == "buy"]]).reset_index(drop=True)
