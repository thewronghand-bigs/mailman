#!/bin/bash
# mailman: 수집 시도 후 조회. 수집 실패 시에도 기존 DB를 출력한다.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib.sh"
exec bun "$SCRIPT_DIR/cli.ts" fetch "$@"
