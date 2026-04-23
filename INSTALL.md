# 설치 가이드

기본 사용법은 `README.md`를 기준으로 보고, 에이전트별 연결은 아래 문서를 본다.

- Claude Code: `docs/claude.md`
- Codex: `docs/codex.md`

## 공통 요구사항

- [bun](https://bun.sh) >= 1.0
- Google Chrome 또는 Chromium
- Google Chat 접근 가능한 계정

## 공통 설치

```bash
cd scripts/mailman
cp config.example.json config.json
bun install
bash run.sh auth
```

원라인 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

Claude + Codex 통합 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=all bash
```

## 런타임 경로

기본값:

- 프로필: `~/.claude/state/mailman-chrome`
- DB: `~/.claude/inbox/mailman.db`
- 로그: `~/.claude/logs/mailman.log`

원하면 변경:

```bash
export MAILMAN_HOME="$HOME/.codex/mailman"
```

샌드박스 환경이면 다음처럼 작업 디렉터리나 `/tmp` 를 쓰는 편이 안전하다.

```bash
export MAILMAN_HOME="$PWD/.mailman"
```
