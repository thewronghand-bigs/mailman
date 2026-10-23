# claude-mailman v2.1

Google Chat API를 사용자 OAuth로 호출해 스페이스 메시지를 SQLite에 저장하고, Claude Code 슬래시 커맨드·Codex 스킬 또는 CLI로 조회/전송하는 파이프라인. 배포는 `bun build --compile` 단일 실행 파일(`~/.claude/bin/mailman`)이며, OAuth 클라이언트는 사용자마다 자기 GCP 프로젝트에 만든다(BYO).

## 구조

```
scripts/mailman/
├─ runtime.ts       # 공용 설정, 경로(설정 파일 포함), 스페이스/환경변수 해석
├─ resolve.ts       # 공통 대상·사람 이름 해석, 목록 캐시, 별칭 저장
├─ private-file.ts  # 설정·인증정보 0600 원자 쓰기
├─ auth.ts          # loopback + PKCE OAuth, refresh token 저장/갱신
├─ chat.ts          # Chat API 목록 페이지네이션/텍스트 전송
├─ http.ts          # fetch 주입, HTTP/네트워크 오류 처리
├─ errors.ts        # 종료 코드, 인증정보 비공개 처리
├─ store.ts         # bun:sqlite 스키마, 메시지 upsert, meta
├─ time.ts          # 나노초 보존 RFC3339 정규화
├─ content.ts       # 전송 태그 라벨(Claude/Codex/중립 AI)과 sendPrefix
├─ cards.ts         # 카드 본문과 HTML 서식의 마크다운 렌더링
├─ collector.ts     # 스페이스 전체 메시지 증분/백필 수집
├─ fetch.ts         # seen 이후 조회 → 스레드/이전 맥락 출력 → seen 저장
├─ send.ts          # 태그 접두사/답글을 붙인 전송 본문
├─ wait.ts          # 답장 폴링, quiet 묶음, 시그널·seen 처리
├─ cli.ts           # 단일 진입점: mailman <auth|spaces|collect|fetch|send|wait>, --help, --version
├─ mailman-dev      # 개발 실행기: bun 탐색 후 cli.ts 실행 (install.sh --dev가 링크)
├─ config.example.json
├─ tests/           # 실제 네트워크를 차단한 bun test
└─ package.json     # 외부 의존성 없음
```

- `scripts/build.sh`: `dist/mailman-darwin-{arm64,x64}` 빌드·버전 주입·ad-hoc 서명·스모크. `dist/`는 gitignore.
- `install.sh`: 기본은 GitHub 최신 릴리스 바이너리와 같은 태그의 커맨드·스킬 설치, `--dev`는 레포 심볼릭 링크. `--target claude|codex|all`(또는 `MAILMAN_TARGET`, 기본 claude)로 슬래시 커맨드·Codex 스킬 설치 대상을 고른다. 릴리스 모드는 모든 파일을 임시 디렉터리에 받아 검증한 뒤 한꺼번에 설치하고, 다운로드가 실패하면 기존 설치를 건드리지 않는다. 각 파일은 같은 디렉터리 임시 파일 → `mv` 한 번으로 교체한다. 실행 파일 백업은 직전 1개(`mailman.bak`), 커맨드·스킬은 `.bak.<타임스탬프>`. Codex `--dev`는 `skills/mailman` **디렉터리**를 링크한다(Codex는 링크된 `SKILL.md` 파일을 읽지 않는다). `uninstall.sh`는 실행 파일(+`mailman.bak`)·커맨드·Codex 스킬만 지운다. 테스트는 `tests/shell.test.ts`(가짜 curl로 릴리스 모드 검증).
- `docs/`: GitHub Pages(main `/docs`) 공개 문서. `index.md`(홈), `setup.md`(사용자별 OAuth 클라이언트 설정 가이드), `privacy.md`(개인정보처리방침). 공개되므로 사내 정보·실명을 넣지 않는다. `privacy.md`의 저장 항목은 `store.ts`·`auth.ts`·`collector.ts`가 실제로 저장하는 것과 맞춘다(저장 필드를 바꾸면 방침도 고친다).
- `commands/mailman.md`: `/mailman` 증분 수집/조회, 승인 후 전송 절차.
- `commands/mailman-deep.md`: `/mailman-deep` 최근 30일 백필 재수집.
- `codex-skills/mailman/SKILL.md`: Codex `$mailman` 스킬. 커맨드 문서와 같은 절차(조회·보고 기준·승인 전송·카드 웹훅)를 Claude 전용 문법 없이 쓰고 샌드박스 밖 실행을 안내한다. 커맨드 절차를 바꾸면 이 파일도 같이 고친다.
- 개인 취향(카드 스타일·말투)은 레포에 두지 않는다. 커맨드·스킬은 `$MAILMAN_HOME/mailman/local.md`가 있으면 먼저 읽고 우선해 따른다(승인 전송·웹훅 URL 비노출은 예외).
- `scripts/mailman-legacy/`: 기존 Playwright/snapshot 구현 보존. v2에서 사용하지 않음.

