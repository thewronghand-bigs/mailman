#!/bin/bash
# mailman 설치
#
# 릴리스 설치 (bun·Node 불필요):
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_TARGET=all bash
#   curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_VERSION=v2.0.0 bash
#
# 개발 설치 (로컬 레포를 심볼릭 링크, bun 필요):
#   bash install.sh --dev [--target claude|codex|all]
set -euo pipefail

REPO="thewronghand-bigs/mailman"
SETUP_GUIDE_URL="https://thewronghand-bigs.github.io/mailman/setup"
CLAUDE_DIR="$HOME/.claude"
BIN_DIR="$CLAUDE_DIR/bin"
BIN_FILE="$BIN_DIR/mailman"
# 실행 파일은 다시 받을 수 있으므로 직전 1개만 백업한다.
BIN_BACKUP="$BIN_FILE.bak"
COMMANDS_DIR="$CLAUDE_DIR/commands"
COMMANDS="mailman mailman-deep"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_SKILL_DIR="$CODEX_DIR/skills/mailman"
LEGACY_CODEX_ADAPTER="$HOME/.local/bin/mailman"
DATA_HOME="${MAILMAN_HOME:-$HOME/.claude}"
CONFIG_FILE="${MAILMAN_CONFIG:-$DATA_HOME/mailman/config.json}"
LOCAL_FILE="$DATA_HOME/mailman/local.md"
CLIENT_FILE="${MAILMAN_CLIENT_FILE:-$HOME/.claude/secrets/mailman-oauth.json}"
LEGACY_SCRIPTS_DIR="$CLAUDE_DIR/scripts/mailman"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
MODE="release"
TARGET="${MAILMAN_TARGET:-claude}"
RELEASE_TAG=""
# 받은 파일은 STAGE_DIR에 모은다. 도중에 실패해도 임시 파일·디렉터리를 남기지 않는다.
STAGE_DIR=""
CURRENT_TEMP=""
cleanup() {
  rm -f "$CURRENT_TEMP"
  if [ -n "$STAGE_DIR" ]; then rm -rf "$STAGE_DIR"; fi
}
trap cleanup EXIT

print_usage() {
  cat <<'EOF'
mailman installer

Usage:
  bash install.sh [--target claude|codex|all]          GitHub 최신 릴리스를 설치
  bash install.sh --dev [--target claude|codex|all]    로컬 레포를 심볼릭 링크로 연결 (개발용, bun 필요)

Targets:
  claude   ~/.claude/commands/ 에 /mailman, /mailman-deep 슬래시 커맨드 (기본)
  codex    ${CODEX_HOME:-~/.codex}/skills/mailman/SKILL.md 에 $mailman 스킬
  all      둘 다
  실행 파일은 대상과 관계없이 ~/.claude/bin/mailman 하나입니다.

Environment:
  MAILMAN_TARGET    --target 대신 쓸 수 있습니다 (curl | bash 용)
  MAILMAN_VERSION   설치할 릴리스 태그 (예: v2.0.0). 기본은 최신 릴리스
EOF
}

wants_claude() { [ "$TARGET" = "claude" ] || [ "$TARGET" = "all" ]; }
wants_codex() { [ "$TARGET" = "codex" ] || [ "$TARGET" = "all" ]; }

# 기존 파일·링크를 $2로 백업한다. 원본은 그대로 두므로 이어서 mv 한 번으로 교체할 수 있다.
backup_copy() {
  local target="$1" backup="$2"
  rm -f "$backup"
  if [ -L "$target" ]; then
    ln -s "$(readlink "$target")" "$backup"
  else
    # 같은 디렉터리라 하드 링크로 복사 없이 백업한다. 안 되면 복사한다.
    ln "$target" "$backup" 2>/dev/null || cp -p "$target" "$backup"
  fi
  echo "[mailman] 기존 파일 백업: $backup"
}

# 같은 디렉터리의 임시 경로($CURRENT_TEMP)를 대상($1)으로 mv 한 번에 교체한다. 기존 것은 $2로 백업한다.
replace_with_temp() {
  local target="$1" backup="$2"
  if [ -e "$target" ] || [ -L "$target" ]; then backup_copy "$target" "$backup"; fi
  mv -f "$CURRENT_TEMP" "$target"
  CURRENT_TEMP=""
}

