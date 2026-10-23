# mailman v2.1 런타임

Google Chat API를 사용자 OAuth로 호출하는 bun 런타임. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 사용한다. 배포본은 `cli.ts`를 `bun build --compile`한 단일 실행 파일이다. 설치는 [루트 가이드](../../INSTALL.md)를 참고한다.

## 명령

예시는 `~/.claude/bin`이 PATH에 있다고 가정한다. 아니면 `~/.claude/bin/mailman` 전체 경로로 실행한다.

```bash
mailman auth [--client <client_secret.json>]
mailman spaces [검색어] [--refresh]
mailman collect [대상] [--dm <사람>] [--save <별칭>] [--deep]
mailman fetch [대상] [--dm <사람>] [--save <별칭>] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep]
printf '%s\n' '본문' | mailman send [대상] [--dm <사람>] [--save <별칭>] [--thread spaces/.../threads/...] [--agent claude|codex] [--no-tag] [--dry-run | --wait]
mailman wait [대상] [--dm <사람>] [--save <별칭>] [--thread spaces/.../threads/...] [--from <사람>] [--quiet 60s] [--timeout 30m] [--interval 15s]
mailman --help
mailman --version
MAILMAN_BACKFILL_DAYS=60 mailman collect team --deep
```

개발 중에는 레포에서 `./mailman-dev <명령>`(또는 `bun cli.ts <명령>`)로 같은 CLI를 실행한다. `mailman-dev`는 `~/.bun/bin`, `NVM_BIN`, `~/.nvm/versions/node/*/bin`(버전 내림차순), `/opt/homebrew/bin`, `/usr/local/bin`, 기존 PATH 순서로 bun을 찾고 심볼릭 링크로 실행돼도 레포 위치를 찾는다. source하면 bun 탐색 함수 `mailman_setup_path`만 정의한다(`scripts/build.sh`에서 사용).

각 명령은 `--help`를 지원한다. help·버전·옵션 해석 오류에서는 설정을 읽거나 인증·수집을 시도하지 않는다. 대상 생략 시 설정의 `defaultSpace`를 쓴다. 조회는 한 번에 새 메시지 최대 200건이다. `fetch`는 조회 전에 수집을 시도하며 `--no-collect`로 메시지 수집을 생략한다(대상 이름/DM 해석은 API를 호출할 수 있음). `--deep`과 `--no-collect`는 함께 쓸 수 없다.

## 대상 해석

`resolve.ts`를 collect/fetch/send/wait가 공유한다. config 별칭, 리터럴 `spaces/ID`, `--dm <사람>`, 스페이스 표시 이름 순서다. 위치 인자와 `--dm`은 배타적이다. 이름은 NFKC·소문자·공백 제거 후 정확 일치 우선, 없으면 부분 일치하며 유일해야 한다. 다중 후보는 이름·종류·ID를 안내하고 exit 1이다. 0개면 캐시를 한 번 새로 고치고 재시도하며, 그래도 없으면 `mailman spaces`를 안내한다. 빈 캐시도 가져온 상태를 기록해 매번 다시 요청하지 않는다.

`spaces`는 설정 파일 없이 동작한다. `spaces.list`를 100개씩 최대 1,000페이지 받아 완전히 성공한 뒤 목록 캐시를 원자 교체한다. 검색은 표시 이름 부분 일치다. `--refresh` 또는 캐시가 없을 때만 API를 호출한다. `--dm`은 `users/ID`·이메일(`users/<이메일>`)을 그대로 쓰고, 사람 이름은 DB 발신자의 표시 이름을 정규화 정확 일치해 유일한 `sender_name`을 찾는다. 동명이인은 후보를 보여 주고 이메일을 요청한다. `spaces:findDirectMessage`의 404는 아직 DM이 없다는 안내이며 생성하지 않는다.

