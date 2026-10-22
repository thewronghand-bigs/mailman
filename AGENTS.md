# claude-mailman v2

Google Chat API를 사용자 OAuth로 호출해 메시지를 SQLite에 저장하고 CLI/슬래시 커맨드로 조회·전송한다. 구조와 환경변수는 `CLAUDE.md`, 설치는 `INSTALL.md`를 참고한다.

## 구조

- `scripts/mailman/`: 새 v2 런타임. 설정 해석은 `runtime.ts`, OAuth는 `auth.ts`, API는 `chat.ts`, 저장은 `store.ts`에 집중한다.
- `collector.ts`는 모든 메시지를 증분/백필 수집하며 `fetch.ts`가 seen 커서와 스레드 출력을 담당한다.
- `content.ts`의 `SEND_TAG`를 써서 `send.ts`가 사용자 명의 텍스트/답글을 전송한다.
- `cli.ts`를 `run.sh`, `fetch.sh`, `send.sh`가 호출한다. 이 세 래퍼의 이름/위치를 유지한다.
- `scripts/mailman-legacy/`: Playwright DOM/snapshot 구현 보존. v2는 이전 설정/DB와 호환하지 않는다.
- `commands/mailman.md`, `commands/mailman-deep.md`: 안 읽은 메시지 조회와 최근 30일 백필 수집, 승인 후 전송 절차.

## 런타임과 데이터

- bun 전용, 외부 의존성 없음. `bun:sqlite`와 node 표준 모듈만 사용한다.
- DB: `$MAILMAN_HOME/inbox/mailman-v2.db`, 로그: `$MAILMAN_HOME/logs/mailman.log`.
- `MAILMAN_HOME` 기본값은 `~/.claude`.
- OAuth 클라이언트: `MAILMAN_CLIENT_FILE`, 기본 `~/.claude/secrets/mailman-oauth.json`.
- 토큰: `MAILMAN_TOKEN_FILE`, 기본 `~/.claude/secrets/mailman-token.json`, 권한 0600.
- OAuth 파일 기본 경로는 `MAILMAN_HOME`과 별개다. access token은 매번 refresh하고 메모리에서만 쓴다.
- `MAILMAN_DEEP=1`은 커서와 무관하게 30일 백필. `MAILMAN_BACKFILL_DAYS`로 최초/백필 창을 덮어쓴다. 최초 기본값은 7일.

## 개발 시 주의

- `config.json`은 gitignore 대상. 토큰, client secret, webhook URL은 출력하지 않는다.
- `any` 대신 `unknown`과 타입 좁히기를 쓴다.
- 코드 주석과 문서는 한국어로 작성한다.
- 테스트는 `bun test`. fetch를 주입하고 실제 Google 호출은 하지 않는다.
- 조회는 발신자와 관계없이 스페이스별 seen 이후 메시지를 오래된 것부터 최대 200건 출력한다. 첫 조회는 24시간이며 이전 맥락은 스레드당 최근 5건이다.
- seen은 출력 성공 후 실제 표시한 새 메시지의 최대 생성 시각으로 전진한다. `--since` 기간 조회는 seen을 바꾸지 않고 DEEP도 기본 조회 모드를 바꾸지 않는다.
- `send.sh`는 `[🤖 Claude] ` 태그를 붙인다. 카드 전송은 기존 웹훅 curl 절차를 유지한다.
- 슬래시 커맨드의 초안 확인/사용자 승인 절차를 유지한다.
