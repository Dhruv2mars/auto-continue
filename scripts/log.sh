#!/bin/sh
# Append a decision-trail row: log.sh <file> <phase> <decision> <why> <evidence> <result>
set -eu
file="$1"; phase="$2"; decision="$3"; why="$4"; evidence="$5"; result="$6"
quote_cell() { case "$1" in =*|+*|-*|@*) printf "'%s" "$1";; *) printf "%s" "$1";; esac; }
if [ ! -f "$file" ]; then
  printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' > "$file"
fi
printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(quote_cell "$phase")" "$(quote_cell "$decision")" "$(quote_cell "$why")" \
  "$(quote_cell "$evidence")" "$(quote_cell "$result")" >> "$file"
