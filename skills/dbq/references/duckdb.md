# DuckDB Client Examples

Use `duckdb` for DuckDB query execution when `DBQ_DATABASE_URL` is a local database file path:

```jsonc
"queryCommand": "duckdb \"$DBQ_DATABASE_URL\" -csv -c \"$DBQ_SQL\""
```

Use a `describeCommand` wrapper that queries DuckDB metadata, such as `information_schema.columns`, and emits DBQ describe JSON. See [describe-format.md](describe-format.md) for the required output shape.
