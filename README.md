# auto-continue

Automatically resume agent sessions interrupted by usage limits, across five coding harnesses. One plugin, one policy, same behavior everywhere.

When a provider rate limit or quota window kills a turn, auto-continue classifies the failure and acts: quota windows get a detached watcher (or an in-process re-prompt on OpenCode) that re-enters the session when the window passes, honoring `retry-after` where the harness exposes it; transient overload gets an immediate bounded re-prompt. Auth and billing errors are never retried. Per-session caps, a watcher dedupe window, a global daily resume ceiling, and the harnesses' own kill switches prevent runaway loops.

Queue your next prompt while you wait: `/continue-queue <prompt>` stores it for the session, and the watcher sends the queue head (one per wake) instead of the canned fallback. `list`, `status`, and `clear` variants included; or drive it from any shell via `node core/cli.mjs enqueue|list|status|clear <session>`.

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
| `AUTO_CONTINUE_MAX_CONTINUES` | harness cap (claude 7, zcode 2, codex 2, cursor 3, opencode 2) | max resumes per session; always clamped one-under the harness's own kill switch |
| `AUTO_CONTINUE_MAX_WAIT` | 7200 | upper bound on a single wait, seconds |
| `AUTO_CONTINUE_MIN_DELAY` | 10 | lower bound on a single wait, seconds |
| `AUTO_CONTINUE_RESUME` | `1` | set `0` to disable the detached resume watcher |
| `AUTO_CONTINUE_RESUME_CMD_CLAUDE` | ``claude --resume "$1" -p "$(if [ -s "$AC_PROMPT_FILE" ]; then cat "$AC_PROMPT_FILE"; else printf '%s' "$2"; fi)"`` | default resume template; `$1` is the session id, `$2` the canned fallback prompt (`{session_id}`/`{prompt}` placeholders also accepted). The watcher drains the queue head into `$AC_PROMPT_FILE` (exported) and the default template consumes it via double-quoted `$(cat ...)` (falls back to `$2` when empty); custom templates keep `$1`/`$2` positionals and should read the queued prompt from stdin. |
| `AUTO_CONTINUE_RESUME_CMD_<HARNESS>` | unset | opt-in detached resume for codex / cursor |
| `AUTO_CONTINUE_PROMPT` | "Continue from where the turn was interrupted by the usage limit." | resume prompt text when the queue is empty |
| `AUTO_CONTINUE_HARNESS` | auto-detected | override harness for queue commands (`--harness` flag works too) |
| `AUTO_CONTINUE_PROBE_CMD_<HARNESS>` | unset | opt-in quota probe before the watcher delivers. Command must exit 0 (quota alive) or nonzero (still limited). While the probe reports limited, the watcher re-arms with the backoff ladder and the queue stays untouched; after the ladder is exhausted it gives up (queue intact, honest log line). |
| `AUTO_CONTINUE_PROBE` | unset | set `1` to also enable the built-in claude probe (`claude -p "Reply with the single word: OK"`) when no probe command is configured; set `0` to disable probing entirely. |
| `AUTO_CONTINUE_PROBE_BACKOFF` | `45 300 1800` | re-arm ladder in seconds while the quota is still limited (space-separated; failures fall back to defaults) |

Safety rails: resume watchers deduplicate within a 2-minute window (plus an already-queued guard out to `AUTO_CONTINUE_MAX_WAIT` so long sleeps never stack a second watcher), a global ceiling of 20 detached resumes per day, per-session counters reset on a healthy turn end (which also acks the delivered `.draining` head unless a delivery is still in flight — a failed resume restores the prompt to the queue head, never loses it), a probe give-up releases the arm and refunds the arm's budget so the next limit event re-arms at once, cap-blocked enqueues store nothing (a blocked prompt is never written to a file nothing would drain), the watcher wakes drain a pending `.draining` head first (FIFO; the canned prompt is only the true-empty fallback), non-claude harnesses without an explicit `AUTO_CONTINUE_RESUME_CMD_<H>` refuse to arm honestly instead of running the claude template, a give-up or auth/billing stand-down always prints its reason to stderr, queued prompts reach the resume command via the `$AC_PROMPT_FILE` temp file (never interpolated into the command string), the watcher never sends into a dead quota while a probe is configured (it re-arms on the backoff ladder instead, and probe failure counts as still-limited), limit classification needs either a strong event idiom or weak tokens (`rate limit`, `429`) corroborated by addressee/retry language, and `~/.auto-continue/` is created `0700`.

State and the audit log live in `~/.auto-continue/` (`state/<session>.json`, `queue/<session>.json` + `.draining` in-flight head, `log.jsonl`, `resumes/*.log`). Hooks never exit nonzero on internal errors; a broken hook must not break a session.

## Behavior notes

- **Claude Code**: a quota-killed turn fires `StopFailure`, which has no decision control, so the plugin arms a detached watcher that waits out the window and runs `claude --resume`. Claude Code also ships a native `autoContinueAtUsageLimit` setting; this plugin is the cross-harness superset. User interrupts are never resumed.
- **ZCode**: the Stop hook returns `{"decision":"block","reason":...}`; ZCode caps continuations at 3 per run, we stay at 2. Zcode env markers (`ZCODE_SESSION_ID`/`ZCODE_PLUGIN_ID`) auto-select the zcode path for queue commands too — set `AUTO_CONTINUE_RESUME_CMD_ZCODE` or enqueue reports why it did not arm.
- **Codex**: `Stop` fires on normal turn ends. Probes on 0.152.0 confirmed quota-killed turns never reach Stop; watchers via `AUTO_CONTINUE_RESUME_CMD_CODEX` are the workaround if you have a resume entry point.
- **Cursor**: `stop` hooks fire in interactive sessions (TUI/IDE); headless `cursor-agent -p` skips them in build 2026.07.23. Resume uses `followup_message`, capped by `loop_limit` (4); our cap stays one under at 3.
- **OpenCode**: resume lives in-process, so it works while the session (TUI/server) is open; headless `opencode run` exits on terminal errors before the wait elapses. A best-effort user-activity guard stands down when the idle payload shows you already continued; unknown payload shapes still resume.

## Queue commands

| Command | Shell | Meaning |
|---|---|---|
| `/continue-queue <prompt>` | `node core/cli.mjs enqueue <session> <prompt>` | store prompt, arm watcher or report honestly why not |
| `/continue-list` | `node core/cli.mjs list <session>` | show queued prompts, FIFO head first |
| `/continue-status` | `node core/cli.mjs status <session>` | queue depth, watcher state, caps, daily ceiling |
| `/continue-clear` | `node core/cli.mjs clear <session>` | drop queue + in-flight head |

One prompt drains per wake. A leftover `.draining` head is restored on the next limit event (never lost), acked by the watcher when its resume exits 0, and acked on a clean turn end that resets the healthy counter. Empty queue falls back to the canned Continue prompt.

## Development

```sh
bun test    # queue, classify, policy, state, cli, watchers, injection, dedupe, opencode adapter
```

Layout: `core/` (shared classification + policy + state), `hooks/` (shared hook entry + per-harness hook configs), `adapters/opencode/` (npm package, vendored core via `bun run sync-opencode`), per-harness manifests at the repo root.

## License

MIT
