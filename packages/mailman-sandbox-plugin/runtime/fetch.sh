#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "${PATH_ADDED:-}" ]; then
  export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  export PATH_ADDED=1
fi

BUN_BIN="$(command -v bun || echo "$HOME/.nvm/versions/node/v24.11.1/bin/bun")"
cd "$SCRIPT_DIR"
"$BUN_BIN" run fetch.ts "$@"
