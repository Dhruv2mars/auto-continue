---
description: Send this prompt now, or when your rate-limit window reopens
argument-hint: <prompt>   (or: at 3pm <prompt>)
allowed-tools: Bash(node:*)
---

!`AUTO_CONTINUE_HARNESS=claude node "${CLAUDE_PLUGIN_ROOT:-.}/bin/ac.mjs" add "$ARGUMENTS"`

Report that output verbatim and stop. Do not do the work yourself.
