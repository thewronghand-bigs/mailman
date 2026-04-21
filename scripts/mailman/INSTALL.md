# mailman 설치 가이드

Claude Code 슬래시 커맨드 `/mailman` 으로 Google Chat 그룹 DM 메시지를 수집/전송하는 로컬 파이프라인입니다.
자세한 동작 원리와 사용법은 `scripts/mailman/README.md` 참고하세요.

## 요구사항
- macOS (Chrome 경로가 `/Applications/Google Chrome.app` 로 하드코딩돼 있음)
- [bun](https://bun.sh) >= 1.0
- Google Chrome 설치
- Claude Code

## 설치 순서

### 1. 압축 해제

`~/.claude/` 위에서 tar 를 풀면 `scripts/mailman/` 과 `commands/mailman.md` 가 알맞은 위치에 배치됩니다.

```bash
tar xzf mailman-share.tar.gz
cp -r mailman-share/scripts/mailman ~/.claude/scripts/
cp mailman-share/commands/mailman.md ~/.claude/commands/
```

> 이미 `~/.claude/commands/mailman.md` 가 있다면 덮어쓰기 전에 본인 버전 백업 권장.

### 2. config.json 생성

템플릿을 복사해서 본인 값으로 채웁니다.

```bash
cd ~/.claude/scripts/mailman
cp config.example.json config.json
```

`config.json` 을 열어 아래 값을 본인 환경에 맞게 수정:

| 필드 | 설명 | 찾는 법 |
|------|------|---------|
| `spaceUrl` | 대상 Google Chat 그룹 DM URL | 브라우저에서 해당 DM 열고 주소창 복사 |
| `spaceName` | DM 이름 (로그용) | 자유 입력 |
| `botName` | 추적할 봇의 **표시 이름** | DM 에서 봇 메시지 보낼 때 보이는 이름, 정확히 일치해야 함 |
| `webhookUrl` | 작업 완료 알림 전송용 webhook URL | 해당 Google Chat space 설정 → 앱 및 통합 → Webhook 추가로 직접 발급 |

> ⚠️ `webhookUrl` 은 **각자 발급받아야** 합니다. 다른 사람의 webhook 을 재사용하면 봇 이름/space 가 엉뚱하게 찍힙니다.

### 3. 의존성 설치

```bash
cd ~/.claude/scripts/mailman
bun install
```

### 4. 최초 Google 로그인

```bash
bash ~/.claude/scripts/mailman/run.sh auth
```

1. 새 Chrome 창이 열립니다 (전용 프로필, 평소 브라우저와 분리됨)
2. **회사 Google 계정** 으로 로그인
3. `config.json` 의 그룹 DM 이 보이는 상태까지 진행
4. 터미널로 돌아와서 **Enter**
5. `✅ 세션 저장 완료` 가 뜨면 끝

### 5. 확인

Claude Code 에서:

```
/mailman
```

최근 메시지가 출력되면 성공입니다.

## 트러블슈팅

- 세션 만료 (며칠~몇 주 주기) 시 `bash ~/.claude/scripts/mailman/run.sh auth` 다시 실행
- DB 초기화: `sqlite3 ~/.claude/inbox/mailman.db "DELETE FROM messages; DELETE FROM meta;"`
- 그 외 자세한 내용은 `scripts/mailman/README.md` 참고
