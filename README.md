# DBQ

DBQ is a local MCP server for querying named Postgres databases through a global `~/.dbq/config.toml` registry.

It is designed for agent use:

- database URLs stay on the local machine
- production targets should use read-only credentials
- queries are wrapped in read-only transactions
- every query is audited to `~/.dbq/audit.log`
- `query_database` requires macOS Touch ID or account-password confirmation before each query

## Install From A Release

Download the release archive for your platform, then run:

```bash
tar -xzf dbq-v0.1.0-darwin-arm64.tar.gz
cd dbq-v0.1.0-darwin-arm64
./install.sh
```

The installer writes binaries to:

```text
~/.dbq/bin/dbq-mcp
~/.dbq/bin/DBQ
```

If no config exists yet, it creates:

```text
~/.dbq/config.toml
```

## MCP Client Config

Use DBQ as a stdio MCP server:

```toml
[mcp_servers.dbq]
command = "/Users/YOU/.dbq/bin/dbq-mcp"
args = []
```

## Configure Databases

Edit `~/.dbq/config.toml`:

```toml
[security]
confirmQueries = true

[databases.my-project-development]
engine = "postgres"
environment = "development"
readonly = true
urlCommand = "op read op://Databases/my-project-development/url"
```

DBQ supports either `urlCommand` or `urlEnv`.

## Tools

DBQ exposes:

- `list_databases`
- `describe_database`
- `query_database`

## Development

```bash
bun install
bun run check
bun run build
```
