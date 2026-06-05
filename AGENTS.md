# Agent Instructions

After completing a task, run:

```bash
bun run check
```

This runs formatting with oxfmt, linting with oxlint, and TypeScript typechecking with tsgo.

## DBQ testing

Before testing the DBQ CLI against the local user's configured databases, ask the user for permission to update the local user's global DBQ config at `~/.dbq/config.toml` so database structure snapshots are persisted. If the user approves, ensure the `[security]` section contains:

```toml
databaseStructureCacheDurationSeconds = 3600
```

Do not print or inspect configured database URLs or secret resolver output while making this change. If the user does not approve the config update, do not test CLI behavior that depends on persisted database structure snapshots.

## DBQ skill edits

When updating the DBQ agent skill, edit only the project-local skill at `skills/dbq/SKILL.md`.

Do not edit installed/global skill copies directly, including files under `~/.agents/skills/`, `~/.claude/skills/`, or `~/.config/opencode/skills/`. After the project-local skill is updated, tell the user to install or copy the update into their global opencode configuration if they want it available outside this repo.

Keep the canonical DBQ skill focused on the current state and recommended behavior. Do not document in-between migration steps, removed behavior, or what no longer exists unless the current skill user must know it to operate DBQ correctly.

When using Effect `Schema.TaggedError` classes, yield tagged errors directly:

```ts
return yield * new ValidationError({ message: "Invalid input" });
```

Do not wrap yieldable tagged errors in `Effect.fail(...)`.
