# claude-mailman

Google Chat 그룹 DM 에서 특정 봇이 공유한 메시지를 Claude Code `/mailman` 슬래시 커맨드 한 방으로 가져오는 로컬 파이프라인.

## 왜 만들었나

백엔드 개발자가 웹훅 봇으로 API 스펙을 그룹 DM 에 공유하면, 프론트엔드가 그걸 매번 복사 → 붙여넣기 → Claude 에 입력하는 반복 노동이 생겼다.
이걸 슬래시 커맨드 한 줄로 자동화하는 게 목표.

> Google Chat API 는 Workspace 계정 소유 GCP 프로젝트가 아니면 사용 불가 (개인 Gmail GCP 에서는 Chat app configuration 이 잠겨있음).
> 따라서 Playwright 로 로그인된 Chrome 세션을 재사용해서 chat.google.com DOM 을 읽는 방식을 채택했다.

## 동작 구조

```
/mailman → fetch.sh → run.sh → collector.ts
                                    ↓
                     Playwright + 저장된 Chrome 프로필
                                    ↓
                     chat.google.com DOM 스크래핑
                                    ↓
                     SQLite (INSERT OR IGNORE, 멱등)
                                    ↓
                               fetch.ts (thread 그룹핑)
                                    ↓
                              Claude 컨텍스트
```

## 셋업 (처음 쓰는 사람)

### 1. 파일 복사

이 디렉토리 전체를 `~/.claude/scripts/mailman/` 으로 복사한다.

```bash
# 이미 이 위치라면 생략
cp -r mailman ~/.claude/scripts/mailman
```

### 2. 의존성 설치

[bun](https://bun.sh) 이 필요하다.

```bash
cd ~/.claude/scripts/mailman
bun install
```

### 3. config.json 수정

`config.json` 을 열어서 본인 환경에 맞게 수정한다.

```json
{
  "spaceUrl": "https://chat.google.com/u/0/app/chat/여기에_스페이스_ID",
  "spaceName": "내 그룹 DM 이름",
  "botName": "추적할 봇 표시 이름"
}
```

| 필드 | 설명 | 찾는 법 |
|------|------|---------|
| `spaceUrl` | 대상 Google Chat 그룹 DM 의 URL | 브라우저에서 해당 DM 열고 주소창 복사 |
| `spaceName` | DM 이름 (로그인 안내 메시지에 쓰임) | 자유 입력 |
| `botName` | 추적할 봇의 **표시 이름** | DM 에서 봇이 메시지 보낼 때 보이는 이름. 정확히 일치해야 함 |

### 4. 슬래시 커맨드 등록

`~/.claude/commands/mailman.md` 를 만든다:

```markdown
---
description: Google Chat에서 수집한 최신 메시지(API 스펙 등) 가져오기
argument-hint: "[개수=5]"
allowed-tools: Bash(~/.claude/scripts/mailman/run.sh:*), Bash(~/.claude/scripts/mailman/fetch.sh:*)
---

!`~/.claude/scripts/mailman/fetch.sh $ARGUMENTS`

위는 구글챗 그룹 DM에서 mailman이 수집한 최근 메시지입니다.
작업 중인 티켓과 관련된 API 스펙이 있다면 타입 정의와 요청 작성에 활용하세요.
```

### 5. 최초 로그인

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

1. 새 Chrome 창이 열림 (전용 프로필 — 평소 브라우저와 별개)
2. **회사 Google 계정** 으로 로그인
3. config.json 에 설정한 그룹 DM 이 보이는 상태까지 진행
4. 터미널로 돌아와서 **Enter**
5. `✅ 세션 저장 완료` 가 뜨면 끝

### 6. 확인

```bash
bash ~/.claude/scripts/mailman/run.sh  # 수집
cd ~/.claude/scripts/mailman && bun run fetch.ts 3  # 최근 3개 출력
```

또는 Claude Code 에서:

```
/mailman
```

## 사용법

### 기본

```
/mailman        # 최근 5개 스레드
/mailman 10     # 최근 10개 스레드
```

### 세션 만료 시

Google SSO 세션이 만료되면 (며칠~몇 주 주기) `/mailman` 실행 시 안내가 뜬다:

```
[mailman] 로그인 세션이 없거나 만료되었습니다. 다음 명령을 실행하세요:
  bash ~/.claude/scripts/mailman/run.sh auth
```

### 환경변수 override

config.json 대신 환경변수로도 설정 가능하다 (환경변수가 우선):

| 환경변수 | 설명 |
|----------|------|
| `MAILMAN_SPACE_URL` | 대상 space URL |
| `MAILMAN_BOT_NAME` | 봇 표시 이름 |
| `MAILMAN_HEADLESS` | `1` 이면 Chrome 창 안 뜸 |
| `MAILMAN_DEBUG` | `1` 이면 디버그 로그 |

### 데이터 위치

| 항목 | 경로 |
|------|------|
| DB (메시지) | `~/.claude/inbox/mailman.db` |
| 로그 | `~/.claude/logs/mailman.log` |
| Chrome 프로필 | `~/.claude/state/mailman-chrome/` |

### DB 초기화

```bash
sqlite3 ~/.claude/inbox/mailman.db "DELETE FROM messages; DELETE FROM meta;"
```

## 요구사항

- macOS (Chrome 경로가 `/Applications/Google Chrome.app` 하드코딩)
- [bun](https://bun.sh) >= 1.0
- Google Chrome 설치됨
- Claude Code (슬래시 커맨드 용)

## 제약 사항

- **on-demand 실행만 지원**: `/mailman` 칠 때만 수집. 백그라운드 주기 수집 없음
- **Google Chat API 사용 불가**: Workspace 소유 GCP 프로젝트 없이는 Chat API Configuration 이 잠겨있어서, DOM 스크래핑으로 우회
- **DOM 변경에 취약할 수 있음**: Google 이 chat.google.com UI 를 바꾸면 selector 가 깨질 수 있음. 그 경우 `collector.ts` 의 `extractMessages` 함수 내 selector 수정 필요
- **봇 메시지만 수집**: `config.json` 의 `botName` 과 정확히 일치하는 발신자만 필터링. 사람 메시지는 무시됨

## 파일 구조

```
~/.claude/scripts/mailman/
├─ config.json      # 설정 (space URL, 봇 이름)
├─ auth.ts          # 최초 로그인 (headful Playwright)
├─ collector.ts     # DOM 스크래핑 + 답장 자동 펼치기
├─ fetch.ts         # SQLite → markdown 렌더
├─ fetch.sh         # 수집 + fetch 통합 래퍼 (슬래시 커맨드용)
├─ run.sh           # 수집 전용 래퍼
├─ package.json
└─ README.md        # 이 문서
```
