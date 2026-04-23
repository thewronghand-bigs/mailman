# Codex 설치

Codex는 두 경로를 지원한다.

- Codex CLI: 로컬 `mailman` 커맨드
- Codex 샌드박스: `Mailman Sandbox` plugin

## 빠른 설치

Codex만 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=codex bash
```

Claude와 같이 설치:

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | INSTALL_TARGET=all bash
```

## 설치 결과

위 스크립트는 아래를 준비한다.

- 공용 런타임: `~/.claude/scripts/mailman`
- Codex CLI 커맨드: `~/.local/bin/mailman`
- Codex CLI skill: `~/.codex/skills/mailman`
- Codex sandbox plugin: `~/plugins/mailman-sandbox`
- local marketplace 등록: `~/.agents/plugins/marketplace.json`

plugin 목록이 바로 안 보이면 Codex를 재시작한다.

## 설치 후 할 일

1. 공용 설정 파일 수정

```bash
vi ~/.claude/scripts/mailman/config.json
```

2. 최초 로그인

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

3. 필요하면 sandbox plugin 설정 확인

```bash
vi ~/plugins/mailman-sandbox/runtime/config.json
```

설치 스크립트는 가능하면 Claude runtime 설정을 plugin runtime에도 복사한다.

## 참고

- Codex CLI 기본 `MAILMAN_HOME` 은 `~/.mailman` 이다.
- Claude와 완전히 같은 데이터 루트를 쓰고 싶으면 직접 지정하면 된다.

```bash
export MAILMAN_HOME="$HOME/.claude/mailman"
```
