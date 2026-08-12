# Laptop deployment with SQL and Tailscale

This path runs one production Stockbot process as the logged-in macOS user. Express serves the built dashboard and `/api/v1` on one loopback port; Tailscale Serve terminates private tailnet HTTPS and proxies to that port. Stockbot stays bound to `127.0.0.1`. Do not set `HOST=0.0.0.0`, `STOCKBOT_ALLOW_REMOTE=true`, or use Tailscale Funnel.

## Host prerequisites

- macOS, Node.js 22 or newer, npm, and this repository
- A reachable SQLite or PostgreSQL database on the future host, represented by that host's private `DATABASE_URL`
- Tailscale installed, signed in, and HTTPS enabled for the tailnet
- A tailnet policy that grants only the intended users/devices access to this laptop

Tailscale documents `tailscale serve --bg --yes --https=443 http://127.0.0.1:4000` as a persistent private HTTPS reverse proxy. `--bg` makes that configuration resume after Tailscale or the device restarts. Serve access still follows tailnet ACLs. This is not public Funnel exposure.

## Install on the future host

From the cloned repository:

```bash
./scripts/laptop/init-config.sh
./scripts/laptop/install.sh
./scripts/laptop/configure-tailscale.sh
```

The initializer privately prompts for `DATABASE_URL`, generates separate API and settings-encryption secrets, and writes them without displaying them to `~/.config/stockbot/stockbot.env` with mode `600`. Edit that file to add market-provider credentials. For another protected location, pass `--env-file /absolute/path` to all three commands.

The installer runs `npm ci`, typechecking, tests, the production build, and an idempotent migration/health check against the database selected in the protected config before pruning development-only packages. It then generates `~/Library/LaunchAgents/com.stockbot.laptop.plist` using paths resolved on that host. The LaunchAgent runs at login, restarts after failure, throttles restarts, and writes logs under `~/Library/Logs/Stockbot/`. Its plist and server config are mode `600`; secrets remain only in the server config.

If you want to inspect the generated job before starting it:

```bash
./scripts/laptop/install.sh --no-start
plutil -p "$HOME/Library/LaunchAgents/com.stockbot.laptop.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.stockbot.laptop.plist"
```

Configure Serve only after loopback health succeeds. The script verifies the Tailscale session and `http://127.0.0.1:4000/api/v1/health`, applies the current supported reverse-proxy form, then prints `tailscale serve status`. If the CLI is not on `PATH`, pass `--tailscale-bin /absolute/path/to/tailscale`.

The script is idempotent when Stockbot already owns that mapping and refuses to overwrite an unrelated existing Serve configuration. After reviewing `tailscale serve status`, pass `--replace-existing` only if this app should replace it and own HTTPS port 443 at the root path.

Open the HTTPS URL shown by `tailscale serve status` from another authorized tailnet device. Enter the `STOCKBOT_API_TOKEN` from the protected host config into the dashboard Settings in that browser tab; it is required for mutations and remains in session storage only.

## Operations

```bash
./scripts/laptop/status.sh
launchctl kickstart -k "gui/$(id -u)/com.stockbot.laptop"
tail -f "$HOME/Library/Logs/Stockbot/stockbot.error.log"
```

Before updating, back up the SQL database using the database engine's native backup tooling. Then pull the code and rerun `./scripts/laptop/install.sh`; migrations are forward-only and run when Stockbot starts.

Inspect database health or export the automated trade ledger without duplicating the connection string into the repository:

```bash
npm run db:status -- --env-file "$HOME/.config/stockbot/stockbot.env"
npm run db:trades -- --env-file "$HOME/.config/stockbot/stockbot.env" --account default-paper
```

See [Database operations](./DATABASE_OPERATIONS.md) for verified SQLite backups and PostgreSQL-native backup guidance.

To remove only the LaunchAgent while preserving database/config/logs and Tailscale state:

```bash
./scripts/laptop/uninstall.sh
```

Disable Stockbot's Tailscale HTTPS root endpoint separately with `tailscale serve --https=443 off`. Do not use `tailscale serve reset` unless you intend to remove every Serve mapping on that laptop.

## Security boundaries

- Tailscale Serve is network-level access control; the API token protects mutations. Read-only API routes and SSE are visible to every tailnet principal allowed to reach this node.
- Keep the SQL server loopback-only where possible. If PostgreSQL is on another tailnet node, restrict port 5432 to the Stockbot laptop and require TLS/database authentication.
- Tailscale Serve exposes only Stockbot's HTTP port. Never create a Serve or Funnel mapping for the database port.
- Never commit the protected env file or place secrets in `VITE_*` variables, the LaunchAgent plist, command-line arguments, or Tailscale Serve configuration.
- The service runs only while this user is logged in. A system-wide pre-login daemon is intentionally not installed.

Current command references: [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [Tailscale Serve overview](https://tailscale.com/docs/features/tailscale-serve), and [Apple launchd guidance](https://support.apple.com/guide/terminal/script-management-with-launchd-apdc6c1077b/mac).
