# Claude Code

Claude Code에서는 공용 런타임 위에 슬래시 커맨드 어댑터만 얹으면 된다.

## 설치

기존 설치 스크립트는 Claude 어댑터용이다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

이 경로는 그대로 유지된다. Codex 지원까지 같이 넣고 싶으면 `INSTALL_TARGET=all` 만 추가로 쓰면 된다.

설치 후 권장 환경변수:

```bash
export MAILMAN_HOME="$HOME/.claude/mailman"
```

## 설정

```bash
vi ~/.claude/scripts/mailman/config.json
```

최초 로그인:

```bash
MAILMAN_HOME="$HOME/.claude/mailman" bash ~/.claude/scripts/mailman/run.sh auth
```

이후 `/mailman` 은 기존처럼 `~/.claude/scripts/mailman/fetch.sh` 를 호출한다.

## 참고

- `commands/mailman.md` 는 Claude 전용 어댑터 문서다.
- 런타임 데이터는 `MAILMAN_HOME` 아래에 저장된다.
