---
description: Queue a prompt to send when the rate-limit window reopens
argument-hint: <time> <prompt>   e.g. 3pm finish the migration
allowed-tools: Bash(node:*)
---

Run this and report the output verbatim:

!`node "${CLAUDE_PLUGIN_ROOT:-.}/bin/ac.mjs" add $ARGUMENTS`
