# auto-continue

You hit a 5-hour limit. You know when it resets — the harness just told you. Queue the prompt you want sent then, and walk away.

```
/queue 3pm finish the migration and run the tests
```

At 3pm (plus a minute of slop) that prompt is sent to the session you queued it from. That's the whole tool.

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
| `/queue 3pm <prompt>` | send at the next 3pm |
| `/queue +5h <prompt>` | send in 5 hours |
| `/queued` | what's waiting |
| `/unqueue <id\|all>` | cancel |

Times: `3pm`, `3:30pm`, `15:30`, `+5h`, `90m`. Anything else is rejected on the spot, while you're still at the keyboard to retype it.

Same from any shell: `ac add 3pm ...`, `ac list`, `ac cancel <id>`.

## Other harnesses

Claude Code works out of the box. For anything else, tell `ac` how that CLI takes a prompt — `$1` is the session id, `$2` a file holding the prompt:

```sh
export AC_SEND_CODEX='codex exec "$(cat "$2")"'
export AC_SEND_OPENCODE='opencode run "$(cat "$2")"'
```

Without one set, `ac` refuses and says which variable to set. It will not guess another CLI's flags.

## How it works

`ac add` forks one detached `sleep N; send` per queued prompt. That's the entire mechanism — no daemon, no scheduler, no background service to install or debug.

Three consequences worth knowing:

- **The queue file is a view.** Each sleeper carries its own prompt in its own file and needs nothing else to send. `queue.json` exists for `list` and `cancel`. Nothing gates on it, so it cannot wedge a delivery.
- **Reboots are recovered lazily.** Any `ac` command re-forks a sleeper that died, firing anything already overdue. If your laptop was asleep the prompt goes out when you wake it — which is right, since nothing could have run while it was off.
- **Two prompts in one session don't collide.** The second waits on the first's pid before sending.

The send retries twice, five minutes apart, in case the window opens slightly later than advertised.

## Configuration

| Variable | Default | |
|---|---|---|
| `AC_SEND_<HARNESS>` | claude only | how to send a prompt; `$1` session, `$2` prompt file |
| `AC_PAD_SEC` | 60 | grace added to the time you typed |
| `AC_RETRY_SEC` | 300 | gap between send attempts |
| `AC_SESSION` | auto | session id to resume |
| `AUTO_CONTINUE_HOME` | `~/.auto-continue` | state, prompts, and send logs (mode 0700) |

Send output lands in `~/.auto-continue/logs/<id>.log`. The default Claude command runs `--permission-mode acceptEdits` so the queued turn can actually do work.

## Scope

Built for 5-hour windows. A prompt queued days out will fire late if the machine reboots and you don't touch `ac` — good enough for same-day resets, not a job scheduler.

## Development

```sh
bun test
```

`bin/ac.mjs` is the whole program.

## License

MIT