## 런타임과 경로

개발·빌드는 bun 전용. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 쓴다. 배포 실행 파일은 bun 없이 동작해야 하므로 스크립트 위치(`import.meta.url`)나 레포 파일에 의존하지 않는다. 최초 인증은 macOS `open`으로 브라우저를 열며, 이후 수집/전송은 API만 호출한다.

| 변수 | 기본값/의미 |
|------|-------------|
| `MAILMAN_HOME` | `~/.claude`, 데이터 루트 |
| `MAILMAN_CONFIG` | `$MAILMAN_HOME/mailman/config.json`, 설정 파일 |
| `CODEX_HOME` | `~/.codex`, Codex 스킬 설치 위치(`skills/mailman/SKILL.md`). install/uninstall만 사용 |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json`, Google `installed` JSON |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json`, refresh token/이메일/허용 스코프/계정 ID(`user_name`), 0600 |
| `MAILMAN_DEEP` | `1`이면 `--deep`과 같이 수집 커서와 무관하게 최근 30일 백필 (조회 모드는 그대로) |
| `MAILMAN_BACKFILL_DAYS` | 최초/DEEP 창 일수, 기본 7/30일, 1~36500 |
| `MAILMAN_AGENT` | `claude`/`codex`(대소문자 무시), `send --agent`가 없을 때 전송 태그 라벨. 빈 값은 미지정, 그 밖의 값은 exit 1(태그가 꺼져 있거나 `--agent`가 있으면 읽지 않음) |

- DB: `$MAILMAN_HOME/inbox/mailman-v2.db` (새 파일 0600)
- 로그: `$MAILMAN_HOME/logs/mailman.log`
- 인증정보 기본 경로는 `MAILMAN_HOME`과 별개다. 인증정보를 옮길 때는 두 파일 변수를 각각 지정한다.
- 설정은 `$MAILMAN_HOME/mailman/config.json`(`MAILMAN_CONFIG`로 변경)에 둔다. 예전 `scripts/mailman/config.json` 위치와 URL/봇별칭 형식은 호환하지 않는다.

## 개발 시 주의

