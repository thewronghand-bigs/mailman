#!/bin/bash
# mailman installer
# 사용 예시:
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=codex bash
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=all bash
set -euo pipefail

REPO="thewronghand-bigs/mailman"
BRANCH="${MAILMAN_INSTALL_BRANCH:-main}"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"
INSTALL_TARGET="${INSTALL_TARGET:-${1:-claude}}"

SCRIPTS_DIR="$HOME/.claude/scripts/mailman"
COMMANDS_DIR="$HOME/.claude/commands"
CODEX_BIN_DIR="${MAILMAN_CODEX_BIN_DIR:-$HOME/.local/bin}"
CODEX_SKILLS_DIR="${CODEX_HOME:-$HOME/.codex}/skills"
PLUGIN_ROOT="$HOME/plugins/mailman-sandbox"
PLUGIN_RUNTIME_DIR="$PLUGIN_ROOT/runtime"

print_usage() {
  cat <<'EOF'
mailman installer

Usage:
  bash install.sh
  INSTALL_TARGET=codex bash install.sh
  INSTALL_TARGET=all bash install.sh
  bash install.sh claude|codex|all

Targets:
  claude  Install the shared runtime plus Claude /mailman adapter
  codex   Install the shared runtime plus Codex CLI adapter and sandbox plugin
  all     Install everything
EOF
}

download_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  curl -fsSL "$BASE_URL/$src" -o "$dest"
}

ensure_bun() {
  BUN_BIN="$(command -v bun 2>/dev/null || echo "")"
  if [ -z "$BUN_BIN" ]; then
    echo "[mailman] bun 이 설치되어 있지 않습니다."
    echo "  curl -fsSL https://bun.sh/install | bash"
    return 1
  fi
  return 0
}

install_runtime() {
  local script_files="auth.ts collector.ts fetch.ts fetch.sh run.sh send.sh send.ts runtime.ts snapshot.ts package.json config.example.json README.md"

  mkdir -p "$SCRIPTS_DIR"
  for f in $script_files; do
    download_file "scripts/mailman/$f" "$SCRIPTS_DIR/$f"
  done

  chmod +x "$SCRIPTS_DIR/fetch.sh" "$SCRIPTS_DIR/run.sh" "$SCRIPTS_DIR/send.sh"

  if [ ! -f "$SCRIPTS_DIR/config.json" ]; then
    cp "$SCRIPTS_DIR/config.example.json" "$SCRIPTS_DIR/config.json"
    echo "[mailman] config.json 이 생성되었습니다. 반드시 본인 환경에 맞게 수정하세요."
  else
    echo "[mailman] config.json 이 이미 존재합니다. 덮어쓰지 않았습니다."
  fi

  ensure_bun || return 1
  (
    cd "$SCRIPTS_DIR"
    "$BUN_BIN" install --silent 2>/dev/null || "$BUN_BIN" install
  )
}

install_claude_adapter() {
  mkdir -p "$COMMANDS_DIR"
  download_file "commands/mailman.md" "$COMMANDS_DIR/mailman.md"
  echo "[mailman] Claude Code /mailman 어댑터를 설치했습니다."
}

install_codex_cli_adapter() {
  mkdir -p "$CODEX_BIN_DIR" "$CODEX_SKILLS_DIR/mailman"
  download_file "adapters/codex-cli/mailman" "$CODEX_BIN_DIR/mailman"
  download_file "codex-skills/mailman/SKILL.md" "$CODEX_SKILLS_DIR/mailman/SKILL.md"
  chmod +x "$CODEX_BIN_DIR/mailman"

  echo "[mailman] Codex CLI용 mailman 커맨드를 설치했습니다: $CODEX_BIN_DIR/mailman"
  echo "[mailman] Codex skill 을 설치했습니다: $CODEX_SKILLS_DIR/mailman"

  case ":$PATH:" in
    *":$CODEX_BIN_DIR:"*) ;;
    *)
      echo "[mailman] 참고: $CODEX_BIN_DIR 가 PATH 에 없으면 아래를 셸 설정에 추가하세요."
      echo "  export PATH=\"$CODEX_BIN_DIR:\$PATH\""
      ;;
  esac
}

