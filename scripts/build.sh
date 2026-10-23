#!/bin/bash
# mailman 단일 실행 파일 빌드: dist/mailman-darwin-arm64, dist/mailman-darwin-x64
# 사용: bash scripts/build.sh            (버전은 scripts/mailman/package.json)
#       MAILMAN_VERSION=2.2.0 bash scripts/build.sh   (릴리스 태그 등으로 덮어쓰기)
set -euo pipefail

ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT/scripts/mailman"
DIST_DIR="$ROOT/dist"

# bun 탐색은 개발 실행기와 같은 로직을 쓴다.
source "$SOURCE_DIR/mailman-dev"
mailman_setup_path

VERSION="${MAILMAN_VERSION:-$(MAILMAN_PACKAGE="$SOURCE_DIR/package.json" bun -e 'process.stdout.write((await Bun.file(process.env.MAILMAN_PACKAGE).json()).version)')}"
VERSION="${VERSION#v}"
# --define 값에 그대로 넣으므로 따옴표·공백이 없는 버전만 허용한다.
if ! [[ "$VERSION" =~ ^[0-9A-Za-z.+-]+$ ]]; then
  echo "[build] 버전 형식이 올바르지 않습니다: $VERSION" >&2
  exit 1
fi

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

for arch in arm64 x64; do
  out="$DIST_DIR/mailman-darwin-$arch"
  # x64는 AVX2가 없는 오래된 Intel Mac에서도 돌도록 baseline 타깃을 쓴다.
  target="bun-darwin-$arch"
  [ "$arch" = "x64" ] && target="bun-darwin-x64-baseline"
  echo "[build] $out (v$VERSION, $target)"
  bun build "$SOURCE_DIR/cli.ts" --compile --target="$target" \
    --define "MAILMAN_BUILD_VERSION=\"$VERSION\"" --outfile "$out"
  # bun이 남긴 서명이 codesign 검증을 통과하지 않아 ad-hoc으로 다시 서명한다.
  codesign --force --sign - "$out"
  codesign --verify "$out"
done

# 현재 아키텍처 바이너리로 네트워크를 타지 않는 명령만 스모크한다. 최소 환경에서도 동작해야 한다.
case "$(uname -m)" in
  arm64) native=arm64 ;;
  x86_64) native=x64 ;;
  *) echo "[build] 스모크 생략: 지원하지 않는 아키텍처 $(uname -m)"; exit 0 ;;
esac
binary="$DIST_DIR/mailman-darwin-$native"
reported="$(env -i HOME="$HOME" PATH=/usr/bin:/bin "$binary" --version)"
if [ "$reported" != "mailman $VERSION" ]; then
  echo "[build] --version 불일치: $reported (기대: mailman $VERSION)" >&2
  exit 1
fi
env -i HOME="$HOME" PATH=/usr/bin:/bin "$binary" --help >/dev/null
echo "[build] 스모크 통과: $reported"
