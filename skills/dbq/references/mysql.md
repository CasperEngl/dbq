# MySQL Client Examples

Use MySQL Shell for MySQL query execution:

```jsonc
"queryCommand": "mysqlsh --uri \"$DBQ_DATABASE_URL\" --sql --execute \"$DBQ_SQL\""
```

Use a `describeCommand` wrapper that queries `information_schema` and emits DBQ describe JSON. See [describe-format.md](describe-format.md) for the required output shape.
