#!/bin/bash
# claude-mailman: 삭제
# 사용: curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/uninstall.sh | bash
set -euo pipefail

SCRIPTS_DIR="$HOME/.claude/scripts/mailman"
COMMANDS_DIR="$HOME/.claude/commands"
DATA_HOME="${MAILMAN_HOME:-$HOME/.claude}"
DB_FILE="$DATA_HOME/inbox/mailman-v2.db"
LEGACY_DB_FILE="$DATA_HOME/inbox/mailman.db"
TOKEN_FILE="${MAILMAN_TOKEN_FILE:-$HOME/.claude/secrets/mailman-token.json}"
PROFILE_DIR="$DATA_HOME/state/mailman-chrome"
LOG_FILE="$DATA_HOME/logs/mailman.log"

echo "[mailman] 삭제를 시작합니다."

# 1. 스크립트 삭제
if [ -d "$SCRIPTS_DIR" ] || [ -L "$SCRIPTS_DIR" ]; then
  rm -rf "$SCRIPTS_DIR"
  echo "[mailman] 스크립트 삭제: $SCRIPTS_DIR"
else
  echo "[mailman] 스크립트가 없습니다: $SCRIPTS_DIR"
fi

# 2. 슬래시 커맨드 삭제
for command in mailman mailman-deep; do
  COMMANDS_FILE="$COMMANDS_DIR/$command.md"
  if [ -f "$COMMANDS_FILE" ] || [ -L "$COMMANDS_FILE" ]; then
    rm -f "$COMMANDS_FILE"
    echo "[mailman] 슬래시 커맨드 삭제: $COMMANDS_FILE"
  fi
done

# 3. 데이터와 토큰은 위치만 안내하고 자동 삭제하지 않는다.
echo ""
echo "[mailman] 데이터와 인증정보는 자동 삭제하지 않습니다. 필요하면 직접 삭제하세요:"
echo "  v2 DB 및 보조 파일: $DB_FILE*"
echo "  OAuth 토큰: $TOKEN_FILE"
[ -f "$LEGACY_DB_FILE" ] && echo "  레거시 DB: $LEGACY_DB_FILE"
[ -d "$PROFILE_DIR" ] && echo "  Chrome 프로필: $PROFILE_DIR"
[ -f "$LOG_FILE" ] && echo "  로그: $LOG_FILE"
echo "  refresh token을 폐기하려면 Google 계정의 연결된 앱에서 OAuth 접근 권한도 취소하세요."

echo ""
echo "[mailman] 삭제 완료."