# 받아 둔 파일($1)을 대상($2)에 권한 $4로 설치한다. 내용이 같으면 그대로 둔다. $3은 백업 경로.
install_file() {
  local staged="$1" target="$2" backup="$3" mode="$4"
  if [ -f "$target" ] && [ ! -L "$target" ] && cmp -s "$staged" "$target"; then
    echo "[mailman] 변경 없음: $target"
    return
  fi
  mkdir -p "$(dirname "$target")"
  CURRENT_TEMP="$(mktemp "$(dirname "$target")/.$(basename "$target").XXXXXX")"
  cp "$staged" "$CURRENT_TEMP"
  chmod "$mode" "$CURRENT_TEMP"
  replace_with_temp "$target" "$backup"
  echo "[mailman] 설치: $target"
}

# $1 위치에 $2를 가리키는 심볼릭 링크를 만든다. 이미 같은 링크면 그대로 둔다. $3은 백업 경로.
link_file() {
  local target="$1" source="$2" backup="$3"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    echo "[mailman] 이미 연결됨: $target → $source"
    return
  fi
  mkdir -p "$(dirname "$target")"
  CURRENT_TEMP="$(mktemp "$(dirname "$target")/.$(basename "$target").XXXXXX")"
  ln -sf "$source" "$CURRENT_TEMP"
  replace_with_temp "$target" "$backup"
  echo "[mailman] 연결: $target → $source"
}

# Codex 스킬 디렉터리 자리에 있는 기존 것을 치운다. 빈 디렉터리는 지우고, 그 밖의 것은
# skills/ 밖으로 백업한다(skills/ 안에 두면 Codex가 같은 이름의 스킬을 두 번 읽는다).
move_aside_codex_skill_dir() {
  if [ -d "$CODEX_SKILL_DIR" ] && [ ! -L "$CODEX_SKILL_DIR" ] && rmdir "$CODEX_SKILL_DIR" 2>/dev/null; then
    return
  fi
  if [ -e "$CODEX_SKILL_DIR" ] || [ -L "$CODEX_SKILL_DIR" ]; then
    local backup="$CODEX_DIR/mailman-skill.bak.$TIMESTAMP"
    mv "$CODEX_SKILL_DIR" "$backup"
    echo "[mailman] 기존 Codex 스킬 백업: $backup"
  fi
}

# 설정 파일이 없을 때만 예시를 만든다. webhookUrl이 들어갈 수 있어 0600으로 둔다.
create_config_example() {
  local example="$1"
  if [ -e "$CONFIG_FILE" ]; then
    echo "[mailman] 설정 파일이 이미 있습니다. 덮어쓰지 않았습니다: $CONFIG_FILE"
    return
  fi
  mkdir -p "$(dirname "$CONFIG_FILE")"
  CURRENT_TEMP="$(mktemp "$(dirname "$CONFIG_FILE")/.config.json.XXXXXX")"
  cp "$example" "$CURRENT_TEMP"
  chmod 600 "$CURRENT_TEMP"
  mv "$CURRENT_TEMP" "$CONFIG_FILE"
  CURRENT_TEMP=""
  echo "[mailman] 설정 예시를 만들었습니다: $CONFIG_FILE"
}

detect_arch() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "[mailman] macOS만 지원합니다." >&2
    exit 1
  fi
  case "$(uname -m)" in
    arm64) echo arm64 ;;
    x86_64)
      # Apple Silicon의 Rosetta 셸에서도 네이티브 arm64 바이너리를 받는다.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then echo arm64; else echo x64; fi
      ;;
    *) echo "[mailman] 지원하지 않는 아키텍처입니다: $(uname -m)" >&2; exit 1 ;;
  esac
}

resolve_tag() {
  if [ -n "${MAILMAN_VERSION:-}" ]; then
    case "$MAILMAN_VERSION" in v*) echo "$MAILMAN_VERSION" ;; *) echo "v$MAILMAN_VERSION" ;; esac
    return
  fi
  # API 호출 제한을 피하려고 /releases/latest 리다이렉트로 최신 태그를 얻는다.
  local effective
  if ! effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"; then
    effective=""
  fi
  case "$effective" in
    */releases/tag/*) echo "${effective##*/releases/tag/}" ;;
    *) echo "[mailman] 최신 릴리스를 찾을 수 없습니다. 네트워크를 확인하거나 MAILMAN_VERSION으로 태그를 지정하세요. 기존 설치는 바꾸지 않았습니다." >&2; exit 1 ;;
  esac
}

fail_release() {
  echo "[mailman] $1" >&2
  echo "[mailman] 설치를 중단했습니다. 기존 설치는 바꾸지 않았습니다. 네트워크와 릴리스 태그($RELEASE_TAG)를 확인한 뒤 다시 실행하세요." >&2
  exit 1
}

