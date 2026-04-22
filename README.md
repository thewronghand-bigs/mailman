<p align="center">
  <img width="261" height="261" alt="mailman" src="https://github.com/user-attachments/assets/b913ae4d-6ab5-4f7a-b655-7acd3865e33d" />
</p>

<h1 align="center">Mailman</h1>

<p align="center">
  <i>소통을 딸깍하세요.</i>
</p>

---

사악한 백뻔뻔([@SongInjun1](https://github.com/SongInjun1))의 스펙 야바위로부터 벗어나세요.

잘못된 스펙에 화를 내는 역할조차 AI에게 대체되는 것이 프론트엔드의 미래입니다.

지금 당장 시작하세요.

> **Mailman.** _Let it replace you._

## 이게 뭔데요

백엔드가 봇으로 뿌린 스펙을 봇으로 빨아옵니다.

```
/mailman              # 기본 스페이스에서 최근 5개
/mailman 인준 3        # 인준 스페이스에서 최근 3개
/mailman tn 희조봇 3   # tn 스페이스에서 희조봇 메시지 3개
```

## FAQ

**Q. 왜 이걸 Google Chat API 안 쓰고 Playwright를 쓰나요?**

A. 우리 회사의 GCP는 이런 누추한 기술에 사용하기엔 너무 소중합니다. (그리고 권한 요청하기가 귀찮았음)

**Q. 어떻게 작동하나요?**

<details>
<summary>A. 그게 왜 궁금하세요?</summary>

### 동작 구조

```
/mailman [스페이스] → fetch.sh → run.sh → collector.ts
                                              ↓
                               Playwright + 저장된 Chrome 프로필
                                              ↓
                               chat.google.com DOM 스크래핑
                                              ↓
                               SQLite (INSERT OR IGNORE, 멱등)
                                              ↓
                                         fetch.ts (thread 그룹핑, 스페이스 필터링)
                                              ↓
                                        Claude 컨텍스트
```

### 핵심 메커니즘

1. **인증**: Playwright가 전용 Chrome 프로필(`~/.claude/state/mailman-chrome/`)로 `chat.google.com`을 연다. Google SSO 세션이 쿠키에 남아있으므로 재로그인 없이 접근 가능.

2. **수집**: `config.json`의 `spaces`에서 지정된 DM URL로 이동 → DOM에서 `div[role='group']` 컨테이너를 찾아 봇 메시지를 추출. `data-message-id`, `data-absolute-timestamp`, `data-topic-id` 등의 안정적인 HTML attribute를 사용.

3. **필터링**: `[data-message-id][role='heading']`의 innerText가 설정된 봇 이름을 포함하는 메시지만 수집. 스레드 답장이 있으면 `jsaction="click:QQNHUe"` 버튼을 클릭해서 자동 펼침.

4. **저장**: SQLite DB에 `INSERT OR IGNORE`로 멱등하게 저장. `space` 컬럼으로 스페이스별 구분. 같은 메시지를 여러 번 수집해도 중복 없음.

5. **출력**: `fetch.ts`가 `thread_name`으로 그룹핑 → 최신 스레드 순으로 마크다운 렌더링 → Claude 컨텍스트에 삽입.

6. **전송**: Google Chat Incoming Webhook으로 메시지 전송. 스페이스별로 다른 webhook URL 사용 가능.

### 데이터 위치

| 항목          | 경로                              |
| ------------- | --------------------------------- |
| DB (메시지)   | `~/.claude/inbox/mailman.db`      |
| 로그          | `~/.claude/logs/mailman.log`      |
| Chrome 프로필 | `~/.claude/state/mailman-chrome/` |

### 제약 사항

- **on-demand 실행만 지원**: `/mailman` 칠 때만 수집
- **DOM 변경에 취약**: Google이 chat.google.com UI를 바꾸면 selector가 깨질 수 있음
- **macOS 전용**: Chrome 경로가 하드코딩

</details>

**Q. Codex에선 어떻게 써요?**

A. 유감입니다.

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/claude-mailman/main/install.sh | bash
```

bun이 없으면 [여기서](https://bun.sh) 먼저 설치하세요.

## 설정

### 1. config.json 수정

```bash
vi ~/.claude/scripts/mailman/config.json
```

```json
{
  "spaces": {
    "myspace": {
      "url": "https://chat.google.com/u/0/app/chat/스페이스_ID",
      "webhookUrl": "",
      "bots": {
        "봇별칭": "봇 표시 이름"
      },
      "defaultBot": "봇별칭"
    }
  },
  "defaultSpace": "myspace"
}
```

여러 DM을 등록할 수 있습니다. `spaces` 안에 별칭을 키로 추가하세요.

| 필드                       | 뭘 넣어야 하나               | 모르겠으면                                                           |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `spaces.{별칭}.url`        | DM URL                       | 브라우저에서 해당 DM 열고 주소창 복사                                |
| `spaces.{별칭}.webhookUrl` | 전송용 webhook URL           | 없으면 비워두세요. 보내기 기능만 안 됨                               |
| `spaces.{별칭}.bots`       | `{ "별칭": "봇 표시 이름" }` | DM에서 봇이 메시지 보낼 때 뜨는 이름. **한 글자라도 다르면 못 잡음** |
| `spaces.{별칭}.defaultBot` | 기본 봇 별칭                 | 생략 시 bots의 첫 번째                                               |
| `defaultSpace`             | 기본 스페이스 별칭           | `/mailman` 인자 없이 쓸 때 사용                                      |

### 2. 최초 로그인 (1회만)

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

Chrome이 뜹니다. 회사 계정으로 로그인하세요. 그룹 DM이 보이면 터미널에서 Enter.

세션이 만료되면 다시 로그인하세요.

### 3. 사용법

클로드한테 물어보세요.

## 보내기도 됩니다

webhook URL을 설정했다면, 작업 완료 후 Claude가 알아서 그룹 DM에 완료 알림을 보내줍니다.

## 준비물

- macOS
- [bun](https://bun.sh) >= 1.0
- Google Chrome
- Claude Code
- 스펙을 줄 백엔드

## 문제 생기면

| 증상                                  | 처방                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| "로그인 세션이 없거나 만료되었습니다" | `bash ~/.claude/scripts/mailman/run.sh auth`                                   |
| 아무것도 안 나옴                      | config.json의 `bots`에서 봇 표시 이름 확인. 띄어쓰기 하나 틀려도 안 됨         |
| 메시지가 깨져 보임                    | Google이 DOM을 바꿨을 수 있음. 이슈 남겨주세요                                 |
| DB 초기화하고 싶음                    | `sqlite3 ~/.claude/inbox/mailman.db "DELETE FROM messages; DELETE FROM meta;"` |

## 상세 문서

- [scripts/mailman/README.md](scripts/mailman/README.md) — 환경변수, 파일 구조, DB 스키마