- 설정/환경변수 해석은 `runtime.ts`에 집중한다.
- 레포·실행 파일·릴리스에 client id/secret, 토큰, webhook URL, 실제 스페이스 ID를 넣지 않는다(공개 레포). 토큰, client secret, webhook URL을 출력하지 않는다.
- `mailman auth --client <파일>`은 `installed` 형식을 검증해 클라이언트 파일 경로로 0600 복사 후 로그인한다. 클라이언트 파일이 없으면 설정 가이드 URL(`runtime.ts`의 `SETUP_GUIDE_URL`)을 안내하고 exit 2.
- access token은 메모리에서만 쓰며 매 실행마다 refresh한다. 토큰 없음은 exit 2, `invalid_grant`는 재인증 안내와 exit 3.
- OAuth 스코프는 `auth.ts`의 다섯 개만 허용한다. 카드 전송은 기존 웹훅 curl 절차를 쓴다.
- 기본/지정 별칭 또는 이름·리터럴·DM으로 선택한 방의 모든 메시지를 저장하고 조회에서도 모든 발신자를 포함한다. 미등록 방은 해당 호출에서만 사용한다. 무엇이 작업에 중요한지는 출력을 읽는 Claude가 판단한다.
- `mailman fetch [스페이스]`는 조회 전에 수집을 시도하고(`--no-collect`로 생략, 실패해도 DB 출력) mailman 자체의 스페이스별 seen 이후 메시지(첫 조회는 최근 24시간)를 오래된 것부터 최대 200건 출력한다. 스레드는 가장 이른 새 메시지순, 내부는 시간순이며 이전 맥락은 스레드당 최근 5건과 생략 건수를 표시한다.
- 출력 성공 후 실제 표시한 새 메시지의 최대 `create_time`을 `seenCreateTime:<space>`에 저장한다. 동일 시각의 200건 경계를 잇기 위해 `seenMessageName:<space>`도 저장한다. 출력 실패/새 메시지 0건이면 seen을 바꾸지 않는다. Google Chat 읽음 상태와는 무관하다.
- `--only bot|human`은 해당 `sender_type`의 새 메시지만 고르며(이전 맥락은 유형 무관) **seen을 바꾸지 않는다**. 거른 조회로 전진하면 거른 쪽 메시지가 기본 조회에서 영구히 빠진다. `--since`와 조합 가능.
- `mailman fetch [스페이스] --since 24h|3d|YYYY-MM-DD`는 지정 시점(날짜는 로컬 자정) 이후를 조회하며 seen을 바꾸지 않는다. 기간 단위는 양의 정수 `h`/`d`다. 상한 초과 시 기본 조회는 재실행으로 이어서 보고, 기간 조회는 `--since`를 좁히고, `--only`만 쓴 조회는 `--since`를 지정하거나 좁히라고 안내한다.
- Claude 커맨드와 Codex 스킬은 같은 DB·seen 커서를 공유한다.
- 일반 텍스트는 사용자 명의로 본문 앞에 `[🤖 <라벨>] ` 태그를 붙여 전송한다. 라벨은 `--agent claude|codex` > `MAILMAN_AGENT` > 중립 `AI` 순(`runtime.ts`의 `resolveSendPrefix`). 설정 최상위 `sendTag: false`(기본 true, 불리언 아니면 설정 오류) 또는 호출 단위 `--no-tag`(설정보다 우선)면 태그 없이 보내고 성공 출력에 그 사실을 한 줄 표시한다. `--no-tag`+`--agent`는 인자 오류다. 커맨드 문서는 `--agent claude`, Codex 스킬은 `--agent codex`로 보낸다. `--thread`로 원 스레드에 답글을 달 수 있다. 슬래시 커맨드의 전송 승인 절차를 유지한다.
- 수집 증분 기준은 마지막 `createTime`이며 조회 seen과 별개다. 기존 메시지 수정분과 오래된 맥락은 DEEP 백필로 보완한다. 수집 페이지 상한/실패에서는 메시지/수집 커서를 부분 갱신하지 않는다. DEEP 수집 후에도 기본 조회는 안 읽은 메시지다.
- `any`를 쓰지 않는다. 외부 응답은 `unknown`에서 좁힌다.
- 검증은 레포 루트에서 `bun test`. fetch와 auth를 주입하고 실제 Google 호출은 하지 않는다. 빌드는 `bash scripts/build.sh`.

## 대상과 답장 대기

