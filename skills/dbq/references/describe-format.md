# DBQ Describe Format

`describeCommand` stdout must be one JSON object matching this structure:

```json
{
  "databaseId": "app-development",
  "engine": "sql",
  "generatedAt": 1780650000000,
  "namespaces": [
    {
      "name": "public",
      "kind": "schema",
      "relations": [
        {
          "name": "users",
          "kind": "table",
          "columns": [
            {
              "name": "id",
              "type": "integer",
              "nullable": false
            }
          ]
        }
      ]
    }
  ]
}
```

DBQ validates the structure with Effect Schema and rejects excess properties.

Required top-level properties:

- `databaseId`: must match the configured database id.
- `engine`: must match the configured database engine.
- `generatedAt`: non-negative integer timestamp in milliseconds.
- `namespaces`: array of namespaces.

Namespace properties:

- `name`: namespace name.
- `kind`: `schema`, `catalog`, or `namespace`.
- `relations`: array of relations.

Relation properties:

- `name`: relation name.
- `kind`: `table`, `view`, or `relation`.
- `columns`: array of columns.

Column properties:

- `name`: column name.
- `type`: database type string.
- `nullable`: boolean.
- `references`: optional column reference.

Column references use:

```json
{
  "namespace": "public",
  "relation": "users",
  "column": "id"
}
```
