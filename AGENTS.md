# claude-mailman v2.1

Google Chat API를 사용자 OAuth로 호출해 메시지를 SQLite에 저장하고 CLI/슬래시 커맨드/Codex 스킬로 조회·전송한다. 배포는 단일 실행 파일 `~/.claude/bin/mailman`이고, OAuth 클라이언트는 사용자마다 자기 GCP 프로젝트에 만든다. 구조와 환경변수는 `CLAUDE.md`, 설치는 `INSTALL.md`를 참고한다.

## 구조

- `scripts/mailman/`: 새 v2 런타임. 설정 해석은 `runtime.ts`, OAuth는 `auth.ts`, API는 `chat.ts`, 저장은 `store.ts`에 집중한다.
- `collector.ts`는 모든 메시지를 증분/백필 수집하며 `fetch.ts`가 seen 커서와 스레드 출력을 담당한다.
- `send.ts`가 사용자 명의 텍스트/답글을 전송한다. 태그 접두사(`content.ts`의 `sendPrefix`)는 `runtime.ts`의 `resolveSendPrefix`가 정한다.
- `resolve.ts`는 collect/fetch/send/wait의 대상·사람 이름을 해석하고 `--save`를 처리한다. `wait.ts`는 답장 폴링과 quiet 묶음 출력을 담당한다. `private-file.ts`는 설정·인증정보를 0600으로 원자 교체한다.
- `cli.ts`가 단일 진입점이다: `mailman <auth|spaces|collect|fetch|send|wait>`, `--help`, `--version`. 개발 실행은 `scripts/mailman/mailman-dev`, 빌드는 `scripts/build.sh`(`dist/`, gitignore).
- `install.sh`는 릴리스 바이너리와 커맨드·스킬을 모두 받아 검증한 뒤 한꺼번에 설치하고(실패 시 기존 설치 유지) `--dev`는 레포를 심볼릭 링크한다. `--target claude|codex|all`(또는 `MAILMAN_TARGET`)로 대상을 고른다. 실행 파일 백업은 `mailman.bak` 1개다. `docs/`는 GitHub Pages 공개 문서(홈·설정 가이드·개인정보처리방침)이며 사내 정보·실명을 넣지 않는다.
- `codex-skills/mailman/SKILL.md`: Codex `$mailman` 스킬(`${CODEX_HOME:-~/.codex}/skills/mailman/`에 설치). `--dev`는 디렉터리를 링크한다(Codex는 링크된 `SKILL.md` 파일을 읽지 않는다). Claude 커맨드와 같은 DB·seen 커서를 공유한다.
- 개인 취향은 레포가 아니라 `$MAILMAN_HOME/mailman/local.md`에 둔다. 커맨드·스킬이 먼저 읽고 우선한다.
- `scripts/mailman-legacy/`: Playwright DOM/snapshot 구현 보존. v2는 이전 설정/DB와 호환하지 않는다.
- `commands/mailman.md`, `commands/mailman-deep.md`: 안 읽은 메시지 조회와 최근 30일 백필 수집, 승인 후 전송 절차. 절차를 바꾸면 Codex 스킬도 같이 고친다.

## Codex에서 mailman 실행

- `~/.claude/bin/mailman`은 작업 폴더 밖 `~/.claude/{inbox,logs,secrets,mailman}`에 쓰고 Google API를 호출한다. `workspace-write` 샌드박스에서는 샌드박스 밖 실행(권한 상승)을 요청해 실행한다. 레포 개발·테스트(`bun test`)는 네트워크 없이 레포 안에서만 돈다.

## 런타임과 데이터

- 외부 의존성 없음. `bun:sqlite`와 node 표준 모듈만 사용한다.
- 개발·빌드는 bun 전용이며 실행 파일은 스크립트 위치(`import.meta.url`)에 의존하지 않는다.
- 설정: `MAILMAN_CONFIG`, 기본 `$MAILMAN_HOME/mailman/config.json`.
- DB: `$MAILMAN_HOME/inbox/mailman-v2.db`, 로그: `$MAILMAN_HOME/logs/mailman.log`.
- `MAILMAN_HOME` 기본값은 `~/.claude`.
- OAuth 클라이언트: `MAILMAN_CLIENT_FILE`, 기본 `~/.claude/secrets/mailman-oauth.json`.
- 토큰: `MAILMAN_TOKEN_FILE`, 기본 `~/.claude/secrets/mailman-token.json`, 권한 0600.
- OAuth 파일 기본 경로는 `MAILMAN_HOME`과 별개다. access token은 매번 refresh하고 메모리에서만 쓴다.
- DB의 `spaces`는 내가 속한 스페이스 목록 캐시(이름·종류·리소스 이름·갱신 시각)다. 토큰의 `user_name`은 `users/<Google 계정 sub>`이며 기존 토큰은 첫 대기 때 userinfo로 한 번 보완한다. OAuth 스코프는 추가하지 않는다.
- `--deep`(또는 `MAILMAN_DEEP=1`)은 커서와 무관하게 30일 백필. `MAILMAN_BACKFILL_DAYS`로 최초/백필 창을 덮어쓴다. 최초 기본값은 7일.

