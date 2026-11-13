"""Tradeable universe.

The screener ranks every symbol in UNIVERSE each run, so the algorithm picks
its own tickers instead of trading one hard-coded fund.  The default list is
~120 liquid, large-cap US names spread across sectors plus the benchmark.  You
can replace or extend it with ``load_sp500()`` (needs internet) or by editing
``data/universe.csv`` if that file exists.
"""
from __future__ import annotations

import csv
import io
import os
from typing import Dict, List

BENCHMARK = "SPY"

# symbol -> sector
UNIVERSE: Dict[str, str] = {
    # Technology
    "AAPL": "Technology", "MSFT": "Technology", "NVDA": "Technology", "AVGO": "Technology",
    "ORCL": "Technology", "CRM": "Technology", "ADBE": "Technology", "AMD": "Technology",
    "CSCO": "Technology", "ACN": "Technology", "INTU": "Technology", "QCOM": "Technology",
    "TXN": "Technology", "AMAT": "Technology", "NOW": "Technology", "PANW": "Technology",
    "MU": "Technology", "LRCX": "Technology", "KLAC": "Technology", "ANET": "Technology",
    # Communication
    "GOOGL": "Communication", "META": "Communication", "NFLX": "Communication",
    "DIS": "Communication", "CMCSA": "Communication", "TMUS": "Communication",
    "VZ": "Communication", "T": "Communication",
    # Consumer Discretionary
    "AMZN": "Consumer Discretionary", "TSLA": "Consumer Discretionary", "HD": "Consumer Discretionary",
    "MCD": "Consumer Discretionary", "NKE": "Consumer Discretionary", "LOW": "Consumer Discretionary",
    "SBUX": "Consumer Discretionary", "BKNG": "Consumer Discretionary", "TJX": "Consumer Discretionary",
    "CMG": "Consumer Discretionary", "ORLY": "Consumer Discretionary",
    # Consumer Staples
    "PG": "Consumer Staples", "KO": "Consumer Staples", "PEP": "Consumer Staples",
    "COST": "Consumer Staples", "WMT": "Consumer Staples", "PM": "Consumer Staples",
    "MDLZ": "Consumer Staples", "CL": "Consumer Staples", "MO": "Consumer Staples",
    # Health Care
    "LLY": "Health Care", "UNH": "Health Care", "JNJ": "Health Care", "ABBV": "Health Care",
    "MRK": "Health Care", "TMO": "Health Care", "ABT": "Health Care", "PFE": "Health Care",
    "DHR": "Health Care", "AMGN": "Health Care", "ISRG": "Health Care", "VRTX": "Health Care",
    "GILD": "Health Care", "REGN": "Health Care", "BSX": "Health Care",
    # Financials
    "BRK-B": "Financials", "JPM": "Financials", "V": "Financials", "MA": "Financials",
    "BAC": "Financials", "WFC": "Financials", "GS": "Financials", "MS": "Financials",
    "AXP": "Financials", "BLK": "Financials", "SCHW": "Financials", "C": "Financials",
    "SPGI": "Financials", "PGR": "Financials", "CB": "Financials",
    # Industrials
    "CAT": "Industrials", "GE": "Industrials", "HON": "Industrials", "UNP": "Industrials",
    "RTX": "Industrials", "BA": "Industrials", "DE": "Industrials", "LMT": "Industrials",
    "UPS": "Industrials", "ETN": "Industrials", "ADP": "Industrials", "WM": "Industrials",
    # Energy
    "XOM": "Energy", "CVX": "Energy", "COP": "Energy", "SLB": "Energy", "EOG": "Energy",
    "MPC": "Energy", "PSX": "Energy", "OXY": "Energy",
    # Materials
    "LIN": "Materials", "APD": "Materials", "SHW": "Materials", "FCX": "Materials",
    "NEM": "Materials", "NUE": "Materials",
    # Utilities
    "NEE": "Utilities", "SO": "Utilities", "DUK": "Utilities", "CEG": "Utilities",
    # Real Estate
    "PLD": "Real Estate", "AMT": "Real Estate", "EQIX": "Real Estate", "O": "Real Estate",
    # Broad / thematic ETFs so the algorithm can still pick a fund when funds lead
    "QQQ": "ETF", "IWM": "ETF", "GLD": "ETF", "XLE": "ETF", "XLK": "ETF", "XLV": "ETF",
    "XLF": "ETF", "SMH": "ETF", "XLU": "ETF", "TLT": "ETF",
}

UNIVERSE_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "universe.csv")


def symbols(include_benchmark: bool = True) -> List[str]:
    """Return the active universe (custom CSV if present, else built-in)."""
    uni = load_custom() or UNIVERSE
    out = list(uni.keys())
    if include_benchmark and BENCHMARK not in out:
        out.append(BENCHMARK)
    return out


def sector_of(symbol: str) -> str:
    uni = load_custom() or UNIVERSE
    if symbol == BENCHMARK:
        return "Benchmark"
    return uni.get(symbol, "Unknown")


def load_custom(path: str = UNIVERSE_FILE) -> Dict[str, str]:
    """Optional override: a CSV with columns symbol,sector."""
    if not os.path.exists(path):
        return {}
    with open(path, newline="") as fh:
        rows = list(csv.DictReader(fh))
    return {r["symbol"].strip().upper(): (r.get("sector") or "Unknown").strip() for r in rows if r.get("symbol")}


def load_sp500(save: bool = True) -> Dict[str, str]:
    """Fetch current S&P 500 constituents from Wikipedia (needs internet).

    Saves them to data/universe.csv so later runs use the full index.
    """
    import pandas as pd  # local import keeps module light

    url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    table = pd.read_html(url)[0]
    uni = {
        str(sym).replace(".", "-").upper(): str(sec)
        for sym, sec in zip(table["Symbol"], table["GICS Sector"])
    }
    if save:
        os.makedirs(os.path.dirname(UNIVERSE_FILE), exist_ok=True)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["symbol", "sector"])
        for s, sec in sorted(uni.items()):
            w.writerow([s, sec])
        with open(UNIVERSE_FILE, "w", newline="") as fh:
            fh.write(buf.getvalue())
    return uni
