# stockbot.plugin.v1

A shareable JSON format for trading methods, their controls, and the research they depend on. One file, no JavaScript, no credentials, no commands.

```bash
npm run plugin -- list
npm run plugin -- inspect --plugin horizon-pack
npm run plugin -- requirements --env-file "$HOME/.config/stockbot/stockbot.env"
npm run plugin -- validate --file plugins/mine.plugin.json
```

## Why a plugin contains no code

The existing `.js` algorithm path runs real JavaScript in a worker with a capability gate over `import`, `process`, `eval`, and friends. Its own documentation is honest that this is "not a formal security boundary for malicious JavaScript" and tells you to review code from other people before uploading it.

That advice is workable when you write your own strategies. It does not survive a world where people **trade methods with each other**, which is what this format is for. Nobody reads 400 lines of someone else's JavaScript before clicking install.

So a plugin is data. A method is a frozen tree of operators walked by an interpreter (`server/plugins/expression.js`) with a closed operator set, a 4,000-node evaluation budget, and a 64-level nesting cap. There is no `eval`, no `new Function`, no dynamic import, and no string is ever compiled. **The worst a malicious method can do is return a wrong number.** That is a stronger guarantee than the sandbox provides, not a weaker one.

The interpreter is also pure: every operator is a function of the evaluation context, and randomness arrives as a per-bar draw from a seeded PRNG rather than being generated inside. Stockbot caches backtests by algorithm version, params, symbol, window, bar hash, and fill model, so a method that consulted the clock would make cached and fresh runs disagree. The format makes that impossible rather than merely discouraged.

## Anatomy

```jsonc
{
  "kind": "stockbot.plugin.v1",
  "schemaVersion": 1,
  "id": "my-pack",
  "name": "My pack",
  "version": "1.0.0",
  "license": "MIT",

  // Declared first, before anything substantive: what the operator must already have.
  "requires": {
    "capabilities": ["backtest", "research.web", "research.ai", "cli"],
    "sources": ["bluesky", "sec-edgar"],
    "secrets": ["OPENAI_API_KEY"],
    "promptTemplates": ["social-sentiment.v1"],
    "aiCli": true,
    "notes": "Free-text guidance shown at install."
  },

  "methods":  [ /* trading rules + controls */ ],
  "research": [ /* scrape + summarize plans  */ ],
  "cli":      { "skills": [ /* gather recipes */ ] },
  "pairings": [ /* every strategy names its controls */ ]
}
```

## `requires`: declare, never supply

This is the security model in one sentence: **a plugin states what it needs; the operator supplies it.**

| Field | What the plugin says | What it can never say |
|---|---|---|
| `sources` | `"bluesky"` | the URL that id maps to |
| `secrets` | `"OPENAI_API_KEY"` | the key's value |
| `aiCli` | `true` | the command, its path, or its argv |
| `promptTemplates` | `"social-sentiment.v1"` | the instruction text |

The schema enforces this rather than trusting it. `secrets` entries must match `^[A-Z][A-Z0-9_]{2,63}$` and are additionally rejected if they look like credential material. A research step may only read a source listed in `requires.sources`, so the manifest cannot drift from what the plugin actually does. Query keys matching `api_key`, `token`, `secret`, `authorization` and similar are rejected outright.

Requirements resolve **at install**, loudly:

```
News and social sentiment (sentiment-pack@1.0.0)
  capabilities   backtest, research.web, research.ai, cli
  sources        bluesky, stocktwits, reddit, nasdaq-news, sec-edgar
  secrets        OPENAI_API_KEY (names only)
  status         7 unmet requirement(s)
    ! Research source "bluesky" is not registered.
      Add "bluesky" to RESEARCH_WEB_SOURCES_JSON in the protected env, restart Stockbot,
      then run npm run research:probe. See docs/RESEARCH_SOURCES.md for the origin and
      its authorization status.
    ! This plugin summarizes research, but no AI CLI is configured.
      Set AI_CLI_COMMAND to an absolute path for a reviewed JSON-in/JSON-out summarizer,
      then restart. Stockbot never selects or downloads that executable, and a plugin
      cannot name it.
```

