"""Alpaca paper-trading adapter (alpaca-py).

Credentials come from the environment variables ``APCA_API_KEY_ID`` /
``APCA_API_SECRET_KEY`` (``config.py`` reads the same variables).  Paper trading only unless you
change ``paper`` yourself.
"""
from __future__ import annotations

import os
from typing import Dict, List, Optional

import pandas as pd

from .allocator import rebalance_orders


def _credentials():
    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
    if not (key and secret):
        try:
            import config  # this folder's config.py, which reads the environment
            key = key or config.ALPACA_CONFIG.get("API_KEY") or config.API_KEY
            secret = secret or config.ALPACA_CONFIG.get("API_SECRET") or config.SECRET_KEY
        except Exception:
            pass
    if not (key and secret):
        raise RuntimeError("Alpaca keys missing: export APCA_API_KEY_ID and APCA_API_SECRET_KEY")
    return key, secret


class AlpacaPaperBroker:
    def __init__(self, paper: bool = True):
        from alpaca.trading.client import TradingClient
        key, secret = _credentials()
        self.client = TradingClient(key, secret, paper=paper)
        self.paper = paper

    # ------------------------------------------------------------------ #
    def account(self) -> dict:
        a = self.client.get_account()
        return {"equity": float(a.equity), "cash": float(a.cash), "buying_power": float(a.buying_power),
                "portfolio_value": float(a.portfolio_value), "status": str(a.status),
                "paper": self.paper, "account_number": str(a.account_number)[-4:].rjust(8, "*")}

    def positions(self) -> pd.DataFrame:
        rows = []
        for p in self.client.get_all_positions():
            rows.append({"symbol": p.symbol, "qty": float(p.qty), "market_value": float(p.market_value),
                         "avg_entry": float(p.avg_entry_price), "current_price": float(p.current_price),
                         "unrealized_pl": float(p.unrealized_pl), "unrealized_plpc": float(p.unrealized_plpc)})
        return pd.DataFrame(rows, columns=["symbol", "qty", "market_value", "avg_entry", "current_price",
                                           "unrealized_pl", "unrealized_plpc"])

    def current_weights(self) -> Dict[str, float]:
        acct = self.account()
        pos = self.positions()
        if pos.empty:
            return {}
        return {r.symbol: r.market_value / acct["equity"] for r in pos.itertuples()}

    def market_open(self) -> bool:
        return bool(self.client.get_clock().is_open)

    # ------------------------------------------------------------------ #
    def rebalance(self, targets: Dict[str, float], prices: Dict[str, float],
                  dry_run: bool = True, band: float = 0.01) -> pd.DataFrame:
        """Trade the paper account to ``targets`` (weights).  Returns the order table."""
        from alpaca.trading.enums import OrderSide, TimeInForce
        from alpaca.trading.requests import MarketOrderRequest

        acct = self.account()
        orders = rebalance_orders(self.current_weights(), targets, acct["equity"], prices, band=band)
        orders["status"] = "dry_run" if dry_run else "pending"
        orders["order_id"] = None
        if dry_run or orders.empty:
            return orders
        for i, o in orders.iterrows():
            try:
                if o.close_position:
                    resp = self.client.close_position(o.symbol)
                else:
                    req = MarketOrderRequest(symbol=o.symbol, notional=round(float(o.notional), 2),
                                             side=OrderSide.BUY if o.side == "buy" else OrderSide.SELL,
                                             time_in_force=TimeInForce.DAY)
                    resp = self.client.submit_order(req)
                orders.at[i, "status"] = str(getattr(resp, "status", "submitted"))
                orders.at[i, "order_id"] = str(getattr(resp, "id", ""))
            except Exception as exc:  # keep going; report per order
                orders.at[i, "status"] = f"error: {exc}"
        return orders
