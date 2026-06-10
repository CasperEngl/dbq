# DBQ

DBQ is an agent skill for querying named databases without the agent ever reading their connection URLs.

There is no CLI, binary, or build step. The skill is a convention:

- `~/.dbq/connections.md` — registry of databases: name, env var name, engine, rules
- `~/.dbq/env` — shell exports holding the actual connection URLs; the agent never reads this file
- `~/.dbq/structure/<name>.md` — schema notes the agent accumulates and reuses

Connection URLs flow from `~/.dbq/env` to the database client inside a single shell command (`source ~/.dbq/env && psql "$DBQ_APP_DEV_URL" ...`), so they never enter the conversation. During setup the skill offers to enforce this at the agent level with a `Read(~/.dbq/env)` permission deny rule.

## Install

```bash
npx skills add CasperEngl/dbq --skill dbq
```

Then ask your agent to set up a database connection — it interviews you and writes the `~/.dbq/` files. You fill in URL values yourself, in your editor, never in chat.

See [skills/dbq/SKILL.md](skills/dbq/SKILL.md) for the full instruction set.
