# auto-continue

Automatically resume agent sessions interrupted by usage limits, across five coding harnesses. One plugin, one policy, same behavior everywhere.

When a provider rate limit or quota window kills a turn, auto-continue classifies the failure, waits out the window (honoring `retry-after` where the harness exposes it), and re-enters the session. Auth and billing errors are never retried. A per-session cap prevents runaway loops.

## How it works per harness

| Harness | Mechanism | Install | Status |
|---|---|---|---|
| **Claude Code** | `Stop` + `StopFailure` (matcher `rate_limit\|overloaded`) plugin hooks; detached watcher resumes via `claude --resume` | `/plugin marketplace add Dhruv2mars/auto-continue` then `/plugin install auto-continue@auto-continue` | install + hook registration verified; live fire pending your OAuth re-login |
| **ZCode** | Plugin `Stop` hook, continuation decisions | Settings → Plugins → Add marketplace → `Dhruv2mars/auto-continue` → install | installed and live-verified in the desktop app |
| **Codex** | Plugin `Stop` hook | `codex plugin marketplace add Dhruv2mars/auto-continue` then `codex plugin add auto-continue@auto-continue` | install verified; quota-killed turns emit no Stop event in codex 0.152.0, so resume fires on clean stops until OpenAI ships interrupted-turn hooks |
| **Cursor** | `stop` hook with `followup_message` | Marketplace submission in progress. Today: add the `stop` block from [hooks/cursor-hooks.json](hooks/cursor-hooks.json) to `~/.cursor/hooks.json` | hook format and event live-verified in the CLI TUI |
| **OpenCode** | v1 plugin: `session.error` arms, `session.idle` re-prompts via `client.session.promptAsync` | `opencode.json` → `{ "plugin": ["opencode-auto-continue"] }` (npm) | error classification and arming live-verified; resume loop unit-tested |

All five read the same core: [core/lib](core/lib) classifies the failure, computes the delay, and enforces caps. Adapters are thin.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_CONTINUE_MAX_CONTINUES` | harness cap (claude 7, zcode 2, codex 3, cursor 4, opencode 3) | max resumes per session; always clamped one-under the harness's own kill switch |
| `AUTO_CONTINUE_MAX_WAIT` | 7200 | upper bound on a single wait, seconds |
| `AUTO_CONTINUE_MIN_DELAY` | 10 | lower bound on a single wait, seconds |
| `AUTO_CONTINUE_RESUME` | `1` | set `0` to disable the detached resume watcher |
| `AUTO_CONTINUE_RESUME_CMD_CLAUDE` | `claude --resume "{session_id}" -p "{prompt}"` | resume command template |
| `AUTO_CONTINUE_RESUME_CMD_<HARNESS>` | unset | opt-in detached resume for codex / cursor |
| `AUTO_CONTINUE_PROMPT` | "Continue from where the turn was interrupted by the usage limit." | resume prompt text |

State and the audit log live in `~/.auto-continue/` (`state/<session>.json`, `log.jsonl`, `resumes/*.log`). Hooks never exit nonzero on internal errors; a broken hook must never break a session.

## Behavior notes

- **Claude Code**: a quota-killed turn fires `StopFailure`, which has no decision control, so the plugin arms a detached watcher that waits out the window and runs `claude --resume`. Claude Code also ships a native `autoContinueAtUsageLimit` setting; this plugin is the cross-harness superset. User interrupts are never resumed.
- **ZCode**: the Stop hook returns `{"decision":"block","reason":...}`; ZCode caps continuations at 3 per run, we stay at 2.
- **Codex**: `Stop` fires on normal turn ends. Probes on 0.152.0 confirmed quota-killed turns never reach Stop; watchers via `AUTO_CONTINUE_RESUME_CMD_CODEX` are the workaround if you have a resume entry point.
- **Cursor**: `stop` hooks fire in interactive sessions (TUI/IDE); headless `cursor-agent -p` skips them in build 2026.07.23. Resume uses `followup_message`, capped by `loop_limit`.
- **OpenCode**: resume lives in-process, so it works while the session (TUI/server) is open; headless `opencode run` exits on terminal errors before the wait elapses.

## Development

```sh
bun install          # no runtime deps; installs nothing for the plugin itself
bun test             # 39 tests: classify, policy, state, cli, watchers, opencode adapter
```

Layout: `core/` (shared classification + policy + state), `hooks/` (shared hook entry + per-harness hook configs), `adapters/opencode/` (npm package, vendored core via `bun run sync-opencode`), per-harness manifests at the repo root.

## License

MIT
