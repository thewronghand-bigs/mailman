# mailman runtime

Google Chat DOM 을 Playwright 로 읽고, 메시지를 로컬 SQLite에 저장/조회/전송하는 공용 런타임.

## 핵심 명령

```bash
bash run.sh auth [스페이스별칭]
bash run.sh [스페이스별칭]
bash fetch.sh [스페이스별칭] [봇별칭] [개수]
echo "hello" | bash send.sh [스페이스별칭]
```

샌드박스용 snapshot 수집:

```bash
MAILMAN_DRIVER=snapshot \
MAILMAN_SNAPSHOT_FILE=/abs/path/chat.json \
MAILMAN_HOME="$PWD/.mailman" \
bash run.sh [스페이스별칭]
```

## 설정

`config.json`:

```json
{
  "spaces": {
    "myspace": {
      "url": "https://chat.google.com/u/0/app/chat/SPACE_ID",
      "webhookUrl": "",
      "bots": {
        "specbot": "Spec Bot"
      },
      "defaultBot": "specbot"
    }
  },
  "defaultSpace": "myspace"
}
```

## 런타임 경로

기본값은 `MAILMAN_HOME=${HOME}/.claude`.

| 항목 | 경로 |
|------|------|
| Chrome 프로필 | `$MAILMAN_HOME/state/mailman-chrome` |
| DB | `$MAILMAN_HOME/inbox/mailman.db` |
| 로그 | `$MAILMAN_HOME/logs/mailman.log` |

## 환경변수

| 환경변수 | 설명 |
|----------|------|
| `MAILMAN_HOME` | 런타임 데이터 루트 |
| `MAILMAN_CHROME_PATH` | Chrome/Chromium 실행 경로 |
| `MAILMAN_HEADLESS` | `1`이면 headless |
| `MAILMAN_DEBUG` | `1`이면 디버그 로그 |
| `MAILMAN_WEBHOOK_URL` | webhook override |
| `MAILMAN_DRIVER` | `playwright` 또는 `snapshot` |
| `MAILMAN_SNAPSHOT_FILE` | snapshot driver에서 읽을 JSON 파일 |

## 메모

- `auth.ts`, `collector.ts`, `fetch.ts`, `send.ts` 는 같은 설정 해석 로직을 사용한다.
- Claude Code 연결은 상위 `commands/mailman.md` 와 `docs/claude.md` 에서 설명한다.
- Codex 사용법은 상위 `docs/codex.md` 에서 설명한다.
- snapshot driver는 저장된 JSON 메시지 배열만 적재한다. 답글 펼침이 필요하면 snapshot 추출 전에 브라우저 쪽에서 먼저 펼쳐야 한다.
