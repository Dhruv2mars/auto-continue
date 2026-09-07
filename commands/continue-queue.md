---
description: Queue the next prompt for auto-continue to send when the usage limit resets.
argument-hint: <prompt...>
allowed-tools: Bash
---

Queue `$ARGUMENTS` for delivery after the quota window passes. Run from the repo root:

```sh
node core/cli.mjs enqueue "$CLAUDE_SESSION_ID" "$ARGUMENTS"
```

Use `--` when the prompt starts with `-`. Check with `node core/cli.mjs list "$CLAUDE_SESSION_ID"`, inspect with `node core/cli.mjs status "$CLAUDE_SESSION_ID"`, drop with `node core/cli.mjs clear "$CLAUDE_SESSION_ID"`.