위치 인자·`--dm`·`--from`·`--save`가 정규화 후 비면 설정/API 접근 전에 exit 1이다. 위치 인자 생략만 defaultSpace를 사용한다. 빈 표시 이름은 이름 매칭 후보에서 제외한다. 이름 해석 전 목록 캐시가 24시간을 초과했으면 한 번 갱신한다. 실패하면 기존 캐시를 유지하고 경고한다. 그 호출에서는 다시 갱신하지 않는다.

미등록 방도 이번 호출에서만 수집·조회·전송한다. `--save`만 최신 config에 새 별칭을 추가한다. 기존 별칭 충돌은 거절하고 모든 다른 필드를 보존해 0600 임시 파일에서 원자 교체한다. 출력·전송 미리보기 첫 줄은 `[대상] 이름 (종류, spaces/...)`다. 기존 별칭·리터럴의 메타데이터가 캐시에 없을 때는 입력 이름과 `SPACE_TYPE_UNSPECIFIED`를 표시해 오프라인 조회를 유지한다. `spaces --refresh`로 보완할 수 있다. `send --dry-run`은 대상과 태그 적용 본문을 출력하고 전송하지 않는다.

DM 대상에는 `DM: 입력 → users/ID`도 표시한다. `--dry-run --save`는 별칭 충돌을 검사하고 저장할 예정만 표시하며 config 내용·권한을 바꾸지 않는다.

- `auth --client <파일>`: Google 데스크톱 앱(`installed`) 형식과 인증 주소를 검증한 뒤 클라이언트 파일 경로로 0600 원자 복사하고 로그인한다. 같은 경로면 권한만 맞춘다. 검증 실패 시 복사·로그인하지 않는다(exit 1).
- `auth`: 기존 클라이언트 파일로 로그인한다. 파일이 없으면 설정 가이드 URL을 안내하고 exit 2.

## 빌드

```bash
bash ../build.sh                         # 버전은 package.json
MAILMAN_VERSION=2.1.0 bash ../build.sh   # 버전 덮어쓰기
```

`--target=bun-darwin-arm64`/`bun-darwin-x64`로 `dist/mailman-darwin-arm64`, `dist/mailman-darwin-x64`를 만들고 `--define MAILMAN_BUILD_VERSION`으로 버전을 주입한 뒤 ad-hoc 서명한다. 현재 아키텍처 바이너리로 최소 환경(`env -i`)에서 `--version`·`--help`를 스모크한다. `dist/`는 gitignore 대상이다. 컴파일된 실행 파일은 스크립트 위치(`import.meta.url`)에 의존하지 않는다.

## 설정과 경로

설정 예시는 `config.example.json`이다. `defaultSpace`와 `spaces.<별칭>.space`를 작성한다. 선택적인 `webhookUrl`은 카드 전송용이며 v2 텍스트 전송에서는 사용하지 않는다. 최상위 `sendTag`(선택, 기본 `true`)를 `false`로 두면 전송 태그를 붙이지 않는다. 불리언이 아니면 설정 오류(exit 1)다. 이전 설정/DB와 호환하지 않는다.

| 변수 | 기본값/용도 |
|------|-------------|
| `MAILMAN_HOME` | `~/.claude`, DB와 로그 루트 |
| `MAILMAN_CONFIG` | `$MAILMAN_HOME/mailman/config.json`, 설정 파일 |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json`, Google `installed` 형식 |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json`, 0600 |
| `MAILMAN_DEEP` | `1`이면 `--deep`과 같이 최근 30일 창 전체를 재수집 |
| `MAILMAN_BACKFILL_DAYS` | 최초/DEEP 일수 오버라이드, 기본 7/30일, 1~36500 |
| `MAILMAN_AGENT` | `claude`/`codex`(대소문자 무시), `--agent`가 없을 때 전송 태그 라벨. 빈 값은 미지정 |

- DB: `$MAILMAN_HOME/inbox/mailman-v2.db` (새 파일은 생성 시 0600, 기존 파일 권한은 유지)
- 로그: `$MAILMAN_HOME/logs/mailman.log`
- OAuth 파일 기본 경로는 `MAILMAN_HOME`과 독립적이다.
- Chrome 프로필, snapshot driver, 봇별칭, webhook override 환경변수는 v2에 없다.