Every unmet requirement carries a remedy. Without this, a plugin whose Bluesky source is unregistered installs cleanly, pins to a session, and silently produces no snapshots — which surfaces weeks later as a research-gated strategy that mysteriously never trades.

## `methods`: rules as data

```jsonc
{
  "id": "weekly-ema",
  "name": "EMA Momentum — Weekly",
  "role": "strategy",
  "horizon": "weekly",
  "params": { "fast": 9, "slow": 21, "stopLossPercent": 8 },
  "method": {
    "kind": "rules.v1",
    "warmup": { "param": "slow" },
    "indicators": {
      "fast": { "fn": "ema", "period": { "param": "fast" } },
      "slow": { "fn": "ema", "period": { "param": "slow" } }
    },
    "entry": [
      { "when": { "crossesAbove": ["fast", "slow"] }, "reason": "Fast EMA crossed above slow EMA" }
    ],
    "exit": [
      { "when": { "lte": [{ "bar": "close" },
                          { "mul": [{ "position": "entryPrice" },
                                    { "sub": [1, { "div": [{ "param": "stopLossPercent" }, 100] }] }] }] },
        "reason": "Protective stop" },
      { "when": { "crossesBelow": ["fast", "slow"] }, "reason": "Fast EMA crossed below slow EMA" }
    ]
  }
}
```

Per bar: return early below `warmup`, advance the seeded PRNG once, then evaluate `exit` rules if long or `entry` rules if flat, first match wins, applying that rule's `set` assignments. Identical to how the hand-written strategies behaved — which is checked, not assumed (see Verification below).

### Expression reference

| Category | Operators |
|---|---|
| References | `param`, `const`, `state`, `bar`, `position`, `series`, `var`, `research`, `value` |
| Arithmetic | `add` `sub` `mul` `div` `mod` `pow` `min` `max` `abs` `neg` `floor` `ceil` `round` `trunc` |
| Comparison | `eq` `ne` `lt` `lte` `gt` `gte` |
| Logic | `and` `or` `not` `if` |
| Series | `crossesAbove`, `crossesBelow` |
| Tables | `lookup` |

A bare string is shorthand for a series reference: `"fast"` means `{"series": "fast"}`. Use `{"value": "bullish"}` for a string literal — this distinction matters, and forgetting it is the most common authoring mistake.

`bar` accepts `open high low close volume time`; `position` accepts `qty entryPrice entryIndex`; `var` accepts `index barCount barsSinceEntry random`; `research` accepts `available sentiment confidence snapshotId ageMs`.

Blocks evaluated at init (`derived`, `state`, `warmup`, `seed`, indicator periods) cannot reference series, bars, or position — there is no bar history yet, and the static validator rejects it rather than letting it throw mid-run.

**Lookahead is structurally impossible.** `series` offsets are always subtracted, never added, and reading before the window start yields `NaN`. There is no operator that reaches forward.

**NaN comparisons return `false` rather than throwing.** An indicator inside its warmup window is legitimately undefined, and a rule referencing it should simply not fire — matching how the hand-written strategies behave.

### Randomness

A method that reads `{"var": "random"}` **must** declare a `seed`, and one that declares a `seed` must read randomness. Both directions are enforced at install. A seedless draw would silently corrupt the result cache; an unused seed means the author misunderstood something.

The PRNG is SplitMix32 over a monotonic counter, advanced exactly once per evaluated bar — before any rule can branch on it, and after the warmup guard. That ordering is why a control's draw sequence depends only on the seed and bar index rather than on the path the strategy took, and it is why the JSON controls reproduce their `.js` ancestors exactly.

## `pairings`: every strategy ships its controls

```jsonc
{
  "strategy": "monthly-ema",
  "controls": ["horizon-fixed", "horizon-random", "core-controls/buy-and-hold"],
  "controlParams": {
    "horizon-fixed":  { "horizon": "monthly" },
    "horizon-random": { "horizon": "monthly" }
  },
  "seeds": 20,
  "notes": "Both controls must run with horizon=\"monthly\"."
}
```

