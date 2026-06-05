# PostgreSQL Client Examples

Use `psql` for PostgreSQL query execution:

```jsonc
"queryCommand": "psql \"$DBQ_DATABASE_URL\" --no-psqlrc --csv --command \"$DBQ_SQL\""
```

Use the installed PostgreSQL describe command:

```jsonc
"describeCommand": "\"$DBQ_HOME/bin/dbq-describe-postgres\""
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
