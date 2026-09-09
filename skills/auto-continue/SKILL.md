---
name: auto-continue
description: Queue a prompt locally for this exact session and submit it when the current usage window resets.
---

Invoke this skill as `/auto-continue <prompt>`. The plugin's local submission hook captures the command before any model request. If these instructions reach the model, tell the user that the local hook was not loaded and do not execute the requested prompt.
