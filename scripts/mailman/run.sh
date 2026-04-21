#!/bin/bash
# claude-mailman: on-demand 수집 래퍼
# 사용법:
#   run.sh           → collector 1회 실행 (기본)
#   run.sh auth      → 최초 로그인 세션 셋업
#
# 설계: Chat API 경로가 막혀서 Playwright + 개인 Chrome 프로필 재사용으로 전환됐다.
# 세션이 만료되면 collector가 exit 3 으로 조용히 종료되고, fetch.ts는 기존 DB 내용을 그대로 보여준다.

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/.claude/logs/mailman.log"
mkdir -p "$(dirname "$LOG_FILE")"

# nvm 사용자 기본 node 경로 확보 (launchd 호환성 유지, on-demand 에도 안전)
if [ -z "$PATH_ADDED" ]; then
  export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  export PATH_ADDED=1
fi

BUN_BIN="$(command -v bun || echo "$HOME/.nvm/versions/node/v24.11.1/bin/bun")"

if [ ! -x "$BUN_BIN" ]; then
  echo "[mailman] $(date -Iseconds) bun not found at $BUN_BIN" >> "$LOG_FILE"
  exit 1
fi

cd "$SCRIPT_DIR"

MODE="${1:-collect}"

if [ "$MODE" = "auth" ]; then
  # headful 로그인. 출력은 사용자가 봐야 하므로 stdout/stderr 둘 다 그대로.
  "$BUN_BIN" run auth.ts
  exit $?
fi

# 수집 모드: stderr만 로그로, stdout은 호출자(슬래시 커맨드)가 받을 수 있게 둔다.
"$BUN_BIN" run collector.ts 2>> "$LOG_FILE"
rc=$?

# exit code 2: 프로필 없음 / 3: 세션 만료 → 사용자에게 힌트
if [ $rc -eq 2 ] || [ $rc -eq 3 ]; then
  echo "[mailman] 로그인 세션이 없거나 만료되었습니다. 다음 명령을 실행하세요:"
  echo "  bash ~/.claude/scripts/mailman/run.sh auth"
fi

exit 0
