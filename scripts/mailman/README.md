# mailman v2 런타임

Google Chat API를 사용자 OAuth로 호출하는 bun 전용 런타임. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 사용한다. 설치는 [루트 가이드](../../INSTALL.md)를 참고한다.

## 명령

```bash
bash run.sh auth
bash run.sh [스페이스별칭]
bash fetch.sh [스페이스별칭] [개수=5] [--all]
printf '%s\n' '본문' | bash send.sh [스페이스별칭] [--thread spaces/.../threads/...]
MAILMAN_DEEP=1 bash fetch.sh tn 5
MAILMAN_DEEP=1 MAILMAN_BACKFILL_DAYS=60 bash run.sh tn
bun test
```

각 래퍼는 `--help`를 지원한다. help와 인자 오류에서는 인증·수집을 시도하지 않는다. 스페이스 생략 시 `config.json`의 `defaultSpace`를 쓰고, 알 수 없는 별칭은 에러로 처리한다. 개수는 1~50개 스레드다.

`lib.sh`에서 공통으로 bun PATH를 구성한다. `~/.bun/bin`, `NVM_BIN`, `~/.nvm/versions/node/*/bin`(버전 내림차순), `/opt/homebrew/bin`, `/usr/local/bin`, 기존 PATH 순서로 찾는다.

## 설정과 경로

`config.example.json`을 참고해 `config.json`에 `defaultSpace`와 `spaces.<별칭>.space`를 작성한다. 선택적인 `webhookUrl`은 카드 전송용이며 v2 텍스트 전송에서는 사용하지 않는다. 이전 설정/DB와 호환하지 않는다.

| 변수 | 기본값/용도 |
|------|-------------|
| `MAILMAN_HOME` | `~/.claude`, DB와 로그 루트 |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json`, Google `installed` 형식 |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json`, 0600 |
| `MAILMAN_DEEP` | `1`이면 최근 30일 창 전체를 재수집 |
| `MAILMAN_BACKFILL_DAYS` | 최초/DEEP 일수 오버라이드, 기본 7/30일, 1~36500 |

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
- `received`: 받은 수. `saved`: 새로 저장/수정 갱신한 수의 합계. 같은 내용을 다시 받으면 0건이다.

최초는 7일, DEEP은 30일 창을 쓴다. DEEP은 기존 커서를 무시하고 창 전체를 받는다. 생성 시각 기준 증분이므로 과거 메시지의 수정은 백필로 반영한다. 페이지 중간 실패나 DB 저장 실패는 전체 실패로 처리한다.

수집 성공은 스페이스·받은 수·저장 수를 로그에 한 줄로 남긴다. 인증·네트워크·API 등 수집 실패도 같은 로그에 시각·스페이스·오류 요약을 한 줄로 남긴다. 비밀값은 제거하고 stderr 오류 안내도 유지한다.

## 조회와 전송

기본 조회 필터는 BOT 전부 + 첫 줄 `@mailman` HUMAN이다. `[🤖 Claude]`로 시작하는 자기 전송은 제외한다. 마커는 DB에 남기고 출력할 때만 지운다. `--all`이면 전체 메시지로 스레드를 고른다.

최신 **필터 통과 메시지의 생성 시각**으로 N개 스레드를 고른다. 무표식 답글은 기본 조회의 스레드 순위를 올리지 않는다. 고른 스레드의 저장된 메시지는 필터와 관계없이 모두 시간순으로 출력한다. 스레드 이름이 없는 메시지는 각각 독립 항목으로 취급한다. 수집 창 밖의 메시지/원문이 없을 수 있어 첫 메시지 `name`은 DB 기준으로 표시한다.

첨부는 `contentName`, `contentType`, 리소스 `name` 순서로 표시한다. `cardsV2[].card`와 구형 `cards[]`의 제목·섹션·위젯 본문은 마크다운 텍스트로 펼친다. HTML 서식과 엔티티를 변환하며 코드블록 안의 들여쓰기와 원문은 엔티티만 풀어 보존한다. 버튼 링크, 중첩 열, 그리드, 이미지 설명도 표시하고 알 수 없는 위젯은 건너뛴다. 메시지 텍스트가 있으면 먼저 출력하고 그 아래 카드를 붙인다. 표시할 내용이 없는 카드는 `(카드)`로 표시한다.

텍스트 전송은 로그인한 사용자 명의이며 `content.ts`의 `SEND_TAG = "🤖 Claude"`를 공유해 `[🤖 Claude] `를 붙인다. `--thread`는 같은 스페이스의 리소스 이름이어야 하고 `REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`로 전송한다. 성공 시 message/thread 이름을 출력한다. 실패 시 자동 재시도하지 않는다. 카드는 사용자 OAuth 범위 밖이며 [커맨드 문서](../../commands/mailman.md)의 웹훅 curl 절차를 사용한다.

## 종료 코드

| 코드 | 의미 |
|------|------|
| 0 | 성공/help; `fetch.sh`는 수집 실패 후 기존 DB 출력도 성공으로 처리 |
| 1 | 인자·설정·파일 권한 오류, 빈 전송 본문 |
| 2 | 토큰 파일 없음 (`run.sh auth` 필요) |
| 3 | 재인증 필요, OAuth/HTTP/네트워크/페이지 수집 실패 |

`fetch.sh`의 수집 오류는 stderr로 알린다. 조회 가능한 DB가 있으면 계속 출력하며, DB 자체가 깨져 읽을 수 없는 경우에는 실패한다.

## 검증

레포 루트 또는 이 디렉터리에서 `bun test`. API/OAuth는 fetch를 주입한다. 테스트 헬퍼는 기본 fetch를 차단하며 임시 파일은 레포 안에 만들고 제거한다. 실제 Google 인증/호출 검증은 별도로 수행한다.
