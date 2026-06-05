# DBQ

DBQ is a local CLI for querying named databases through `~/.dbq/config.toml`.

DBQ is designed for local agent use:

- database URLs stay on the local machine
- production targets should use read-only credentials
- every query is audited to `~/.dbq/audit.log`
- queries require macOS Touch ID or account-password confirmation when `confirmQueries` is enabled

## Install

Install DBQ with the release installer:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | bash
```

The installer writes binaries to:

```text
~/.dbq/bin/dbq
~/.dbq/bin/dbq-confirm
~/.dbq/bin/dbq-describe-postgres
```

It also writes PATH wrapper commands into `~/.local/bin` by default. The wrappers set default `DBQ_HOME` and `DBQ_BIN_DIR` values before running the managed binaries:

```text
~/.local/bin/dbq
~/.local/bin/dbq-confirm
~/.local/bin/dbq-describe-postgres
```

The installer also writes a shell env file for manual use:

```text
~/.dbq/env
```

Source it when you want `DBQ_HOME`, `DBQ_BIN_DIR`, and the DBQ PATH available in your current shell:

```bash
source "$HOME/.dbq/env"
```

Set `DBQ_HOME` to change DBQ state location and `DBQ_BIN_DIR` to choose another PATH directory:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | DBQ_HOME="$HOME/.dbq" DBQ_BIN_DIR="$HOME/bin" bash
```

If no config exists yet, it creates:

```text
~/.dbq/config.toml
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
queryCommand = "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\""
describeCommand = "\"$DBQ_HOME/bin/dbq-describe-postgres\""
# Optional per-database override. Each database URL has its own cache entry and expiry.
databaseUrlCacheDurationSeconds = 300
# Optional per-database structure snapshot expiry override.
databaseStructureCacheDurationSeconds = 900
```

DBQ supports either `urlCommand` or `urlEnv`.

Use `urlCommand` for secret-manager references and let DBQ run the command. Do not print database URLs or paste them into agent conversations.

Configure `queryCommand` for each database agents should query. DBQ delegates database communication to the configured command: it resolves the connection URL, passes it as `DBQ_DATABASE_URL`, passes the requested SQL as `DBQ_SQL`, and returns the command's stdout as query output. Do not print either value.

Configure `describeCommand` for each database agents should inspect. DBQ resolves the connection URL and runs the command with `DBQ_DATABASE_URL`, `DBQ_DATABASE_ID`, `DBQ_DATABASE_ENGINE`, `DBQ_DATABASE_ENVIRONMENT`, and `DBQ_DATABASE_READONLY` in the environment. The command must print DBQ database structure JSON to stdout:

```json
{
  "databaseId": "analytics",
  "engine": "sql",
  "generatedAt": 1780650000000,
  "namespaces": []
}
```

DBQ validates `databaseId`, `engine`, `generatedAt`, namespaces, relations, columns, and optional column references. Column references use `{ "namespace": "...", "relation": "...", "column": "..." }`.

Common `queryCommand` examples:

```toml
# PostgreSQL psql
queryCommand = "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\""

# MySQL Shell
queryCommand = "mysqlsh --uri \"$DBQ_DATABASE_URL\" --sql --execute \"$DBQ_SQL\""

# SQLite, when DBQ_DATABASE_URL is a local database file path
queryCommand = "sqlite3 -header -csv \"$DBQ_DATABASE_URL\" \"$DBQ_SQL\""

# DuckDB, when DBQ_DATABASE_URL is a local database file path
queryCommand = "duckdb \"$DBQ_DATABASE_URL\" -csv -c \"$DBQ_SQL\""
```

DBQ installs `dbq-describe-postgres` under `$DBQ_HOME/bin` for PostgreSQL structure snapshots. It uses `psql` to run metadata SQL and emit one JSON object:

```bash
#!/usr/bin/env bash
set -euo pipefail

psql "$DBQ_DATABASE_URL" \
  --no-psqlrc \
  --tuples-only \
  --no-align \
  --set=DBQ_DATABASE_ID="$DBQ_DATABASE_ID" \
  --set=DBQ_DATABASE_ENGINE="$DBQ_DATABASE_ENGINE" <<'SQL'
with foreign_key_columns as (
  select
    source_namespace.nspname as table_schema,
    source_relation.relname as table_name,
    source_column.attname as column_name,
    target_namespace.nspname as foreign_table_schema,
    target_relation.relname as foreign_table_name,
    target_column.attname as foreign_column_name
  from pg_constraint constraint_metadata
  join pg_class source_relation
    on source_relation.oid = constraint_metadata.conrelid
  join pg_namespace source_namespace
    on source_namespace.oid = source_relation.relnamespace
  join pg_class target_relation
    on target_relation.oid = constraint_metadata.confrelid
  join pg_namespace target_namespace
    on target_namespace.oid = target_relation.relnamespace
  join lateral unnest(constraint_metadata.conkey, constraint_metadata.confkey) as constrained_columns(source_column_number, target_column_number)
    on true
  join pg_attribute source_column
    on source_column.attrelid = source_relation.oid
    and source_column.attnum = constrained_columns.source_column_number
  join pg_attribute target_column
    on target_column.attrelid = target_relation.oid
    and target_column.attnum = constrained_columns.target_column_number
  where constraint_metadata.contype = 'f'
),
columns_by_relation as (
  select
    columns.table_schema,
    columns.table_name,
    max(tables.table_type) as table_type,
    jsonb_agg(
      jsonb_strip_nulls(
        jsonb_build_object(
          'name', columns.column_name,
          'type', columns.data_type,
          'nullable', columns.is_nullable = 'YES',
          'references', case
            when foreign_key_columns.foreign_table_schema is null then null
            else jsonb_build_object(
              'namespace', foreign_key_columns.foreign_table_schema,
              'relation', foreign_key_columns.foreign_table_name,
              'column', foreign_key_columns.foreign_column_name
            )
          end
        )
      )
      order by columns.ordinal_position
    ) as columns
  from information_schema.columns
  join information_schema.tables
    on tables.table_schema = columns.table_schema
    and tables.table_name = columns.table_name
  left join foreign_key_columns
    on foreign_key_columns.table_schema = columns.table_schema
    and foreign_key_columns.table_name = columns.table_name
    and foreign_key_columns.column_name = columns.column_name
  where columns.table_schema not in ('pg_catalog', 'information_schema')
  group by columns.table_schema, columns.table_name
),
relations_by_schema as (
  select
    table_schema,
    jsonb_agg(
      jsonb_build_object(
        'name', table_name,
        'kind', case when table_type = 'VIEW' then 'view' else 'table' end,
        'columns', columns
      )
      order by table_name
    ) as relations
  from columns_by_relation
  group by table_schema
)
select jsonb_build_object(
  'databaseId', :'DBQ_DATABASE_ID',
  'engine', :'DBQ_DATABASE_ENGINE',
  'generatedAt', floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
  'namespaces', coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', table_schema,
        'kind', 'schema',
        'relations', relations
      )
      order by table_schema
    ),
    jsonb_build_array()
  )
)::text
from relations_by_schema;
SQL
```

```toml
[databases.analytics]
engine = "postgres"
environment = "development"
readonly = true
urlCommand = "op read op://Databases/analytics/url"
queryCommand = "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\""
describeCommand = "\"$DBQ_HOME/bin/dbq-describe-postgres\""
```

DBQ caches resolved database URLs in memory per process. Set `security.databaseUrlCacheDurationSeconds` to also cache `urlCommand` results between separate CLI runs. Set `databases.<id>.databaseUrlCacheDurationSeconds` to give a specific database URL its own cache duration. The disk cache is opt-in, stores multiple URL entries in `~/.dbq/url-cache.json`, and is written with `0600` permissions. Leave cache durations at `0` to avoid writing resolved database URLs to disk.

DBQ reads cached database structure snapshots from `~/.dbq/database-structure-cache.json` and keeps them in memory per process. On cache miss or `--refresh`, DBQ runs `describeCommand`, validates the returned structure JSON, persists it, and returns the requested format. Structure is a generic namespace/relation/column model with optional references. Set `security.databaseStructureCacheDurationSeconds` or `databases.<id>.databaseStructureCacheDurationSeconds` to expire structure snapshots after a duration; `0` keeps snapshots until manually refreshed.

`describe` caches the full structure snapshot when it has to inspect the database. The `namespace` and `relations` filters only limit returned output, so agents can reuse the full cached structure while requesting a smaller table list.

## CLI

Use the same binary locally:

```bash
dbq list
dbq describe my-project-development
dbq describe my-project-development --namespace public
dbq describe my-project-development --namespace public --relation users --relation posts
dbq describe my-project-development --format json
dbq describe my-project-development --refresh
dbq query my-project-development 'select * from users limit 10'
```

`describe` defaults to `--format compact`, a token-efficient line format for agents. Use `--namespace` and repeat `--relation` to include multiple relations while DBQ keeps the full structure snapshot cached. Use `--format json` for grouped structured output with cache details. `query` runs the SQL exactly as provided through the configured `queryCommand` after confirmation when confirmation is enabled; include dialect-appropriate limits in the SQL when you need bounded output.

To warm or reuse the full structure cache and then retrieve only selected tables:

```bash
dbq describe my-project-development --format compact
dbq describe my-project-development --format compact --namespace public --relation users --relation posts
```

## Release

Release from a clean `main` worktree:

```bash
bun run release -- patch
git push origin main v0.1.1
```

Use `minor`, `major`, or an exact version like `0.2.0` instead of `patch` when needed. The release command updates `package.json`, prepends `CHANGELOG.md`, runs `bun run check`, builds the archive, verifies the compiled CLI version, commits the release, and creates an annotated `vX.Y.Z` tag. Add `--push` to publish the branch and tag in the same command.

After the GitHub release action publishes the archive, update the Homebrew formula from the actual published asset:

```bash
bun run release:homebrew -- v0.1.1
git push origin main
```

## Agent Skill

Install the DBQ agent skill with:

```bash
npx skills add CasperEngl/dbq --skill dbq --full-depth
```