**A `role: "strategy"` method with no pairing fails validation.** This is the one opinionated constraint in the format, and it is deliberate: a shared trading method that arrives without its null hypothesis is a marketing claim, not a result. See [Control group](./CONTROL_GROUP.md).

`controlParams` is what stops a monthly strategy being compared against a daily control — a comparison that measures turnover and slippage rather than skill. `expandPairing()` in `server/plugins/algorithm-bridge.js` turns a pairing into concrete run specs with those params applied and seeded controls expanded across `seeds`, so the operator never hand-copies parameters.

Controls may be referenced across plugins as `"<pluginId>/<methodId>"`, which is how a strategy pack reuses `core-controls` instead of shipping a near-copy.

## `research` and prompts

Research entries lower to canonical `ResearchPlanV1` documents (`server/plugins/compile-research.js`), so origin pinning, immutable snapshots, session pinning, and point-in-time selection all work unchanged. A plugin gains no reach a hand-written plan did not have.

The one real addition is the prompt. Instead of the single hardcoded instruction set, a plugin picks a **registered template** and fills **typed slots**:

```jsonc
{
  "id": "social-summary",
  "kind": "summarize",
  "dependsOn": ["bluesky-cashtag", "reddit-wsb"],
  "template": "social-sentiment.v1",
  "slots": {
    "horizon": "weekly",
    "emphasis": "balanced",
    "audience": "systematic",
    "avoid": ["price target screenshots", "unsourced rumour"]
  }
}
```

| Template | Slots | Tuned for |
|---|---|---|
| `market-summary.v1` | none | The original fixed template |
| `market-summary.focused.v1` | focus, avoid, sector, horizon, emphasis, audience | General research |
| `catalyst-summary.v1` | focus, sector, horizon, emphasis | Filings and contract awards — separates occurred from anticipated, preserves figures verbatim |
| `social-sentiment.v1` | focus, avoid, sector, horizon, emphasis, audience | Social — explicitly discounts coordinated agreement and repeated phrasing |

**The server owns every sentence the model reads.** A plugin cannot supply instruction text, because the documents these prompts wrap are scraped from news pages, Reddit, and Bluesky — written by people who may be actively trying to manipulate a model reading them. If a shared plugin could rewrite the instructions, a plugin author and a forum poster would have the same authority over the summarizer.

Slot values are the only plugin-authored strings that reach the model, and they are neutralised first: newlines collapsed so a slot cannot fake a new instruction block, and `<>{}|\`` stripped so it cannot imitate a role delimiter. A slot ends up as a noun phrase inside a server-written sentence. The base rules — untrusted-evidence framing and the prohibition on emitting orders — are always rendered **last**.

`market-summary.v1` renders byte-identical instructions to the pre-plugin pipeline, and a test asserts the hash still matches `MARKET_SUMMARY_PROMPT_HASH`. This is not cosmetic: `promptHash` is stored on every snapshot in SQL, and changing a character would make archived research stop reconciling against the template that produced it.

## `cli.skills`: gather recipes

```bash
npm run plugin -- skill list
npm run plugin -- skill run --skill sentiment-pack/daily-sentiment-sweep --symbol NVDA
```

A skill names research plans from the same plugin, runs them in order, and reports which produced a snapshot:

```jsonc
{
  "id": "daily-sentiment-sweep",
  "name": "Daily sentiment sweep",
  "gather": ["news-social", "social"],
  "suggestedCadence": "daily",
  "minSnapshots": 1
}
```

`skill run` checks the plugin's requirements first and refuses with the full remedy report if anything is unmet, so a skill cannot half-run against a missing source. It drives the existing loopback research API; it never executes anything a plugin names, because **a plugin cannot name an executable** — the format has no field for one.

