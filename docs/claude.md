# Claude Code

mailman v2는 사용자 OAuth + Google Chat API로 수집·전송한다. 설치와 인증 파일 준비는 [INSTALL.md](../INSTALL.md)를 따른다.

## 연결

`~/.claude/scripts/mailman`이 레포의 `scripts/mailman/`을 가리키게 연결하고, `commands/mailman.md`, `commands/mailman-deep.md`를 `~/.claude/commands/`에 복사한다. 기존 심볼릭 링크가 있다면 유지한다.

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

이후 `/mailman [스페이스]`로 mailman이 그 방에서 마지막으로 보여준 이후의 새 메시지를 조회한다. 첫 조회는 최근 24시간이며 모든 발신자를 포함한다. 스페이스 생략 시 설정의 `defaultSpace`를 쓴다.

새 메시지는 오래된 것부터 최대 200건을 스레드로 묶어 출력한다. 스레드는 가장 이른 새 메시지순이며 내부는 시간순이고, 이전 맥락은 스레드당 최근 5건과 생략 건수를 표시한다. 출력 성공 후에만 seen을 전진하며 새 메시지 0건이나 출력 실패에서는 유지한다. 남은 메시지는 재실행으로 이어서 조회한다. seen은 수집 커서나 Google Chat 읽음 상태와 별개다.

`/mailman [스페이스] --since 7d`로 기간을 지정할 수 있다. `24h`, `3d` 같은 양의 정수 시간/일 또는 `YYYY-MM-DD` 로컬 자정 이후를 조회하며 seen을 바꾸지 않는다. 200건이 넘으면 기간을 좁힌다. `/mailman-deep [스페이스]`은 최근 30일 창을 재수집하고 기본 조회(안 읽은 메시지)는 그대로 유지한다.

Claude는 출력 전체에서 API 스펙·변경과 현재 티켓의 관련성, 의현에게 온 요청·질문·확인, 작업에 영향 주는 일정·배포 공지만 보고한다. 잡담·인사·리액션은 보고하지 않는다. 관련 내용이 없으면 `새 메시지 N건, 작업 관련 없음` 한 줄로 끝낸다.

## 참고

- `MAILMAN_HOME`은 DB/로그 루트다. 기본 `~/.claude`이며 DB는 `inbox/mailman-v2.db`다.
- OAuth 파일은 기본 `~/.claude/secrets/` 아래에 있다. 다른 경로는 `MAILMAN_CLIENT_FILE`, `MAILMAN_TOKEN_FILE`로 각각 지정한다.
- 텍스트는 승인 후 사용자 명의 + `[🤖 Claude] ` 태그로 전송한다. `--thread`로 원 스레드에 답글을 달 수 있다.
- `cardsV2`는 [커맨드 문서](../commands/mailman.md)의 기존 웹훅 curl 절차를 쓴다.
