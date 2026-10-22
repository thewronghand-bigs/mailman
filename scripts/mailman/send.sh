#!/bin/bash
# mailman: stdin 본문을 사용자 명의로 전송. 카드 전송은 별도 웹훅 절차를 쓴다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
exec bun "$SCRIPT_DIR/cli.ts" send "$@"
