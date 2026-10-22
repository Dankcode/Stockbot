# Hermes stock research with Twitter CLI

This workflow researches **US stocks for several weeks to several months**.
Twitter discovers leads; independent Hermes workers check fundamentals,
price/volume, catalysts and the bear case. The result is a sourced shortlist.

## Installation

Hermes must already be configured with a working model/provider and web tools.
The runner uses its existing model settings; it does not edit Hermes configuration.
Install the selected [Twitter CLI](https://github.com/public-clis/twitter-cli) in
an isolated, ignored environment from a pinned revision:

```bash
uv venv .tools/twitter-cli
uv pip install --python .tools/twitter-cli/bin/python 'git+https://github.com/public-clis/twitter-cli.git@7c634e0d396b1e7af9f63315b414925fe4f29ae7'
```

The installed version is 0.8.6. Dependencies are resolved by uv at installation;
only the CLI source revision is pinned. Node 22+ and `hermes` on PATH are required.
Optional `STOCKBOT_TWITTER_BIN` and `STOCKBOT_HERMES_BIN` select existing binaries.

## Authenticate and run

Twitter CLI can extract the logged-in X session from local browsers. Running the
commands below authorizes it to use that browser session for read requests.
Alternatively configure `TWITTER_AUTH_TOKEN` and `TWITTER_CT0` in your protected
local environment. Do not paste cookies into chats or commit them to Git.

```bash
npm run research:hermes -- status
npm run research:hermes -- prepare
npm run research:hermes -- run
```

`status` performs a live login check and prints no account details. `prepare`
collects the configured searches and writes evidence and the coordinator prompt
without invoking a model. `run` collects a fresh bundle and starts Hermes through the shared launcher
(`scripts/lib/hermes.js`, also used by the swarm worker): `chat --query-file`
with only `web,delegation`, a 40-turn coordinator limit, a 15-minute run budget,
`--ignore-rules`, and the run directory as the working directory. The evidence
is inlined into the prompt (capped at 60 KB), so no file toolset is granted.
Before each run the launcher checks `hermes chat --help` for every flag it
passes and stops with a clear message if one is missing. Child resource use also
follows your Hermes delegation settings. No model/provider override, scheduling,
account posting, or trade execution is configured.

Edit [`research/us-equities-twitter.json`](../research/us-equities-twitter.json)
to tune queries. The defaults collect three sequential searches, at most 25
posts each, from the last seven UTC dates. Search results are leads, not a
complete stock universe. Empty results and unverified claims must be reported.

Each run writes an ignored `data/hermes-research/<UTC timestamp>/` directory
(override with `STOCKBOT_HERMES_RESEARCH_DIR`):

- `evidence.json`: original structured search results, queries and fetch times.
- `prompt.md`: the exact coordinator mandate with the inlined evidence.
- `report.md`: Hermes stdout, saved only after a successful nonempty response.

The runner validates Twitter's version-1 output envelope and stops on any failed
search. It does not validate the factual accuracy or completeness of Hermes's
Markdown. Review role completion and data coverage in the report. A runtime
failure preserves collected evidence for inspection; do not mistake it for a
finished recommendation.

## Team workflow and Stockbot boundary

The [coordinator mandate](../research/hermes-us-equities.md) requires two discovery
workers, followed by three diligence workers on a shared candidate list, using
Hermes's native `delegate_task`. It requires primary-source checks and current
price/liquidity evidence before a conditional buy verdict. It permits rejecting
every candidate. Portfolio sizing awaits the owner's holdings and risk limits.

This is a separate research workspace. Reports are not automatically imported
into Stockbot's immutable research snapshots and do not drive strategies.
Do not configure this agentic Hermes runner as `AI_CLI_COMMAND`: that adapter
expects a non-agentic JSON summarizer. The existing paper/backtest engine and
sentiment plans retain their current behavior.

References: [Twitter output contract](https://github.com/public-clis/twitter-cli/blob/main/SCHEMA.md),
[Hermes delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation).
