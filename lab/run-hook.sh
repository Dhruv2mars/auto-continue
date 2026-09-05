#!/bin/sh
# lab/run-hook.sh — isolated hook simulation. Never touches ~/.auto-continue.
#
# Usage:
#   lab/run-hook.sh [harness] [event] [--fixture FILE] [--dry] [--max-continues N] [--max-wait SEC]
#   lab/run-hook.sh claude stop --fixture tests/fixtures/stop-retry-after.json
#   lab/run-hook.sh --fixture tests/fixtures/stop-retry-after.json   # defaults: claude stop
#   echo '{"session_id":"x",...}' | lab/run-hook.sh claude stop      # stdin payload
#
# Env forced here (override-safe):
#   AUTO_CONTINUE_HOME -> lab/home (unless already a temp/lab path; never $HOME/.auto-continue)
#   AUTO_CONTINUE_RESUME_CMD_CLAUDE -> node lab/fake-claude.mjs "$1" "$2"
#   AUTO_CONTINUE_MIN_DELAY -> 1 (unless already set; keeps sim fast)
set -eu

LAB_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LAB_HOME="$LAB_DIR/home"
FAKE_CLAUDE="$LAB_DIR/fake-claude.mjs"
CLI="$LAB_DIR/../core/cli.mjs"
DEFAULT_FIXTURE="$LAB_DIR/../tests/fixtures/stop-retry-after.json"

# --- isolation: force AUTO_CONTINUE_HOME to temp/lab dir, never ~/.auto-continue ---
REAL_HOME="${HOME:-/tmp}"
AUTO_CONTINUE_HOME="${AUTO_CONTINUE_HOME:-$LAB_HOME}"
case "$AUTO_CONTINUE_HOME" in
  "$REAL_HOME/.auto-continue"|~/.auto-continue|"")
    AUTO_CONTINUE_HOME="$LAB_HOME" ;;
  *"$LAB_DIR"*|*"${TMPDIR:-/tmp}"*|*/tmp/*)
    : ;; # already an isolated path, keep it
  *)
    AUTO_CONTINUE_HOME="$LAB_HOME" ;;
esac
export AUTO_CONTINUE_HOME
export AUTO_CONTINUE_MIN_DELAY="${AUTO_CONTINUE_MIN_DELAY:-1}"
export AUTO_CONTINUE_RESUME_CMD_CLAUDE="${AUTO_CONTINUE_RESUME_CMD_CLAUDE:-node \"$FAKE_CLAUDE\" \"\$1\" \"\$2\"}"

mkdir -p "$AUTO_CONTINUE_HOME" "$LAB_HOME"

# --- arg passthrough with defaults (harness event [--fixture ...]) ---
HARNESS=""
EVENT=""
case "${1:-}" in --*) ;; "" ) ;; *) HARNESS="$1"; shift ;; esac
case "${1:-}" in --*) ;; "" ) ;; *) EVENT="$1"; shift ;; esac
HARNESS="${HARNESS:-claude}"
EVENT="${EVENT:-stop}"

HAS_FIXTURE=0
for a in "$@"; do
  case "$a" in --fixture) HAS_FIXTURE=1; break ;; esac
done

if [ "$HAS_FIXTURE" -eq 0 ] && [ ! -t 0 ] ; then
  # stdin is piped: no fixture, payload comes from stdin
  exec node "$CLI" "$HARNESS" "$EVENT" "$@"
else
  if [ "$HAS_FIXTURE" -eq 0 ]; then
    set -- --fixture "$DEFAULT_FIXTURE" "$@"
  fi
  exec node "$CLI" "$HARNESS" "$EVENT" "$@"
fi
