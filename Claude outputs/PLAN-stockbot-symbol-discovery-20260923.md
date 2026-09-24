# PLAN-stockbot-symbol-discovery-20260923

**Mode:** Plan and do not code. Read-only audit of `~/Documents/GitHub/Stockbot` at `60dd350` (clean tree).
**Owner:** Codex implements after the owner approves; Hermes verifies.

## Goal

Stockbot should find tradeable stocks other than SPY, and a found symbol should reach a backtest or paper session in one click, with no retyping.

## Non-goals (these follow the owner's 2026-08-26 decisions)

- No auto-launch. The flow stays *recommend → owner confirms*.
- No live symbol rotation inside a running session.
- Backtest performance never feeds selection scores. Scores stay tradeability-only.
- No change to `server/experiments/selection.js` scoring weights, except the crypto volatility band in Step 6.

## Current evidence: why it only ever trades SPY

Since the 08-26 audit, the universe pipeline has mostly been built: `alpaca.mostActives()`, `market.selectionUniverse()`, `server/selection/service.js`, the `GET /api/v1/selection` route and `SelectionPage.tsx`. It still finds nothing new, for five reasons:

1. **There are no market-data credentials in this checkout.** No `.env` exists, only `.env.example`. With `ALPACA_API_KEY` empty, `chain.catalog()` returns the 17 hardcoded `LOCAL_ASSETS` and `selectionUniverse()` quietly falls back to them (`fallback: true`). The ranking runs over a fixed shortlist, so no stock outside it can ever be found.
2. **The catalogue gate blocks everything else.** `getBars()` and `getQuote()` throw `UNKNOWN_SYMBOL` for any symbol that is not in `catalog()`. Without Alpaca, typing `CRWD` into a backtest fails even though Polygon or Finnhub could serve the bars.
3. **The selector leads nowhere.** `SelectionPage` shows a table with no action on it. `StrategyDetailPage` hardcodes `useState("SPY")`. `CreateSessionDialog` accepts `initialSymbol`, but only `MarketsPage` passes one. Results have to be copied by hand.
4. **The CLI bypasses the new service.** `scripts/experiment.js selectSymbols()` still ranks `/market/search?q=&limit=50` (the catalogue) instead of calling `/api/v1/selection`. `run --auto` also takes `limit: 1`.
5. **The universe is one list.** Only `most-actives by volume` is used. There are no movers (gainers/losers), no user watchlist and no sector ETF constituents.

Two latent bugs will bite once items 1–3 are fixed:

- **The look-ahead guard is dead code, and its design would do harm if wired up.** `markForwardTestOnly()` adds symbols to a process-global, permanent `Set`. `assertBacktestAllowed()` is never called. If Codex wired it naively, AAPL showing up once in most-actives would block every future AAPL backtest until restart. Forward-test-only is a property of *a selection run*, not of a symbol.
- **Crypto volatility band** (from the 08-26 audit, still open): `band(atrPercent, 2.75, 2.6)` scores crypto near zero on 25% of the weight.

## Decision needed from the owner before Codex starts

**D1: Where do credentials come from?** Either (a) put Alpaca paper keys in the Mac's `.env`, or (b) run Stockbot against the oldlaptop instance that holds the private config. Alpaca's free tier covers the screener and the IEX feed. Without keys, Steps 2–3 still work through Polygon/Finnhub, but no live screen exists.

**D2: Backtestable discovery (Step 7, optional).** Live screens are forward-test-only by design. Historical backtests on discovered names need a point-in-time universe, meaning a screen computed from data *before* the backtest window. Include it now, or defer it?

## Proposed files

| File | Change |
|---|---|
| `server/market/chain.js` | Step 2 catalogue gate; Step 4 universe sources; Step 5 remove global forward-test set |
| `server/market/providers/alpaca.js` | Add `movers({ top })` (`/v1beta1/screener/stocks/movers`) |
| `server/selection/service.js` | Accept `source` values `active`, `movers`, `watchlist`, `blend`; return `selectionRunId` |
| `server/http/routes/selection.js` | Extend `SOURCES`; add `watchlist` GET/PUT |
| `server/db/migrations/*` + repository | `selection_runs` table (id, source, forward_test_only, symbols_json, result_json, created_at); `watchlist` table |
| `src/features/selection/SelectionPage.tsx` | Row checkboxes → **Backtest** / **Paper session** actions |
| `src/features/strategies/StrategyDetailPage.tsx` | Read `?symbol=`; replace the free-text input with a symbol search (`/market/search`) |
| `src/features/sessions/CreateSessionDialog.tsx` | Accept `initialSymbols: string[]` and `selectionRunId` |
| `scripts/experiment.js` | `selectSymbols()` calls `/api/v1/selection`; add `--source` flag |
| `server/experiments/selection.js` | Step 6 only: asset-class volatility band |

## Ordered steps

