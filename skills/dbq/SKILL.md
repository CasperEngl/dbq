---
name: dbq
description: Use DBQ to list, inspect, and safely query configured Postgres databases.
---

# DBQ

DBQ queries named Postgres databases through `~/.dbq/config.toml`. It keeps database URLs on the local machine, audits activity to `~/.dbq/audit.log`, wraps queries in read-only transactions, and requires macOS confirmation for query execution.

DBQ caches resolved database URLs in memory per process. A `urlCommand` such as `op read ...` runs once for a given database id and resolver config during a long-lived MCP process; restarting DBQ clears the cache.

## Install

Install DBQ with the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | bash
```

The installer uses these defaults:

- Managed binaries: `~/.dbq/bin/dbq`, `~/.dbq/bin/dbq-confirm`
- PATH symlinks: `~/.local/bin/dbq`, `~/.local/bin/dbq-confirm`
- Config: `~/.dbq/config.toml`

Set `DBQ_HOME` to change DBQ state location and `DBQ_BIN_DIR` to change the PATH symlink directory:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | DBQ_HOME="$HOME/.dbq" DBQ_BIN_DIR="$HOME/.local/bin" bash
```

## CLI

Use the CLI:

```bash
dbq list
dbq describe app-development
dbq query app-development 'select * from users limit 10'
dbq query app-production-readonly 'select now()' --max-rows 10
dbq mcp
```

`query` requires quoted SQL, allows only `SELECT`/`WITH`, rejects semicolons, and defaults to `--max-rows 100`.

## Querying Rules

Use DBQ as the only interface for database queries and DBQ-managed credentials:

- Prefer DBQ MCP tools when available: `list_databases`, `describe_database`, `query_database`.
- Use the `dbq` CLI when MCP tools are unavailable or unclear.
- Do not call `op`, `psql`, or other credential/database clients directly to resolve DBQ database URLs.
- Do not print, inspect, or validate DBQ-managed database URLs outside DBQ.
- If DBQ URL resolution fails, report the DBQ error and inspect DBQ logs/config structure only; do not read the secret value with 1Password.

Ambiguous database names:

- Do not bake customer/project-specific database names or aliases into this generic skill.
- If a user names an ambiguous database, run `dbq list` or the MCP `list_databases` tool to identify candidates.
- If multiple candidates remain and no project-local instruction defines a default, ask one short clarification question before querying.
- If project-local instructions define aliases or defaults, follow those instructions without repeating private customer names in this skill.

## MCP Config

Use this MCP server config:

```toml
[mcp_servers.dbq]
command = "dbq"
args = ["mcp"]
```

Use the absolute binary if PATH is not available to the MCP client:

```toml
[mcp_servers.dbq]
command = "/Users/YOU/.local/bin/dbq"
args = ["mcp"]
```

DBQ exposes these MCP tools:

- `list_databases`
- `describe_database`
- `query_database`

## Local Config

DBQ reads config from `~/.dbq/config.toml`. Do not print, commit, or expose database URLs. Prefer `urlCommand` with 1Password references, but let DBQ execute those commands.

```toml
[security]
confirmQueries = true

[databases.app-development]
engine = "postgres"
environment = "development"
readonly = true
urlCommand = "op read 'op://Databases/App Development DB URL/notesPlain'"

[databases.app-production-readonly]
engine = "postgres"
environment = "production"
readonly = true
urlCommand = "op read 'op://Databases/App Production Read-Only DB URL/notesPlain'"

[databases.app-production-writable]
engine = "postgres"
environment = "production"
readonly = false
urlCommand = "op read 'op://Databases/App Production Writable DB URL/notesPlain'"
```

The `urlCommand` examples document how DBQ is configured. They are not instructions for agents to run `op` directly during query tasks.
