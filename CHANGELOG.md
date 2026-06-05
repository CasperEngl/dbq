# Changelog

## v0.3.1 - 2026-06-05

- Remove `environment` field and add support for literal `url` config

## v0.3.0 - 2026-06-05

- Migrate config format from TOML to JSONC

## v0.2.1 - 2026-06-05

- Refactor release script to simplify function signatures
- Update GitHub Actions dependencies to latest versions
- Add foreign key support to PostgreSQL schema introspection

## v0.2.0 - 2026-06-05

- Initial DBQ release project
- Add Effect-based CLI and MCP server with improved architecture
- Simplify README with streamlined install and config docs
- Add disk caching for database URLs
- Refactor confirmQuery to skip confirmation for read-only databases
- Add database structure caching with disk persistence
- Clarify database structure snapshot expiry behavior
- Add compact format for database describe output
- Add foreign key support to database structure
- Refactor Schema definitions to use pipe syntax
- Generalize database support beyond Postgres
- Support filtering describe output by multiple relations
- Remove MCP server and Zod dependency
- Refactor database clients to run external commands
- Add release automation script and GitHub workflow
