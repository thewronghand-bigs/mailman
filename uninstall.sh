#!/bin/bash
# mailman 제거: 실행 파일(직전 백업 포함)과 슬래시 커맨드·Codex 스킬만 지운다. 설정·데이터·인증정보는 위치만 안내한다.
# 사용: curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/uninstall.sh | bash
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
BIN_FILE="$CLAUDE_DIR/bin/mailman"
BIN_BACKUP="$BIN_FILE.bak"
COMMANDS_DIR="$CLAUDE_DIR/commands"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_SKILL_DIR="$CODEX_DIR/skills/mailman"
LEGACY_SCRIPTS_DIR="$CLAUDE_DIR/scripts/mailman"
DATA_HOME="${MAILMAN_HOME:-$HOME/.claude}"
CONFIG_FILE="${MAILMAN_CONFIG:-$DATA_HOME/mailman/config.json}"
DB_FILE="$DATA_HOME/inbox/mailman-v2.db"
LEGACY_DB_FILE="$DATA_HOME/inbox/mailman.db"
LOG_FILE="$DATA_HOME/logs/mailman.log"
CLIENT_FILE="${MAILMAN_CLIENT_FILE:-$HOME/.claude/secrets/mailman-oauth.json}"
TOKEN_FILE="${MAILMAN_TOKEN_FILE:-$HOME/.claude/secrets/mailman-token.json}"
PROFILE_DIR="$DATA_HOME/state/mailman-chrome"

echo "[mailman] 제거를 시작합니다."

# 1. 실행 파일 (릴리스 바이너리 또는 --dev 심볼릭 링크). 직전 백업도 다시 받을 수 있는 프로그램이라 함께 지운다.
if [ -e "$BIN_FILE" ] || [ -L "$BIN_FILE" ]; then
  rm -f "$BIN_FILE"
  echo "[mailman] 실행 파일 삭제: $BIN_FILE"
else
  echo "[mailman] 실행 파일이 없습니다: $BIN_FILE"
fi
if [ -e "$BIN_BACKUP" ] || [ -L "$BIN_BACKUP" ]; then
  rm -f "$BIN_BACKUP"
  echo "[mailman] 실행 파일 백업 삭제: $BIN_BACKUP"
fi

# 2. 슬래시 커맨드
for command in mailman mailman-deep; do
  file="$COMMANDS_DIR/$command.md"
  if [ -e "$file" ] || [ -L "$file" ]; then
    rm -f "$file"
    echo "[mailman] 슬래시 커맨드 삭제: $file"
  fi
done

# 3. Codex 스킬: 개발 설치 링크면 링크만, 릴리스 설치면 SKILL.md를 지운다. 백업 파일이 남으면 디렉터리는 둔다.
if [ -L "$CODEX_SKILL_DIR" ]; then
  rm -f "$CODEX_SKILL_DIR"
  echo "[mailman] Codex 스킬 링크 삭제: $CODEX_SKILL_DIR"
elif [ -d "$CODEX_SKILL_DIR" ]; then
  if [ -e "$CODEX_SKILL_DIR/SKILL.md" ] || [ -L "$CODEX_SKILL_DIR/SKILL.md" ]; then
    rm -f "$CODEX_SKILL_DIR/SKILL.md"
    echo "[mailman] Codex 스킬 삭제: $CODEX_SKILL_DIR/SKILL.md"
  fi
  rmdir "$CODEX_SKILL_DIR" 2>/dev/null || true
fi

# 4. 설치 때 만든 커맨드·스킬 백업(.bak.<타임스탬프>)은 직접 고친 내용일 수 있어 위치만 안내한다.
backups=()
for candidate in "$COMMANDS_DIR"/mailman.md.bak.* "$COMMANDS_DIR"/mailman-deep.md.bak.* "$CODEX_SKILL_DIR"/SKILL.md.bak.* "$CODEX_DIR"/mailman-skill.bak.*; do
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then backups+=("$candidate"); fi
done
if [ "${#backups[@]}" -gt 0 ]; then
  echo "[mailman] 설치 때 만든 백업이 남아 있습니다. 필요 없으면 직접 삭제하세요:"
  for backup in "${backups[@]}"; do echo "  $backup"; done
fi

# 5. 이전 설치 경로: 심볼릭 링크만 지운다. 실제 디렉터리에는 예전 config.json이 있을 수 있어 안내만 한다.
if [ -L "$LEGACY_SCRIPTS_DIR" ]; then
  rm -f "$LEGACY_SCRIPTS_DIR"
  echo "[mailman] 이전 설치 링크 삭제: $LEGACY_SCRIPTS_DIR"
elif [ -d "$LEGACY_SCRIPTS_DIR" ]; then
  echo "[mailman] 이전 설치 디렉터리는 남겨 두었습니다. 필요 없으면 직접 삭제하세요: $LEGACY_SCRIPTS_DIR"
fi

# 6. 설정·데이터·인증정보는 자동 삭제하지 않는다.
echo ""
echo "[mailman] 설정·데이터·인증정보는 자동 삭제하지 않습니다. 필요하면 직접 삭제하세요:"
echo "  설정: $CONFIG_FILE"
[ -f "$DATA_HOME/mailman/local.md" ] && echo "  개인 컨벤션: $DATA_HOME/mailman/local.md"
echo "  DB 및 보조 파일: $DB_FILE*"
echo "  로그: $LOG_FILE"
echo "  OAuth 클라이언트: $CLIENT_FILE"
echo "  OAuth 토큰: $TOKEN_FILE"
[ -f "$LEGACY_DB_FILE" ] && echo "  레거시 DB: $LEGACY_DB_FILE"
[ -d "$PROFILE_DIR" ] && echo "  레거시 Chrome 프로필: $PROFILE_DIR"
echo "  refresh token을 폐기하려면 Google 계정 → 보안 → 서드파티 연결(https://myaccount.google.com/connections)에서 접근 권한도 삭제하세요."

echo ""
echo "[mailman] 제거 완료."
