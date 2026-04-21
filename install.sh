#!/bin/bash
# claude-mailman installer
# 사용: curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/claude-mailman/main/install.sh | bash
set -euo pipefail

REPO="thewronghand-bigs/claude-mailman"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

SCRIPTS_DIR="$HOME/.claude/scripts/mailman"
COMMANDS_DIR="$HOME/.claude/commands"

echo "[mailman] claude-mailman 설치를 시작합니다."

# 1. 디렉토리 생성
mkdir -p "$SCRIPTS_DIR" "$COMMANDS_DIR"

# 2. 스크립트 파일 다운로드
SCRIPT_FILES="auth.ts collector.ts fetch.ts fetch.sh run.sh send.sh package.json config.example.json README.md"
for f in $SCRIPT_FILES; do
  curl -fsSL "$BASE_URL/scripts/mailman/$f" -o "$SCRIPTS_DIR/$f"
done

# 실행 권한
chmod +x "$SCRIPTS_DIR/fetch.sh" "$SCRIPTS_DIR/run.sh" "$SCRIPTS_DIR/send.sh"

# 3. 슬래시 커맨드 파일 다운로드
curl -fsSL "$BASE_URL/commands/mailman.md" -o "$COMMANDS_DIR/mailman.md"

# 4. config.json 생성 (이미 있으면 건드리지 않음)
if [ ! -f "$SCRIPTS_DIR/config.json" ]; then
  cp "$SCRIPTS_DIR/config.example.json" "$SCRIPTS_DIR/config.json"
  echo "[mailman] config.json 이 생성되었습니다. 반드시 본인 환경에 맞게 수정하세요."
else
  echo "[mailman] config.json 이 이미 존재합니다. 덮어쓰지 않았습니다."
fi

# 5. bun 확인 및 의존성 설치
BUN_BIN="$(command -v bun 2>/dev/null || echo "")"
if [ -z "$BUN_BIN" ]; then
  echo "[mailman] bun 이 설치되어 있지 않습니다."
  echo "  curl -fsSL https://bun.sh/install | bash"
  echo "  설치 후 다시 이 스크립트를 실행하거나, 아래를 수동 실행하세요:"
  echo "  cd $SCRIPTS_DIR && bun install"
  exit 1
fi

cd "$SCRIPTS_DIR"
"$BUN_BIN" install --silent 2>/dev/null || "$BUN_BIN" install

echo ""
echo "============================================"
echo "[mailman] 설치 완료!"
echo "============================================"
echo ""
echo "다음 단계:"
echo ""
echo "  1. config.json 수정:"
echo "     vi $SCRIPTS_DIR/config.json"
echo ""
echo "     - spaceUrl:  대상 Google Chat 그룹 DM URL"
echo "     - spaceName: DM 이름 (로그용)"
echo "     - botName:   추적할 봇 표시 이름 (정확히 일치해야 함)"
echo "     - webhookUrl: 메시지 전송용 webhook URL (선택)"
echo ""
echo "  2. 최초 로그인:"
echo "     bash $SCRIPTS_DIR/run.sh auth"
echo ""
echo "  3. Claude Code 에서:"
echo "     /mailman"
echo ""
