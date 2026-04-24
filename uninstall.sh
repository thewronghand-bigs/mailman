#!/bin/bash
# claude-mailman: 삭제
# 사용: curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/uninstall.sh | bash
set -euo pipefail

SCRIPTS_DIR="$HOME/.claude/scripts/mailman"
COMMANDS_FILE="$HOME/.claude/commands/mailman.md"
DB_FILE="$HOME/.claude/inbox/mailman.db"
PROFILE_DIR="$HOME/.claude/state/mailman-chrome"
LOG_FILE="$HOME/.claude/logs/mailman.log"

echo "[mailman] 삭제를 시작합니다."

# 1. 스크립트 삭제
if [ -d "$SCRIPTS_DIR" ]; then
  rm -rf "$SCRIPTS_DIR"
  echo "[mailman] 스크립트 삭제: $SCRIPTS_DIR"
else
  echo "[mailman] 스크립트가 없습니다: $SCRIPTS_DIR"
fi

# 2. 슬래시 커맨드 삭제
if [ -f "$COMMANDS_FILE" ]; then
  rm -f "$COMMANDS_FILE"
  echo "[mailman] 슬래시 커맨드 삭제: $COMMANDS_FILE"
fi

# 3. 데이터 삭제 확인
HAS_DATA=false
if [ -f "$DB_FILE" ]; then HAS_DATA=true; fi
if [ -d "$PROFILE_DIR" ]; then HAS_DATA=true; fi
if [ -f "$LOG_FILE" ]; then HAS_DATA=true; fi

if [ "$HAS_DATA" = true ]; then
  echo ""
  echo "[mailman] 수집된 데이터가 남아 있습니다:"
  [ -f "$DB_FILE" ] && echo "  DB: $DB_FILE"
  [ -d "$PROFILE_DIR" ] && echo "  Chrome 프로필: $PROFILE_DIR"
  [ -f "$LOG_FILE" ] && echo "  로그: $LOG_FILE"
  echo ""
  echo "  완전히 삭제하려면:"
  echo "    rm -f $DB_FILE $LOG_FILE"
  echo "    rm -rf $PROFILE_DIR"
else
  echo "[mailman] 데이터 없음."
fi

echo ""
echo "[mailman] 삭제 완료."
