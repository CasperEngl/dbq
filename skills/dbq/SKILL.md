---
name: dbq
description: Use DBQ to list, inspect, and safely query configured databases.
---

# DBQ

DBQ queries named databases through `~/.dbq/config.jsonc`. It keeps database URLs on the local machine, audits activity to `~/.dbq/audit.log`, and requires macOS confirmation for queries when `confirmQueries` is enabled.

DBQ caches resolved database URLs in memory per process. Set `security.databaseUrlCacheDurationSeconds` to also cache `urlCommand` results between separate CLI runs. Set `databases.<id>.databaseUrlCacheDurationSeconds` to give a specific database URL its own cache duration. The disk cache is opt-in, stores multiple URL entries in `~/.dbq/url-cache.json`, and is written with `0600` permissions. Leave cache durations at `0` to avoid writing resolved database URLs to disk.

DBQ runs `databases.<id>.queryCommand` with `DBQ_DATABASE_URL` and `DBQ_SQL` in the command environment. The configured command is responsible for talking to the database. Do not print either value.

DBQ runs `databases.<id>.describeCommand` with `DBQ_DATABASE_URL`, `DBQ_DATABASE_ID`, `DBQ_DATABASE_ENGINE`, `DBQ_DATABASE_ENVIRONMENT`, and `DBQ_DATABASE_READONLY` in the command environment when database structure must be refreshed. The command must print DBQ database structure JSON to stdout. Do not print the URL.

For the exact `describeCommand` JSON schema, read [references/describe-format.md](references/describe-format.md). For client-specific `queryCommand` templates and describe wrapper examples, read only the relevant reference:

- PostgreSQL: [references/postgres.md](references/postgres.md)
- MySQL: [references/mysql.md](references/mysql.md)
- SQLite: [references/sqlite.md](references/sqlite.md)
- DuckDB: [references/duckdb.md](references/duckdb.md)

DBQ reads cached database structure snapshots from `~/.dbq/database-structure-cache.json` and keeps them in memory per process. On cache miss or `--refresh`, DBQ runs `describeCommand`, validates the returned structure JSON, persists it, and returns the requested format. Structure is a generic namespace/relation/column model. Set `security.databaseStructureCacheDurationSeconds` or `databases.<id>.databaseStructureCacheDurationSeconds` to expire snapshots after a duration; `0` keeps snapshots until manually refreshed.

`describe` caches the full database structure snapshot when it has to inspect the database. The `--namespace` and `--relation` filters only limit returned output. Agents can first run `dbq describe <database-id> --format compact` without relation filters to populate or reuse the full cached structure, then call it again with repeated `--relation` options to retrieve a smaller focused slice from that cached structure.

## Install

Install DBQ with the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | bash
```

The installer uses these defaults:

- Managed binaries: `~/.dbq/bin/dbq`, `~/.dbq/bin/dbq-confirm`, `~/.dbq/bin/dbq-describe-postgres`
- PATH wrappers: `~/.local/bin/dbq`, `~/.local/bin/dbq-confirm`, `~/.local/bin/dbq-describe-postgres`
- Shell env file: `~/.dbq/env`
- Config: `~/.dbq/config.jsonc`

Source the env file when manual shell access to `DBQ_HOME`, `DBQ_BIN_DIR`, and the DBQ PATH is needed:

```bash
source "$HOME/.dbq/env"
```

Set `DBQ_HOME` to change DBQ state location and `DBQ_BIN_DIR` to change the PATH wrapper directory:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | DBQ_HOME="$HOME/.dbq" DBQ_BIN_DIR="$HOME/.local/bin" bash
```

## CLI

Use the CLI:

```bash
dbq list
dbq describe app-development --format compact
dbq describe app-development --format compact --namespace public
dbq describe app-development --format compact --namespace public --relation users --relation posts
dbq describe app-development --format json
dbq describe app-development --format compact --refresh
dbq query app-development 'select * from users limit 10'
dbq query app-production-readonly 'select now()'
```

