# mailman v2.4 런타임

Google Chat API를 사용자 OAuth로 호출하는 bun 런타임. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 사용한다. 배포본은 `cli.ts`를 `bun build --compile`한 단일 실행 파일이다. 설치는 [루트 가이드](../../INSTALL.md)를 참고한다.

## 명령

예시는 `~/.claude/bin`이 PATH에 있다고 가정한다. 아니면 `~/.claude/bin/mailman` 전체 경로로 실행한다.

```bash
mailman auth [--client <client_secret.json>]
mailman doctor
mailman spaces [검색어] [--refresh] [--save <별칭>] [--default]
mailman people [검색어]
mailman people --forget <users/숫자ID>
mailman collect [대상] [--dm <사람>] [--save <별칭>] [--default] [--deep]
mailman fetch [대상] [--dm <사람>] [--save <별칭>] [--default] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep] [--with-attachments]
printf '%s\n' '본문' | mailman send [대상] [--dm <사람>] [--save <별칭>] [--default] [--attach <파일> ...] [--thread spaces/.../threads/...] [--agent claude|codex] [--no-tag] [--dry-run | --wait]
mailman wait [대상] [--dm <사람>] [--save <별칭>] [--default] [--thread spaces/.../threads/...] [--from <사람>] [--quiet 60s] [--timeout 30m] [--interval 15s]
mailman download <메시지 name> [--out <디렉터리>] [--print]
mailman react <메시지 name> <👀|✅>
mailman --help
mailman --version
MAILMAN_BACKFILL_DAYS=60 mailman collect team --deep
```

개발 중에는 레포에서 `./mailman-dev <명령>`(또는 `bun cli.ts <명령>`)로 같은 CLI를 실행한다. `mailman-dev`는 `~/.bun/bin`, `NVM_BIN`, `~/.nvm/versions/node/*/bin`(버전 내림차순), `/opt/homebrew/bin`, `/usr/local/bin`, 기존 PATH 순서로 bun을 찾고 심볼릭 링크로 실행돼도 레포 위치를 찾는다. source하면 bun 탐색 함수 `mailman_setup_path`만 정의한다(`scripts/build.sh`에서 사용).

각 명령은 `--help`를 지원한다. help·버전·옵션 해석 오류에서는 설정을 읽거나 인증·수집을 시도하지 않는다. 대상 생략 시 설정의 `defaultSpace`를 쓴다. 조회는 한 번에 새 메시지 최대 200건이다. `fetch`는 조회 전에 수집을 시도하며 `--no-collect`로 메시지 수집을 생략한다(대상 이름/DM 해석은 API를 호출할 수 있음). `--deep`과 `--no-collect`는 함께 쓸 수 없다.

## 대상 해석

`resolve.ts`를 collect/fetch/send/wait와 `spaces --save`가 공유한다. config 별칭, 리터럴 `spaces/ID`, `--dm <사람>`, 스페이스 표시 이름 순서다(`spaces`에는 `--dm` 없음). 위치 인자와 `--dm`은 배타적이다. 이름은 NFKC·소문자·공백 제거 후 정확 일치 우선, 없으면 부분 일치하며 유일해야 한다. 다중 후보는 이름·종류·ID를 안내하고 exit 1이다. 0개면 캐시를 한 번 새로 고치고 재시도하며, 그래도 없으면 `mailman spaces`를 안내한다. 빈 캐시도 가져온 상태를 기록해 매번 다시 요청하지 않는다.

설정 파일이 없으면 `{ defaultSpace: "", spaces: {}, sendTag: true }`를 사용한다. 기존 파일도 defaultSpace의 빈 문자열·키 생략을 허용하며, 비어 있지 않은 별칭이 spaces에 없으면 오류다. 명시 대상은 config 없이 동작한다. 대상 생략 시에만 기본 방이 필요하고, 없으면 대상 지정이나 `mailman spaces '검색어' --save <별칭>`을 안내한다(exit 1). 잘못된 JSON·형식·읽기 권한은 계속 차단한다.