## OAuth

`auth.ts`는 macOS `open`, `127.0.0.1` 임의 포트 loopback, PKCE S256, state 검증을 쓴다. 인증 대기는 최대 5분이며 `access_type=offline`, `prompt=consent`를 보낸다.

허용 스코프는 `openid`, `userinfo.email`, `chat.spaces.readonly`, `chat.messages.readonly`, `chat.messages.create`의 다섯 개다. `openid` 외에는 `https://www.googleapis.com/auth/` 접두사를 쓴다. 요청/허용 스코프를 검증하고, 검증된 계정 이메일은 Bearer 헤더로 호출한 Google userinfo에서 확인한다.

토큰 파일은 `refresh_token`, `email`, `scopes`, `user_name`(`users/<Google 계정 sub>`)을 저장한다. auth는 토큰 응답의 id_token에서 sub를 읽고 userinfo의 sub와도 대조한다. id_token이 없으면 userinfo의 sub를 쓴다. 이전 토큰의 user_name은 첫 대기 때 userinfo를 한 번 호출해 보완한다. 0600 임시 파일을 만든 뒤 원자적으로 교체한다. access token은 수집/전송 때마다 refresh로 발급하고 메모리에서만 쓰며 id_token 원문도 저장하지 않는다. 원본 OAuth 에러, 토큰, client secret, webhook URL은 출력하지 않는다.

## 수집과 스키마

`messages.list`를 `orderBy=createTime asc`, `filter=createTime > "RFC3339"`, `pageSize=100`으로 호출한다. 다음 토큰이 없어질 때까지 최대 1,000페이지를 받는다. 반복 토큰이나 상한 초과는 실패이며 DB/커서는 갱신하지 않는다. 전체 페이지 수신과 유효성 확인 뒤 한 트랜잭션으로 저장한다.

```text
messages(
  name TEXT PRIMARY KEY,
  space TEXT NOT NULL,
  create_time TEXT NOT NULL,
  last_update_time TEXT NOT NULL,
  sender_name TEXT,
  sender_display_name TEXT,
  sender_type TEXT,
  text TEXT NOT NULL,
  thread_name TEXT,
  attachments_json TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
)
meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)
spaces(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, space_type TEXT NOT NULL, updated_at TEXT NOT NULL)
```

스페이스/작성 시각, 스페이스/스레드/작성 시각 인덱스를 가진다. 시각은 UTC·소수 9자리로 맞춰 Google의 나노초 정밀도를 잃지 않고 비교한다. `lastUpdateTime`이 없으면 생성 시각을 쓴다. `name`이 같고 내용이 바뀌었으면 갱신하되, 오래된 수정본은 최신 내용을 덮어쓰지 않는다. 동일 내용은 재저장하지 않는다.

- `lastCreateTime:spaces/ID`: 받은 최대 `createTime`. 빈 응답/오래된 백필로 후퇴하지 않는다.
- `lastSync:spaces/ID`: 전체 페이지 수신과 저장에 마지막으로 성공한 시각.
- `seenCreateTime:spaces/ID`: 출력 성공 후 실제 보여준 새 메시지의 최대 생성 시각. 수집 커서나 Google Chat 읽음 상태와 별개다.
- `seenMessageName:spaces/ID`: 그 시각에 마지막으로 보여준 메시지 이름. 같은 생성 시각에 200건 경계가 걸려도 누락 없이 잇기 위한 보조 커서다. seen 시각과 함께 원자적으로 저장한다.
- `received`: 받은 수. `saved`: 새로 저장/수정 갱신한 수의 합계. 같은 내용을 다시 받으면 0건이다.

