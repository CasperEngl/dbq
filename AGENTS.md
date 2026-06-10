# Agent Instructions

This repo is a single agent skill: `skills/dbq/SKILL.md`. There is no code, build, or test step.

## DBQ skill edits

Edit only the project-local skill at `skills/dbq/SKILL.md`. Do not edit installed/global skill copies, including files under `~/.agents/skills/`, `~/.claude/skills/`, or `~/.config/opencode/skills/`. After updating, tell the user to reinstall or copy the skill if they want it available outside this repo.

Keep the skill focused on current state and recommended behavior. Do not document migration steps, removed behavior, or what no longer exists unless the skill user must know it to operate DBQ correctly.

Keep SKILL.md minimal. Every instruction costs tokens in the agent's context; prefer removing rules over adding them.
