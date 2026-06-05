# DBQ

DBQ is a local CLI and MCP server for safely querying named Postgres databases through `~/.dbq/config.toml`.

DBQ is designed for local agent use:

- database URLs stay on the local machine
- production targets should use read-only credentials
- queries are wrapped in read-only transactions
- every query is audited to `~/.dbq/audit.log`
- queries against writable database targets require macOS Touch ID or account-password confirmation when `confirmQueries` is enabled

## Install

Install DBQ with the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | bash
```

The installer writes binaries to:

```text
~/.dbq/bin/dbq
~/.dbq/bin/dbq-confirm
```

It also links the commands into `~/.local/bin` by default:

```text
~/.local/bin/dbq
~/.local/bin/dbq-confirm
```

Set `DBQ_BIN_DIR` to choose another PATH directory:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | DBQ_BIN_DIR="$HOME/bin" bash
```

If no config exists yet, it creates:

```text
~/.dbq/config.toml
```

## MCP Client Config

Use DBQ as a stdio MCP server:

```toml
[mcp_servers.dbq]
command = "/Users/YOU/.dbq/bin/dbq"
args = ["mcp"]
```

If `~/.local/bin` is on your PATH, this can be:

```toml
[mcp_servers.dbq]
command = "dbq"
args = ["mcp"]
```

## Configure Databases

Edit `~/.dbq/config.toml`:

```toml
[security]
confirmQueries = true
# 0 disables disk caching. Set a default duration for reusing urlCommand results between CLI runs.
databaseUrlCacheDurationSeconds = 900
# 0 keeps database structure snapshots until manually refreshed. Positive values expire them.
databaseStructureCacheDurationSeconds = 3600

[databases.my-project-development]
engine = "postgres"
environment = "development"
readonly = true
urlCommand = "op read op://Databases/my-project-development/url"
# Optional per-database override. Each database URL has its own cache entry and expiry.
databaseUrlCacheDurationSeconds = 300
# Optional per-database structure snapshot expiry override.
databaseStructureCacheDurationSeconds = 900
```

DBQ supports either `urlCommand` or `urlEnv`.

Use `urlCommand` for secret-manager references and let DBQ run the command. Do not print database URLs or paste them into agent conversations.

DBQ caches resolved database URLs in memory per process. Set `security.databaseUrlCacheDurationSeconds` to also cache `urlCommand` results between separate CLI runs. Set `databases.<id>.databaseUrlCacheDurationSeconds` to give a specific database URL its own cache duration. The disk cache is opt-in, stores multiple URL entries in `~/.dbq/url-cache.json`, and is written with `0600` permissions. Leave cache durations at `0` to avoid writing resolved database URLs to disk.

DBQ also caches database structure from `describe` in memory per process and persists successful structure snapshots to `~/.dbq/database-structure-cache.json`. Structure includes schemas, tables, columns, nullability, and foreign keys. Set `security.databaseStructureCacheDurationSeconds` or `databases.<id>.databaseStructureCacheDurationSeconds` to expire structure snapshots after a duration; `0` keeps snapshots until they are manually refreshed. Use `dbq describe <database-id> --refresh` or MCP `describe_database` with `refresh: true` to bypass cached database structure and update the snapshot.

## CLI

Use the same binary locally:

```bash
dbq list
dbq describe my-project-development
dbq describe my-project-development --schema public
dbq describe my-project-development --schema public --table users
dbq describe my-project-development --format json
dbq describe my-project-development --refresh
dbq query my-project-development 'select * from users limit 10'
```

`describe` defaults to `--format compact`, a token-efficient line format for agents that omits cache status and format version. Use `--schema` and `--table` to keep large database output focused. Use `--format json` for grouped structured output with cache details. `query` accepts `--max-rows` and defaults to 100 rows.

## MCP Tools

DBQ exposes:

- `list_databases`
- `describe_database`
- `query_database`

## Agent Skill

Install the DBQ agent skill with:

```bash
npx skills add CasperEngl/dbq --skill dbq --full-depth
```
