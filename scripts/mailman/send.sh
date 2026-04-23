#!/bin/bash
# mailman: 메시지 전송 (Incoming Webhook 방식, 멀티 스페이스 지원)
# 사용: echo "메시지" | send.sh [스페이스별칭]
#   별칭 생략 시 defaultSpace 의 webhookUrl 사용

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAILMAN_HOME="${MAILMAN_HOME:-$HOME/.mailman}"
LOG_FILE="$MAILMAN_HOME/logs/mailman.log"
mkdir -p "$(dirname "$LOG_FILE")"

if [ -z "${PATH_ADDED:-}" ]; then
  export PATH="$HOME/.bun/bin:$HOME/.nvm/versions/node/v24.11.1/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
  export PATH_ADDED=1
fi

BUN_BIN="$(command -v bun || echo "$HOME/.nvm/versions/node/v24.11.1/bin/bun")"
cd "$SCRIPT_DIR"

TMP_OUTPUT="$(mktemp)"
if "$BUN_BIN" run send.ts "$@" >"$TMP_OUTPUT" 2>&1; then
  cat "$TMP_OUTPUT"
  echo "[mailman-send] $(date -Iseconds) ✅ sent" >> "$LOG_FILE"
  rm -f "$TMP_OUTPUT"
  exit 0
fi

cat "$TMP_OUTPUT"
echo "[mailman-send] $(date -Iseconds) ❌ fail" >> "$LOG_FILE"
rm -f "$TMP_OUTPUT"
exit 3
