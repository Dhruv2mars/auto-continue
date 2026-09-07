# Harness isolation lab

Throwaway sandbox for testing the auto-continue hook + opencode adapter
**without touching real CLIs, real sessions, or `~/.auto-continue`.**

All lab scripts force `AUTO_CONTINUE_HOME` to a temp/lab dir
(`lab/home/` by default). They never fall through to `~/.auto-continue`.

## Files

- `fake-claude.mjs` — fake `claude --resume` target. Reads queued prompt
  args (`$1` = session_id, rest = prompt), appends one JSON line to
  `lab/runs.log`, exits 0.
- `run-hook.sh` — runs `core/cli.mjs` isolated:
  `AUTO_CONTINUE_HOME=lab/home`,
  `AUTO_CONTINUE_RESUME_CMD_CLAUDE=node lab/fake-claude.mjs "$1" "$2"`,
  `AUTO_CONTINUE_MIN_DELAY=1`. Fixture args pass through to `cli.mjs`.
- `fake-opencode-client.mjs` — minimal `{ session: { promptAsync } }` stub.
  Records each call (sessionId + prompt text) to `lab/runs.log`, resolves
  `{ ok: true }`.
- `home/` — isolated state/log dir (gitignored). `runs.log` — recorded queue.

## How to run

```sh
# 1. Hook sim (default: claude stop + tests/fixtures/stop-retry-after.json)
sh lab/run-hook.sh

# explicit harness/event + fixture passthrough
sh lab/run-hook.sh claude stop --fixture tests/fixtures/stop-retry-after.json

# stdin payload instead of fixture
echo '{"session_id":"lab-1","hook_event_name":"Stop","last_assistant_message":"rate limit, retry in 1s"}' \
  | sh lab/run-hook.sh claude stop

# 2. Wait for the 1s resume watcher, then check what got "queued"
sleep 2
cat lab/runs.log          # one JSON line from fake-claude
ls lab/home/state lab/home/resumes  # isolated state, no ~/.auto-continue writes

# 3. Fake opencode client, manual smoke
node lab/fake-opencode-client.mjs test-session "Continue."

# opencode adapter end-to-end (isolated home, 0s delay)
AUTO_CONTINUE_HOME="$PWD/lab/home" AUTO_CONTINUE_MIN_DELAY=0 node -e "
import('./lab/fake-opencode-client.mjs').then(async ({ client }) => {
  const { AutoContinue } = await import('./adapters/opencode/index.js');
  const p = await AutoContinue({ client });
  await p.event({ event: { type: 'session.error',
    properties: { sessionID: 'lab-opencode', error: { status: 429, message: 'rate limit' } } } });
  await p.event({ event: { type: 'session.idle', properties: { sessionID: 'lab-opencode' } } });
});"
sleep 1
cat lab/runs.log

# 4. Full suite still green
bun test

# 5. Clean up lab artifacts (state + runs log), commit nothing
rm -rf lab/home lab/runs.log
```

## Isolation contract

- Every lab script checks `AUTO_CONTINUE_HOME`: if unset, `~/.auto-continue`,
  or any non-temp/non-lab path, it is forced to `lab/home/`.
- To use your own temp dir: set `AUTO_CONTINUE_HOME` to a path containing
  `lab/` or `/tmp/` (e.g. `AUTO_CONTINUE_HOME=$(mktemp -d) lab/run-hook.sh`).
- Verify isolation: `grep -r auto-continue lab/runs.log | head` shows
  `"home":".../lab/home"`, and `ls ~/.auto-continue` is untouched
  (check mtime: `ls -la ~/.auto-continue 2>/dev/null || echo "no real home writes"`).
- Nothing in `lab/` is imported by `core/`, `adapters/`, `hooks/`, or `tests/`.
