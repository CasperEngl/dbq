# PostgreSQL Client Examples

Use `psql` for PostgreSQL query execution:

```toml
queryCommand = "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\""
```

Use the installed PostgreSQL describe command:

```toml
describeCommand = "\"$DBQ_HOME/bin/dbq-describe-postgres\""
```

The installed command runs this wrapper:

```bash
#!/usr/bin/env bash
set -euo pipefail

psql "$DBQ_DATABASE_URL" \
  --no-psqlrc \
  --tuples-only \
  --no-align \
  --set=DBQ_DATABASE_ID="$DBQ_DATABASE_ID" \
  --set=DBQ_DATABASE_ENGINE="$DBQ_DATABASE_ENGINE" \
  --command "
with columns_by_relation as (
  select
    table_schema,
    table_name,
    jsonb_agg(
      jsonb_build_object(
        'name', column_name,
        'type', data_type,
        'nullable', is_nullable = 'YES'
      )
      order by ordinal_position
    ) as columns
  from information_schema.columns
  where table_schema not in ('pg_catalog', 'information_schema')
  group by table_schema, table_name
),
relations_by_schema as (
  select
    table_schema,
    jsonb_agg(
      jsonb_build_object(
        'name', table_name,
        'kind', 'table',
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
"
```
