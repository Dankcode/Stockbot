"""Rank the universe and pick what to own.

The screener is the part of the system that *chooses tickers*.  Every run it:
1. computes factor signals for every symbol in the universe,
2. applies hard filters (liquidity, price, uptrend, not over-extended),
3. ranks the survivors on a composite momentum/quality score,
4. checks the market regime (benchmark above its 200-day average),
5. hands the top names to the allocator.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional

import numpy as np
import pandas as pd

from . import signals as S
from . import universe as U
from .data import Market


@dataclass
class ScreenConfig:
    top_n: int = 10                   # number of positions to hold
    min_price: float = 5.0
    min_dollar_volume: float = 2e7    # 20M USD / day average
    max_rsi: float = 80.0             # skip names that are already parabolic
    require_trend: bool = True        # only Stage-2 uptrends
    regime_sma: int = 200             # benchmark SMA for risk-on / risk-off
    max_weight: float = 0.15          # cap per position
    max_per_sector: int = 3           # diversification
    weighting: str = "inverse_vol"    # or "equal"
    weights: Dict[str, float] = field(default_factory=lambda: dict(S.DEFAULT_WEIGHTS))
    benchmark: str = U.BENCHMARK
    exclude: List[str] = field(default_factory=lambda: [U.BENCHMARK])

    def to_dict(self):
        return asdict(self)


@dataclass
class ScreenResult:
    as_of: pd.Timestamp
    table: pd.DataFrame            # every symbol with factors, score, rank, pass flags
    selected: List[str]
    risk_on: bool
    regime: Dict[str, float]
    config: ScreenConfig

    @property
    def selected_table(self) -> pd.DataFrame:
        return self.table.loc[self.selected]


def market_regime(close: pd.DataFrame, benchmark: str, window: int) -> Dict[str, float]:
    bench = close[benchmark].dropna()
    last = float(bench.iloc[-1])
    sma = float(bench.iloc[-window:].mean()) if len(bench) >= window else float("nan")
    risk_on = bool(last > sma) if not np.isnan(sma) else True
    return {"benchmark": benchmark, "close": last, "sma": sma, "risk_on": risk_on,
            "distance": (last / sma - 1.0) if sma else float("nan")}


def screen(market: Market, cfg: Optional[ScreenConfig] = None, as_of=None) -> ScreenResult:
    cfg = cfg or ScreenConfig()
    m = market.as_of(as_of) if as_of is not None else market
    close, volume = m.close, m.volume
    f = S.factor_table(close, volume, cfg.benchmark)
    f["sector"] = [U.sector_of(s) for s in f.index]

    # ---- hard filters -----------------------------------------------------
    f["f_price"] = f["price"] >= cfg.min_price
    f["f_liquid"] = f["adv_20"] >= cfg.min_dollar_volume
    f["f_trend"] = f["trend"] if cfg.require_trend else True
    f["f_rsi"] = f["rsi_14"] <= cfg.max_rsi
    f["f_data"] = f["mom_12_1"].notna() & f["vol_20"].notna()
    f["f_universe"] = ~f.index.isin(cfg.exclude)
    f["passes"] = f[["f_price", "f_liquid", "f_trend", "f_rsi", "f_data", "f_universe"]].all(axis=1)

    # ---- score & rank -----------------------------------------------------
    f["score"] = S.composite_score(f, cfg.weights)
    f.loc[~f["f_data"], "score"] = np.nan
    f = f.sort_values("score", ascending=False)
    f["rank"] = np.arange(1, len(f) + 1)

    # ---- selection with sector cap ---------------------------------------
    selected: List[str] = []
    per_sector: Dict[str, int] = {}
    for sym, row in f[f["passes"]].iterrows():
        sec = row["sector"]
        if per_sector.get(sec, 0) >= cfg.max_per_sector:
            continue
        selected.append(sym)
        per_sector[sec] = per_sector.get(sec, 0) + 1
        if len(selected) >= cfg.top_n:
            break
    f["selected"] = f.index.isin(selected)

    regime = market_regime(close, cfg.benchmark, cfg.regime_sma)
    return ScreenResult(as_of=close.index[-1], table=f, selected=selected,
                        risk_on=regime["risk_on"], regime=regime, config=cfg)
