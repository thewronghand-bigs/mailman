# mailman v2 런타임

Google Chat API를 사용자 OAuth로 호출하는 bun 런타임. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 사용한다. 배포본은 `cli.ts`를 `bun build --compile`한 단일 실행 파일이다. 설치는 [루트 가이드](../../INSTALL.md)를 참고한다.

## 명령

예시는 `~/.claude/bin`이 PATH에 있다고 가정한다. 아니면 `~/.claude/bin/mailman` 전체 경로로 실행한다.

```bash
mailman auth [--client <client_secret.json>]
mailman collect [스페이스별칭] [--deep]
mailman fetch [스페이스별칭] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep]
printf '%s\n' '본문' | mailman send [스페이스별칭] [--thread spaces/.../threads/...] [--agent claude|codex] [--no-tag]
mailman --help
mailman --version
MAILMAN_BACKFILL_DAYS=60 mailman collect team --deep
```

개발 중에는 레포에서 `./mailman-dev <명령>`(또는 `bun cli.ts <명령>`)로 같은 CLI를 실행한다. `mailman-dev`는 `~/.bun/bin`, `NVM_BIN`, `~/.nvm/versions/node/*/bin`(버전 내림차순), `/opt/homebrew/bin`, `/usr/local/bin`, 기존 PATH 순서로 bun을 찾고 심볼릭 링크로 실행돼도 레포 위치를 찾는다. source하면 bun 탐색 함수 `mailman_setup_path`만 정의한다(`scripts/build.sh`에서 사용).

각 명령은 `--help`를 지원한다. help·버전·인자 오류에서는 설정을 읽거나 인증·수집을 시도하지 않는다. 스페이스 생략 시 설정의 `defaultSpace`를 쓰고, 알 수 없는 별칭은 에러로 처리한다. 조회는 한 번에 새 메시지 최대 200건이다. `fetch`는 조회 전에 수집을 시도하며 `--no-collect`로 생략한다. `--deep`과 `--no-collect`는 함께 쓸 수 없다.

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

토큰 파일은 `refresh_token`, `email`, `scopes`만 저장한다. 0600 임시 파일을 만든 뒤 원자적으로 교체한다. access token은 수집/전송 때마다 refresh로 발급하고 메모리에서만 쓴다. 원본 OAuth 에러, 토큰, client secret, webhook URL은 출력하지 않는다.

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

수집 범위는 config에 등록한 스페이스로 정하고, 저장과 조회 모두 사람·봇·mailman 전송을 포함한다. 본문을 그대로 출력하며 작업 관련성은 이를 읽는 Claude가 판단한다.

기본 조회는 스페이스별 `seenCreateTime` 이후의 생성 시각을 가진 메시지다. 커서가 없으면 실행 시각의 24시간 전을 기준으로 쓴다. `--since 24h`, `3d`, `7d`는 실행 시각에서 양의 정수 시간/일을 빼고, `--since YYYY-MM-DD`는 실행 환경의 로컬 자정을 기준으로 쓴다. 기준 시각과 같은 메시지는 새 메시지에서 제외한다. 기간 조회는 seen을 읽거나 바꾸지 않는다. DEEP 수집 후에도 기본 조회는 안 읽은 메시지다.

새 메시지를 `create_time`, `name` 오름차순으로 최대 200건 고른다. seen의 보조 이름이 있으면 같은 시각의 더 뒤 이름도 이어서 조회한다. 스레드는 그 스레드의 가장 이른 새 메시지순, 내부는 시간순으로 묶는다. 스레드 이름이 없는 메시지는 각각 독립 항목으로 취급한다. 새 답글 앞의 저장된 메시지 중 최근 5건을 **이전 맥락**으로 표시하고 나머지 생략 건수도 알린다. 이전 맥락은 새 메시지 상한에 포함하지 않는다. 상한으로 잘린 나중 답글은 이번 출력에 포함하지 않는다.

