#!/bin/bash
# claude-mailman: 메시지 전송 (Incoming Webhook 방식)
# 사용: echo "메시지" | send.sh  또는  cat <<EOF | send.sh ... EOF

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$HOME/.claude/logs/mailman.log"
mkdir -p "$(dirname "$LOG_FILE")"

WEBHOOK_URL="${MAILMAN_WEBHOOK_URL:-$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("webhookUrl",""))' "$SCRIPT_DIR/config.json" 2>/dev/null)}"

if [ -z "$WEBHOOK_URL" ]; then
  echo "[mailman-send] webhookUrl 이 설정되지 않았습니다. config.json 또는 MAILMAN_WEBHOOK_URL 확인."
  exit 2
fi

MESSAGE="$(cat)"
if [ -z "$(printf %s "$MESSAGE" | tr -d '[:space:]')" ]; then
  echo "[mailman-send] 빈 메시지는 전송하지 않습니다."
  exit 1
fi

# JSON payload: {"text": "..."} — 문자열 이스케이프는 python에 위임 (bash 수동 escape 위험)
PAYLOAD="$(printf %s "$MESSAGE" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')"

HTTP_STATUS="$(curl -sS -o /tmp/mailman-send-response.json -w "%{http_code}" \
  -X POST \
  -H "Content-Type: application/json; charset=UTF-8" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL")"

if [ "$HTTP_STATUS" = "200" ]; then
  echo "[mailman-send] ✅ 전송 완료"
  echo "[mailman-send] $(date -Iseconds) ✅ sent (HTTP 200)" >> "$LOG_FILE"
  exit 0
fi

echo "[mailman-send] ❌ 전송 실패 (HTTP $HTTP_STATUS)"
cat /tmp/mailman-send-response.json
echo "[mailman-send] $(date -Iseconds) ❌ fail HTTP=$HTTP_STATUS body=$(cat /tmp/mailman-send-response.json)" >> "$LOG_FILE"
exit 3
