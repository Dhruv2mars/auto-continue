# auto-continue

Queue a prompt locally and send it to the same coding-agent session when its usage window reopens.

```text
/auto-continue continue the work
```

`ac` tries the prompt immediately. If the provider reports a usage limit, it reads the reset time from that failure, waits, and retries. Prompts and queue state stay in `~/.auto-continue`.

## Install

Clone the repository and install the shared `ac` command:

```sh
git clone https://github.com/Dhruv2mars/auto-continue
cd auto-continue
bun link
```

Then enable the integration you use.

### Claude Code

```text
/plugin marketplace add Dhruv2mars/auto-continue
/plugin install auto-continue@auto-continue
```

Run `/auto-continue:auto-continue <prompt>`. Claude namespaces commands installed by plugins.

### Codex

```sh
codex plugin marketplace add https://github.com/Dhruv2mars/auto-continue
codex plugin add auto-continue@auto-continue
```

Review and trust the plugin hooks when Codex asks. Run `$auto-continue <prompt>` in the interactive app. Codex does not expose plugin-defined slash commands, so `/auto-continue` is not available there.

### OpenCode

Link the plugin into OpenCode's global plugin directory:

```sh
mkdir -p ~/.config/opencode/plugins
ln -s "$PWD/.opencode/plugins/auto-continue.ts" ~/.config/opencode/plugins/auto-continue.ts
```

Run `/auto-continue <prompt>`. OpenCode may also print the local short-circuit as a command error after the prompt has been queued. The success toast and `ac list` show the real result.

### Cursor

Load this checkout as a Cursor plugin:

```sh
cursor-agent --plugin-dir "$PWD"
```

Run `/auto-continue <prompt>`. The `sessionStart` hook captures the conversation ID and `beforeSubmitPrompt` queues the prompt without a model request.

## Use

| Command | Result |
|---|---|
| `/auto-continue <prompt>` | Send now, then reschedule if usage is limited |
| `/auto-continue at 3pm <prompt>` | Wait until 3pm before the first attempt |
| `/auto-continue-status` | Show queued and completed prompts in Claude |
| `/auto-continue-cancel <id\|all>` | Cancel prompts in Claude |
| `ac add <prompt>` | Queue from any shell |
| `ac list` | Show queue state |
| `ac cancel <id\|all>` | Cancel queued prompts |

Explicit times accept `3pm`, `3:30pm`, `15:30`, `+5h`, and `90m`.

## How it works

Each prompt gets one detached sleeper process. The process sends through the matching CLI, reads a reset time from a limit failure, and retries up to four times. There is no daemon or background service.

Built-in send commands resume the captured session:

| Harness | Resume command |
|---|---|
| Claude Code | `claude --resume <session> -p ...` |
| Codex | `codex exec resume <session> -` |
| OpenCode | `opencode run --session <session> ...` |
| Cursor | `cursor-agent --resume <session> --print ...` |

Two prompts for one session run in order. Any `ac` command also restarts sleepers lost to a reboot. A non-limit failure, such as bad credentials or an unknown session, stops without retrying and appears as `failed` in `ac list`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AC_SEND_<HARNESS>` | built in | Override a send command. `$1` is the session ID and `$2` is the prompt file |
| `AC_PAD_SEC` | `60` | Grace period added to a typed time |
| `AC_RETRIES` | `4` | Maximum send attempts |
| `AC_BLIND_SEC` | `1800` | Wait when a limit failure has no readable reset time |
| `AC_SESSION` | detected | Override the session ID |
| `AUTO_CONTINUE_HOME` | `~/.auto-continue` | Queue, prompts, markers, and logs |

The default Claude command uses `--permission-mode acceptEdits` so a queued turn can edit files. Send output is written to `~/.auto-continue/logs/<id>.log`.

## Limits

This is meant for same-day usage windows, not scheduled jobs. If the machine shuts down, overdue work resumes the next time any `ac` command runs. Cursor and Codex require trusted local hooks. OpenCode's V1 plugin API has no clean "handled locally" return value, which is why its TUI can show an error after a successful queue.

## Development

```sh
bun test
```

## License

MIT