`--only bot|human`은 새 메시지 선정(200건 상한과 남은 건수 포함)을 해당 `sender_type`으로 거른다. 이전 맥락은 유형과 무관하게 붙인다. `--only` 조회는 seen을 읽어 기준으로 쓰지만 **바꾸지 않는다**. 거른 조회로 전진하면 거른 쪽 메시지가 기본 조회에서 영구히 빠지기 때문이다. `--since`와 함께 쓰면 기간 기준으로 거른다. 상한 초과 시 `--since`가 있으면 기간을 좁히라고, `--only` 단독이면 seen이 바뀌지 않아 같은 메시지가 다시 나온다며 `--since`를 지정하거나 좁히라고 안내한다.

출력 머리에 `thread_name`과 DB 기준 첫 메시지 `name`을 표시한다. 첫 메시지가 이전 맥락 제한으로 생략되어도 DB 기준 이름은 유지한다. 각 메시지에 시각·발신자 표시명(없으면 사용자 리소스 이름)·BOT/HUMAN 구분을 붙인다. 수집 창 밖의 메시지/원문이 없을 수 있다.

stdout 쓰기가 완료된 뒤 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진한다. 동시 조회에서도 더 뒤의 seen을 되돌리지 않는다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`와 기존 수집 메타를 출력한다. 상한 초과 시 기본 조회는 `N건 더 남음 — 다시 실행하면 이어서` 안내를, 기간 조회는 `--since`를 좁히라는 안내를 출력한다.

첨부는 `contentName`, `contentType`, 리소스 `name` 순서로 표시한다. `cardsV2[].card`와 구형 `cards[]`의 제목·섹션·위젯 본문은 마크다운 텍스트로 펼친다. HTML 서식과 엔티티를 변환하며 코드블록 안의 들여쓰기와 원문은 엔티티만 풀어 보존한다. 버튼 링크, 중첩 열, 그리드, 이미지 설명도 표시하고 알 수 없는 위젯은 건너뛴다. 메시지 텍스트가 있으면 먼저 출력하고 그 아래 카드를 붙인다. 표시할 내용이 없는 카드는 `(카드)`로 표시한다.

텍스트 전송은 로그인한 사용자 명의이며 본문 첫 줄 앞에 `[🤖 <라벨>] `을 한 번 붙인다(`content.ts`의 `sendPrefix`). 결정은 `runtime.ts`의 `resolveSendPrefix`가 한다: `--no-tag`면 태그 없음, 아니면 설정 `sendTag: false`면 태그 없음, 아니면 라벨을 `--agent` > `MAILMAN_AGENT` > 중립 `AI` 순으로 정한다(`claude`→`Claude`, `codex`→`Codex`, 그 밖의 값은 exit 1). `MAILMAN_AGENT`는 태그를 붙이고 `--agent`가 없을 때만 읽는다. `--no-tag`와 `--agent`를 같이 주면 인자 오류다. 태그 없이 보내면 성공 출력에 `태그 없이 전송했습니다 (--no-tag)` 또는 `(설정 sendTag: false)` 한 줄을 붙인다. 값 검증은 모두 refresh 전에 끝난다. `--thread`는 같은 스페이스의 리소스 이름이어야 하고 `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`로 전송한다. 성공 시 message/thread 이름을 출력한다. 실패 시 자동 재시도하지 않는다. 카드는 사용자 OAuth 범위 밖이며 [커맨드 문서](../../commands/mailman.md)의 웹훅 curl 절차를 사용한다.

## 종료 코드

| 코드 | 의미 |
|------|------|
| 0 | 성공/help/버전; `mailman fetch`는 수집 실패 후 기존 DB 출력도 성공으로 처리 |
| 1 | 인자·설정·파일 권한 오류, 잘못된 `--client` 파일, 빈 전송 본문 |
| 2 | 토큰 파일 또는 OAuth 클라이언트 파일 없음 (`mailman auth` 필요) |
| 3 | 재인증 필요, OAuth/HTTP/네트워크/페이지 수집 실패 |

`mailman fetch`의 수집 오류는 stderr로 알린다. 조회 가능한 DB가 있으면 계속 출력하며, DB 자체가 깨져 읽을 수 없는 경우에는 실패한다.

## 검증

레포 루트 또는 이 디렉터리에서 `bun test`. API/OAuth는 fetch를 주입한다. 테스트 헬퍼는 기본 fetch를 차단하며 임시 파일은 레포 안에 만들고 제거한다. 실제 Google 인증/호출 검증은 별도로 수행한다.
