
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

> **Mailman.** *Let it replace you.*

## 이게 뭔데요

백엔드가 봇으로 뿌린 스펙을 봇으로 빨아옵니다.

```
/mailman
```


## FAQ

**Q. 왜 이걸 Google Chat API 안 쓰고 Playwright를 쓰나요?**

A. 우리 회사의 GCP는 이런 누추한 기술에 사용하기엔 너무 소중합니다. 그리고 권한 요청하기가 귀찮았음.

**Q. 어떻게 작동하나요?**

A. 잘 모르겠는데 어떻게든 작동합니다.

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
  "spaceUrl": "https://chat.google.com/u/0/app/chat/여기에_스페이스_ID",
  "spaceName": "내 그룹 DM 이름",
  "botName": "추적할 봇 표시 이름",
  "webhookUrl": ""
}
```

| 필드 | 뭘 넣어야 하나 | 모르겠으면 |
|------|----------------|-----------|
| `spaceUrl` | 그룹 DM URL | 브라우저에서 해당 DM 열고 주소창 복사 |
| `spaceName` | DM 이름 | 아무거나 써도 됨. 로그에만 찍힘 |
| `botName` | 봇 표시 이름 | DM에서 봇이 메시지 보낼 때 뜨는 이름. **한 글자라도 다르면 못 잡음** |
| `webhookUrl` | 전송용 webhook URL | 없으면 비워두세요. 보내기 기능만 안 됨 |

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

| 증상 | 처방 |
|------|------|
| "로그인 세션이 없거나 만료되었습니다" | `bash ~/.claude/scripts/mailman/run.sh auth` |
| 아무것도 안 나옴 | config.json의 `botName` 확인. 띄어쓰기 하나 틀려도 안 됨 |
| 메시지가 깨져 보임 | Google이 DOM을 바꿨을 수 있음. 이슈 남겨주세요 |
| DB 초기화하고 싶음 | `sqlite3 ~/.claude/inbox/mailman.db "DELETE FROM messages; DELETE FROM meta;"` |

## 상세 문서

- [scripts/mailman/README.md](scripts/mailman/README.md) — 동작 원리, 환경변수, 파일 구조