# $1 URL을 $2로 받는다. 실패하거나 빈 파일이면 아무것도 설치하지 않고 끝낸다.
download() {
  local url="$1" dest="$2" label="$3"
  if ! curl -fsSL "$url" -o "$dest"; then fail_release "다운로드 실패: $label"; fi
  if [ ! -s "$dest" ]; then fail_release "받은 파일이 비어 있습니다: $label"; fi
}

# 커맨드·스킬 문서는 front matter(---)로 시작해야 한다. 오류 페이지를 설치하지 않으려는 확인이다.
check_markdown() {
  if [ "$(head -n 1 "$1")" != "---" ]; then fail_release "받은 문서 형식이 올바르지 않습니다: $2"; fi
}

install_release() {
  local arch command
  arch="$(detect_arch)"
  RELEASE_TAG="$(resolve_tag)"
  echo "[mailman] 릴리스 $RELEASE_TAG (darwin-$arch, 대상 $TARGET) 설치를 시작합니다."

  # 1. 필요한 파일을 모두 임시 디렉터리에 받고 검증한다. 여기까지는 기존 설치를 건드리지 않는다.
  STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mailman-install.XXXXXX")"
  local raw="https://raw.githubusercontent.com/$REPO/$RELEASE_TAG"
  download "https://github.com/$REPO/releases/download/$RELEASE_TAG/mailman-darwin-$arch" "$STAGE_DIR/mailman" "mailman-darwin-$arch"
  chmod 755 "$STAGE_DIR/mailman"
  # 받은 파일이 실행되는지 네트워크를 타지 않는 명령으로 확인한다.
  if ! "$STAGE_DIR/mailman" --version >/dev/null 2>&1; then fail_release "받은 실행 파일을 실행할 수 없습니다."; fi
  if wants_claude; then
    for command in $COMMANDS; do
      download "$raw/commands/$command.md" "$STAGE_DIR/$command.md" "commands/$command.md"
      check_markdown "$STAGE_DIR/$command.md" "commands/$command.md"
    done
  fi
  if wants_codex; then
    download "$raw/codex-skills/mailman/SKILL.md" "$STAGE_DIR/SKILL.md" "codex-skills/mailman/SKILL.md"
    check_markdown "$STAGE_DIR/SKILL.md" "codex-skills/mailman/SKILL.md"
  fi
  if [ ! -e "$CONFIG_FILE" ]; then
    download "$raw/scripts/mailman/config.example.json" "$STAGE_DIR/config.example.json" "scripts/mailman/config.example.json"
  fi

  # 2. 모두 받은 뒤 한꺼번에 설치한다. 각 파일은 같은 디렉터리의 임시 파일에서 mv 한 번으로 교체된다.
  install_file "$STAGE_DIR/mailman" "$BIN_FILE" "$BIN_BACKUP" 755
  if wants_claude; then
    for command in $COMMANDS; do
      install_file "$STAGE_DIR/$command.md" "$COMMANDS_DIR/$command.md" "$COMMANDS_DIR/$command.md.bak.$TIMESTAMP" 644
    done
  fi
  if wants_codex; then
    # 개발 설치의 디렉터리 링크가 있으면 레포 파일을 덮어쓰지 않도록 먼저 치운다.
    if [ -L "$CODEX_SKILL_DIR" ] || { [ -e "$CODEX_SKILL_DIR" ] && [ ! -d "$CODEX_SKILL_DIR" ]; }; then
      move_aside_codex_skill_dir
    fi
    install_file "$STAGE_DIR/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md" "$CODEX_SKILL_DIR/SKILL.md.bak.$TIMESTAMP" 644
  fi
  if [ -f "$STAGE_DIR/config.example.json" ]; then
    create_config_example "$STAGE_DIR/config.example.json"
  else
    echo "[mailman] 설정 파일이 이미 있습니다. 덮어쓰지 않았습니다: $CONFIG_FILE"
  fi
}

