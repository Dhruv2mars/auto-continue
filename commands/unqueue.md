---
description: Cancel a queued prompt
argument-hint: <id|all>
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT:-.}/bin/ac.mjs" cancel $ARGUMENTS`
