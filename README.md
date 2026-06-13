# Stockbot

Stockbot is a local-first paper trading dashboard for exploring stock ideas before wiring in real broker execution. The first screen is a strategy cockpit with market search, movers, tabbed multi-stock charts, candlesticks, zoom controls, holdings, portfolio stats, strategy comparisons, and a single failsafe exit.

## What is included

- React + TypeScript + Vite frontend
- Express API for market data, portfolio state, and simulated paper orders
- Local paper-money account starting at `$100,000`
- Candlestick charts with thin precision strokes and mini charts for open stock tabs
- Spreadsheet-style methods matrix for strategy/control winners and losers
- Failsafe liquidation endpoint for pulling out of all simulated positions
- `src/strategy` for Stockbot's strategy logic
- `src/control` for baseline strategy comparisons
- Alpaca-ready environment variables kept on the server side

## Run

```bash
npm install
npm run dev
```

Then open `http://localhost:5173`.

## Alpaca mode

The current backend uses a local simulator by default. Add paper/data keys to `.env` when you are ready to connect server-side Alpaca market data and the full Alpaca asset universe:

```bash
cp .env.example .env
```

Paper order routing is intentionally not enabled in this first base dashboard. The API boundary is in place so it can be added without exposing credentials to the browser.

When `ALPACA_API_KEY` and `ALPACA_API_SECRET` are present, search loads active US equity and crypto assets from Alpaca's `/v2/assets` endpoint and caches them on the server. Without keys, Stockbot falls back to the local demo universe.

You can also open **Settings** in the dashboard to save local Alpaca/OpenAI credentials. Stockbot writes those values to `.env`, which is ignored by git, while `.env.example` documents the fields for anyone cloning the project.

Stockbot Momentum backtests use real historical bars only. The server tries Alpaca first, then Polygon, then Finnhub. If no provider can supply historical bars, the dashboard reports that historical data is unavailable and does not invent buy/sell markers.

All charts render real market bars. Every chart range (1H through ALL) is served by `GET /api/market/bars/:symbol?range=`, which pulls real historical bars from Alpaca, then Polygon, then Finnhub, with a short server-side cache (60s intraday, 5 min for longer ranges). Mini tab charts use real 1D bars, and chart diagnostics (RSI, EMA, VWAP, ATR) are computed from those real bars. If no provider can supply bars for a symbol, the chart shows an explicit "unavailable" state instead of synthetic data.
