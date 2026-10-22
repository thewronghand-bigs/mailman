# claude-mailman v2

Google Chat API를 사용자 OAuth로 호출해 스페이스 메시지를 SQLite에 저장하고, 슬래시 커맨드 또는 CLI로 조회/전송하는 파이프라인.

## 구조

```
scripts/mailman/
├─ runtime.ts       # 공용 설정, 경로, 스페이스/환경변수 해석
├─ auth.ts          # loopback + PKCE OAuth, refresh token 저장/갱신
├─ chat.ts          # Chat API 목록 페이지네이션/텍스트 전송
├─ http.ts          # fetch 주입, HTTP/네트워크 오류 처리
├─ errors.ts        # 종료 코드, 인증정보 비공개 처리
├─ store.ts         # bun:sqlite 스키마, 메시지 upsert, meta
├─ time.ts          # 나노초 보존 RFC3339 정규화
├─ content.ts       # SEND_TAG, 기본 조회 필터, 마커 제거
├─ cards.ts         # 카드 본문과 HTML 서식의 마크다운 렌더링
├─ collector.ts     # 스페이스 전체 메시지 증분/백필 수집
├─ fetch.ts         # 조회 필터 → 스레드 선정 → 답글 전체 마크다운
├─ send.ts          # 태그/답글 전송 본문
├─ cli.ts           # 인증/수집/조회/전송 진입점
├─ lib.sh           # 세 래퍼의 공통 bun PATH 탐색
├─ run.sh           # 수집 또는 auth
├─ fetch.sh         # 수집 시도 + 기존 DB 조회
├─ send.sh          # stdin 텍스트 전송
├─ config.example.json
├─ tests/           # 실제 네트워크를 차단한 bun test
└─ package.json     # 외부 의존성 없음
```

- `commands/mailman.md`: `/mailman` 증분 수집/조회, 승인 후 전송 절차.
- `commands/mailman-deep.md`: `/mailman-deep` 최근 30일 백필 재수집.
- `scripts/mailman-legacy/`: 기존 Playwright/snapshot 구현 보존. v2에서 사용하지 않음.

## 런타임과 경로

bun 전용. 외부 의존성 없이 `bun:sqlite`와 node 표준 모듈을 쓴다. 최초 인증은 macOS `open`으로 브라우저를 열며, 이후 수집/전송은 API만 호출한다.

| 변수 | 기본값/의미 |
|------|-------------|
| `MAILMAN_HOME` | `~/.claude`, 데이터 루트 |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json`, Google `installed` JSON |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json`, refresh token/이메일/허용 스코프, 0600 |
| `MAILMAN_DEEP` | `1`이면 meta와 무관하게 최근 30일 백필 |
| `MAILMAN_BACKFILL_DAYS` | 최초/DEEP 창 일수, 기본 7/30일, 1~36500 |

- DB: `$MAILMAN_HOME/inbox/mailman-v2.db` (새 파일 0600)
- 로그: `$MAILMAN_HOME/logs/mailman.log`
- 인증정보 기본 경로는 `MAILMAN_HOME`과 별개다. 인증정보를 옮길 때는 두 파일 변수를 각각 지정한다.
- 설정은 `scripts/mailman/config.json`에 둔다. 예전 URL/봇별칭 형식과 호환하지 않는다.

## 개발 시 주의

- 설정/환경변수 해석은 `runtime.ts`에 집중한다.
- `config.json`은 gitignore 대상. 토큰, client secret, webhook URL을 출력하지 않는다.
- access token은 메모리에서만 쓰며 매 실행마다 refresh한다. 토큰 없음은 exit 2, `invalid_grant`는 재인증 안내와 exit 3.
- OAuth 스코프는 `auth.ts`의 다섯 개만 허용한다. 카드 전송은 기존 웹훅 curl 절차를 쓴다.
- 수집은 조회 필터 없이 전부 저장한다. 기본 조회는 BOT + 첫 줄 `@mailman` HUMAN, `[🤖 Claude]` 시작 메시지는 제외한다. 선정된 스레드의 저장된 답글은 필터 없이 전부 출력한다.
- 일반 텍스트는 사용자 명의로 `[🤖 Claude] ` 태그를 붙여 전송한다. `--thread`로 원 스레드에 답글을 달 수 있다. 슬래시 커맨드의 전송 승인 절차를 유지한다.
- 증분 기준은 마지막 `createTime`. 기존 메시지 수정분과 오래된 맥락은 DEEP 백필로 보완한다. 페이지 상한/실패에서는 DB/커서를 부분 갱신하지 않는다.
- `any`를 쓰지 않는다. 외부 응답은 `unknown`에서 좁힌다.
- 검증은 레포 루트에서 `bun test`. fetch를 주입하고 실제 Google 호출은 하지 않는다.