install_codex_plugin() {
  local plugin_files="
.codex-plugin/plugin.json
README.md
INSTALL.md
bootstrap.sh
marketplace.example.json
scripts/extract_google_chat_messages.js
scripts/import_snapshot.sh
skills/mailman-sandbox/SKILL.md
runtime/collector.ts
runtime/config.example.json
runtime/fetch.sh
runtime/fetch.ts
runtime/package.json
runtime/run.sh
runtime/runtime.ts
runtime/snapshot.ts"

  mkdir -p "$PLUGIN_ROOT"
  for f in $plugin_files; do
    download_file "packages/mailman-sandbox-plugin/$f" "$PLUGIN_ROOT/$f"
  done

  # Short skill alias so plugin usage feels closer to /mailman.
  download_file "packages/mailman-sandbox-plugin/skills/mailman/SKILL.md" "$PLUGIN_ROOT/skills/mailman/SKILL.md"
  chmod +x "$PLUGIN_ROOT/bootstrap.sh" "$PLUGIN_ROOT/scripts/import_snapshot.sh" \
    "$PLUGIN_ROOT/runtime/fetch.sh" "$PLUGIN_ROOT/runtime/run.sh"

  (
    cd "$PLUGIN_ROOT"
    bash ./bootstrap.sh
  )

  if [ -f "$SCRIPTS_DIR/config.json" ] && [ ! -f "$PLUGIN_RUNTIME_DIR/config.json" ]; then
    cp "$SCRIPTS_DIR/config.json" "$PLUGIN_RUNTIME_DIR/config.json"
    echo "[mailman] Claude runtime config 를 Codex plugin runtime 으로 복사했습니다."
  fi
}

print_next_steps() {
  echo ""
  echo "============================================"
  echo "[mailman] 설치 완료!"
  echo "============================================"
  echo ""
  echo "다음 단계:"
  echo ""
  echo "  1. 공용 런타임 설정:"
  echo "     vi $SCRIPTS_DIR/config.json"
  echo ""
  echo "  2. 최초 로그인:"
  echo "     bash $SCRIPTS_DIR/run.sh auth"
  echo ""

  if [ -d "$PLUGIN_RUNTIME_DIR" ]; then
    echo "  3. Codex sandbox plugin 설정 확인:"
    echo "     vi $PLUGIN_RUNTIME_DIR/config.json"
    echo ""
  fi

  if [ "$INSTALL_TARGET" = "claude" ] || [ "$INSTALL_TARGET" = "all" ]; then
    echo "  4. Claude Code:"
    echo "     /mailman"
    echo ""
  fi

  if [ "$INSTALL_TARGET" = "codex" ] || [ "$INSTALL_TARGET" = "all" ]; then
    echo "  5. Codex CLI:"
    echo "     mailman"
    echo "     mailman tn specbot 3"
    echo ""
    echo "  6. Codex 샌드박스:"
    echo "     plugin 목록이 갱신되지 않으면 Codex 를 재시작하세요."
    echo ""
  fi
}

case "$INSTALL_TARGET" in
  -h|--help|help)
    print_usage
    exit 0
    ;;
  claude)
    echo "[mailman] Claude 설치를 시작합니다."
    install_runtime
    install_claude_adapter
    ;;
  codex)
    echo "[mailman] Codex 설치를 시작합니다."
    install_runtime
    install_codex_cli_adapter
    install_codex_plugin
    ;;
  all)
    echo "[mailman] Claude + Codex 통합 설치를 시작합니다."
    install_runtime
    install_claude_adapter
    install_codex_cli_adapter
    install_codex_plugin
    ;;
  *)
    echo "[mailman] 지원하지 않는 INSTALL_TARGET: $INSTALL_TARGET"
    echo "[mailman] 사용 가능 값: claude, codex, all"
    exit 1
    ;;
esac
print_next_steps
