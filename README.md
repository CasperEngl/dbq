# DBQ

DBQ is a local MCP server for querying named Postgres databases through a global `~/.dbq/config.toml` registry.

It is designed for agent use:

- database URLs stay on the local machine
- production targets should use read-only credentials
- queries are wrapped in read-only transactions
- every query is audited to `~/.dbq/audit.log`
- `query_database` requires macOS Touch ID or account-password confirmation before each query

## Install

Install the latest macOS Apple Silicon release:

```bash
curl -fsSL https://raw.githubusercontent.com/CasperEngl/dbq/main/install-release.sh | bash
```

Or download the release archive for your platform, then run:

```bash
tar -xzf dbq-v0.1.0-darwin-arm64.tar.gz
cd dbq-v0.1.0-darwin-arm64
./install.sh
```

The installer writes binaries to:

```text
~/.dbq/bin/dbq
~/.dbq/bin/dbq-confirm
```

It also links the commands into `~/.local/bin` by default:

```text
~/.local/bin/dbq
~/.local/bin/dbq-confirm
```

Use `DBQ_BIN_DIR` to choose another PATH directory:

```bash
DBQ_BIN_DIR="$HOME/bin" ./install.sh
```

If no config exists yet, it creates:

```text
~/.dbq/config.toml
```

## MCP Client Config

Use DBQ as a stdio MCP server:

```toml
[mcp_servers.dbq]
command = "/Users/YOU/.dbq/bin/dbq"
args = ["mcp"]
```

If `~/.local/bin` is on your PATH, this can be:

```toml
[mcp_servers.dbq]
command = "dbq"
args = ["mcp"]
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

## CLI

Use the same binary locally:

```bash
dbq list
dbq describe my-project-development
dbq query my-project-development 'select * from users limit 10'
```

`query` accepts `--max-rows` and defaults to 100 rows.

## MCP Tools

DBQ exposes:

- `list_databases`
- `describe_database`
- `query_database`

## Agent Skill

This repo includes a DBQ agent skill at `skills/dbq/SKILL.md`.

Install it from this repo with:

```bash
npx skills add CasperEngl/dbq --skill dbq --full-depth
```

From a local checkout, test discovery with:

```bash
npx skills add . --list --full-depth
```

## Development

```bash
bun install
bun run check
bun run build
```

## Release

Push a version tag to build and publish the macOS Apple Silicon archive:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow uploads `dbq-vVERSION-darwin-arm64.tar.gz` to the GitHub Release. For Homebrew, copy `homebrew/dbq.rb` into a tap repository after replacing `REPLACE_WITH_RELEASE_SHA256` with the release archive SHA-256.
