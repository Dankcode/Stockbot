"""Lumibot version of the rotation strategy (optional adapter).

Uses the same screener/allocator as ``run.py`` so the stock-selection logic is
identical; Lumibot only supplies prices and executes orders.  Requires
``pip install lumibot`` (not available on every Python version).
"""
from datetime import datetime

import pandas as pd

from config import ALPACA_CONFIG
from trader import universe as U
from trader.allocator import target_weights
from trader.data import Market
from trader.screener import ScreenConfig, screen

try:
    from lumibot.backtesting import YahooDataBacktesting
    from lumibot.brokers import Alpaca
    from lumibot.strategies import Strategy
    from lumibot.traders import Trader
except ImportError as exc:  # pragma: no cover
    raise SystemExit("lumibot is not installed; use `python run.py paper` instead") from exc


class Rotation(Strategy):
    parameters = {"top_n": 10, "lookback_days": 300, "rebalance_days": 5}

    def initialize(self):
        self.sleeptime = "1D"
        self.days_since = 10**6
        self.cfg = ScreenConfig(top_n=self.parameters["top_n"])

    def _market(self) -> Market:
        closes, vols = {}, {}
        for sym in U.symbols():
            bars = self.get_historical_prices(sym, self.parameters["lookback_days"], "day")
            if bars is None or bars.df.empty:
                continue
            df = bars.df
            closes[sym], vols[sym] = df["close"], df["volume"]
        close = pd.DataFrame(closes).ffill()
        close.index = pd.to_datetime(close.index).tz_localize(None)
        vol = pd.DataFrame(vols).reindex(close.index).fillna(0)
        vol.index = close.index
        return Market(close, vol, "lumibot")

    def on_trading_iteration(self):
        self.days_since += 1
        if self.days_since < self.parameters["rebalance_days"]:
            return
        self.days_since = 0
        market = self._market()
        res = screen(market, self.cfg)
        targets = target_weights(res)
        self.log_message(f"regime risk_on={res.risk_on} selected={res.selected}")
        value = self.portfolio_value
        held = {p.symbol: p for p in self.get_positions() if p.symbol != "USD"}
        for sym, pos in held.items():                       # rotate out
            if sym not in targets and pos.quantity:
                self.submit_order(self.create_order(sym, pos.quantity, "sell"))
        for sym, w in targets.items():                      # rotate in / resize
            price = self.get_last_price(sym)
            if not price:
                continue
            target_qty = int(w * value / price)
            cur_qty = int(held[sym].quantity) if sym in held else 0
            diff = target_qty - cur_qty
            if abs(diff * price) > 0.02 * value:
                self.submit_order(self.create_order(sym, abs(diff), "buy" if diff > 0 else "sell"))


if __name__ == "__main__":
    trade = False
    if trade:
        broker = Alpaca(ALPACA_CONFIG)
        trader = Trader()
        trader.add_strategy(Rotation(broker=broker))
        trader.run_all()
    else:
        Rotation.backtest(YahooDataBacktesting, datetime(2023, 1, 1), datetime(2024, 12, 31))