`spaces.list`는 100개씩 최대 1,000페이지를 받아 완전히 성공한 뒤 목록 캐시를 원자 교체한다. 검색은 표시 이름 부분 일치다. `--refresh` 또는 캐시가 없을 때만 API를 호출한다. `--dm`은 `users/ID`·이메일(`users/<이메일>`)을 그대로 쓰고, 이름은 people 등록부의 정규화 정확 일치 → DB 발신자 → People API 디렉터리 순으로 해석한다. 디렉터리는 정확 일치 우선, 없으면 부분 일치다. 여러 명이면 이름·이메일·ID 후보를 보여 주고 추측하지 않는다.

`people` 테이블은 user_name(PK, users/숫자ID), display_name, email(nullable), source(sender|directory|manual), updated_at을 저장한다. 기존 DB에는 CREATE TABLE IF NOT EXISTS로 추가한다. 이름으로 확정된 한 명만 upsert하며 dry-run은 등록·갱신하지 않는다. `people [검색어]`는 이름·ID·이메일·출처를 출력하고 `people --forget <users/숫자ID>`는 한 명의 등록만 지운다. 검색·삭제는 네트워크 없이 동작한다.

디렉터리는 선택 `directory.readonly` 스코프가 있을 때 `GET https://people.googleapis.com/v1/people:searchDirectoryPeople`로 이름·이메일을 검색한다. pageSize=10, readMask=names,emailAddresses, sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE을 사용하며 다음 페이지의 동명이인도 확인한다. people/숫자ID를 users/숫자ID로 변환하고 후보 전체는 저장하지 않는다. SERVICE_DISABLED는 People API 사용 설정, 스코프 부족은 mailman auth를 안내한다.

`spaces:findDirectMessage`의 404는 조회·수집·대기에서는 아직 대화가 없는 DM 안내다. send는 본문·옵션 검증 뒤 선택 `chat.spaces.create`를 확인하고 `POST /v1/spaces:setup`으로 DM을 만들어 캐시한 뒤 전송한다. dry-run은 `새 DM을 만들어 보냄`을 표시하고 생성·등록하지 않는다. 생성 POST도 재시도하지 않는다. 생성 권한이 없는 토큰은 실제 생성에서만 exit 2이며 미리보기는 가능하다.

위치 인자·`--dm`·`--from`·`--save`가 정규화 후 비면 설정/API 접근 전에 exit 1이다. 위치 인자 생략만 defaultSpace를 사용한다. 빈 표시 이름은 이름 매칭 후보에서 제외한다. 이름 해석 전 목록 캐시가 24시간을 초과했으면 한 번 갱신한다. 실패하면 기존 캐시를 유지하고 경고한다. 그 호출에서는 다시 갱신하지 않는다.

미등록 방도 이번 호출에서만 수집·조회·전송한다. `--save`만 최신 config에 새 별칭을 추가한다. 기존 별칭 충돌은 거절하고 모든 다른 필드를 보존해 0600 임시 파일에서 원자 교체한다. 출력·전송 미리보기 첫 줄은 `[대상] 이름 (종류, spaces/...)`다. 기존 별칭·리터럴의 메타데이터가 캐시에 없을 때는 입력 이름과 `SPACE_TYPE_UNSPECIFIED`를 표시해 오프라인 조회를 유지한다. `spaces --refresh`로 보완할 수 있다. `send --dry-run`은 대상과 태그 적용 본문을 출력하고 전송하지 않는다.

