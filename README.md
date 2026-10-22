<p align="center">
  <img width="261" height="261" alt="mailman" src="https://github.com/user-attachments/assets/b913ae4d-6ab5-4f7a-b655-7acd3865e33d" />
</p>

<h1 align="center">Mailman v2</h1>

<p align="center"><i>소통을 딸깍하세요.</i></p>

Google Chat 스페이스의 메시지를 로컬 SQLite에 모아 Claude Code에서 조회하고, 승인한 답장을 원 스레드에 보냅니다. **사용자 OAuth + Google Chat API**를 사용합니다.

## 사용

```text
/mailman                 # 기본 스페이스, 마지막으로 보여준 이후의 새 메시지
/mailman 인준             # 인준 스페이스의 새 메시지
/mailman tn --since 7d    # 최근 7일 조회, seen 커서는 유지
/mailman-deep tn          # 최근 30일을 백필 재수집한 뒤 새 메시지 조회
```

CLI도 같은 동작을 합니다.

```bash
bash scripts/mailman/run.sh auth
bash scripts/mailman/run.sh tn
bash scripts/mailman/fetch.sh tn
bash scripts/mailman/fetch.sh tn --since 7d
bash scripts/mailman/fetch.sh tn --since 2026-10-01
MAILMAN_DEEP=1 bash scripts/mailman/fetch.sh tn
printf '%s\n' '확인했습니다.' | bash scripts/mailman/send.sh tn
printf '%s\n' '명세 반영 완료했습니다.' | bash scripts/mailman/send.sh tn --thread spaces/SPACE_ID/threads/THREAD_ID
```

한 번에 새 메시지를 최대 **200건** 보여줍니다. 첫 조회는 최근 24시간이며, 기본 조회에서 남은 메시지는 다시 실행하면 이어서 보여줍니다.

## 설치와 설정

준비물은 macOS, bun, Google Chat에 접근할 사용자 계정, Chat API가 활성화된 GCP 프로젝트의 **데스크톱 앱 OAuth 클라이언트**입니다. 새 런타임에는 외부 패키지 의존성이 없습니다.

1. `scripts/mailman/config.example.json`을 `config.json`으로 복사해 스페이스를 등록합니다.
2. Google에서 받은 `{"installed": {...}}` JSON을 `~/.claude/secrets/mailman-oauth.json`에 저장합니다.
3. `bash scripts/mailman/run.sh auth`를 실행하고 브라우저에서 로그인·권한 동의를 마칩니다.
4. [INSTALL.md](INSTALL.md)를 따라 Claude Code 커맨드를 연결합니다.

```json
{
  "defaultSpace": "tn",
  "spaces": {
    "tn": {
      "space": "spaces/AAQAgRGQTic",
      "webhookUrl": ""
    }
  }
}
```

`space`는 Chat API의 리소스 이름입니다. 별칭을 추가하면 여러 스페이스를 사용할 수 있습니다. `webhookUrl`은 선택 사항이며 카드 전송에만 씁니다. `config.json`은 gitignore 대상입니다.

## 수집과 조회

```text
/mailman → fetch.sh → 사용자 OAuth refresh → Chat API messages.list
                                               ↓
                                   모든 발신자 메시지를 SQLite upsert
                                               ↓
                         seen 이후 새 메시지 선정 → 스레드와 이전 맥락 출력
                                               ↓
                                  출력 성공 후 조회 seen 커서 저장
```