- `resolve.ts`에서 config 별칭 → 리터럴 `spaces/ID` → `--dm <사람>` → 표시 이름 순으로 해석한다. 위치 인자와 DM은 함께 받지 않는다. NFKC·소문자·공백 제거 후 정확 일치 우선, 없으면 부분 일치하며 유일한 후보만 사용한다. 여러 개면 이름·종류·ID 목록과 exit 1, 0개면 목록을 한 번 갱신한다. 스페이스 ID를 사용자에게 묻지 않는다.
- `spaces [검색어] [--refresh]`는 설정 파일 없이 `spaces.list`로 목록을 캐시한다(100개씩 최대 1,000페이지, 완전 수신 후 교체). DB `spaces`에는 name/display_name/space_type/updated_at을 저장한다. 별칭/리터럴의 캐시가 없으면 입력 이름·SPACE_TYPE_UNSPECIFIED로 표시해 오프라인 조회를 유지한다.
- DM은 users/ID·이메일 또는 DB 발신자 표시 이름의 유일한 sender_name으로 `spaces:findDirectMessage`를 호출한다. 동명이인은 이메일로 구분하며 404에서는 새 방을 만들지 않는다. `--save`는 기존 별칭 충돌을 거절하고 config의 다른 필드를 보존해 0600 원자 쓰기한다. `send --dry-run`으로 대상·본문을 미리 볼 수 있다.
- `wait`는 실행 시각, `send --wait`는 생성 응답의 createTime 이후를 폴링한다. 기본 quiet 60s·timeout 30m·interval 15s, 첫 답장 후 최대 10분과 timeout 중 빠른 시점까지 묶는다. 중복 수신은 quiet를 늘리지 않는다. quiet 경계도 폴링하며 전체/묶음 제한 시각에는 진행 중 API도 중단한다.
- 토큰의 user_name은 auth id_token의 sub에서 얻은 users/ID다. 기존 토큰은 첫 대기 때 userinfo로 한 번 보완한다. 전송 sender.name 불일치는 경고하고 두 ID 모두 내 메시지에서 제외한다. OAuth 스코프는 그대로 유지한다.
- 대기 전부터 있던 다른 사람의 안 읽은 메시지를 먼저, 이후 답장 묶음을 fetch 렌더러로 출력한다. 두 섹션 모두 출력 성공 뒤 최대 시각·보조 이름으로 seen을 전진한다. thread/from 필터·출력 실패·시그널에서는 유지한다. 누락을 막기 위해 대기 출력은 200건으로 자르지 않는다.
- 빈 대상·`--dm`·`--from`·`--save`는 정규화 후 exit 1이며 대상 생략만 기본 방을 쓴다. 빈 표시 이름은 이름 매칭에서 제외한다. 이름 해석 전 24시간 초과 캐시는 갱신하고 실패하면 경고 후 기존 캐시를 쓴다. DM에는 해석된 users/ID도 표시한다. `--dry-run --save`는 config를 바꾸지 않고 저장할 예정만 알린다.
- `--from`은 전송 전에 ID를 확정한다. 이메일은 수집된 이메일 발신자 별칭 또는 기존 DM의 상대 발신자로 확인한다. DM 수집 기록이 없으면 최근 메시지(기본 7일, MAILMAN_BACKFILL_DAYS 적용)를 조회하며 확정하지 못하면 전송하지 않는다. 대기 중 발신자별 조회는 없으며 봇은 from에서 제외한다.
- timeout 상한은 2h다. 수신 createTime에서 1ns 겹친 폴링과 같은 시각 name 중복 제거로 범위를 전진한다. 연결 오류·5xx·429는 최대 60초 지수 백오프와 연속 실패 5분 이내로 재시도하고, 종료 시 받은 답장을 먼저 출력한다. GET 401은 토큰 갱신 후 1회 재시도하며 POST는 재시도하지 않는다. 대기 오류도 seen을 유지한다.
- 답장 없음은 exit 4, 단독 wait의 SIGINT/SIGTERM은 130/143이다. `send --wait`는 전송 완료를 먼저 출력하며 그 뒤 대기 오류·출력 실패·시그널은 exit 5와 재전송 금지 문구로 알린다. 전송 요청 중 시그널은 130/143과 전송 여부 불확실·Chat 확인 안내다. 시계·sleep·fetch·AbortSignal을 주입해 검증한다. 승인된 질문의 `send --wait`는 Claude Code에서 Bash `run_in_background`로 실행하고 완료 알림의 묶음을 읽어 후속 작업을 한다. Codex는 짧은 timeout으로 블로킹 실행한다. 전송 승인 절차와 해석된 대상 이름·종류·ID 미리보기를 유지한다.
