# Sentiment pack

Two research plans that read recent news, disclosure, and public social posts, plus a matched strategy/control pair that measures whether any of it is worth anything.

The pack is built around one comparison:

```
Sentiment-Gated Momentum  −  Control: Sentiment Blind  =  what the research is actually worth
```

Both files run byte-identical EMA(9/21) technical rules. The only difference is that one consults an archived research snapshot before entering and the other never looks. Nothing else in Stockbot isolates the value of the research pipeline.

## Twitter/X is not reachable, and what replaces it

X requires paid API authentication. `web.page.v1` forbids credential-bearing query keys by schema, cannot send custom headers, and always identifies itself as `StockbotResearch/1.0`. There is no configuration of this pipeline that reads X, and scraping x.com would violate its terms regardless. It joins SAM.gov and FPDS in [Research sources](./RESEARCH_SOURCES.md) as a documented dead end.

Three sources take its place:

| Source id | Origin | Status | Notes |
|---|---|---|---|
| `bluesky` | `https://public.api.bsky.app` | **Ready** | `app.bsky.feed.searchPosts` on the public AppView. No API key, no auth token, GET, returns JSON. The only true Twitter-shaped source that works under these constraints. |
| `stocktwits` | `https://api.stocktwits.com` | Verify | `/api/2/streams/symbol/{SYMBOL}.json` — purpose-built cashtag streams, closer to trading intent than general social. Access has been tightening; expect the probe to tell you. |
| `reddit` | `https://www.reddit.com` | Verify | `/r/{sub}/search.json` — GET and JSON, but Reddit blocks many non-authenticated clients by User-Agent. Register `www.reddit.com`, not `reddit.com`, or the cross-host redirect fails closed. |

Add them to your protected env alongside the existing sources:

```dotenv
RESEARCH_WEB_SOURCES_JSON='{"sec-edgar":"https://www.sec.gov","sec-edgar-fts":"https://efts.sec.gov","dod-contracts":"https://www.war.gov","usaspending":"https://api.usaspending.gov","nasdaq-news":"https://www.nasdaq.com","finviz":"https://finviz.com","bluesky":"https://public.api.bsky.app","stocktwits":"https://api.stocktwits.com","reddit":"https://www.reddit.com"}'
```

Then restart and confirm before importing anything:

```bash
npm run research:probe -- --symbol NVDA --env-file "$HOME/.config/stockbot/stockbot.env"
```

Two of these three are marked "verify" for a reason. Run the probe rather than assuming.

## The plans

**`social-sentiment.json`** — five social reads (Bluesky cashtag, Bluesky mentions, StockTwits stream, r/stocks, r/wallstreetbets) into one summary. Snapshot lifetime 4 hours, because social sentiment decays faster than anything else in the pipeline.

**`news-social-analysis.json`** — the trade-analysis plan, and the one intended for session pinning: Nasdaq headlines, the issuer's latest 8-K index, Bluesky, StockTwits, and r/wallstreetbets into a single summary. Lifetime 6 hours.

Run the single-source plan when you want to know *where* a signal came from; pin the composite when you want the strategy to act on all of it.

```bash
ENVFILE="$HOME/.config/stockbot/stockbot.env"
npm run research -- validate --file research-plans/news-social-analysis.json --env-file "$ENVFILE"
npm run research -- import   --file research-plans/news-social-analysis.json --env-file "$ENVFILE"
npm run research -- run --plan news-social-analysis --symbol NVDA --env-file "$ENVFILE"
```

### Social text is the most dangerous input here

Anyone can post anything on these platforms, including text engineered to manipulate a model reading it. The existing protections still hold — the fixed `market-summary.v1` prompt instructs the model to treat documents as untrusted evidence, the response schema has no action, quantity, or price field, and only reviewed strategy code converts a summary into a signal that still passes through normal risk and next-bar fill handling.

That bounds the blast radius. It does not make the *signal* trustworthy. A coordinated pump on a low-float name looks exactly like genuine enthusiasm to a summarizer, and unlike a filing or a contract award there is no primary source behind it. Weight this pack accordingly against the disclosure and procurement plans.

## The strategy and its control

**`sentiment-gated-momentum.js`** — EMA(9/21) cross entry, permitted only when a snapshot is available, `sentiment` is bullish, and `confidence >= minConfidence` (default 0.6). Set `allowMixed: 1` to also accept `mixed`.

**Exits are deliberately ungated.** Once long, the position leaves on the cross-down or the stop whether or not research is available. Gating exits on research would let a fetch failure trap capital in a losing trade — a data-availability bug wearing a strategy costume.

**`control-sentiment-blind.js`** — the same technical rules with the gate removed entirely.

Verified behaviour on 400 synthetic bars where the blind control took 19 trades:

| Research scenario | Gated trades |
|---|---:|
| No plan pinned | 0 |
| Always bullish, confidence 0.9 | 19 — identical to blind |
| Always bearish, confidence 0.9 | 0 |
| Bullish but confidence 0.3 | 0 |
| Bullish only after bar 200 | 11 |

The second row is the important one: with research that is always available and always passing, the gated variant reproduces the blind control *exactly*. That means the gate is the only difference between them, which is what makes the subtraction valid. A separate case confirms that positions opened before a snapshot expires can still exit afterwards.

## Reading the comparison

Run both over the same symbol, window, and fill model. Three outcomes, and only one is good news:

| Result | Meaning |
|---|---|
| **gated > blind** | The gate filtered out losing entries. Verify against the horizon controls before believing it — a filter that merely reduces exposure looks like alpha on a symbol that fell. |
| **gated ≈ blind** | The research changed nothing. It is cost, not signal. |
| **gated < blind** | The gate removed winning entries. Common and worth knowing: sentiment often peaks *after* the move it describes. |

### The coverage trap

Research snapshots exist only where a `run` succeeded. Backtests read archived snapshots and never rerun a scraper to backfill history — a plan imported today produces nothing for a window last year, and that is correct behaviour, not a gap to work around.

So if your plan only started producing snapshots last month, the gated variant sits flat for the rest of the window and "loses" for reasons that have nothing to do with sentiment. **Compare over the covered range only**, or you are measuring your scraper's uptime.

Build coverage first. Schedule `npm run research -- run` from launchd or cron against the symbols you care about, let it accumulate, then compare. Never put a scheduler command inside a plan — the schema has no field for it, by design.

## What this pack does not prove

Beating the blind control is necessary, not sufficient. The full procedure in [Control group](./CONTROL_GROUP.md) still applies: exposure-match it, build a null distribution with the horizon controls, and repeat on several unrelated symbols. A sentiment gate that wins on one ticker over one window has told you about that ticker and that window.