1. **Credentials check at startup (small).** Log one clear line: `Selection universe: local catalogue (17) – set ALPACA_API_KEY for live screens`. Show the same banner on the Selection page (the `fallback` flag already exists). Do not commit any secrets.
2. **Relax the catalogue gate.** `getBars`/`getQuote` should accept any symbol that matches `SYMBOL_PATTERN` and let the provider chain decide. `UNKNOWN_SYMBOL` becomes "no provider returned data" (404) rather than "not in our list". The catalogue stays for search and autocomplete only.
3. **Close the last mile (the core of this plan).**
   - SelectionPage: add a checkbox per recommended row and two buttons. **Backtest** → `/strategies/:id?symbol=X` via a strategy picker. **Paper session** → opens `CreateSessionDialog` with `initialSymbols=[…]` (max 20, the existing cap) and `selectionRunId`.
   - For a forward-test-only run, disable the Backtest button with the existing warning text. Paper stays enabled.
   - StrategyDetailPage: seed `symbol` from `?symbol=`, falling back to `SPY`.
4. **Broaden the universe.** Sources: `active` (existing), `movers` (gainers + losers, new), `watchlist` (user-saved, backtestable because the owner chose it rather than a live screen), and `blend` (union, dedupe, capped at 100). `auto` = `blend` when Alpaca is configured, otherwise `watchlist ∪ local`.
5. **Replace the global forward-test set.** Persist each selection run to `selection_runs`. Sessions and backtests created from a run carry `selectionRunId`. The backtest route rejects with `FORWARD_TEST_ONLY` only when the referenced run is forward-test-only. A symbol typed by hand is never blocked. Delete `forwardTestOnlySymbols`, `markForwardTestOnly` and `assertBacktestAllowed`.
6. **Crypto volatility band.** Use a separate band center/width per asset class (`isCryptoSymbol`). Only this touches scoring.
7. **(Optional, D2) Point-in-time universe.** `source=pit&asOf=<window start>`: rank the watchlist plus the Alpaca asset list by dollar volume computed only from bars ending before `asOf`. Mark it `forwardTestOnly: false`. Defer if D2 = no.
8. **CLI parity.** `experiment select|run --auto` calls `/api/v1/selection?source=…`, and `--limit` is honoured in `run --auto`.

## Tests (write each failing test first)

- `chain`: `getBars("CRWD")` with only Polygon configured returns bars and does not throw `UNKNOWN_SYMBOL`.
- `chain`: with Alpaca unconfigured, `selectionUniverse({source:"auto"})` returns `fallback: true` **and** includes watchlist symbols.
- `alpaca.movers`: parses both `gainers` and `losers` arrays from the fixture response.
- `selection route`: rejects unknown `source`, persists a `selection_runs` row, and returns `selectionRunId`.
- `backtest route`: a forward-test-only `selectionRunId` → 422; the same symbol with no run id → 200 (a regression test for the global-set bug).
- `selection.js`: BTCUSD at 4.5% ATR scores above zero on the volatility component; a 1.0%-ATR equity scores the same as before.
- Frontend: SelectionPage → Paper session opens the dialog pre-filled with the checked symbols; `/strategies/x?symbol=NVDA` seeds NVDA.
- **Falsifiable fixture** (per the verification rule): the universe includes THIN (illiquid), PENNY (<$1) and SHORT (60 bars). All three must appear under `excluded`, never under `recommended`.

## Acceptance check (Hermes, end to end, not only unit tests)

Using `scripts/dev/integration-server.js` (the injected market), plus one real run with Alpaca keys if D1 = (a):

1. Open Selection, choose Auto, click Rank. At least one symbol outside `LOCAL_ASSETS` appears in Recommended.
2. Tick two of them, then Paper session. The session is created with those symbols and `selectionRunId`.
3. Backtest is disabled for that run. A manual backtest of the same symbol from Strategy detail succeeds.
4. `npm run experiment -- select --source blend --limit 5` returns the same top 5 as the UI for the same window.

## Risks

- **Survivorship and look-ahead bias:** mitigated by run-scoped forward-test flags; Step 7 is the proper fix.
- **Provider rate limits:** blend with 100 symbols × bars fetch. The existing `concurrency: 4` and the 5-minute universe cache help. Rate limiting (plan phase 5) is still unbuilt, so watch Polygon's free-tier 5 req/min.
- **Relaxing the catalogue gate** lets typos reach providers. The provider-chain error is now the user-facing message, so check it reads clearly.
- **IEX feed** volume is a fraction of SIP. Liquidity gates may reject names that are actually liquid. Consider scaling the ADV threshold when `stockFeed === "iex"`.

## Rollback

Each step is its own commit. Steps 1–3 need no schema change and revert cleanly. Steps 4–5 add two tables through a forward migration; to roll back, revert the code and leave the tables unused (nothing else reads them).

## Review findings carried over

- `research_documents` has no symbol column. Research coverage must JOIN through `research_runs`. This is still relevant if `getResearch` is wired later, and is out of scope here.
- `providers/polygon.js` hardcodes `api.polygon.io`, and Polygon rebranded as Massive. Verify the base URL before Step 2 relies on Polygon as the fallback.
