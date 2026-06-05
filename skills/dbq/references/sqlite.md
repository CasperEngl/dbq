# SQLite Client Examples

Use `sqlite3` for SQLite query execution when `DBQ_DATABASE_URL` is a local database file path:

```toml
queryCommand = "sqlite3 -header -csv \"$DBQ_DATABASE_URL\" \"$DBQ_SQL\""
```

Use a `describeCommand` wrapper that queries SQLite metadata, such as `sqlite_schema` and `pragma_table_info`, and emits DBQ describe JSON. See [describe-format.md](describe-format.md) for the required output shape.
