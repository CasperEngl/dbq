# DBQ

DBQ is a local CLI and MCP server for safely querying named Postgres databases through `~/.dbq/config.toml`.

DBQ is designed for local agent use:

- database URLs stay on the local machine
- production targets should use read-only credentials
- queries are wrapped in read-only transactions
- every query is audited to `~/.dbq/audit.log`
- query execution requires macOS Touch ID or account-password confirmation when `confirmQueries` is enabled

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
# 0 disables disk caching. Set a default TTL to reuse urlCommand results between CLI runs.
urlCacheTtlSeconds = 900

[databases.my-project-development]
engine = "postgres"
environment = "development"
readonly = true
urlCommand = "op read op://Databases/my-project-development/url"
# Optional per-database override. Each database URL has its own cache entry and expiry.
urlCacheTtlSeconds = 300
```

DBQ supports either `urlCommand` or `urlEnv`.

Use `urlCommand` for secret-manager references and let DBQ run the command. Do not print database URLs or paste them into agent conversations.

DBQ caches resolved database URLs in memory per process. Set `security.urlCacheTtlSeconds` to also cache `urlCommand` results between separate CLI runs. Set `databases.<id>.urlCacheTtlSeconds` to give a specific database URL its own TTL. The disk cache is opt-in, stores multiple URL entries in `~/.dbq/url-cache.json`, and is written with `0600` permissions. Leave TTLs at `0` to avoid writing resolved database URLs to disk.

## CLI

Use the same binary locally:

```bash
dbq list
dbq describe my-project-development
dbq query my-project-development 'select * from users limit 10'
```

`query` accepts `--max-rows` and defaults to 100 rows.

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
