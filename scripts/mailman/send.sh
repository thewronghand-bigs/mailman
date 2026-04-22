#!/bin/bash
# claude-mailman: 메시지 전송 (Incoming Webhook 방식, 멀티 스페이스 지원)
# 사용: echo "메시지" | send.sh [스페이스별칭]
#   별칭 생략 시 defaultSpace 의 webhookUrl 사용

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/.claude/logs/mailman.log"
mkdir -p "$(dirname "$LOG_FILE")"

SPACE_KEY="${1:-}"

# config.json에서 webhookUrl 추출 (스페이스 별칭 지원)
WEBHOOK_URL="${MAILMAN_WEBHOOK_URL:-$(python3 -c '
import json, sys
cfg = json.load(open(sys.argv[1]))
key = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else cfg.get("defaultSpace", "")
spaces = cfg.get("spaces", {})
if key in spaces:
    print(spaces[key].get("webhookUrl", ""))
else:
    print("")
' "$SCRIPT_DIR/config.json" "$SPACE_KEY" 2>/dev/null)}"

if [ -z "$WEBHOOK_URL" ]; then
  echo "[mailman-send] webhookUrl 이 설정되지 않았습니다. config.json 의 spaces.${SPACE_KEY:-default}.webhookUrl 확인."
  exit 2
fi

MESSAGE="$(cat)"
if [ -z "$(printf %s "$MESSAGE" | tr -d '[:space:]')" ]; then
  echo "[mailman-send] 빈 메시지는 전송하지 않습니다."
  exit 1
fi

PAYLOAD="$(printf %s "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')"

HTTP_STATUS="$(curl -sS -o /tmp/mailman-send-response.json -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json; charset=UTF-8" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL")"

if [ "$HTTP_STATUS" = "200" ]; then
  echo "[mailman-send] ✅ 전송 완료 (space=${SPACE_KEY:-default})"
  echo "[mailman-send] $(date -Iseconds) ✅ sent (HTTP 200) space=${SPACE_KEY:-default}" >> "$LOG_FILE"
  exit 0
fi

echo "[mailman-send] ❌ 전송 실패 (HTTP $HTTP_STATUS)"
cat /tmp/mailman-send-response.json
echo "[mailman-send] $(date -Iseconds) ❌ fail HTTP=$HTTP_STATUS space=${SPACE_KEY:-default} body=$(cat /tmp/mailman-send-response.json)" >> "$LOG_FILE"
exit 3
