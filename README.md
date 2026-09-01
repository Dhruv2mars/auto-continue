# auto-continue

Automatically resume agent sessions interrupted by usage limits, across five coding harnesses. One plugin, one policy, same behavior everywhere.

When a provider rate limit or quota window kills a turn, auto-continue classifies the failure and acts: quota windows get a detached watcher (or an in-process re-prompt on OpenCode) that re-enters the session when the window passes, honoring `retry-after` where the harness exposes it; transient overload gets an immediate bounded re-prompt. Auth and billing errors are never retried. Per-session caps, a watcher dedupe window, a global daily resume ceiling, and the harnesses' own kill switches prevent runaway loops.

## How it works per harness

| Harness | Mechanism | Install | Status |
|---|---|---|---|
| **Claude Code** | `Stop` + `StopFailure` (matcher `rate_limit\|overloaded`) plugin hooks; detached watcher resumes via `claude --resume` | `/plugin marketplace add Dhruv2mars/auto-continue` then `/plugin install auto-continue@auto-continue` | install + hook registration verified from this repo; live quota fire pending your OAuth re-login |
| **ZCode** | Plugin `Stop` hook, continuation decisions | Settings → Plugins → Add marketplace → `Dhruv2mars/auto-continue` → install | installed and live-verified in the desktop app (hook fires each turn, correct classification) |
| **Codex** | Plugin `Stop` hook | `codex plugin marketplace add Dhruv2mars/auto-continue` then `codex plugin add auto-continue@auto-continue` | install verified from this repo; quota-killed turns emit no Stop event in codex 0.152.0, so resume fires on clean stops; harness auto-detection for codex is unverified until first live fire |
| **Cursor** | `stop` hook emits `followup_message` | Marketplace submission in progress. Today: add the `stop` block from [hooks/cursor-hooks.json](hooks/cursor-hooks.json) to your `~/.cursor/hooks.json` (point the command at a checkout of this repo) | hook format and `stop` event live-verified in the CLI TUI; plugin-level discovery silent in CLI build 2026.07.23 |
| **OpenCode** | v1 plugin: `session.error` arms, `session.idle` re-prompts via `client.session.promptAsync` | npm package pending (`npm publish` blocked on maintainer token). Today: copy `adapters/opencode/index.js` + `adapters/opencode/core/` into `.opencode/plugins/` (rename index.js to `auto-continue.js`) or `~/.config/opencode/plugins/` | error classification (structured 429) and arming live-verified; resume loop unit-tested |

All five read the same core: [core/lib](core/lib) classifies the failure, computes the delay, and enforces caps. Adapters are thin.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `AUTO_CONTINUE_MAX_CONTINUES` | harness cap (claude 7, zcode 2, codex 2, cursor 4, opencode 2) | max resumes per session; always clamped one-under the harness's own kill switch |
| `AUTO_CONTINUE_MAX_WAIT` | 7200 | upper bound on a single wait, seconds |
| `AUTO_CONTINUE_MIN_DELAY` | 10 | lower bound on a single wait, seconds |
| `AUTO_CONTINUE_RESUME` | `1` | set `0` to disable the detached resume watcher |
| `AUTO_CONTINUE_RESUME_CMD_CLAUDE` | `claude --resume "$1" -p "$2"` | resume command template; `$1` is the session id, `$2` the resume prompt (`{session_id}`/`{prompt}` placeholders also accepted) |
| `AUTO_CONTINUE_RESUME_CMD_<HARNESS>` | unset | opt-in detached resume for codex / cursor |
| `AUTO_CONTINUE_PROMPT` | "Continue from where the turn was interrupted by the usage limit." | resume prompt text |

Safety rails: resume watchers deduplicate within a 2-minute window, a global ceiling of 20 detached resumes per day, per-session counters reset on a healthy turn end, payload-derived values reach the resume command only as quoted positional shell parameters (never interpolated into the command string), and `~/.auto-continue/` is created `0700`.

State and the audit log live in `~/.auto-continue/` (`state/<session>.json`, `log.jsonl`, `resumes/*.log`). Hooks never exit nonzero on internal errors; a broken hook must not break a session.

## Behavior notes

- **Claude Code**: a quota-killed turn fires `StopFailure`, which has no decision control, so the plugin arms a detached watcher that waits out the window and runs `claude --resume`. Claude Code also ships a native `autoContinueAtUsageLimit` setting; this plugin is the cross-harness superset. User interrupts are never resumed.
- **ZCode**: the Stop hook returns `{"decision":"block","reason":...}`; ZCode caps continuations at 3 per run, we stay at 2.
- **Codex**: `Stop` fires on normal turn ends. Probes on 0.152.0 confirmed quota-killed turns never reach Stop; watchers via `AUTO_CONTINUE_RESUME_CMD_CODEX` are the workaround if you have a resume entry point.
- **Cursor**: `stop` hooks fire in interactive sessions (TUI/IDE); headless `cursor-agent -p` skips them in build 2026.07.23. Resume uses `followup_message`, capped by `loop_limit`.
- **OpenCode**: resume lives in-process, so it works while the session (TUI/server) is open; headless `opencode run` exits on terminal errors before the wait elapses. There is no user-activity guard yet: a scheduled re-prompt lands even if you typed first.

## Development

```sh
bun test    # 44 tests: classify, policy, state, cli, watchers, injection, dedupe, opencode adapter
```

Layout: `core/` (shared classification + policy + state), `hooks/` (shared hook entry + per-harness hook configs), `adapters/opencode/` (npm package, vendored core via `bun run sync-opencode`), per-harness manifests at the repo root.

## License

MIT
