"""Price data access with three sources.

* ``yfinance``  - live download (default), cached to ``data/cache``.
* ``cache``     - last downloaded data only, no network.
* ``synthetic`` - deterministic simulated market so the pipeline, backtest and
                  dashboard can run offline.  Clearly labelled in the output.
"""
from __future__ import annotations

import datetime as dt
import os
from dataclasses import dataclass
from typing import Iterable, List, Optional

import numpy as np
import pandas as pd

from . import universe as U

CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cache")


@dataclass
class Market:
    close: pd.DataFrame   # index: date, columns: symbol
    volume: pd.DataFrame  # same shape
    source: str

    def as_of(self, date) -> "Market":
        """Return a view truncated to ``date`` (inclusive)."""
        c = self.close.loc[:date]
        return Market(c, self.volume.loc[:date], self.source)

    @property
    def last_date(self):
        return self.close.index[-1]


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def load_market(symbols: Optional[Iterable[str]] = None, *, source: str = "yfinance",
                start: Optional[str] = None, end: Optional[str] = None,
                years: float = 3.0, seed: int = 42) -> Market:
    syms = list(symbols) if symbols else U.symbols()
    if U.BENCHMARK not in syms:
        syms.append(U.BENCHMARK)
    end_d = pd.Timestamp(end) if end else pd.Timestamp(dt.date.today())
    start_d = pd.Timestamp(start) if start else end_d - pd.DateOffset(days=int(365.25 * years))

    if source == "synthetic":
        return synthetic_market(syms, start_d, end_d, seed=seed)
    if source == "cache":
        m = read_cache(syms)
        if m is None:
            raise FileNotFoundError("No cached prices in data/cache. Run once with --source yfinance.")
        return m
    if source == "yfinance":
        try:
            m = download_yfinance(syms, start_d, end_d)
            write_cache(m)
            return m
        except Exception as exc:  # network blocked, rate limited, ...
            cached = read_cache(syms)
            if cached is not None:
                cached.source = f"cache (yfinance failed: {type(exc).__name__})"
                return cached
            raise
    raise ValueError(f"unknown source {source!r}")


# --------------------------------------------------------------------------- #
# yfinance
# --------------------------------------------------------------------------- #
def download_yfinance(symbols: List[str], start, end) -> Market:
    import yfinance as yf

    raw = yf.download(symbols, start=start, end=end + pd.Timedelta(days=1), auto_adjust=True,
                      progress=False, group_by="column", threads=True)
    if raw.empty:
        raise RuntimeError("yfinance returned no data")
    if isinstance(raw.columns, pd.MultiIndex):
        close = raw["Close"].copy()
        volume = raw["Volume"].copy()
    else:  # single symbol
        close = raw[["Close"]].rename(columns={"Close": symbols[0]})
        volume = raw[["Volume"]].rename(columns={"Volume": symbols[0]})
    close.index = pd.to_datetime(close.index).tz_localize(None)
    volume.index = close.index
    close = close.dropna(how="all").ffill()
    volume = volume.reindex(close.index).fillna(0.0)
    # drop symbols with almost no history
    ok = close.columns[close.notna().mean() > 0.5]
    return Market(close[ok].astype(float), volume[ok].astype(float), "yfinance")


def write_cache(m: Market) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    m.close.to_csv(os.path.join(CACHE_DIR, "close.csv"))
    m.volume.to_csv(os.path.join(CACHE_DIR, "volume.csv"))


def read_cache(symbols: Optional[List[str]] = None) -> Optional[Market]:
    cpath = os.path.join(CACHE_DIR, "close.csv")
    vpath = os.path.join(CACHE_DIR, "volume.csv")
    if not (os.path.exists(cpath) and os.path.exists(vpath)):
        return None
    close = pd.read_csv(cpath, index_col=0, parse_dates=True)
    volume = pd.read_csv(vpath, index_col=0, parse_dates=True)
    if symbols:
        keep = [s for s in symbols if s in close.columns]
        close, volume = close[keep], volume[keep]
    return Market(close.astype(float), volume.astype(float), "cache")


# --------------------------------------------------------------------------- #
# Synthetic market (offline testing)
# --------------------------------------------------------------------------- #
def synthetic_market(symbols: List[str], start, end, seed: int = 42) -> Market:
    """A seeded multi-factor random market.

    Each symbol = market factor + sector factor + idiosyncratic noise, with a
    slowly varying drift so that leadership rotates between sectors the way it
    does in real markets.  Deterministic for a given seed.
    """
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start, end)
    n = len(dates)
    sectors = sorted({U.sector_of(s) for s in symbols})
    sec_idx = {s: i for i, s in enumerate(sectors)}

    # market regime: drift switches between bull / bear phases
    phase_len = rng.integers(90, 220, size=20)
    drift = np.concatenate([np.full(l, rng.choice([0.0009, 0.0006, -0.0008, 0.0003])) for l in phase_len])[:n]
    if len(drift) < n:
        drift = np.pad(drift, (0, n - len(drift)), constant_values=0.0004)
    market = drift + rng.normal(0, 0.010, n)

    # sector factors: AR(1)-ish drift so trends persist for months
    sector_f = np.zeros((len(sectors), n))
    for i in range(len(sectors)):
        d = 0.0
        for t in range(n):
            if t % 60 == 0:
                d = rng.normal(0, 0.0008)
            sector_f[i, t] = d + rng.normal(0, 0.006)

    close = {}
    volume = {}
    for s in symbols:
        beta = 1.0 if s == U.BENCHMARK else rng.uniform(0.6, 1.5)
        idio_vol = 0.0 if s == U.BENCHMARK else rng.uniform(0.008, 0.022)
        alpha = 0.0 if s == U.BENCHMARK else rng.normal(0.0, 0.0004)
        r = beta * market + alpha + rng.normal(0, idio_vol, n)
        if s != U.BENCHMARK and s != "TLT":
            r = r + 0.8 * sector_f[sec_idx[U.sector_of(s)]]
        if s in ("TLT", "GLD"):
            r = -0.3 * market + rng.normal(0.0002, 0.008, n)
        p0 = 400.0 if s == U.BENCHMARK else float(rng.uniform(20, 600))
        close[s] = p0 * np.exp(np.cumsum(r))
        base_vol = float(rng.uniform(1e6, 4e7))
        volume[s] = base_vol * np.exp(rng.normal(0, 0.3, n))
    c = pd.DataFrame(close, index=dates)
    v = pd.DataFrame(volume, index=dates)
    return Market(c, v, "synthetic")
