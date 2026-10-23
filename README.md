<p align="center">
  <img width="261" height="261" alt="mailman" src="https://github.com/user-attachments/assets/b913ae4d-6ab5-4f7a-b655-7acd3865e33d" />
</p>

<h1 align="center">Mailman v2</h1>

<p align="center"><i>소통을 딸깍하세요.</i></p>

Google Chat 스페이스의 메시지를 로컬 SQLite에 모아 Claude Code(`/mailman`)나 Codex(`$mailman`)에서 조회하고, 승인한 답장을 원 스레드에 보냅니다. **사용자 OAuth + Google Chat API**를 사용합니다.

## 사용

```text
/mailman                       # 기본 스페이스, 마지막으로 보여준 이후의 새 메시지
/mailman backend               # backend 별칭 스페이스의 새 메시지
/mailman team --since 7d       # 최근 7일 조회, seen 커서는 유지
/mailman team --only human     # 사람 메시지만 조회, seen 커서는 유지
/mailman-deep team             # 최근 30일을 백필 재수집한 뒤 새 메시지 조회
```

Codex에서는 `$mailman` 스킬로 같은 일을 합니다(아래 [Codex에서 쓰기](#codex에서-쓰기)).

CLI도 같은 동작을 합니다. 실행 파일 하나(`~/.claude/bin/mailman`)에 하위 명령이 있습니다. 아래 예시는 `~/.claude/bin`을 PATH에 넣었다고 가정합니다. 넣지 않았다면 `~/.claude/bin/mailman`처럼 전체 경로로 실행하세요.

```bash
echo 'export PATH="$HOME/.claude/bin:$PATH"' >> ~/.zshrc   # PATH 추가 (zsh)
```

```bash
mailman auth --client ~/Downloads/client_secret_XXXX.json   # 최초 로그인 (클라이언트 등록)
mailman auth                                                # 재로그인
mailman collect team                                        # 수집만
mailman collect team --deep                                 # 최근 30일 백필 수집
mailman fetch team                                          # 수집 후 새 메시지 조회
mailman fetch team --since 2026-10-01                       # 기간 조회 (seen 유지)
mailman fetch team --only bot                               # 봇 메시지만 (seen 유지)
mailman fetch team --no-collect                             # 수집 없이 DB만 조회
printf '%s\n' '확인했습니다.' | mailman send team
printf '%s\n' '명세 반영 완료했습니다.' | mailman send team --thread spaces/SPACE_ID/threads/THREAD_ID
mailman --help
mailman --version
```

한 번에 새 메시지를 최대 **200건** 보여줍니다. 첫 조회는 최근 24시간이며, 기본 조회에서 남은 메시지는 다시 실행하면 이어서 보여줍니다.

## 설치와 설정

준비물은 macOS(Apple Silicon/Intel)와 Google Chat에 접근할 회사(Workspace) 계정입니다. 배포본은 `bun build --compile`로 만든 단일 실행 파일이라 bun·Node.js가 필요 없습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

1. 설치 스크립트가 최신 릴리스의 `mailman-darwin-<arch>`를 `~/.claude/bin/mailman`에, `/mailman`·`/mailman-deep` 커맨드를 `~/.claude/commands/`에 설치하고 설정 예시를 `~/.claude/mailman/config.json`에 만듭니다. 필요한 파일을 모두 받아 검증한 뒤 한꺼번에 설치하므로, 다운로드가 하나라도 실패하면 기존 설치는 그대로입니다. 실행 파일은 직전 1개만 `mailman.bak`으로, 커맨드·스킬 문서는 `.bak.<타임스탬프>`로 백업합니다. Codex 스킬도 설치하려면 `MAILMAN_TARGET=all`(또는 `codex`)을 붙입니다.
2. **OAuth 클라이언트는 사용자마다 직접 만듭니다.** [설정 가이드](https://thewronghand-bigs.github.io/mailman/setup)를 따라 본인 GCP 프로젝트에 데스크톱 앱 OAuth 클라이언트를 만들고 JSON을 받습니다. 실행 파일·레포·릴리스에는 client id/secret이 없습니다.
3. `~/.claude/bin/mailman auth --client <받은 JSON>`으로 로그인합니다. JSON은 검증 후 `~/.claude/secrets/mailman-oauth.json`에 0600으로 복사됩니다.
4. 설정 파일에 스페이스를 등록합니다.

```json
{
  "defaultSpace": "team",
  "spaces": {
    "team": {
      "space": "spaces/SPACE_ID",
      "webhookUrl": ""
    }
  }
}
```

`space`는 Chat API의 리소스 이름(`spaces/` + Chat 웹 URL 끝의 ID)입니다. 별칭을 추가하면 여러 스페이스를 사용할 수 있습니다. `webhookUrl`은 선택 사항이며 카드 전송에만 씁니다. 자세한 내용은 [INSTALL.md](INSTALL.md)를 참고하세요.

### 개인 컨벤션 (`local.md`)

`$MAILMAN_HOME/mailman/local.md`(기본 `~/.claude/mailman/local.md`)를 만들어 두면 `/mailman`·`/mailman-deep`·`$mailman`이 커맨드 문서보다 먼저 읽고 우선해 따릅니다. 카드 제목·헤더 이미지·섹션 구성·색상, 보고 말투처럼 사람마다 다른 취향을 여기에 적습니다. 레포 문서에는 중립적인 최소 예시만 둡니다. 없으면 무시합니다. 전송 전 사용자 승인과 웹훅 URL 비노출 규칙은 `local.md`로 바꾸지 않습니다.

## Codex에서 쓰기

Codex CLI는 `${CODEX_HOME:-~/.codex}/skills/mailman/SKILL.md`를 `$mailman` 스킬로 읽습니다. 설치 대상에 `codex`를 넣으면 이 스킬을 함께 설치합니다. 실행 파일은 대상과 관계없이 `~/.claude/bin/mailman` 하나입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_TARGET=all bash     # Claude + Codex
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash -s -- --target codex    # Codex만
```

- **Claude와 같은 DB·seen 커서를 공유합니다.** 한쪽에서 기본 조회로 본 메시지는 다른 쪽 기본 조회에서 새 메시지로 나오지 않습니다. 다시 보려면 `--since`를 씁니다.
- **샌드박스**: mailman은 작업 폴더 밖인 `~/.claude/{inbox,logs,secrets,mailman}`에 쓰고 Google API로 네트워크를 씁니다. 기본 `workspace-write` 샌드박스에서는 실패할 수 있어, 스킬은 mailman 명령을 샌드박스 밖에서 실행하도록 승인을 요청합니다.
- 매번 승인하지 않으려면 `~/.codex/config.toml`에서 해당 경로를 쓰기 가능으로 두고 네트워크를 켭니다. `network_access = true`는 그 샌드박스의 모든 명령에 네트워크를 허용하므로 필요할 때만 켜세요. 경로는 절대 경로로 씁니다.

```toml
[sandbox_workspace_write]
writable_roots = [
  "/Users/<사용자>/.claude/inbox",
  "/Users/<사용자>/.claude/logs",
  "/Users/<사용자>/.claude/secrets",
  "/Users/<사용자>/.claude/mailman",
]
network_access = true
```

- 최초 인증(`mailman auth --client ...`)은 브라우저 로그인이 필요하므로 터미널에서 직접 실행합니다.
- 예전 Codex 어댑터 `~/.local/bin/mailman`이 있으면 설치 스크립트가 알려 줍니다. 더 이상 쓰지 않으므로 필요 없으면 직접 지우세요.

## 수집과 조회

```text
/mailman → mailman fetch → 사용자 OAuth refresh → Chat API messages.list
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
- 수집 범위는 **config에 등록한 방**으로 정합니다. 조회도 사람·봇·mailman 전송을 모두 포함하고 본문을 그대로 보여줍니다. Claude는 출력 전체를 읽고 API 스펙, 사용자에게 온 요청·질문, 일정·배포 등 작업에 영향 주는 내용만 요약합니다.
- 기본 조회는 **mailman이 그 방에서 마지막으로 보여준 이후**의 생성 시각을 가진 메시지입니다. 스페이스별 `seenCreateTime`은 수집 커서 및 Google Chat 읽음 상태와 별개입니다. seen이 없으면 최근 24시간을 보여줍니다.
- 새 메시지를 오래된 것부터 최대 200건 고릅니다. 스레드는 가장 이른 새 메시지 시각순이며 내부는 시간순입니다. 오래된 스레드의 답글이면 직전의 저장된 메시지 중 최근 5건을 **이전 맥락**으로 붙이고, 생략한 건수를 표시합니다. 출력에는 `thread_name`, DB 기준 첫 메시지 `name`, 각 메시지의 발신자·BOT/HUMAN 구분, 첨부 파일명이 포함됩니다.
- 출력 완료 후 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진합니다. 같은 시각에 200건 경계가 걸리면 메시지 이름을 보조 커서로 사용해 이어서 보여줍니다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로입니다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`로 표시합니다.
- `--since 24h`, `--since 3d`, `--since 7d` 또는 `--since YYYY-MM-DD`는 지정 시점 이후를 조회합니다. 기간은 양의 정수 시간/일, 날짜는 실행 환경의 로컬 자정 기준이며 **seen을 바꾸지 않습니다**. 같은 200건·스레드 규칙을 적용하고, 상한을 넘으면 기간을 좁히도록 안내합니다.
- `cardsV2`와 구형 `cards`의 카드 본문도 제목·섹션·코드블록·버튼 링크 등을 마크다운 텍스트로 펼칩니다. 메시지 텍스트가 함께 있으면 텍스트 다음에 카드를 표시합니다.
- `--only bot|human`은 해당 발신자 유형의 새 메시지만 보여주며 **seen을 바꾸지 않습니다**. 거른 조회로 커서를 전진시키면 거른 쪽 메시지가 기본 조회에서 영구히 빠지기 때문입니다. `--since`와 함께 쓸 수 있고, 같은 스레드의 다른 유형 메시지는 이전 맥락으로 보일 수 있습니다.
- 수집에 실패해도 `mailman fetch`는 기존 DB를 보여줍니다. `--no-collect`로 수집을 건너뛸 수 있습니다. 오류 안내와 마지막 성공 수집 시각을 함께 확인하세요.

증분 필터는 생성 시각 기준이므로 **예전에 생성된 메시지의 수정분은 백필로 갱신**합니다. 수집 창 밖의 과거 원문/답글은 DB에 없을 수 있습니다. 필요한 경우 백필 기간을 늘리세요. 수집은 100개씩 최대 1,000페이지이며, 실패/상한 초과 때는 저장과 커서 갱신을 하지 않습니다.

## 인증과 전송

인증은 임의 포트 `127.0.0.1` loopback, PKCE S256, state 검증을 사용합니다. refresh token·이메일·허용 스코프만 0600 파일에 저장하며, access token은 매 실행마다 새로 발급받아 메모리에서만 사용합니다.

요청 스코프는 다음 다섯 개입니다.

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages.readonly`
- `https://www.googleapis.com/auth/chat.messages.create`

`mailman send`는 **로그인한 사용자 명의**로 본문 앞에 `[🤖 Claude] `를 붙입니다. `--thread`를 주면 원 스레드에 답글을 보내며, API가 답글을 만들 수 없으면 새 스레드로 전환합니다. 실패 시 자동 재시도하지 않습니다. 슬래시 커맨드에서는 초안을 보여주고 **사용자 승인 후** 전송합니다.

사용자 인증 전송은 텍스트 전용입니다. `cardsV2`는 [commands/mailman.md](commands/mailman.md)의 기존 웹훅 curl 절차를 계속 사용합니다. [Chat API 전송 규격](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create)을 참고하세요.

## 데이터와 환경변수

| 항목 | 기본 경로/설정 |
|------|----------------|
| 실행 파일 | `~/.claude/bin/mailman` (직전 백업 `mailman.bak`) |
| 슬래시 커맨드 | `~/.claude/commands/mailman.md`, `mailman-deep.md` |
| Codex 스킬 | `${CODEX_HOME:-~/.codex}/skills/mailman/SKILL.md` |
| 설정 (`MAILMAN_CONFIG`) | `$MAILMAN_HOME/mailman/config.json` |
| 개인 컨벤션 (선택) | `$MAILMAN_HOME/mailman/local.md` |
| DB | `$MAILMAN_HOME/inbox/mailman-v2.db` |
| 요약 로그 | `$MAILMAN_HOME/logs/mailman.log` |
| `MAILMAN_HOME` | `~/.claude` |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json` |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json` |
| `MAILMAN_DEEP=1` | `--deep`과 같음, 최근 30일 백필 재수집 |
| `MAILMAN_BACKFILL_DAYS` | 최초/백필 창 일수, 기본 7/30, 1~36500 |

인증정보 경로는 `MAILMAN_HOME`과 독립적입니다. 다른 위치를 쓰려면 `MAILMAN_CLIENT_FILE`과 `MAILMAN_TOKEN_FILE`을 각각 지정하세요.

## 이전 버전과 개발

기존 Playwright/snapshot 구현은 [scripts/mailman-legacy/README.md](scripts/mailman-legacy/README.md)에 보존합니다. v2는 이전 설정·DB와 호환하지 않습니다. 예전 셸 래퍼(`run.sh`/`fetch.sh`/`send.sh`)와 `scripts/mailman/config.json` 위치는 더 이상 쓰지 않습니다. 설정은 `~/.claude/mailman/config.json`으로 옮기세요.

개발에는 bun이 필요합니다. 레포를 클론한 뒤 개발 설치를 하면 `~/.claude/bin/mailman`이 `scripts/mailman/mailman-dev`(bun으로 `cli.ts`를 실행)를, 슬래시 커맨드가 레포의 `commands/*.md`를 가리키는 심볼릭 링크가 됩니다. `--target codex|all`이면 Codex 스킬 디렉터리 `skills/mailman`이 레포의 `codex-skills/mailman`을 가리킵니다(Codex는 링크된 `SKILL.md` 파일은 읽지 않고 링크된 디렉터리는 따라갑니다).

```bash
bash install.sh --dev                 # 개발 설치 (Claude)
bash install.sh --dev --target all    # 개발 설치 (Claude + Codex)
bun test                     # 테스트
bash scripts/build.sh        # dist/mailman-darwin-arm64, dist/mailman-darwin-x64 빌드 + 스모크
```

테스트는 fetch를 주입하고 실제 네트워크를 차단합니다. 자세한 스키마와 종료 코드는 [런타임 문서](scripts/mailman/README.md)를 참고하세요. 제거는 `uninstall.sh`이며, 실행 파일(직전 백업 포함)·슬래시 커맨드·Codex 스킬만 지우고 설정·데이터·인증정보와 커맨드·스킬 백업은 위치만 안내합니다.

- 홈페이지: <https://thewronghand-bigs.github.io/mailman/>
- 설정 가이드: <https://thewronghand-bigs.github.io/mailman/setup>
- 개인정보처리방침: <https://thewronghand-bigs.github.io/mailman/privacy>