설치기는 설정 파일을 만들지 않는다. 설정 파일이 없으면 대상을 명시한 첫 `--save`가 그 별칭을 기본 방으로 지정해 0600 설정 파일을 만든다. **처음 저장한 별칭이 기본 방이며 바꾸려면 `--save <별칭> --default`**를 쓴다. 기존 별칭은 해석된 대상과 같은 방일 때만 기본 지정만 바꾸며 별칭의 값·추가 필드는 보존한다. `spaces --save <기존 별칭> --default`처럼 대상을 생략하면 그 별칭을 선택한다. `--default` 단독은 인자 오류다. 기존 파일이 잘못된 경우에는 덮어쓰지 않고 오류로 끝낸다. `send --dry-run --save`는 별칭·기본 방·파일 권한을 변경하거나 파일을 만들지 않는다.

DM 대상은 수집된 sender 표시명을 알면 `DM: 이름 → users/ID`, 모르면 `DM: users/ID`로 표시한다. 대기 중 받은 sender 표시명도 마지막 출력에 반영한다. 출력 머리의 방 라벨은 `DM: 이름 또는 users/ID`, 일반 스페이스는 표시 이름(없으면 별칭/ID)이다. `--dry-run --save`는 별칭 충돌을 검사하고 저장할 예정만 표시하며 config 내용·권한을 바꾸지 않는다.

- `auth --client <파일>`: Google 데스크톱 앱(`installed`) 형식과 인증 주소를 검증한 뒤 클라이언트 파일 경로로 0600 원자 복사하고 로그인한다. 같은 경로면 권한만 맞춘다. 검증 실패 시 복사·로그인하지 않는다(exit 1).
- `auth`: 기존 클라이언트 파일로 로그인한다. 파일이 없으면 설정 가이드 URL을 안내하고 exit 2.

## 설정 점검

`doctor.ts`는 경로·0600 권한, 설정 JSON과 defaultSpace, 데스크톱 클라이언트, 토큰·필수/리액션/디렉터리/DM 생성 스코프, OAuth 갱신, `GET /v1/spaces?pageSize=1`을 순서대로 점검한다. 디렉터리 스코프가 있으면 이메일 앞부분으로 People API에 pageSize=1 요청을 한 번 한다. 선택 API 실패는 경고만 내며 전체 실패로 만들지 않는다. 파일·DB·권한·캐시·로그를 변경하지 않고 브라우저를 열지 않는다. 기본 방 메시지 조회는 하지 않는다. 파일 검증과 OAuth 갱신은 `auth.ts`, API 호출은 `chat.ts`를 공유하며 실제 네트워크 없이 fetch를 주입해 검증한다.

