# claude-mailman

Google Chat 그룹 DM 에서 특정 봇이 공유한 메시지를 Claude Code `/mailman` 슬래시 커맨드로 가져오는 로컬 파이프라인.

- Playwright 로 로그인된 Chrome 세션을 재사용해 chat.google.com DOM 을 읽는 방식
- Google Chat API 는 Workspace 소유 GCP 프로젝트 없이는 사용 불가하므로 DOM 스크래핑으로 우회
- Incoming Webhook 을 통한 메시지 전송도 지원

## 원라인 설치

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/claude-mailman/main/install.sh | bash
```

## 설치 후 설정

### 1. config.json 수정

```bash
vi ~/.claude/scripts/mailman/config.json
```

```json
{
  "spaceUrl": "https://chat.google.com/u/0/app/chat/YOUR_SPACE_ID",
  "spaceName": "내 그룹 DM 이름",
  "botName": "추적할 봇 표시 이름",
  "webhookUrl": ""
}
```

| 필드 | 설명 | 찾는 법 |
|------|------|---------|
| `spaceUrl` | 대상 그룹 DM URL | 브라우저에서 해당 DM 열고 주소창 복사 |
| `spaceName` | DM 이름 (로그용) | 자유 입력 |
| `botName` | 추적할 봇의 **표시 이름** | DM 에서 봇 메시지 보낼 때 보이는 이름. 정확히 일치해야 함 |
| `webhookUrl` | 전송용 webhook URL (선택) | Google Chat space 설정 > 앱 및 통합 > Webhook 추가 |

### 2. 최초 로그인

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

1. 새 Chrome 창이 열림 (전용 프로필)
2. **회사 Google 계정** 으로 로그인
3. 대상 그룹 DM 이 보이는 상태까지 진행
4. 터미널에서 **Enter**

### 3. 사용

Claude Code 에서:

```
/mailman        # 최근 5개 스레드
/mailman 10     # 최근 10개 스레드
```

## 요구사항

- macOS
- [bun](https://bun.sh) >= 1.0
- Google Chrome
- Claude Code

## 상세 문서

- [scripts/mailman/README.md](scripts/mailman/README.md) — 동작 원리, 환경변수, 트러블슈팅
