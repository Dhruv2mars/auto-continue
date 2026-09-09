# auto-continue

Hand it the prompt you want run next, and walk away.

```
/auto-continue continue the work
```

If you're not rate limited, it goes now. If you are, the send fails, `ac` reads the reset time out of that failure, sleeps until then, and sends it. Same command either way — you never have to know which case you're in.

## Install

```sh
git clone https://github.com/Dhruv2mars/auto-continue && cd auto-continue
bun link                      # puts `ac` on your PATH
```

For the slash commands in Claude Code:

```
/plugin marketplace add Dhruv2mars/auto-continue
/plugin install auto-continue@auto-continue
```

## Use

| | |
|---|---|
| `/auto-continue <prompt>` | send now; reschedule itself if you're limited |
| `/auto-continue at 3pm <prompt>` | skip the first attempt, send at 3pm |
| `/auto-continue-status` | what's waiting, and what happened |
| `/auto-continue-cancel <id\|all>` | cancel |

Explicit times: `3pm`, `3:30pm`, `15:30`, `+5h`, `90m`. You rarely need one — the failure tells `ac` when the window reopens.

Same from any shell: `ac add continue the work`, `ac list`, `ac cancel <id>`.

## Other harnesses

Claude Code works out of the box. For anything else, tell `ac` how that CLI takes a prompt — `$1` is the session id, `$2` a file holding the prompt:

```sh
export AC_SEND_CODEX='codex exec "$(cat "$2")"'
export AC_SEND_OPENCODE='opencode run "$(cat "$2")"'
```

Without one set, `ac` refuses and says which variable to set. It will not guess another CLI's flags.

## How it works

`ac add` forks one detached process per prompt. It attempts the send; if that fails, it asks the failure when to try again, sleeps, and retries — up to four attempts. That's the entire mechanism: no daemon, no scheduler, no hooks, no background service to install or debug.

The reset time is read from the output of the send that just failed — `Claude AI usage limit reached|<epoch>`, `retry-after`, an ISO timestamp, or `resets 3pm`. A failure that isn't a limit at all (bad credentials, unknown session) is **not** retried; it's marked `failed` and the reason is in the log.

Three more consequences worth knowing:

- **The queue file is a view.** Each sleeper carries its own prompt in its own file and needs nothing else to send. `queue.json` exists for `list` and `cancel`. Nothing gates on it, so it cannot wedge a delivery.
- **Reboots are recovered lazily.** Any `ac` command re-forks a sleeper that died, firing anything already overdue. If your laptop was asleep the prompt goes out when you wake it — which is right, since nothing could have run while it was off.
- **Two prompts in one session don't collide.** The second waits on the first's pid before sending.

The send retries twice, five minutes apart, in case the window opens slightly later than advertised.

## Configuration

| Variable | Default | |
|---|---|---|
| `AC_SEND_<HARNESS>` | claude only | how to send a prompt; `$1` session, `$2` prompt file |
| `AC_PAD_SEC` | 60 | grace added to a time you typed |
| `AC_RETRIES` | 4 | attempts before giving up |
| `AC_BLIND_SEC` | 1800 | wait when the failure is limit-shaped but names no time |
| `AC_SESSION` | auto | session id to resume |
| `AUTO_CONTINUE_HOME` | `~/.auto-continue` | state, prompts, and send logs (mode 0700) |

Send output lands in `~/.auto-continue/logs/<id>.log`. The default Claude command runs `--permission-mode acceptEdits` so the queued turn can actually do work.

## Scope

Built for 5-hour windows. A prompt queued days out will fire late if the machine reboots and you don't touch `ac` — good enough for same-day resets, not a job scheduler.

Verified against the real CLI: `claude --resume <id> -p` continues an existing session with its context intact. Verified against a fake harness: immediate send, rate-limited reschedule from a parsed reset time, non-limit failures not retried, cancel, dead-sleeper recovery, and two prompts in one session not colliding.

## Development

```sh
bun test
```

`bin/ac.mjs` is the whole program.

## License

MIT