실패가 있으면 exit 1, 경고만 있으면 0이다. 설정 파일·DB 없음과 예시 자리표시 기본 방·0600이 아닌 권한·리액션 스코프 없음은 경고다. 클라이언트 없음은 받은 JSON의 8단계 등록 또는 처음 만드는 6단계, web 유형은 6단계를 안내한다. 갱신의 invalid_client/deleted_client/unauthorized_client는 새 JSON을 받거나 만들어 auth --client로 등록하도록 6단계를 안내한다. invalid_grant는 기존 5단계 게시·재인증 안내를 유지한다. 설정 오류가 있어도 독립적인 인증 점검은 계속하고, 클라이언트·토큰 실패 뒤에는 갱신/API를 건너뛴다. 응답 원문을 출력하지 않고 원인과 [설정 가이드](https://thewronghand-bigs.github.io/mailman/setup)의 단계 링크만 표시한다. 게시 상태·브라우저 계정·관리자 콘솔은 조회하지 않는다.

## 빌드

```bash
bash ../build.sh                         # 버전은 package.json
MAILMAN_VERSION=2.4.0 bash ../build.sh   # 버전 덮어쓰기
```

`--target=bun-darwin-arm64`/`bun-darwin-x64`로 `dist/mailman-darwin-arm64`, `dist/mailman-darwin-x64`를 만들고 `--define MAILMAN_BUILD_VERSION`으로 버전을 주입한 뒤 ad-hoc 서명한다. 현재 아키텍처 바이너리로 최소 환경(`env -i`)에서 `--version`·`--help`를 스모크한다. `dist/`는 gitignore 대상이다. 컴파일된 실행 파일은 스크립트 위치(`import.meta.url`)에 의존하지 않는다.

## 설정과 경로

`config.example.json`은 문서 참고용이며 설치기가 복사하지 않는다. `defaultSpace`와 `spaces.<별칭>.space`는 `--save`·`--default`로 저장한다. 선택적인 `webhookUrl`은 카드 전송용이며 v2 텍스트 전송에서는 사용하지 않는다. 최상위 `sendTag`(선택, 기본 `true`)를 `false`로 두면 전송 태그를 붙이지 않는다. 불리언이 아니면 설정 오류(exit 1)다. 이전 설정/DB와 호환하지 않는다.

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
- 첨부: `$MAILMAN_HOME/mailman/attachments/<space id>/<message id>/` (기본 디렉터리 0700·파일 0600, `download --out`은 기존 디렉터리 권한 유지)
- OAuth 파일 기본 경로는 `MAILMAN_HOME`과 독립적이다.
- Chrome 프로필, snapshot driver, 봇별칭, webhook override 환경변수는 v2에 없다.

## OAuth

`auth.ts`는 macOS `open`, `127.0.0.1` 임의 포트 loopback, PKCE S256, state 검증을 쓴다. 인증 대기는 최대 5분이며 `access_type=offline`, `prompt=consent`를 보낸다.

요청/허용 스코프는 `openid`, `userinfo.email`, `chat.spaces.readonly`, `chat.messages.readonly`, `chat.messages.create`, `chat.messages.reactions.create`, `directory.readonly`, `chat.spaces.create`의 여덟 개다. `openid` 외에는 `https://www.googleapis.com/auth/` 접두사를 쓴다. 필수 검사는 기존 4개+openid만 요구하며 리액션·디렉터리 검색·DM 생성은 선택이다. 해당 선택 권한이 없으면 필요한 기능만 exit 2와 `mailman auth` 재실행을 안내한다. 검증된 계정 이메일은 Bearer 헤더로 호출한 Google userinfo에서 확인한다.

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

DM과 메시지 1개짜리 단발은 시각·발신자·본문과 한 줄 `message name`의 시간순 간결 목록으로 출력하며, 답글용 `thread name`도 한 줄로 표시한다. DM은 실제 스레드도 간결 목록으로 표시하며 스레드별 머리·이전 맥락·생략 건수를 붙이지 않는다. 그룹의 실제 스레드(2개 이상)는 `thread_name`과 DB 기준 첫 메시지 `name`, 맥락 출력 형식을 유지한다. 답글은 출력의 `thread name`(스레드 머리에서는 `thread_name`) 값을 `--thread`에 쓴다. 첫 메시지가 이전 맥락 제한으로 생략되어도 DB 기준 이름은 유지한다. 각 메시지에 시각·발신자 표시명(없으면 사용자 리소스 이름)·BOT/HUMAN 구분과 한 줄 `message name`을 붙인다. 수집 창 밖의 메시지/원문이 없을 수 있다.

stdout 쓰기가 완료된 뒤 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진한다. 동시 조회에서도 더 뒤의 seen을 되돌리지 않는다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`와 기존 수집 메타를 출력한다. 상한 초과 시 기본 조회는 `N건 더 남음 — 다시 실행하면 이어서` 안내를, 기간 조회는 `--since`를 좁히라는 안내를 출력한다.

첨부는 `contentName`, `contentType`, 리소스 `name` 순서로 표시한다. `cardsV2[].card`와 구형 `cards[]`의 제목·섹션·위젯 본문은 마크다운 텍스트로 펼친다. HTML 서식과 엔티티를 변환하며 코드블록 안의 들여쓰기와 원문은 엔티티만 풀어 보존한다. 버튼 링크, 중첩 열, 그리드, 이미지 설명도 표시하고 알 수 없는 위젯은 건너뛴다. 메시지 텍스트가 있으면 먼저 출력하고 그 아래 카드를 붙인다. 표시할 내용이 없는 카드는 `(카드)`로 표시한다.

## 첨부 내려받기와 리액션

`download.ts`는 `download <메시지 name> [--out <디렉터리>] [--print]`를 처리한다. DB의 `raw_json.attachment`를 먼저 쓰고 메시지가 없으면 `GET /v1/{message name}`으로 조회한다(이 조회는 DB에 저장하지 않음). `attachmentDataRef.resourceName`이 있는 업로드만 `GET /v1/media/{resourceName}?alt=media`로 받으며 외부 downloadUri는 호출하지 않는다. Drive 첨부는 파일 ID/Drive 링크와 미지원 안내만 표시한다.

파일명에서 경로 구분자·`..`·제어문자를 제거하고 UTF-8 이름 길이를 제한한다. 충돌은 확장자 앞 `-1`, `-2` 접미사로 구분하고 기존 파일/심볼릭 링크를 덮어쓰지 않는다. 기본 저장 경로의 `.mailman-attachments.json`(0600)에만 소스 참조·정리한 원래 이름·실제 파일명·크기를 기록한다. 같은 소스·이름이고 로컬 크기가 기록과 같으면 API 호출 없이 재사용한다. 파일당 50MB(50×1024² 바이트)를 Content-Length와 실제 수신 스트림 양쪽에서 제한하며 실패한 수신은 최종 파일로 남지 않는다. 기본 디렉터리 0700·파일 0600이다. `--out`은 기존 디렉터리 권한을 유지하고 새 디렉터리만 0700으로 만든다. 재사용 기록은 기본 저장 경로에만 두며 `--out`에서는 기록 없이 매번 새 파일로 받는다. 다운로드는 30초 무수신 또는 전체 10분 초과 시 중단한다. 리다이렉트는 HTTPS의 `*.googleapis.com`·`*.googleusercontent.com`·`*.google.com`만 최대 5회 따르며 호스트 변경 시 Authorization을 제거한다. 허용 범위 밖에는 요청하지 않는다.

저장 위치는 하드 링크를 지원해야 한다. 링크 생성 실패 시 파일시스템 오류 코드와 하드 링크를 지원하고 쓰기 권한이 있는 `--out` 디렉터리 지정 안내를 표시하며 임시 파일을 정리한다.

`--print`는 md/txt/json/csv/yaml/log 등 확장자 또는 텍스트 Content-Type이고 256KB(256×1024 바이트) 이하인 유효 UTF-8만 펼친다. 바이너리·제어문자·잘못된 UTF-8·큰 파일은 경로만 출력한다. 내용의 코드 펜스보다 긴 펜스를 사용한다. `fetch`·`wait`·`send --wait`는 첨부 줄에 `mailman download <메시지 name>` 힌트를 붙인다. `--with-attachments`는 실제 표시하는 새 메시지/맥락의 텍스트 첨부를 메시지당 최대 3개·각 256KB까지 시도하고, 실패 사유만 표시해 조회와 seen 규칙을 유지한다. 업로드 다운로드는 기존 읽기 스코프를 사용한다. 403이면 권한 부족·필요한 스코프 확인·`mailman auth` 재실행을 안내하고 다른 스코프를 추측해 추가하지 않는다.

`react <메시지 name> <👀|✅>`는 `POST /v1/{message name}/reactions`, body `{"emoji":{"unicode":"<이모지>"}}`를 사용한다. 409 또는 ALREADY_EXISTS는 `이미 있음` 성공이며 POST는 재시도하지 않는다. 👀는 작업 관련 스펙·요청·핸드오버를 읽고 보고한 뒤 자동으로, ✅는 실제 반영 완료 뒤 사용자 승인 후 단다. 잡담과 중복 리액션은 피한다. 리액션은 **해당 내용을 보낸 메시지(스펙·요청·핸드오버 그 자체)**의 `message name`에 단다. 사용자 본인 메시지에는 달지 않는다. 정책은 커맨드와 Codex 스킬에서 적용하며 `local.md`도 ✅ 승인·전송 승인을 완화할 수 없다.

## 전송 동작

`send --attach <파일>`은 반복 가능하며 최대 10개·파일당 200MB(200×1024² 바이트)까지 받는다. `upload.ts`가 모든 파일의 존재·일반 파일 여부·크기를 먼저 검증하고 읽기 전용 파일 디스크립터를 유지한다. lstat으로 심볼릭 링크·디렉터리·소켓·파이프를 거절하고 O_NOFOLLOW로 연다. 중간 디렉터리 링크는 허용하되 미리보기·성공 출력에는 realpath로 해석한 실제 경로를 표시한다. 검증 후 변경된 파일은 전송하지 않는다. `ChatClient.uploadAttachment`는 `POST /upload/v1/{space}/attachments:upload?uploadType=multipart`에 multipart/related(JSON `{"filename":"basename"}` + 원본 파일 바이트)를 64KB씩 스트리밍한다. 로컬 전체 경로는 Google에 보내지 않는다. 응답의 attachmentDataRef(resourceName/attachmentUploadToken)를 messages.create의 attachment[]에 넣는다. 파일 업로드에는 기존 chat.messages.create만 사용하고 403이면 권한 확인·mailman auth 재실행을 안내한다.

전부 업로드한 뒤에만 메시지를 생성한다. 업로드는 60초 동안 전송 진척이 없거나 전체 30분 상한을 넘으면 중단한다. 업로드가 중간 실패·중단되면 메시지 미전송과 이미 올라간 업로드를 무시해도 된다는 안내를 표시한다. 업로드 중 파일 변경은 연결 오류와 구분해 내용을 확인하고 다시 승인받으라고 안내하며 재시도 대상이 아니다. 업로드 POST도 재시도하지 않는다. send --wait의 업로드 실패는 exit 5가 아니며 전송 여부 불확실 안내도 메시지 생성 POST부터 적용한다. 파일 디스크립터는 업로드 종료/모든 종료 경로에서 닫는다.

본문이 비고 첨부가 있으면 텍스트는 태그만, 태그가 꺼져 있으면 text 필드 없이 첨부만 보낸다. 본문·첨부가 모두 없으면 기존처럼 거절한다. TTY는 첨부만 바로 보낼 수 있고 파이프에서는 `< /dev/null`로 빈 본문을 준다. `--thread`·`--wait`·`--agent`·`--no-tag`·`--dry-run`과 결합하며 기존 옵션 간 배타 규칙은 유지한다. dry-run은 실제 업로드 없이 파일 경로·이름·크기를 미리 보고 성공 출력은 첨부 파일 이름과 실제 경로를 나열한다.

커맨드·Codex 스킬은 사용자가 지정한 파일만 첨부하고 미리보기의 경로·이름·크기를 전송 승인에 포함한다. .env·키·토큰·자격증명 파일은 첨부하지 않고 사용자에게 경고한다. 작성 요청을 받은 핸드오버 md도 먼저 파일로 쓴 뒤 경로를 미리보기에 포함해 승인받고 첨부한다.

텍스트 전송은 로그인한 사용자 명의이며 본문 첫 줄 앞에 `[🤖 <라벨>] `을 한 번 붙인다(`content.ts`의 `sendPrefix`). 결정은 `runtime.ts`의 `resolveSendPrefix`가 한다: `--no-tag`면 태그 없음, 아니면 설정 `sendTag: false`면 태그 없음, 아니면 라벨을 `--agent` > `MAILMAN_AGENT` > 중립 `AI` 순으로 정한다(`claude`→`Claude`, `codex`→`Codex`, 그 밖의 값은 exit 1). `MAILMAN_AGENT`는 태그를 붙이고 `--agent`가 없을 때만 읽는다. `--no-tag`와 `--agent`를 같이 주면 인자 오류다. 태그 없이 보내면 성공 출력에 `태그 없이 전송했습니다 (--no-tag)` 또는 `(설정 sendTag: false)` 한 줄을 붙인다. 값 검증은 모두 refresh 전에 끝난다. `--thread`는 같은 스페이스의 리소스 이름이어야 하고 `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`로 전송한다. 성공 시 message/thread 이름을 출력한다. 실패 시 자동 재시도하지 않는다. 카드는 사용자 OAuth 범위 밖이며 [커맨드 문서](../../commands/mailman.md)의 웹훅 curl 절차를 사용한다.

## 답장 대기

`wait.ts`는 시계(`now`/`sleep`), API fetch, AbortSignal을 주입받는다. 단독 `wait`는 CLI 실행 시각, `send --wait`는 전송 응답의 createTime 이후를 고정 필터로 반복 조회한다. 먼저 일반 증분 수집으로 이전 안 읽은 메시지를 보충하고, 각 폴링 결과는 같은 upsert로 저장하되 수집 커서는 별도로 뛰어넘지 않는다. API에서 같은 메시지를 다시 받아도 quiet는 재시작하지 않는다.

기본 `--quiet 60s --timeout 30m --interval 15s`이며 양의 정수 s/m/h를 받는다. timeout 상한은 2시간이며 초과하면 exit 1이다. 내 Google 계정 ID를 제외하고, thread/from이 있으면 해당 답장만 고른다. 새 답장을 발견할 때마다 quiet를 다시 센다. 마지막 답장부터 quiet가 지나면 묶음을 출력하며, 첫 답장부터 10분 또는 전체 timeout 중 빠른 시점에도 반환한다. quiet가 interval보다 짧으면 quiet 경계에 한 번 더 폴링한다. API 페이지 수신도 전체/묶음 제한 시각에 중단한다. timeout까지 답장이 없으면 `답장 없음`과 exit 4다.

`--from`은 전송/대기 전에 ID로 확정한다. 이름은 수집된 sender_name으로, users/ID는 직접 비교한다. 이메일 발신자 별칭이 이미 DB에 있으면 그대로 비교하고, 없으면 기존 DM에서 내가 아닌 사람 발신자를 찾는다. DM의 수집 기록이 없으면 최근 메시지를 조회한다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 상대가 없거나 유일하지 않으면 전송하지 않고 수집된 정확한 이름이나 users/ID를 안내한다. 내 계정 이메일/ID로 확정되는 --from도 거절한다. 추가 멤버 API 없이 정식 ID를 확인하기 위한 선택이다. 대기 중 발신자별 조회는 없으며 봇은 from과 일치하지 않는다. `send --wait`에서 sender.name이 계정 ID와 다르면 경고하고 두 ID 모두 내 메시지에서 제외한다. 전송 응답에 createTime이 없거나 시각/발신자 형식이 잘못되면 전송 완료 정보와 재전송 금지 문구를 출력하고 exit 5다. 이 메타데이터 검증은 `--wait`에서만 수행하며 일반 send는 전송 성공이면 exit 0이다.

폴링은 직전 수신의 최대 createTime 경계부터 조회한다. `createTime >` 필터의 경계를 1ns 겹치고 같은 시각의 수신 이름을 기억해 중복을 제거한다. 같은 시각에 작은 이름이 나중에 도착해도 포함하며 내 메시지·필터 제외 메시지도 수신 커서에는 반영한다. 준비 수집의 증분 커서와 대기의 수신 커서는 별개다.

연결 오류·5xx·429는 interval부터 최대 60초까지 지수 백오프하며 남은 전체/묶음 시간과 연속 실패 5분 이내로 제한한다. 재시도는 비밀값을 지운 한 줄을 stderr와 로그에 남긴다. 연속 실패 5분, 재시도 중 제한 시간 도달, 영구 오류면 모은 답장을 먼저 출력하고 seen을 유지한 채 오류 종료한다. GET의 401은 refresh token으로 access token을 갱신한 뒤 1회만 재시도한다. 전송 POST는 재시도하지 않는다.

출력은 `대기 전부터 있던 안 읽은 메시지` 다음 `답장 N건(조용해진 뒤 묶음)`이다. 제한 시간으로 묶었으면 그 이유를 표시한다. 이전 안 읽은 메시지는 seen(없으면 시작 24시간 전) 이후부터 시작 시각까지의 다른 사람 메시지이며 thread/from 필터는 이 섹션에 적용하지 않는다. 두 섹션 모두 기존 스레드·최근 5건 맥락·카드·첨부 렌더러를 쓴다. 대기 출력에는 200건 상한을 두지 않아 이전 미조회 메시지를 건너뛰지 않는다.

두 섹션의 stdout 출력 성공 후 실제 표시한 메시지의 최대 시각·이름으로 seen을 전진한다. 다른 조회가 먼저 전진시킨 커서는 되돌리지 않는다. thread/from이 있는 대기는 seen을 유지한다. 대기 오류·출력 실패·SIGINT/SIGTERM에서는 seen을 바꾸지 않는다. 단독 wait의 시그널은 API 요청·sleep도 중단하고 130/143을 반환하며 리스너를 정리한다. 이미 수집한 DB 메시지는 남는다.

`send --wait`는 전송 완료와 message/thread 이름을 항상 먼저 출력한다. 전송 완료 뒤 대기 오류·출력 실패·SIGINT/SIGTERM은 **exit 5: 전송은 완료됨 — 재전송하지 말 것**으로 구분한다. 정상적인 답장 없음은 exit 4이며 이때도 재전송하지 않는다. 전송 요청 도중 시그널은 130/143과 `전송 여부 불확실 — Chat에서 확인 후 재전송 판단`을 출력한다.

## 종료 코드

| 코드 | 의미 |
|------|------|
| 0 | 성공/help/버전, doctor 경고만 있음; `mailman fetch`는 수집 실패 후 기존 DB 출력도 성공으로 처리 |
| 1 | 인자·설정·파일 권한/첨부 검증 오류, 잘못된 `--client` 파일, 본문·첨부 모두 없음, doctor 실패 항목 있음 |
| 2 | 토큰 파일 또는 OAuth 클라이언트 파일 없음, 필요한 선택 스코프 없음 (`mailman auth` 필요) |
| 3 | 재인증 필요, OAuth/HTTP/네트워크/페이지 수집 실패 |
| 4 | wait 또는 send --wait에서 timeout까지 답장 없음 (과거 안 읽은 메시지는 표시할 수 있음). send --wait는 이미 전송 완료됨, 재전송 금지 |
| 5 | send --wait 전송 완료 후 대기 오류·출력 실패·시그널 — 재전송 금지. POST 자체 실패는 해당 오류 코드 |
| 130 / 143 | 단독 wait의 SIGINT / SIGTERM, 또는 send --wait 전송 요청 중 중단(전송 여부 불확실, Chat 확인). seen 불변. 전송 완료 후 시그널은 5 |

`mailman fetch`의 수집 오류는 stderr로 알린다. 조회 가능한 DB가 있으면 계속 출력하며, DB 자체가 깨져 읽을 수 없는 경우에는 실패한다.

## 검증

레포 루트 또는 이 디렉터리에서 `bun test`. API/OAuth는 fetch를 주입한다. 테스트 헬퍼는 기본 fetch를 차단하며 임시 파일은 레포 안에 만들고 제거한다. 실제 Google 인증/호출 검증은 별도로 수행한다.