- 최초 수집은 최근 7일입니다. 이후에는 스페이스별 마지막 `createTime` 이후를 증분 수집합니다.
- `/mailman-deep`은 수집 커서와 관계없이 최근 30일을 다시 받습니다. 구멍을 메우는 재수집이며, 그 뒤 조회는 기본 모드(안 읽은 메시지)를 유지합니다. `MAILMAN_BACKFILL_DAYS`로 최초/백필 창을 바꿀 수 있습니다.
- 모든 발신자 메시지를 원문 그대로 저장합니다. 이름(`name`)이 같으면 `lastUpdateTime` 기준으로 수정 내용을 갱신합니다.
- 수집 범위는 **config에 등록한 방**으로 정합니다. 조회도 사람·봇·mailman 전송을 모두 포함하고 본문을 그대로 보여줍니다. Claude는 출력 전체를 읽고 API 스펙, 의현에게 온 요청·질문, 일정·배포 등 작업에 영향 주는 내용만 요약합니다.
- 기본 조회는 **mailman이 그 방에서 마지막으로 보여준 이후**의 생성 시각을 가진 메시지입니다. 스페이스별 `seenCreateTime`은 수집 커서 및 Google Chat 읽음 상태와 별개입니다. seen이 없으면 최근 24시간을 보여줍니다.
- 새 메시지를 오래된 것부터 최대 200건 고릅니다. 스레드는 가장 이른 새 메시지 시각순이며 내부는 시간순입니다. 오래된 스레드의 답글이면 직전의 저장된 메시지 중 최근 5건을 **이전 맥락**으로 붙이고, 생략한 건수를 표시합니다. 출력에는 `thread_name`, DB 기준 첫 메시지 `name`, 각 메시지의 발신자·BOT/HUMAN 구분, 첨부 파일명이 포함됩니다.
- 출력 완료 후 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진합니다. 같은 시각에 200건 경계가 걸리면 메시지 이름을 보조 커서로 사용해 이어서 보여줍니다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로입니다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`로 표시합니다.
- `--since 24h`, `--since 3d`, `--since 7d` 또는 `--since YYYY-MM-DD`는 지정 시점 이후를 조회합니다. 기간은 양의 정수 시간/일, 날짜는 실행 환경의 로컬 자정 기준이며 **seen을 바꾸지 않습니다**. 같은 200건·스레드 규칙을 적용하고, 상한을 넘으면 기간을 좁히도록 안내합니다.
- `cardsV2`와 구형 `cards`의 카드 본문도 제목·섹션·코드블록·버튼 링크 등을 마크다운 텍스트로 펼칩니다. 메시지 텍스트가 함께 있으면 텍스트 다음에 카드를 표시합니다.
- 수집에 실패해도 `fetch.sh`는 기존 DB를 보여줍니다. 오류 안내와 마지막 성공 수집 시각을 함께 확인하세요.

증분 필터는 생성 시각 기준이므로 **예전에 생성된 메시지의 수정분은 백필로 갱신**합니다. 수집 창 밖의 과거 원문/답글은 DB에 없을 수 있습니다. 필요한 경우 백필 기간을 늘리세요. 수집은 100개씩 최대 1,000페이지이며, 실패/상한 초과 때는 저장과 커서 갱신을 하지 않습니다.

## 인증과 전송

인증은 임의 포트 `127.0.0.1` loopback, PKCE S256, state 검증을 사용합니다. refresh token·이메일·허용 스코프만 0600 파일에 저장하며, access token은 매 실행마다 새로 발급받아 메모리에서만 사용합니다.

요청 스코프는 다음 다섯 개입니다.

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages.readonly`
- `https://www.googleapis.com/auth/chat.messages.create`

`send.sh`는 **로그인한 사용자 명의**로 본문 앞에 `[🤖 Claude] `를 붙입니다. `--thread`를 주면 원 스레드에 답글을 보내며, API가 답글을 만들 수 없으면 새 스레드로 전환합니다. 실패 시 자동 재시도하지 않습니다. 슬래시 커맨드에서는 초안을 보여주고 **사용자 승인 후** 전송합니다.

사용자 인증 전송은 텍스트 전용입니다. `cardsV2`는 [commands/mailman.md](commands/mailman.md)의 기존 웹훅 curl 절차를 계속 사용합니다. [Chat API 전송 규격](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create)을 참고하세요.

## 데이터와 환경변수

| 항목 | 기본 경로/설정 |
|------|----------------|
| DB | `$MAILMAN_HOME/inbox/mailman-v2.db` |
| 요약 로그 | `$MAILMAN_HOME/logs/mailman.log` |
| `MAILMAN_HOME` | `~/.claude` |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json` |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json` |
| `MAILMAN_DEEP=1` | 최근 30일 백필 재수집 |
| `MAILMAN_BACKFILL_DAYS` | 최초/백필 창 일수, 기본 7/30, 1~36500 |

인증정보 경로는 `MAILMAN_HOME`과 독립적입니다. 다른 위치를 쓰려면 `MAILMAN_CLIENT_FILE`과 `MAILMAN_TOKEN_FILE`을 각각 지정하세요.

## 이전 버전과 개발

기존 Playwright/snapshot 구현은 [scripts/mailman-legacy/README.md](scripts/mailman-legacy/README.md)에 보존합니다. v2는 이전 설정·DB와 호환하지 않습니다. 기존 gitignore 대상 `config.json`, `node_modules/`, `bun.lock`은 자동 정리하지 않습니다. 설정은 예제 기준으로 사용자가 새로 작성합니다.

```bash
bun test
```

테스트는 fetch를 주입하고 실제 네트워크를 차단합니다. 자세한 스키마와 종료 코드는 [런타임 문서](scripts/mailman/README.md)를 참고하세요.
