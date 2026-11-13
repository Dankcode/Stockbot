"""Offline tests for the stock-selection engine (synthetic data, no network)."""
import numpy as np
import pandas as pd
import pytest

from trader import universe as U
from trader.allocator import rebalance_orders, target_weights
from trader.backtest import BacktestConfig, run_backtest
from trader.data import load_market
from trader.screener import ScreenConfig, screen
from trader.state import build_state


@pytest.fixture(scope="module")
def market():
    return load_market(source="synthetic", years=2.5, seed=3)


def test_universe_has_sectors_and_benchmark():
    syms = U.symbols()
    assert U.BENCHMARK in syms
    assert len(syms) > 50
    assert U.sector_of("AAPL") == "Technology"


def test_screen_selects_from_universe_not_a_fixed_ticker(market):
    res = screen(market, ScreenConfig(top_n=8))
    assert len(res.selected) <= 8
    assert U.BENCHMARK not in res.selected          # benchmark is a regime gauge, not a holding
    assert all(s in market.close.columns for s in res.selected)
    assert res.table["rank"].iloc[0] == 1
    # table is sorted by score descending
    sc = res.table["score"].dropna().values
    assert np.all(np.diff(sc) <= 1e-12)


def test_sector_cap_respected(market):
    cfg = ScreenConfig(top_n=10, max_per_sector=2)
    res = screen(market, cfg)
    counts = res.selected_table["sector"].value_counts()
    assert counts.max() <= 2


def test_filters_applied(market):
    res = screen(market, ScreenConfig(require_trend=True))
    sel = res.selected_table
    assert sel["trend"].all()
    assert (sel["rsi_14"] <= 80).all()


def test_weights_sum_to_one_and_capped(market):
    res = screen(market, ScreenConfig(top_n=10, max_weight=0.15))
    w = target_weights(res)
    if res.risk_on and res.selected:
        assert abs(sum(w.values()) - 1) < 1e-6
        assert max(w.values()) <= 0.15 + 1e-6


def test_risk_off_goes_to_cash(market):
    res = screen(market, ScreenConfig())
    res.risk_on = False
    assert target_weights(res) == {}


def test_point_in_time_no_lookahead(market):
    d = market.close.index[-120]
    full = screen(market, ScreenConfig(), as_of=d)
    truncated = screen(market.as_of(d), ScreenConfig())
    pd.testing.assert_frame_equal(full.table, truncated.table)


def test_rebalance_orders_sells_first():
    cur = {"AAA": 0.5, "BBB": 0.5}
    tgt = {"BBB": 0.5, "CCC": 0.5}
    o = rebalance_orders(cur, tgt, 10000, {"AAA": 10, "BBB": 20, "CCC": 30})
    assert list(o.side) == ["sell", "buy"]
    assert o.iloc[0].symbol == "AAA" and bool(o.iloc[0].close_position)
    assert o.iloc[1].notional == 5000


def test_backtest_runs_and_builds_state(market):
    bt = run_backtest(market, BacktestConfig(rebalance_every=10, screen=ScreenConfig(top_n=6)))
    assert len(bt.equity) > 100
    assert bt.equity.iloc[0] > 0
    assert "strategy_sharpe" in bt.stats and "benchmark_cagr" in bt.stats
    assert bt.trades["symbol"].nunique() > 6     # it rotated through many names
    res = screen(market, ScreenConfig(top_n=6))
    st = build_state(market, res, target_weights(res), backtest=bt, mode="backtest")
    assert st["universe_size"] == len(market.close.columns)
    assert len(st["rankings"]) == st["universe_size"]
    assert len(st["backtest"]["equity"]["dates"]) == len(st["backtest"]["equity"]["strategy"])
    import json; json.dumps(st)   # must be JSON serialisable
