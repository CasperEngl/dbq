---
name: dbq
description: Query the user's named databases without ever reading their connection URLs. Use when the user asks to query, inspect, or explore a database, or to add a new database connection.
---

# DBQ

DBQ is a convention, not a tool. All state lives in `~/.dbq/`.

<state>
- `~/.dbq/connections.md` — the registry: database name, env var name, engine/client, rules. Read and update this freely.
- `~/.dbq/env` — shell exports holding the actual connection URLs. **Never read this file or print its variables.** Only the user edits values.
- `~/.dbq/structure/<name>.md` — schema notes you create and reuse.
</state>

<url_rule>
Connection URLs must never enter the conversation. Inject them inside a single shell command:

```bash
source ~/.dbq/env && psql "$DBQ_APP_DEV_URL" --no-psqlrc --csv -c 'select 1'
```

- Never `cat`/Read `~/.dbq/env`; never `echo`, `printenv`, or interpolate a `DBQ_*` variable; never use `set -x`.
- To check a variable is set without seeing it: `source ~/.dbq/env && [ -n "$DBQ_APP_DEV_URL" ] && echo OK`.
- Debug connection failures from the client's stderr only. If the URL itself seems wrong, ask the user to fix it in `~/.dbq/env` — do not look at it.
</url_rule>

<bare_invocation>
If invoked with no question or task, show current state and stop: list the databases from `~/.dbq/connections.md` (name, engine, readonly), flag any env vars still unset (use the `[ -n ... ]` check — never the value), and offer to query a database, add or remove one, refresh schema notes, or set up enforcement. If no registry exists, start the setup interview instead.
</bare_invocation>

<setup>
Run setup when there is no registry yet or the user wants to add a database. Interview the user in one round:

1. Name and engine of the database (postgres, mysql, sqlite, ...)?
2. Where does the URL come from — literal string, existing env var, or a secret-manager command like `op read ...`?
3. Read-only? Production? Any standing rules (always LIMIT, confirm writes, ...)?

Setup is idempotent: if the database already exists in the registry, update its entry and env placeholder in place instead of duplicating them.

Verify the client is installed (`command -v psql`), then:

1. Append an entry to `~/.dbq/connections.md`:

   ```markdown
   # app-dev
   - env var: DBQ_APP_DEV_URL
   - postgres via psql; local dev, writes OK
   ```

2. Append a placeholder to `~/.dbq/env` and ask the user to fill in the value themselves (never have them paste a URL into the conversation):

   ```bash
   export DBQ_APP_DEV_URL="" # paste URL, or: "$(op read 'op://Vault/Item/field')"
   ```

3. **Offer enforcement** (first setup only): ask whether they want the URL file protected at the agent level, so it cannot be read even by mistake. If yes and running in Claude Code, add to the `permissions.deny` list in `~/.claude/settings.json`:

   ```json
   "deny": ["Read(~/.dbq/env)", "Bash(cat ~/.dbq/env)"]
   ```

   Tell them the `Read` rule is the hard guarantee; shell patterns are best-effort. In other agents, offer the equivalent mechanism if one exists.

4. Verify connectivity: `source ~/.dbq/env && psql "$DBQ_APP_DEV_URL" -c 'select 1'`.
</setup>

<querying>
- Find the database in `~/.dbq/connections.md`; if the name is ambiguous, ask.
- Unfamiliar schema: introspect once, save what you learn to `~/.dbq/structure/<name>.md`, and consult that file in later sessions instead of re-introspecting. Refresh it when queries fail on missing tables or columns.
- Honor each entry's rules. Read-only entries: never attempt writes. Writable non-dev databases: confirm with the user before INSERT/UPDATE/DELETE/DDL.
- Include a LIMIT unless the user asks otherwise.
</querying>
