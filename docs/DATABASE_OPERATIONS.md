# Database operations

Stockbot stores the complete automated-paper-trading trail in SQL: immutable strategy versions and session settings, order decisions, fills, FIFO position lots, equity snapshots, risk events, alerts, and audit entries. The operational commands below work from `DATABASE_URL`; they never print the connection string.

For one laptop, use file-backed SQLite:

```dotenv
DATABASE_URL=file:./data/stockbot.db
```

PostgreSQL remains available through a private connection string:

```dotenv
DATABASE_URL=postgresql://stockbot:private-password@127.0.0.1:5432/stockbot
```

Keep `.env` private. Unsupported schemes and a missing `DATABASE_URL` fail explicitly.

If an installer stores configuration outside the checkout, pass it explicitly:

```bash
npm run db:init -- --env-file ~/.config/stockbot/stockbot.env
```

On macOS and Linux, an explicit environment file must be an owner-only regular file (`chmod 600`). Values already present in the process environment take precedence. Loading the file does not mutate the running process environment.

## Initialize and inspect

Run initialization after installing the app and whenever deploying a newer version:

```bash
npm run db:init
npm run db:status
```

When using the portable laptop installer, point the commands at its protected host configuration instead of copying the URL into the repository:

```bash
npm run db:init -- --env-file "$HOME/.config/stockbot/stockbot.env"
npm run db:status -- --env-file "$HOME/.config/stockbot/stockbot.env"
```

On Unix, an explicit environment file must be a regular file with mode `0600`; process environment variables take precedence over values in that file.

`db:init` is safe to repeat. It applies checksum-protected forward migrations and creates the `default-paper` account only when it does not exist. `db:status` is read-only: it compares applied migration checksums, reports row counts, and checks ledger invariants such as negative cash, invalid lots, overfilled orders, and filled orders without fills.

File-backed SQLite is configured automatically for foreign keys, a 5-second busy timeout, WAL journaling, and `synchronous=FULL`. This lets the web process serve concurrent readers while prioritizing committed ledger durability over maximum write throughput.

## Track and export automated trades

Print a JSON reconciliation report:

```bash
npm run db:trades -- --account default-paper
```

Scope the report and write an execution CSV:

```bash
npm run db:trades -- \
  --account default-paper \
  --session SESSION_ID \
  --since 2026-08-01T00:00:00Z \
  --format csv \
  --output ./exports/august-trades.csv
```

`--since` accepts ISO-8601 or UTC epoch milliseconds. `--output -` writes to standard output. Existing output files are never overwritten. JSON includes execution rows plus matched lots, the latest equity point, risk events, audit entries, commissions, notional, and realized P&L. CSV is one row per fill, with rejected and pending orders represented by rows whose fill columns are empty. Money remains integer cents, quantity remains integer micro-shares, and timestamps remain UTC epoch milliseconds.

## Consistent backups

Create a new SQLite snapshot while Stockbot is running:

```bash
npm run db:backup -- --output ./backups/stockbot-2026-08-12.db
```

The command uses SQLite's online backup API rather than copying the live WAL files. It writes a temporary snapshot, runs full integrity and foreign-key checks, verifies migration state against the source, then atomically renames it to the requested path. It refuses the live database path and refuses to overwrite a previous backup.

Restore only while Stockbot is stopped. Preserve the current database separately, place the verified snapshot at the path selected by `DATABASE_URL`, then run `npm run db:status` before starting Stockbot.

`db:backup` intentionally refuses PostgreSQL. Use the PostgreSQL-native tools so transaction snapshots, roles, and extensions are handled correctly:

```bash
pg_dump --format=custom --file=stockbot.dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" stockbot.dump
```

Test restores into a separate database before relying on a backup. Avoid passing a PostgreSQL URL as a literal command-line argument; environment variables keep it out of shell history and Stockbot output.