`suggestedCadence` is advisory. Stockbot never schedules from plugin data; schedule the CLI command from launchd or cron. This mirrors the rule already stated for research plans, for the same reason.

Skills are how you build the coverage a research-gated strategy needs. Backtests read only archived snapshots and never rerun a scraper to backfill history, so comparing gated against blind before you have coverage measures your scraper's uptime rather than the value of sentiment.

## Shipped plugins

| Plugin | Contents | Needs |
|---|---|---|
| `core-controls` | buy-and-hold, fixed-interval, random-entry | nothing |
| `base-methods` | EMA momentum, RSI mean reversion, Donchian breakout | nothing |
| `horizon-pack` | 12 strategies × 4 horizons + 2 band-matched controls | nothing |
| `sentiment-pack` | gated/blind pair, 2 research plans, 2 CLI skills | 5 sources, AI CLI, `OPENAI_API_KEY` |
| `gov-research` | EDGAR + federal contracts plans, 1 CLI skill | 4 sources, AI CLI |

## Verification

Every JSON method was checked against the `.js` original it replaces, over 39 configurations covering all four horizons, three methods, multiple seeds, and multiple parameter sets. The comparison is a fingerprint of **every trade** — side, signal index, fill index, price, quantity — plus the full metrics object:

```
=== JSON method vs .js original: trade-for-trade equivalence ===
  39/39 JSON methods reproduce their .js original trade-for-trade
```

The research-aware method is checked against a synthetic snapshot timeline across six availability scenarios, including the one that proves the gate is the only difference: with always-available bullish research the gated variant reproduces the blind control exactly, 19 trades to 19.

Two bugs were caught this way and are worth knowing about if you extend the interpreter:

**Indicator series must be re-fetched every bar.** The engine hands `signal` a facade whose arrays are truncated to the current index. Caching the array returned on the first call froze every indicator at two elements and made every rule read `NaN` — every indicator-based method silently took zero trades. Periods resolve once at init; the series are bound per bar.

**Nesting depth needs its own cap.** A ~5,000-level nested expression exhausted the native call stack with an unrecoverable `RangeError` before the node budget was ever consulted. A crash is a worse failure than a rejection, and in a format designed to be downloaded from strangers it is a denial-of-service primitive. Depth is now capped at 64 in both the evaluator and the static walk.

Malformed plugins are rejected at install with a path. Verified rejections: unknown operator, undeclared series, undeclared state assignment, randomness without a seed, a seed without randomness, a strategy with no pairing, a credential in a query key, and a source not listed in `requires`.

## Migrating from `.js`

The `.js` files in `algorithms/` still load — the two paths coexist, and the JSON plugin `.plugin.json` files in `plugins/` are proven equivalent. Once you have confirmed the plugin versions in your own dashboard, delete the superseded files so the Strategies list does not show each method twice:

```bash
rm algorithms/control-*.js algorithms/horizon-*.js algorithms/sentiment-gated-momentum.js \
   algorithms/ema-momentum.js algorithms/rsi-mean-reversion.js algorithms/donchian-breakout.js
```

Keep `algorithms/README.md` and `algorithms/uploads/`. Uploaded `.js` strategies are unaffected — the format does not replace the upload path, it adds a safer one for **sharing**.

To wire compiled plugin methods into the algorithm registry, apply the three-line patch documented at the top of `server/plugins/algorithm-bridge.js`. It is left as an explicit change rather than made silently because it touches a core load path.

## Authoring a plugin

1. Start from a shipped bundle — `core-controls` is the smallest complete example.
2. `npm run plugin -- validate --file plugins/mine.plugin.json` after every edit. The static validator catches unresolvable references with a path, so most mistakes surface in under a second.
3. Give every strategy a pairing. Validation will insist.
4. `npm run plugin -- requirements --plugin mine` before sharing, to confirm the manifest is honest.
5. If you need something the format cannot express, that is a signal about the format, not a reason to reach for `.js`. Open the operator list in `expression.js` and consider whether the missing operator belongs there — where everyone gets it, safely — rather than in one person's uploaded file.