install_dev() {
  local repo_dir dev_runner command skill_source
  if [ -z "${BASH_SOURCE[0]:-}" ]; then
    echo "[mailman] --dev는 레포 안의 install.sh 파일로 실행하세요 (bash install.sh --dev)." >&2
    exit 1
  fi
  repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dev_runner="$repo_dir/scripts/mailman/mailman-dev"
  if [ ! -f "$dev_runner" ]; then
    echo "[mailman] --dev는 레포 안의 install.sh로 실행하세요: $dev_runner 가 없습니다." >&2
    exit 1
  fi
  echo "[mailman] 개발 설치: $repo_dir (대상 $TARGET)"
  link_file "$BIN_FILE" "$dev_runner" "$BIN_BACKUP"
  if wants_claude; then
    for command in $COMMANDS; do
      link_file "$COMMANDS_DIR/$command.md" "$repo_dir/commands/$command.md" "$COMMANDS_DIR/$command.md.bak.$TIMESTAMP"
    done
  fi
  if wants_codex; then
    # Codex는 심볼릭 링크인 SKILL.md 파일은 읽지 않고 링크된 디렉터리는 따라가므로 디렉터리를 링크한다.
    skill_source="$repo_dir/codex-skills/mailman"
    if [ -L "$CODEX_SKILL_DIR" ] && [ "$(readlink "$CODEX_SKILL_DIR")" = "$skill_source" ]; then
      echo "[mailman] 이미 연결됨: $CODEX_SKILL_DIR → $skill_source"
    else
      mkdir -p "$(dirname "$CODEX_SKILL_DIR")"
      move_aside_codex_skill_dir
      ln -s "$skill_source" "$CODEX_SKILL_DIR"
      echo "[mailman] 연결: $CODEX_SKILL_DIR → $skill_source"
    fi
  fi

  create_config_example "$repo_dir/scripts/mailman/config.example.json"

  if ! (source "$dev_runner" && mailman_setup_path) >/dev/null 2>&1; then
    echo "[mailman] 경고: bun을 찾을 수 없습니다. 개발 설치는 bun이 필요합니다 (https://bun.sh)."
  fi
}

print_next_steps() {
  echo ""
  echo "[mailman] 설치 완료. 다음 단계:"
  echo ""
  echo "  1. 설정 가이드를 따라 본인 GCP 프로젝트에 데스크톱 앱 OAuth 클라이언트를 만들고 JSON을 받습니다."
  echo "     $SETUP_GUIDE_URL"
  echo ""
  echo "  2. 받은 JSON으로 로그인합니다 (클라이언트 파일은 $CLIENT_FILE 에 0600으로 복사됩니다)."
  echo "     $BIN_FILE auth --client ~/Downloads/client_secret_XXXX.json"
  echo ""
  echo "  3. 설정 파일에 조회할 스페이스를 추가합니다."
  echo "     $CONFIG_FILE"
  echo ""
  local step=4
  if wants_claude; then
    echo "  $step. Claude Code에서 /mailman 을 실행합니다."
    step=5
  fi
  if wants_codex; then
    echo "  $step. Codex에서 \$mailman 을 실행합니다. mailman은 작업 폴더 밖에 쓰고 네트워크를 쓰므로"
    echo "     샌드박스 밖 실행 승인이 필요할 수 있습니다 (README의 \"Codex에서 쓰기\" 참조)."
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      echo ""
      echo "[mailman] 터미널에서 mailman만으로 실행하려면 PATH에 추가하세요 (zsh 예시):"
      echo "  echo 'export PATH=\"\$HOME/.claude/bin:\$PATH\"' >> ~/.zshrc"
      echo "  추가하지 않으면 $BIN_FILE 처럼 전체 경로로 실행합니다."
      ;;
  esac
  echo ""
  echo "[mailman] 개인 컨벤션(카드 스타일·말투 등)은 $LOCAL_FILE 에 적어 두면 /mailman·\$mailman 이 먼저 읽습니다 (선택)."
  if [ -e "$LEGACY_SCRIPTS_DIR" ] || [ -L "$LEGACY_SCRIPTS_DIR" ]; then
    echo ""
    echo "[mailman] 참고: 이전 설치 경로 $LEGACY_SCRIPTS_DIR 는 더 이상 쓰지 않습니다."
    echo "  예전 config.json이 있다면 $CONFIG_FILE 로 옮긴 뒤 직접 삭제하세요."
  fi
  if [ -e "$LEGACY_CODEX_ADAPTER" ] || [ -L "$LEGACY_CODEX_ADAPTER" ]; then
    echo ""
    echo "[mailman] 참고: 옛 Codex 어댑터 $LEGACY_CODEX_ADAPTER 가 있습니다."
    echo "  이제 Codex는 \$mailman 스킬과 $BIN_FILE 을 씁니다. 필요 없으면 직접 지우세요."
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help|help) print_usage; exit 0 ;;
    --dev) MODE="dev" ;;
    --target)
      if [ $# -lt 2 ]; then echo "[mailman] --target 값이 없습니다 (claude|codex|all)." >&2; exit 1; fi
      TARGET="$2"
      shift
      ;;
    --target=*) TARGET="${1#--target=}" ;;
    *) print_usage >&2; exit 1 ;;
  esac
  shift
done
case "$TARGET" in
  claude|codex|all) ;;
  *) echo "[mailman] 설치 대상은 claude, codex, all 중 하나여야 합니다: $TARGET" >&2; exit 1 ;;
esac

if [ "$MODE" = "dev" ]; then install_dev; else install_release; fi
print_next_steps
