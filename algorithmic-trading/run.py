#!/usr/bin/env python3
"""Command-line entry point for the active stock-selection system.

    python run.py screen     [--source yfinance|cache|synthetic] [--top 10]
    python run.py backtest   [--source ...] [--years 3] [--rebalance 5]
    python run.py paper      [--live-orders]        # Alpaca paper account
    python run.py dashboard  [--port 8765]          # web UI
    python run.py universe-sp500                    # pull full S&P 500 list

Every command refreshes output/state.json, which the dashboard reads.
"""
from __future__ import annotations

import argparse
import sys

import pandas as pd

from trader import universe as U
from trader.allocator import target_weights
from trader.backtest import BacktestConfig, run_backtest
from trader.data import load_market
from trader.screener import ScreenConfig, screen
from trader.state import build_state, write_state


def _common(p: argparse.ArgumentParser):
    p.add_argument("--source", default="yfinance", choices=["yfinance", "cache", "synthetic"])
    p.add_argument("--years", type=float, default=3.0)
    p.add_argument("--top", type=int, default=10, help="positions to hold")
    p.add_argument("--weighting", default="inverse_vol", choices=["inverse_vol", "equal"])
    p.add_argument("--no-trend-filter", action="store_true")
    p.add_argument("--seed", type=int, default=42, help="synthetic market seed")


def _screen_cfg(a) -> ScreenConfig:
    return ScreenConfig(top_n=a.top, weighting=a.weighting, require_trend=not a.no_trend_filter)


def print_screen(res, targets):
    pd.set_option("display.width", 160)
    r = res.regime
    print(f"\nAs of {res.as_of.date()}  |  universe {len(res.table)}  |  passing filters {int(res.table.passes.sum())}")
    print(f"Regime: {r['benchmark']} {r['close']:.2f} vs {res.config.regime_sma}d SMA {r['sma']:.2f} "
          f"-> {'RISK ON' if res.risk_on else 'RISK OFF (cash)'}")
    cols = ["rank", "sector", "price", "score", "mom_12_1", "mom_6m", "mom_3m", "vol_20", "rsi_14", "passes"]
    print("\nTop 20 by composite score:")
    print(res.table[cols].head(20).round(3).to_string())
    print("\nSelected -> target weights:")
    if not targets:
        print("  (none: risk-off or nothing passed)")
    for s, w in sorted(targets.items(), key=lambda kv: -kv[1]):
        print(f"  {s:6} {w:6.2%}  {U.sector_of(s)}")
    print(f"  {'CASH':6} {1 - sum(targets.values()):6.2%}")


def cmd_screen(a):
    market = load_market(source=a.source, years=a.years, seed=a.seed)
    res = screen(market, _screen_cfg(a))
    targets = target_weights(res)
    print_screen(res, targets)
    path = write_state(build_state(market, res, targets, mode="screen"))
    print(f"\n[data source: {market.source}]  state -> {path}")


def cmd_backtest(a):
    market = load_market(source=a.source, years=a.years, seed=a.seed)
    cfg = BacktestConfig(rebalance_every=a.rebalance, trailing_stop=a.stop, screen=_screen_cfg(a))
    bt = run_backtest(market, cfg)
    s = bt.stats
    print(f"\nBacktest {s['start']} -> {s['end']}  ({market.source})")
    print(f"{'':22}{'strategy':>12}{'benchmark':>12}")
    for k in ["total_return", "cagr", "vol", "sharpe", "max_drawdown"]:
        fmt = "{:>12.2f}" if k == "sharpe" else "{:>12.2%}"
        print(f"{k:22}" + fmt.format(s[f'strategy_{k}']) + fmt.format(s[f'benchmark_{k}']))
    print(f"trades {s['trades']}  closed {s['closed_trades']}  win rate {s['win_rate']:.1%}")
    res = screen(market, cfg.screen)
    targets = target_weights(res)
    print_screen(res, targets)
    path = write_state(build_state(market, res, targets, backtest=bt, mode="backtest"))
    bt.trades.to_csv("output/backtest_trades.csv", index=False)
    bt.equity.to_frame().join(bt.benchmark).to_csv("output/backtest_equity.csv")
    print(f"\nstate -> {path}; trades -> output/backtest_trades.csv")


def cmd_paper(a):
    from trader.broker_alpaca import AlpacaPaperBroker
    market = load_market(source=a.source, years=a.years, seed=a.seed)
    res = screen(market, _screen_cfg(a))
    targets = target_weights(res)
    print_screen(res, targets)
    broker = AlpacaPaperBroker(paper=True)
    acct = broker.account()
    print(f"\nAlpaca paper account: equity {acct['equity']:,.2f}  cash {acct['cash']:,.2f}")
    prices = market.close.iloc[-1].to_dict()
    dry = not a.live_orders
    orders = broker.rebalance(targets, prices, dry_run=dry)
    print("\nOrders" + (" (dry run; add --live-orders to submit to the paper account)" if dry else " submitted:"))
    print(orders.to_string() if not orders.empty else "  nothing to do")
    pos = broker.positions()
    acct["positions"] = pos.to_dict(orient="records")
    path = write_state(build_state(market, res, targets, account=acct,
                                   orders=orders.to_dict(orient="records"), mode="paper"))
    print(f"\nstate -> {path}")


def cmd_dashboard(a):
    from dashboard.server import serve
    serve(port=a.port, open_browser=not a.no_browser)


def cmd_universe(a):
    uni = U.load_sp500(save=True)
    print(f"saved {len(uni)} symbols to {U.UNIVERSE_FILE}")


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("screen", help="rank the universe and show target weights"); _common(s); s.set_defaults(fn=cmd_screen)
    b = sub.add_parser("backtest", help="walk-forward backtest"); _common(b)
    b.add_argument("--rebalance", type=int, default=5, help="trading days between rebalances")
    b.add_argument("--stop", type=float, default=0.15, help="trailing stop (0 disables)")
    b.set_defaults(fn=cmd_backtest)
    pp = sub.add_parser("paper", help="rebalance the Alpaca paper account"); _common(pp)
    pp.add_argument("--live-orders", action="store_true", help="actually submit orders (default: dry run)")
    pp.set_defaults(fn=cmd_paper)
    d = sub.add_parser("dashboard", help="serve the web UI")
    d.add_argument("--port", type=int, default=8765); d.add_argument("--no-browser", action="store_true")
    d.set_defaults(fn=cmd_dashboard)
    u = sub.add_parser("universe-sp500", help="download S&P 500 constituents into data/universe.csv")
    u.set_defaults(fn=cmd_universe)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
