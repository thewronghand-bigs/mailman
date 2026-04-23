#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SPACE_ALIAS="${1:-}"

if [ -z "${PATH_ADDED:-}" ]; then
  export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  export PATH_ADDED=1
fi

if [ -z "${MAILMAN_HOME:-}" ]; then
  echo "[mailman-sandbox] MAILMAN_HOME is required."
  echo "[mailman-sandbox] Example: MAILMAN_HOME=\"\$PWD/.mailman\""
  exit 1
fi

if [ -z "${MAILMAN_SNAPSHOT_FILE:-}" ]; then
  echo "[mailman-sandbox] MAILMAN_SNAPSHOT_FILE is required."
  exit 1
fi

cd "$PLUGIN_ROOT/runtime"
MAILMAN_DRIVER=snapshot bash run.sh "$SPACE_ALIAS"
