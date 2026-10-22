# Stockbot secrets: rules for agents

Hand this to any agent (Claude, Codex, Hermes) that works on the Stockbot repo.
It contains **no secret values**. It says where each secret lives, who may read
it, and what an agent must never do with it.

**The repo is public on GitHub.** Anything committed is public the moment it is
pushed, and deleting it later does not un-publish it.

## 1. Where the real secrets live

All of them are outside the repo, in files readable only by the owner (`chmod 600`;
directories `chmod 700`).

| Secret | File | Read by |
|---|---|---|
| `DATABASE_URL` (includes the PostgreSQL role password) | `~/.config/stockbot/stockbot.env` | Stockbot server, `scripts/database.js`, `scripts/swarm/cutover.js` |
| `STOCKBOT_API_TOKEN` (operator token: full control) | same file | Stockbot server |
| `STOCKBOT_SETTINGS_KEY` (encrypts secrets stored in settings) | same file | Stockbot server |
| `ALPACA_API_KEY` / `ALPACA_API_SECRET`, `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `OPENAI_API_KEY`, AI-CLI provider keys | same file | Stockbot server only |
| Operator token copy for the Claude MCP bridge and the swarm CLI | `~/.config/stockbot/mcp.env` (`STOCKBOT_URL`, `STOCKBOT_API_TOKEN`) | `scripts/mcp/stockbot-mcp.js`, `npm run swarm` |
| One token per swarm agent (`sbat_…`) | `~/.config/stockbot/agents/<hermes-profile>.env` (`STOCKBOT_URL`, `STOCKBOT_AGENT_TOKEN`) | that agent's MCP server and worker only |
| Hermes model-provider keys | `~/.hermes/profiles/<profile>/.env` (copied by `hermes profile create --clone`) | Hermes |
| X / Twitter session | the browser profile, or `TWITTER_AUTH_TOKEN` / `TWITTER_CT0` in a protected env file | Twitter CLI |
| PostgreSQL TLS private key | `/etc/postgresql/tailscale/server.key` on the database host | PostgreSQL |
| Database backups (full copies of the data, including token hashes and settings) | `~/.local/state/stockbot/cutover/*.dump` and `rehearsal.json` | the cutover tool |
| Local database and research runs | `data/` in the repo (git-ignored) | Stockbot |

The database stores agent tokens as SHA-256 hashes only. A token is shown once,
written straight into its agent's env file, and never printed.

## 2. Hard rules

1. **Never put a real secret in a repo file**: not in code, tests, plans, docs,
   `Claude outputs/`, commit messages or PR text. Use a placeholder, or a path
   to the protected file.
2. **Never print, echo, `cat` or paste a secret** into a chat, log, report, task
   or result file, or Obsidian note. When you need to show that one exists,
   show the variable name and the file path, never the value.
3. **Never pass a secret on a command line.** `ps` and error messages show argv.
   Use env files, `PGPASSWORD`, or the tool's own config. `cutover.js` already
   does this; keep it that way.
4. **Never copy a secret file into the repo, a handoff bundle or a zip.** The
   repo root already holds `Stockbot-private-config-*.zip`. Treat it as secret,
   and never commit it or move it into a tracked path.
5. **Do not widen file permissions.** Env files stay 0600 and their directories
   0700. The MCP bridge, agent MCP server and server launcher refuse looser
   files on purpose; fix the permissions instead of the check.
6. **Each swarm agent gets only its own token.** Never give an agent profile the
   operator token, `mcp.env`, `stockbot.env`, or another agent's env file. The
   agent's Hermes profile should list only the `stockbot-agent` MCP server (check
   with `hermes --profile <p> mcp list`); remove an operator `stockbot` server if
   a clone brought one along.
7. **Treat database dumps as secrets.** Keep them in the 0700 backup directory.
   Never attach them or move them into the repo.
8. **Never commit with `--no-verify`.** Only the owner may do that, after
   reading the hit and confirming it is a false positive.

## 3. Writing tests and docs without tripping the scanners

`scripts/git-hooks/pre-commit` blocks a staged line that has any of:

- `STOCKBOT_API_TOKEN=`, `STOCKBOT_SETTINGS_KEY=`, `ALPACA_API_SECRET=`,
  `ALPACA_API_KEY=`, `POLYGON_API_KEY=`, `FINNHUB_API_KEY=`, `OPENAI_API_KEY=`
  or `DATABASE_URL=` followed by 16 or more token characters;
- a URL with a password embedded after the user name (6 or more characters between the `:` and the `@`);
- PEM or OpenSSH private-key material.

These placeholder markers are allowed through: `replace-me`, `replace-with`,
`example.test`, `paste-at-this-prompt`, `URL_ENCODED_PASSWORD`, `your-`,
`operator-configured`, `localhost`, `127.0.0.1`.

GitHub's push protection also looks for provider-shaped keys (`AKIA…`, `xoxb-…`,
`sk-…`, `ghp_…`), even fake ones.

So, in tests:

- **Build fake credentials at runtime from parts**, so no credential-shaped
  literal is ever committed:

  ```js
  const fakePassword = ["FAKE", "pw", "only4test"].join("-");
  const url = ["postgres://app", fakePassword].join(":") + "@db:5432/stockbot";
  const awsShaped = ["AK", "IA", "FAKEFAKEFAKEFAKE"].join("");
  ```

  `test/research/hermes-cli.test.js` and `scripts/dev/fake-hermes.js` do this.
- Make fake values obviously fake (`FAKE`, `fake`, `only4test`) so a reader
  never wonders.
- Use database URLs on `127.0.0.1` with throwaway passwords for local scratch
  servers. Pass real test-server URLs only through environment variables, as
  `STOCKBOT_TEST_POSTGRES_URL` does; never in a committed file.
- In docs, write `postgresql://APP_USER:URL_ENCODED_PASSWORD@host:5432/APP_DATABASE`
  or `replace-me`, never a working value.

## 4. If the hook fires

1. Read the hit. If it is a **real** value: remove it from the file, unstage it,
   and move the value to the protected file it belongs in (section 1). Then
   treat the secret as exposed (step 3).
2. If it is a **fake** fixture: rewrite it so it is built at runtime or uses an
   allowlisted placeholder (section 3). Do not bypass the hook.
3. If a real secret was ever pushed, or pasted anywhere outside its protected
   file, **rotate it**. Removing it from history is not enough.

## 5. Rotating each secret

| Secret | How to rotate |
|---|---|
| Swarm agent token | `npm run swarm -- token <agent>`. The old token stops working at once, and the new one goes straight into the agent's env file. To cut an agent off entirely: `npm run swarm -- status <agent> paused`, or retire it. |
| Operator token | Put a new 32+ character value in `stockbot.env` **and** `mcp.env`, then restart the service. |
| PostgreSQL role password | `ALTER ROLE … PASSWORD …` at an interactive `psql` prompt on the database host, then update `DATABASE_URL` in `stockbot.env` and restart. |
| `STOCKBOT_SETTINGS_KEY` | Do not change it casually: it decrypts secrets stored in settings. Re-enter those settings after rotating. |
| Market-data / model provider keys | Revoke the old key in that provider's dashboard, create a new one and update the env file. |
| X session | Sign out of that X session (which invalidates the cookies), then sign in again. |

## 6. Quick self-check before you finish

- `git diff --cached` shows no real value, and every fake one is runtime-built
  or a placeholder.
- `bash scripts/git-hooks/pre-commit` exits cleanly.
- Nothing you wrote (reports, task results, notes) quotes a token, password or key.
- New env or backup files you created are 0600, in 0700 directories outside the repo.