최초 수집은 7일, DEEP은 30일 창을 쓴다. DEEP은 기존 수집 커서를 무시하고 창 전체를 받으며 조회 seen을 바꾸지 않는다. 생성 시각 기준 증분이므로 과거 메시지의 수정은 백필로 반영한다. 페이지 중간 실패나 DB 저장 실패는 전체 실패로 처리한다.

수집 성공은 스페이스·받은 수·저장 수를 로그에 한 줄로 남긴다. 인증·네트워크·API 등 수집 실패도 같은 로그에 시각·스페이스·오류 요약을 한 줄로 남긴다. 비밀값은 제거하고 stderr 오류 안내도 유지한다.

## 조회와 전송

수집 범위는 기본/지정 별칭 또는 호출에서 이름·리터럴·DM으로 선택한 스페이스다. 저장과 조회 모두 사람·봇·mailman 전송을 포함한다. 본문을 그대로 출력하며 작업 관련성은 이를 읽는 Claude가 판단한다.

기본 조회는 스페이스별 `seenCreateTime` 이후의 생성 시각을 가진 메시지다. 커서가 없으면 실행 시각의 24시간 전을 기준으로 쓴다. `--since 24h`, `3d`, `7d`는 실행 시각에서 양의 정수 시간/일을 빼고, `--since YYYY-MM-DD`는 실행 환경의 로컬 자정을 기준으로 쓴다. 기준 시각과 같은 메시지는 새 메시지에서 제외한다. 기간 조회는 seen을 읽거나 바꾸지 않는다. DEEP 수집 후에도 기본 조회는 안 읽은 메시지다.

새 메시지를 `create_time`, `name` 오름차순으로 최대 200건 고른다. seen의 보조 이름이 있으면 같은 시각의 더 뒤 이름도 이어서 조회한다. 스레드는 그 스레드의 가장 이른 새 메시지순, 내부는 시간순으로 묶는다. 스레드 이름이 없는 메시지는 각각 독립 항목으로 취급한다. 새 답글 앞의 저장된 메시지 중 최근 5건을 **이전 맥락**으로 표시하고 나머지 생략 건수도 알린다. 이전 맥락은 새 메시지 상한에 포함하지 않는다. 상한으로 잘린 나중 답글은 이번 출력에 포함하지 않는다.

`--only bot|human`은 새 메시지 선정(200건 상한과 남은 건수 포함)을 해당 `sender_type`으로 거른다. 이전 맥락은 유형과 무관하게 붙인다. `--only` 조회는 seen을 읽어 기준으로 쓰지만 **바꾸지 않는다**. 거른 조회로 전진하면 거른 쪽 메시지가 기본 조회에서 영구히 빠지기 때문이다. `--since`와 함께 쓰면 기간 기준으로 거른다. 상한 초과 시 `--since`가 있으면 기간을 좁히라고, `--only` 단독이면 seen이 바뀌지 않아 같은 메시지가 다시 나온다며 `--since`를 지정하거나 좁히라고 안내한다.

출력 머리에 `thread_name`과 DB 기준 첫 메시지 `name`을 표시한다. 첫 메시지가 이전 맥락 제한으로 생략되어도 DB 기준 이름은 유지한다. 각 메시지에 시각·발신자 표시명(없으면 사용자 리소스 이름)·BOT/HUMAN 구분을 붙인다. 수집 창 밖의 메시지/원문이 없을 수 있다.

