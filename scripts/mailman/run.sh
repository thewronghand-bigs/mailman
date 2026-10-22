#!/bin/bash
# mailman: 사용자 OAuth 인증 또는 Chat API 수집
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
exec bun "$SCRIPT_DIR/cli.ts" run "$@"
