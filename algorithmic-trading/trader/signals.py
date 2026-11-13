"""Factor signals computed on a Market as of a date.

All functions take the close/volume frames (dates x symbols) and return one
value per symbol for the LAST row.  Everything is point-in-time: only data up
to and including the last row is used, so the same code serves the backtest
and the live screener.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def _ret(close: pd.DataFrame, lookback: int, skip: int = 0) -> pd.Series:
    """Total return over ``lookback`` days ending ``skip`` days ago."""
    if len(close) <= lookback + skip:
        return pd.Series(np.nan, index=close.columns)
    end = close.iloc[-1 - skip]
    start = close.iloc[-1 - skip - lookback]
    return end / start - 1.0


def momentum_12_1(close):  # classic: last 12 months excluding the most recent month
    return _ret(close, TRADING_DAYS - 21, skip=21)


def momentum_6m(close):
    return _ret(close, 126)


def momentum_3m(close):
    return _ret(close, 63)


def momentum_1m(close):
    return _ret(close, 21)


def volatility(close, window: int = 20) -> pd.Series:
    r = np.log(close).diff().iloc[-window:]
    return r.std() * np.sqrt(TRADING_DAYS)


def sma(close, window: int) -> pd.Series:
    if len(close) < window:
        return pd.Series(np.nan, index=close.columns)
    return close.iloc[-window:].mean()


def trend_ok(close) -> pd.Series:
    """Price above 50-day SMA and 50-day above 200-day SMA (Stage 2 uptrend)."""
    last = close.iloc[-1]
    s50, s200 = sma(close, 50), sma(close, 200)
    return (last > s50) & (s50 > s200)


def pct_from_52w_high(close) -> pd.Series:
    hi = close.iloc[-TRADING_DAYS:].max()
    return close.iloc[-1] / hi - 1.0


def rsi(close, window: int = 14) -> pd.Series:
    delta = close.diff().iloc[-(window * 3):]
    gain = delta.clip(lower=0).ewm(alpha=1 / window, adjust=False).mean().iloc[-1]
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / window, adjust=False).mean().iloc[-1]
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100.0)


def avg_dollar_volume(close, volume, window: int = 20) -> pd.Series:
    return (close * volume).iloc[-window:].mean()


def relative_strength(close, benchmark: str, lookback: int = 126) -> pd.Series:
    r = _ret(close, lookback)
    return r - r.get(benchmark, 0.0)


def zscore(s: pd.Series) -> pd.Series:
    s = s.replace([np.inf, -np.inf], np.nan)
    sd = s.std()
    if not sd or np.isnan(sd):
        return s * 0.0
    z = (s - s.mean()) / sd
    return z.clip(-3, 3)


def factor_table(close: pd.DataFrame, volume: pd.DataFrame, benchmark: str) -> pd.DataFrame:
    """One row per symbol with every raw factor."""
    f = pd.DataFrame(index=close.columns)
    f["price"] = close.iloc[-1]
    f["mom_12_1"] = momentum_12_1(close)
    f["mom_6m"] = momentum_6m(close)
    f["mom_3m"] = momentum_3m(close)
    f["mom_1m"] = momentum_1m(close)
    f["vol_20"] = volatility(close, 20)
    f["trend"] = trend_ok(close)
    f["from_high"] = pct_from_52w_high(close)
    f["rsi_14"] = rsi(close)
    f["adv_20"] = avg_dollar_volume(close, volume)
    f["rs_6m"] = relative_strength(close, benchmark)
    f["sma_50"] = sma(close, 50)
    f["sma_200"] = sma(close, 200)
    return f


DEFAULT_WEIGHTS = {
    "mom_12_1": 0.35,
    "mom_6m": 0.25,
    "mom_3m": 0.15,
    "from_high": 0.10,
    "vol_20": -0.15,  # negative: prefer calmer names
}


def composite_score(f: pd.DataFrame, weights=None) -> pd.Series:
    weights = weights or DEFAULT_WEIGHTS
    score = pd.Series(0.0, index=f.index)
    for col, w in weights.items():
        score = score + w * zscore(f[col])
    return score
