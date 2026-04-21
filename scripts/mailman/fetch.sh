#!/bin/bash
# claude-mailman: 슬래시 커맨드용 수집+출력 래퍼
# 사용: fetch.sh [limit]
#   limit 생략 시 5

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 수집 시도 (실패해도 기존 DB 내용은 그대로 출력)
bash "$SCRIPT_DIR/run.sh" > /dev/null 2>&1 || true

# PATH 확보 (Claude Code 에서 바로 실행될 때 nvm PATH 누락 대비)
if [ -z "$PATH_ADDED" ]; then
  export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  export PATH_ADDED=1
fi

BUN_BIN="$(command -v bun || echo "$HOME/.nvm/versions/node/v24.11.1/bin/bun")"
cd "$SCRIPT_DIR"
"$BUN_BIN" run fetch.ts "$@"
