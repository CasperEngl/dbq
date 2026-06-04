# Agent Instructions

After completing a task, run:

```bash
bun run check
```

This runs formatting with oxfmt, linting with oxlint, and TypeScript typechecking with tsgo.

## DBQ skill edits

When updating the DBQ agent skill, edit only the project-local skill at `skills/dbq/SKILL.md`.

Do not edit installed/global skill copies directly, including files under `~/.agents/skills/`, `~/.claude/skills/`, or `~/.config/opencode/skills/`. After the project-local skill is updated, tell the user to install or copy the update into their global opencode configuration if they want it available outside this repo.

When using Effect `Schema.TaggedError` classes, yield tagged errors directly:

```ts
return yield * new ValidationError({ message: "Invalid input" });
```

Do not wrap yieldable tagged errors in `Effect.fail(...)`.