## 개발 시 주의

- 공개 레포다. client id/secret, 토큰, webhook URL, 실제 스페이스 ID를 커밋하거나 출력하지 않는다.
- `auth --client <파일>`은 `installed` 형식 검증 후 클라이언트 파일 경로로 0600 복사하고 로그인한다. 클라이언트 파일이 없으면 설정 가이드를 안내하고 exit 2.
- `any` 대신 `unknown`과 타입 좁히기를 쓴다.
- 코드 주석과 문서는 한국어로 작성한다.
- 테스트는 `bun test`. fetch와 auth를 주입하고 실제 Google 호출은 하지 않는다.
- 조회는 발신자와 관계없이 스페이스별 seen 이후 메시지를 오래된 것부터 최대 200건 출력한다. 첫 조회는 24시간이며 이전 맥락은 스레드당 최근 5건이다.
- seen은 출력 성공 후 실제 표시한 새 메시지의 최대 생성 시각으로 전진한다. `--since` 기간 조회와 `--only bot|human` 조회는 seen을 바꾸지 않고 DEEP도 기본 조회 모드를 바꾸지 않는다.
- `mailman send`는 본문 앞에 `[🤖 <라벨>] ` 태그를 붙인다. 라벨은 `--agent claude|codex` > `MAILMAN_AGENT` > 중립 `AI` 순이다. 설정 최상위 `sendTag: false` 또는 `--no-tag`(설정보다 우선)면 태그 없이 보낸다. `--no-tag`+`--agent`는 인자 오류다. Codex 스킬은 `--agent codex`로 보낸다. 카드 전송은 기존 웹훅 curl 절차를 유지한다.
- 슬래시 커맨드의 초안 확인/사용자 승인 절차를 유지한다.
- 대상은 config 별칭 → `spaces/ID` → `--dm <사람>` → 표시 이름 순이다. 표시 이름은 정규화 정확/부분 일치 중 유일한 후보만 사용한다. 다중 후보는 목록과 exit 1, 0개는 목록을 1회 갱신한다. 스페이스 ID를 사용자에게 묻지 않는다. DM은 수집된 발신자 이름·이메일·users/ID로 기존 방만 찾는다. 미등록 방은 해당 호출에서만 사용하며 `--save`는 기존 별칭을 덮어쓰지 않는다.
- 위치 인자·`--dm`·`--from`·`--save`는 정규화 후 빈 값을 exit 1로 거절한다. 위치 인자 생략만 기본 방을 쓴다. 이름이 빈 방은 매칭에서 제외한다. 이름 캐시는 24시간 초과 시 갱신하고 실패하면 경고 후 기존 캐시를 쓴다. DM 출력에는 해석된 users/ID를 넣으며 `--dry-run --save`는 저장 예정만 알린다.
- `--from` ID는 전송 전에 확정한다. 이메일은 수집된 이메일 발신자 별칭 또는 기존 DM의 상대 발신자를 사용한다. DM 기록이 없으면 최근 메시지(기본 7일, MAILMAN_BACKFILL_DAYS 적용)를 조회한다. 확정 실패 시 전송하지 않는다. 대기 중 발신자별 추가 조회는 하지 않고 봇은 from에서 제외한다.
- `wait`/`send --wait`: 기본 quiet 60s·timeout 30m(상한 2h)·interval 15s, 첫 답장 후 묶음 상한 10분/timeout. 직전 수신 createTime에서 1ns 겹쳐 조회하고 같은 시각은 name으로 중복 제거한다. 연결 오류·5xx·429는 최대 60초 백오프로 재시도하고 연속 실패 5분이면 받은 답장을 출력 후 오류 종료한다. 401 GET은 토큰 갱신 후 1회 재시도한다. POST는 재시도하지 않는다.
- 내 메시지를 제외하고 출력 성공 뒤 실제 표시분으로 seen을 전진한다. thread/from 필터·대기 오류·출력 실패·시그널은 seen 불변이다. 답장 없음은 exit 4다. 단독 wait의 SIGINT/SIGTERM은 130/143이며, `send --wait` 전송 완료 뒤 대기 실패·중단은 exit 5와 재전송 금지 문구를 출력한다. 전송 요청 중 시그널은 전송 여부 불확실을 알리고 Chat 확인을 안내한다. 시계·sleep·fetch를 주입해 실제 네트워크 없이 검증한다.
- 답장이 필요한 승인된 질문은 `send --wait`를 쓴다. Claude Code는 Bash `run_in_background`와 완료 알림, Codex는 짧은 timeout의 블로킹 실행을 쓴다. 미리보기에는 해석된 대상의 이름·종류·ID를 표시한다.
