# claude-mailman

Google Chat DM에서 봇 메시지를 수집해 로컬 SQLite에 저장하고, 슬래시 커맨드 또는 CLI로 조회/전송하는 파이프라인.

## 구조

```
scripts/mailman/
├─ runtime.ts       # 공용 설정 로더, 경로 해석, 스페이스/봇 resolve
├─ auth.ts          # 최초 Google 로그인 (headful Playwright)
├─ collector.ts     # DOM 스크래핑 수집 (playwright driver) 또는 JSON import (snapshot driver)
├─ snapshot.ts      # snapshot JSON 파서
├─ fetch.ts         # SQLite → markdown 출력
├─ send.ts          # webhook 전송
├─ fetch.sh         # 수집 + 출력 래퍼 (슬래시 커맨드 진입점)
├─ run.sh           # 수집 전용 래퍼
├─ send.sh          # 전송 래퍼
├─ config.json      # 스페이스/봇 설정 (gitignore 대상)
└─ package.json

commands/mailman.md  # Claude Code 슬래시 커맨드 정의
```

## 런타임

- bun 전용 — `bun:sqlite` 등 bun 내장 모듈 사용
- Playwright로 Chrome DOM 스크래핑 (기본 driver)
- `MAILMAN_DRIVER=snapshot`이면 JSON 파일에서 import (브라우저 불필요)

## 데이터 경로

`MAILMAN_HOME` 환경변수로 오버라이드 가능. 기본값 `~/.claude`.

- DB: `$MAILMAN_HOME/inbox/mailman.db`
- Chrome 프로필: `$MAILMAN_HOME/state/mailman-chrome`
- 로그: `$MAILMAN_HOME/logs/mailman.log`

## 주요 환경변수

| 변수 | 설명 |
|------|------|
| `MAILMAN_HOME` | 런타임 데이터 루트 (기본: `~/.claude`) |
| `MAILMAN_DRIVER` | `playwright` (기본) 또는 `snapshot` |
| `MAILMAN_SNAPSHOT_FILE` | snapshot driver용 JSON 파일 경로 |
| `MAILMAN_CHROME_PATH` | Chrome/Chromium 실행 파일 경로 |
| `MAILMAN_HEADLESS` | `1`이면 headless 모드 |
| `MAILMAN_WEBHOOK_URL` | webhook URL override |

## 개발 시 주의

- `config.json`은 gitignore 대상 (개인 URL, webhook 포함)
- DOM selector는 Google Chat UI 변경에 취약 — `collector.ts`의 `extractMessages` 참고
- 설정 해석 로직은 `runtime.ts`에 집중. 개별 스크립트에서 중복 구현하지 말 것