stdout 쓰기가 완료된 뒤 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진한다. 동시 조회에서도 더 뒤의 seen을 되돌리지 않는다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`와 기존 수집 메타를 출력한다. 상한 초과 시 기본 조회는 `N건 더 남음 — 다시 실행하면 이어서` 안내를, 기간 조회는 `--since`를 좁히라는 안내를 출력한다.

첨부는 `contentName`, `contentType`, 리소스 `name` 순서로 표시한다. `cardsV2[].card`와 구형 `cards[]`의 제목·섹션·위젯 본문은 마크다운 텍스트로 펼친다. HTML 서식과 엔티티를 변환하며 코드블록 안의 들여쓰기와 원문은 엔티티만 풀어 보존한다. 버튼 링크, 중첩 열, 그리드, 이미지 설명도 표시하고 알 수 없는 위젯은 건너뛴다. 메시지 텍스트가 있으면 먼저 출력하고 그 아래 카드를 붙인다. 표시할 내용이 없는 카드는 `(카드)`로 표시한다.

텍스트 전송은 로그인한 사용자 명의이며 본문 첫 줄 앞에 `[🤖 <라벨>] `을 한 번 붙인다(`content.ts`의 `sendPrefix`). 결정은 `runtime.ts`의 `resolveSendPrefix`가 한다: `--no-tag`면 태그 없음, 아니면 설정 `sendTag: false`면 태그 없음, 아니면 라벨을 `--agent` > `MAILMAN_AGENT` > 중립 `AI` 순으로 정한다(`claude`→`Claude`, `codex`→`Codex`, 그 밖의 값은 exit 1). `MAILMAN_AGENT`는 태그를 붙이고 `--agent`가 없을 때만 읽는다. `--no-tag`와 `--agent`를 같이 주면 인자 오류다. 태그 없이 보내면 성공 출력에 `태그 없이 전송했습니다 (--no-tag)` 또는 `(설정 sendTag: false)` 한 줄을 붙인다. 값 검증은 모두 refresh 전에 끝난다. `--thread`는 같은 스페이스의 리소스 이름이어야 하고 `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`로 전송한다. 성공 시 message/thread 이름을 출력한다. 실패 시 자동 재시도하지 않는다. 카드는 사용자 OAuth 범위 밖이며 [커맨드 문서](../../commands/mailman.md)의 웹훅 curl 절차를 사용한다.

## 답장 대기

`wait.ts`는 시계(`now`/`sleep`), API fetch, AbortSignal을 주입받는다. 단독 `wait`는 CLI 실행 시각, `send --wait`는 전송 응답의 createTime 이후를 고정 필터로 반복 조회한다. 먼저 일반 증분 수집으로 이전 안 읽은 메시지를 보충하고, 각 폴링 결과는 같은 upsert로 저장하되 수집 커서는 별도로 뛰어넘지 않는다. API에서 같은 메시지를 다시 받아도 quiet는 재시작하지 않는다.

기본 `--quiet 60s --timeout 30m --interval 15s`이며 양의 정수 s/m/h를 받는다. timeout 상한은 2시간이며 초과하면 exit 1이다. 내 Google 계정 ID를 제외하고, thread/from이 있으면 해당 답장만 고른다. 새 답장을 발견할 때마다 quiet를 다시 센다. 마지막 답장부터 quiet가 지나면 묶음을 출력하며, 첫 답장부터 10분 또는 전체 timeout 중 빠른 시점에도 반환한다. quiet가 interval보다 짧으면 quiet 경계에 한 번 더 폴링한다. API 페이지 수신도 전체/묶음 제한 시각에 중단한다. timeout까지 답장이 없으면 `답장 없음`과 exit 4다.

`--from`은 전송/대기 전에 ID로 확정한다. 이름은 수집된 sender_name으로, users/ID는 직접 비교한다. 이메일 발신자 별칭이 이미 DB에 있으면 그대로 비교하고, 없으면 기존 DM에서 내가 아닌 사람 발신자를 찾는다. DM의 수집 기록이 없으면 최근 메시지를 조회한다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 상대가 없거나 유일하지 않으면 전송하지 않고 수집된 정확한 이름이나 users/ID를 안내한다. 추가 스코프나 멤버 API 없이 정식 ID를 확인하기 위한 선택이다. 대기 중 발신자별 조회는 없으며 봇은 from과 일치하지 않는다. `send --wait`에서 sender.name이 계정 ID와 다르면 경고하고 두 ID 모두 내 메시지에서 제외한다. 전송 응답에 createTime이 없으면 전송 완료 정보와 재전송 금지 문구를 출력하고 exit 5다.

폴링은 직전 수신의 최대 createTime 경계부터 조회한다. `createTime >` 필터의 경계를 1ns 겹치고 같은 시각의 수신 이름을 기억해 중복을 제거한다. 같은 시각에 작은 이름이 나중에 도착해도 포함하며 내 메시지·필터 제외 메시지도 수신 커서에는 반영한다. 준비 수집의 증분 커서와 대기의 수신 커서는 별개다.

연결 오류·5xx·429는 interval부터 최대 60초까지 지수 백오프하며 남은 전체/묶음 시간과 연속 실패 5분 이내로 제한한다. 재시도는 비밀값을 지운 한 줄을 stderr와 로그에 남긴다. 연속 실패 5분, 재시도 중 제한 시간 도달, 영구 오류면 모은 답장을 먼저 출력하고 seen을 유지한 채 오류 종료한다. GET의 401은 refresh token으로 access token을 갱신한 뒤 1회만 재시도한다. 전송 POST는 재시도하지 않는다.

출력은 `대기 전부터 있던 안 읽은 메시지` 다음 `답장 N건(조용해진 뒤 묶음)`이다. 제한 시간으로 묶었으면 그 이유를 표시한다. 이전 안 읽은 메시지는 seen(없으면 시작 24시간 전) 이후부터 시작 시각까지의 다른 사람 메시지이며 thread/from 필터는 이 섹션에 적용하지 않는다. 두 섹션 모두 기존 스레드·최근 5건 맥락·카드·첨부 렌더러를 쓴다. 대기 출력에는 200건 상한을 두지 않아 이전 미조회 메시지를 건너뛰지 않는다.

두 섹션의 stdout 출력 성공 후 실제 표시한 메시지의 최대 시각·이름으로 seen을 전진한다. 다른 조회가 먼저 전진시킨 커서는 되돌리지 않는다. thread/from이 있는 대기는 seen을 유지한다. 대기 오류·출력 실패·SIGINT/SIGTERM에서는 seen을 바꾸지 않는다. 단독 wait의 시그널은 API 요청·sleep도 중단하고 130/143을 반환하며 리스너를 정리한다. 이미 수집한 DB 메시지는 남는다.

`send --wait`는 전송 완료와 message/thread 이름을 항상 먼저 출력한다. 전송 완료 뒤 대기 오류·출력 실패·SIGINT/SIGTERM은 **exit 5: 전송은 완료됨 — 재전송하지 말 것**으로 구분한다. 정상적인 답장 없음은 exit 4이며 이때도 재전송하지 않는다. 전송 요청 도중 시그널은 130/143과 `전송 여부 불확실 — Chat에서 확인 후 재전송 판단`을 출력한다.

## 종료 코드

| 코드 | 의미 |
|------|------|
| 0 | 성공/help/버전; `mailman fetch`는 수집 실패 후 기존 DB 출력도 성공으로 처리 |
| 1 | 인자·설정·파일 권한 오류, 잘못된 `--client` 파일, 빈 전송 본문 |
| 2 | 토큰 파일 또는 OAuth 클라이언트 파일 없음 (`mailman auth` 필요) |
| 3 | 재인증 필요, OAuth/HTTP/네트워크/페이지 수집 실패 |
| 4 | wait 또는 send --wait에서 timeout까지 답장 없음 (과거 안 읽은 메시지는 표시할 수 있음) |
| 130 / 143 | SIGINT / SIGTERM으로 대기 중단, seen 불변 |

`mailman fetch`의 수집 오류는 stderr로 알린다. 조회 가능한 DB가 있으면 계속 출력하며, DB 자체가 깨져 읽을 수 없는 경우에는 실패한다.

## 검증

레포 루트 또는 이 디렉터리에서 `bun test`. API/OAuth는 fetch를 주입한다. 테스트 헬퍼는 기본 fetch를 차단하며 임시 파일은 레포 안에 만들고 제거한다. 실제 Google 인증/호출 검증은 별도로 수행한다.
