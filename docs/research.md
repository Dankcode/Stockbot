# Research Notes

Sources checked on 2026-06-05:

- Alpaca's paper trading docs: paper accounts use a separate API key and the paper base URL is `https://paper-api.alpaca.markets`.
- Alpaca GitHub organization: official SDK and CLI repositories are active, including updated trade API clients.
- TradeSight: a recent self-hosted strategy lab with paper trading, indicators, and a local web dashboard.
- OpenAlgo: a recent full-stack trading platform with React surfaces, sandbox trading, and strategy tooling.

Implementation decision:

- Keep Stockbot local-first for the base rebuild.
- Use a server-side broker adapter boundary so credentials never live in frontend code.
- Reserve `src/strategy` for Stockbot-owned strategy code and `src/control` for comparison baselines.
