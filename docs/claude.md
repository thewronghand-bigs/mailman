# Claude Code

mailman v2는 사용자 OAuth + Google Chat API로 수집·전송한다. 설치와 인증 파일 준비는 [INSTALL.md](../INSTALL.md)를 따른다.

## 연결

`~/.claude/scripts/mailman`이 레포의 `scripts/mailman/`을 가리키게 연결하고, `commands/mailman.md`, `commands/mailman-deep.md`를 `~/.claude/commands/`에 복사한다. 기존 심볼릭 링크가 있다면 유지한다.

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

이후 `/mailman [스페이스] [개수=5] [--all]`을 사용한다. `/mailman-deep`은 같은 인자로 최근 30일 창을 재수집한다. 스페이스 생략 시 설정의 `defaultSpace`를 쓴다.

## 참고

- `MAILMAN_HOME`은 DB/로그 루트다. 기본 `~/.claude`이며 DB는 `inbox/mailman-v2.db`다.
- OAuth 파일은 기본 `~/.claude/secrets/` 아래에 있다. 다른 경로는 `MAILMAN_CLIENT_FILE`, `MAILMAN_TOKEN_FILE`로 각각 지정한다.
- 텍스트는 승인 후 사용자 명의 + `[🤖 Claude] ` 태그로 전송한다. `--thread`로 원 스레드에 답글을 달 수 있다.
- `cardsV2`는 [커맨드 문서](../commands/mailman.md)의 기존 웹훅 curl 절차를 쓴다.
