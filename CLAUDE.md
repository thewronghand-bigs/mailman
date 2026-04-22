# claude-mailman

Google Chat DM에서 봇 메시지를 수집해 Claude Code 슬래시 커맨드로 제공하는 로컬 파이프라인.

## 구조

- `scripts/mailman/` — 핵심 스크립트 (collector, fetch, send, auth)
- `commands/mailman.md` — `/mailman` 슬래시 커맨드 정의
- 런타임: bun + Playwright (Chrome DOM 스크래핑)
- 저장: SQLite (`~/.claude/inbox/mailman.db`)

## 멀티 스페이스

`config.json`의 `spaces` 객체에 여러 DM을 별칭으로 등록.
인자로 스페이스 별칭을 넘기면 해당 DM에서 수집/조회/전송.

## 개발 시 주의

- `config.json`은 gitignore 대상 (개인 URL, webhook 포함)
- bun 전용 프로젝트 — `bun:sqlite` 등 bun 내장 모듈 사용
- DOM selector는 Google Chat UI 변경에 취약 — `collector.ts`의 `extractMessages` 참고