Use `dbq describe ... --format compact`, a token-efficient line format for agents. Do not rely on the installed DBQ default. Use `--namespace` and repeat `--relation` to include multiple relations while DBQ keeps the full structure snapshot cached. Use `--format json` only when grouped structured output is needed for parsing. `query` requires quoted SQL and runs the SQL exactly as provided through the configured `queryCommand` after confirmation when confirmation is enabled.

For CLI use, run an unfiltered describe when you need to warm or refresh the full structure cache:

```bash
dbq describe app-development --format compact
dbq describe app-development --format compact --namespace public --relation users --relation posts
```

## Querying Rules

Use DBQ as the only interface for database queries and DBQ-managed credentials:

- Use the `dbq` CLI for all database operations.
- Before writing SQL against an unfamiliar database, run `dbq describe <database-id> --format compact` once and reuse that database structure during the task.
- For large databases, scope structure output with `--namespace` and repeated `--relation` instead of dumping the whole database structure into the conversation. The filtered response still comes from the full cached structure snapshot.
- Use `dbq describe --format json` only when you need grouped structured data for programmatic parsing.
- Do not refresh database structure before every query. Use `dbq describe --refresh` only when the user asks for fresh database structure, the cached database structure may be stale, or a query fails because of missing or renamed tables/columns.
- DBQ does not rewrite SQL or enforce row limits. Include dialect-appropriate limits in the SQL when output should be bounded.
- Do not call `op`, `psql`, or other credential/database clients directly to resolve DBQ database URLs.
- Do not print, inspect, or validate DBQ-managed database URLs outside DBQ.
- If DBQ URL resolution fails, report the DBQ error and inspect DBQ logs/config structure only; do not read the secret value with 1Password.

Ambiguous database names:

- Do not bake customer/project-specific database names or aliases into this generic skill.
- If a user names an ambiguous database, run `dbq list` to identify candidates.
- If multiple candidates remain and no project-local instruction defines a default, ask one short clarification question before querying.
- If project-local instructions define aliases or defaults, follow those instructions without repeating private customer names in this skill.

## Local Config

DBQ reads config from `~/.dbq/config.jsonc`. Do not print, commit, or expose database URLs. Prefer `urlCommand` with 1Password references, but let DBQ execute those commands.

```jsonc
{
  "security": {
    "confirmQueries": true,
    // 0 disables disk caching. Set a default duration for reusing urlCommand results between CLI runs.
    "databaseUrlCacheDurationSeconds": 900,
    // 0 keeps database structure snapshots until manually refreshed. Positive values expire them.
    "databaseStructureCacheDurationSeconds": 3600,
  },
  "databases": {
    "app-development": {
      "engine": "postgres",
      "environment": "development",
      "readonly": true,
      "urlCommand": "op read 'op://Databases/App Development DB URL/notesPlain'",
      "queryCommand": "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\"",
      "describeCommand": "\"$DBQ_HOME/bin/dbq-describe-postgres\"",
      // Optional per-database override. Each database URL has its own cache entry and expiry.
      "databaseUrlCacheDurationSeconds": 300,
      // Optional per-database structure snapshot expiry override.
      "databaseStructureCacheDurationSeconds": 900,
    },
    "app-production-readonly": {
      "engine": "postgres",
      "environment": "production",
      "readonly": true,
      "urlCommand": "op read 'op://Databases/App Production Read-Only DB URL/notesPlain'",
      "queryCommand": "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\"",
      "describeCommand": "\"$DBQ_HOME/bin/dbq-describe-postgres\"",
    },
    "app-production-writable": {
      "engine": "postgres",
      "environment": "production",
      "readonly": false,
      "urlCommand": "op read 'op://Databases/App Production Writable DB URL/notesPlain'",
      "queryCommand": "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\"",
      "describeCommand": "\"$DBQ_HOME/bin/dbq-describe-postgres\"",
    },
    "app-analytics": {
      "engine": "postgres",
      "environment": "development",
      "readonly": true,
      "urlCommand": "op read 'op://Databases/App Analytics DB URL/notesPlain'",
      "queryCommand": "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\"",
      "describeCommand": "\"$DBQ_HOME/bin/dbq-describe-postgres\"",
    },
  },
}
```

The `urlCommand` examples document how DBQ is configured. They are not instructions for agents to run `op` directly during query tasks.
