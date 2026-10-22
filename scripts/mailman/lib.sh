#!/bin/bash
# 로그인 셸 PATH가 없는 환경에서도 bun을 찾는다. 세 래퍼에서 함께 사용한다.
mailman_setup_path() {
  local candidate version
  local search_path="$HOME/.bun/bin"
  if [ -n "${NVM_BIN:-}" ]; then search_path="$search_path:$NVM_BIN"; fi

  # nvm 버전은 문자열 순서가 아닌 major/minor/patch 숫자 내림차순으로 찾는다.
  while IFS= read -r version; do
    search_path="$search_path:$HOME/.nvm/versions/node/$version/bin"
  done < <(
    for candidate in "$HOME"/.nvm/versions/node/*/bin; do
      [ -d "$candidate" ] || continue
      version="${candidate%/bin}"
      printf '%s\n' "${version##*/}"
    done | LC_ALL=C sort -t . -k1.2,1nr -k2,2nr -k3,3nr
  )

  export PATH="$search_path:/opt/homebrew/bin:/usr/local/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    echo "[mailman] bun을 찾을 수 없습니다. bun 설치와 PATH를 확인하세요." >&2
    exit 1
  fi
}

mailman_setup_path
