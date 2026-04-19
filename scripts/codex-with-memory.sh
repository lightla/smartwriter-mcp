#!/usr/bin/env bash
set -euo pipefail

MEM_DIR="${HOME}/.codex/memories"

if [ ! -d "$MEM_DIR" ]; then
  exec codex "$@"
fi

# Build a compact bootstrap prompt from memory markdown files.
MEM_TEXT="$({
  echo "System bootstrap: Load and obey the following user memory rules for this session:";
  for f in "$MEM_DIR"/*.md; do
    [ -e "$f" ] || continue
    echo ""
    echo "--- MEMORY: $(basename "$f") ---"
    cat "$f"
  done
  echo ""
  echo "Acknowledge memory loaded, then continue normally."
} )"

if [ "$#" -gt 0 ]; then
  exec codex "$MEM_TEXT" "$@"
else
  exec codex "$MEM_TEXT"
fi
