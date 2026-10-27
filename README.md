<p align="center">
  <img width="261" height="261" alt="mailman" src="https://github.com/user-attachments/assets/b913ae4d-6ab5-4f7a-b655-7acd3865e33d" />
</p>

<h1 align="center">Mailman v2.4</h1>

<p align="center"><i>소통을 딸깍하세요.</i></p>

Google Chat 스페이스의 메시지를 로컬 SQLite에 모아 Claude Code(`/mailman`)나 Codex(`$mailman`)에서 조회하고, 승인한 답장을 원 스레드에 보냅니다. **사용자 OAuth + Google Chat API**를 사용합니다.

**처음 보내는 사람도 이름만으로 DM을 보낼 수 있습니다.** 등록된 사람·수집 발신자·회사 디렉터리를 순서대로 찾고, 기존 DM이 없으면 만들어 보냅니다. 한 번 확정한 사람은 로컬 등록부에 남아 다음 세션부터 바로 해석됩니다. 방 이름·`spaces/ID`·`--dm`을 명시하면 config 파일 없이 동작합니다.

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
mailman doctor                                              # 설정·인증·Chat API 점검, 해결 단계 안내
mailman spaces                                             # 내가 속한 스페이스 이름·종류·ID (캐시)
mailman spaces '개발 팀' --refresh                          # 이름 검색, 목록 갱신
mailman spaces '개발 팀' --save dev                         # 별칭 저장 (첫 별칭이 기본 방)
mailman spaces --save dev --default                        # 기존 별칭을 기본 방으로 변경
mailman people                                             # 등록된 사람의 이름·ID·이메일·출처
mailman people '검색어'                                     # 등록부 검색 (네트워크 없음)
mailman people --forget users/100001                        # 한 사람의 등록 삭제
mailman fetch dev                                          # 저장한 별칭으로 조회
mailman fetch --dm colleague@example.test                   # 기존 1:1 DM 조회
mailman collect team                                        # 수집만
mailman collect team --deep                                 # 최근 30일 백필 수집
mailman fetch team                                          # 수집 후 새 메시지 조회
mailman fetch team --since 2026-10-01                       # 기간 조회 (seen 유지)
mailman fetch team --only bot                               # 봇 메시지만 (seen 유지)
mailman fetch team --no-collect                             # 수집 없이 DB만 조회
mailman fetch team --with-attachments                       # 작은 텍스트 첨부 펼치기
mailman download spaces/SPACE_ID/messages/MESSAGE_ID --print # 첨부 저장, 작은 텍스트 출력
mailman react spaces/SPACE_ID/messages/MESSAGE_ID '👀'        # 작업 관련 메시지 읽음
mailman react spaces/SPACE_ID/messages/MESSAGE_ID '✅'        # 실제 반영 완료, 사용자 승인 후
printf '%s\n' '확인했습니다.' | mailman send team
printf '%s\n' '안녕하세요.' | mailman send --dm '사람 이름' --agent codex  # 첫 DM도 이름만으로
printf '%s\n' '명세 반영 완료했습니다.' | mailman send team --thread spaces/SPACE_ID/threads/THREAD_ID
printf '%s\n' '확인했습니다.' | mailman send team --agent codex   # [🤖 Codex] 태그
printf '%s\n' '확인했습니다.' | mailman send team --no-tag        # 이번만 태그 없이
mailman send team --attach ./handover.md < /dev/null             # 핸드오버 파일 전송
mailman send team --attach ./handover.md --dry-run < /dev/null   # 경로·이름·크기 미리보기
printf '%s\n' '확인 부탁드립니다.' | mailman send '개발 팀' --dry-run  # 대상·본문 미리보기
printf '%s\n' '확인 부탁드립니다.' | mailman send team --wait --timeout 5m
mailman wait team --from colleague@example.test --quiet 60s --timeout 5m
mailman --help
mailman --version
```

한 번에 새 메시지를 최대 **200건** 보여줍니다. 첫 조회는 최근 24시간이며, 기본 조회에서 남은 메시지는 다시 실행하면 이어서 보여줍니다.

대상은 **config 별칭 → `spaces/ID` → `--dm <사람>` → 스페이스 표시 이름** 순서로 해석합니다. 방 표시 이름은 대소문자·공백을 무시한 정확 일치를 먼저 찾고, 없으면 부분 일치합니다. 후보가 여러 개면 목록을 보여 주고 exit 1로 끝납니다. 이름을 못 찾으면 방 목록을 한 번 갱신합니다. 스페이스 ID를 직접 찾을 필요가 없습니다. `--dm`은 `users/ID`, 이메일 또는 사람 이름을 받습니다. 사람 이름은 **로컬 people 등록부의 정확 일치 → 수집 발신자 → 회사 디렉터리** 순서로 찾고, 디렉터리는 정확 일치가 없으면 부분 일치를 사용합니다. 동명이인은 이름·이메일·ID 후보를 보여 주며 추측하지 않습니다. 위치 인자와 `--dm`은 함께 쓸 수 없습니다.

`send`는 DM이 없으면 선택 권한 `chat.spaces.create`로 만든 뒤 전송합니다. `--dry-run`은 `새 DM을 만들어 보냄` 미리보기만 표시하고 DM 생성·사람 등록을 하지 않습니다. `fetch`·`collect`·`wait`는 기존 DM만 사용합니다. `mailman people [검색어]`는 등록된 사람의 이름·users/ID·이메일·출처를 보여 주고, `people --forget users/숫자ID`는 한 명의 등록을 지웁니다(메시지는 유지). 디렉터리 후보 전체는 저장하지 않고 확정된 한 명만 저장합니다.

config에 없는 방도 해당 호출에서 사용할 수 있습니다. `--save <새 별칭>`을 붙일 때만 별칭을 저장하며, 기존 별칭은 덮어쓰지 않습니다. 출력 첫 줄의 `[대상] 이름 (종류, spaces/...)`를 확인하세요. 별칭·리터럴의 표시 정보가 캐시에 없으면 입력 이름과 `SPACE_TYPE_UNSPECIFIED`를 표시합니다. `mailman spaces --refresh`로 표시 정보를 채울 수 있습니다.

설치기는 설정 파일을 만들지 않습니다. 첫 `--save`가 0600 설정 파일을 만들며 **처음 저장한 별칭이 기본 방**입니다. 대상을 생략하면 이 방을 사용합니다. **바꾸려면 `--save <별칭> --default`**를 붙이세요. 새 대상을 저장하면서 기본으로 정하거나 `mailman spaces --save dev --default`로 기존 별칭의 기본 지정만 바꿀 수 있습니다. 기존 별칭의 `space` 값과 다른 필드는 보존하며, 다른 방으로 덮어쓰는 요청은 거절합니다. `config.example.json`은 문서 참고용입니다.

config 파일이 없거나 `spaces: {}`와 빈/생략된 `defaultSpace`를 사용해도 명시 대상은 동작합니다. 기본 방은 대상을 생략할 때만 필요하며, 없으면 대상 지정이나 `mailman spaces '검색어' --save <별칭>`을 안내합니다. 잘못된 JSON·형식·읽기 권한과 등록되지 않은 기본 별칭은 계속 오류로 처리합니다.

`wait`는 실행 시각부터, `send --wait`는 방금 보낸 메시지의 생성 시각부터 내 메시지를 제외한 답장을 기다립니다. 기본값은 `--quiet 60s --timeout 30m --interval 15s`입니다. 짧은 답장이 이어지면 quiet를 다시 세고, 조용해졌을 때 한 묶음으로 보여 줍니다. 첫 답장 후 최대 10분과 전체 timeout 중 빠른 시점에도 묶음을 반환합니다. `--thread`·`--from`으로 범위를 좁힐 수 있습니다. 대기 전 안 읽은 다른 사람 메시지는 먼저 표시합니다. 이 과거 메시지와 답장 묶음은 누락 없이 모두 표시하므로 일반 fetch의 200건 상한을 적용하지 않습니다.

대기 출력이 성공하면 실제 보여 준 메시지까지 seen을 전진합니다. `--thread`·`--from`, 대기 오류·출력 실패·중단에서는 seen을 유지합니다. 답장이 없으면 `답장 없음`과 **exit 4**입니다. **`send --wait`가 exit 5면 전송은 완료됨 — 재전송 금지**입니다. 전송 완료 정보는 먼저 출력하며 이후 대기 오류·출력 실패·시그널은 exit 5입니다. 전송 요청 중 중단은 전송 여부가 불확실하므로 Chat에서 확인 후 재전송 여부를 판단합니다. 단독 `wait`의 Ctrl-C/SIGTERM은 **130/143**입니다. Claude Code는 승인 후 `send --wait`를 Bash `run_in_background`로 실행하고 완료 알림에서 답장 묶음을 읽습니다. Codex는 완료 알림이 없으므로 `--timeout 2m`처럼 짧게 잡아 블로킹 실행합니다.

`--timeout` 상한은 2시간입니다. 연결 오류·5xx·429는 최대 60초 백오프로 재시도하고, 연속 실패 5분이면 받은 답장을 출력하고 오류로 종료합니다. 401은 토큰 갱신 후 1회 재시도합니다. `--from`은 전송 전에 확정합니다. 이메일은 이미 수집된 이메일 발신자 별칭 또는 기존 DM의 상대 발신자로 ID를 찾습니다. DM 기록이 없으면 최근 메시지를 조회합니다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). DM이 없거나 ID를 확정하지 못하면 전송하지 않으므로 수집된 정확한 이름이나 users/ID로 지정하세요.

빈 문자열·공백 대상/사람/저장 별칭은 exit 1이며, 대상 생략만 기본 방을 사용합니다. 이름 해석 전 24시간보다 오래된 목록 캐시는 자동 갱신하고, 오프라인이면 경고 후 기존 캐시를 사용합니다. DM 출력에는 해석된 users/ID도 표시합니다. `--dry-run --save`는 저장할 예정만 표시하고 config를 바꾸지 않습니다.

## 설치와 설정

준비물은 macOS(Apple Silicon/Intel)와 회사 Google Workspace 계정입니다. 직접 프로젝트를 만들 때는 개인 Gmail도 필요합니다. 배포본은 단일 실행 파일이라 bun·Node.js가 필요 없습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

**A. 설정을 마친 동료에게 클라이언트 JSON을 받았다면 [설정 가이드 8단계부터(약 5분)](https://thewronghand-bigs.github.io/mailman/setup#step-8), B. 처음부터 혼자 설정한다면 [1단계부터(약 20분)](https://thewronghand-bigs.github.io/mailman/setup#step-1)** 진행하세요.

이어서 `mailman doctor`로 점검하면 됩니다. 이름을 지정한 DM 전송에는 방 등록이 필요 없습니다. 기본 방을 쓰려면 `mailman spaces '검색어' --save dev`로 등록하세요. 후보가 여러 개면 표시 이름으로 검색 범위를 좁힙니다. 처음 저장한 별칭이 기본 방이며 바꾸려면 `--default`를 붙입니다. 설정 파일을 직접 편집할 필요가 없습니다.

오류가 나면 출력된 안내를 먼저 따르고, 해결되지 않을 때 `mailman doctor`를 실행하세요. 실패한 항목에서 가이드의 해결 단계로 바로 이동할 수 있습니다. 실패는 exit 1, 경고만 있으면 exit 0이며, 설정·권한·DB를 자동 변경하지 않습니다. Codex 설치·업데이트·백업과 경로 설정은 [INSTALL.md](INSTALL.md)를 참고하세요.

### 개인 컨벤션 (`local.md`)

`$MAILMAN_HOME/mailman/local.md`(기본 `~/.claude/mailman/local.md`)를 만들어 두면 `/mailman`·`/mailman-deep`·`$mailman`이 커맨드 문서보다 먼저 읽고 우선해 따릅니다. 카드 제목·헤더 이미지·섹션 구성·색상, 보고 말투처럼 사람마다 다른 취향을 여기에 적습니다. 레포 문서에는 중립적인 최소 예시만 둡니다. 없으면 무시합니다. 전송 전 사용자 승인·✅ 리액션 승인·첨부 파일 제한·웹훅 URL 비노출 규칙은 `local.md`로 완화할 수 없습니다.

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
- 수집 범위는 기본/지정 별칭이나 해당 호출에서 이름·리터럴·`--dm`으로 선택한 방입니다. 자동으로 config에 추가하지 않습니다. 조회도 사람·봇·mailman 전송을 모두 포함하고 본문을 그대로 보여줍니다. Claude는 출력 전체를 읽고 API 스펙, 사용자에게 온 요청·질문, 일정·배포 등 작업에 영향 주는 내용만 요약합니다.
- 기본 조회는 **mailman이 그 방에서 마지막으로 보여준 이후**의 생성 시각을 가진 메시지입니다. 스페이스별 `seenCreateTime`은 수집 커서 및 Google Chat 읽음 상태와 별개입니다. seen이 없으면 최근 24시간을 보여줍니다.
- 새 메시지를 오래된 것부터 최대 200건 고릅니다. DM과 단발 메시지는 시각·발신자·본문·`message name`을 시간순 간결 목록으로 표시합니다. DM은 실제 스레드도 간결 목록이므로 이전 맥락과 생략 건수를 붙이지 않습니다. 그룹 스레드도 각 메시지에 한 줄 `message name`을 표시합니다. 그룹의 실제 스레드(2건 이상)는 가장 이른 새 메시지순으로 묶고 `thread_name`, DB 기준 첫 메시지 `name`, 최근 5건의 **이전 맥락**과 생략 건수를 유지합니다. 출력 머리는 스페이스 표시 이름 또는 `DM: 이름`(이름이 없으면 users/ID)을 사용합니다.
- 출력 완료 후 실제 표시한 새 메시지의 최대 생성 시각까지 seen을 전진합니다. 같은 시각에 200건 경계가 걸리면 메시지 이름을 보조 커서로 사용해 이어서 보여줍니다. 출력 실패 또는 새 메시지 0건이면 seen은 그대로입니다. 빈 결과는 `[별칭] 새 메시지가 없습니다.`로 표시합니다.
- `--since 24h`, `--since 3d`, `--since 7d` 또는 `--since YYYY-MM-DD`는 지정 시점 이후를 조회합니다. 기간은 양의 정수 시간/일, 날짜는 실행 환경의 로컬 자정 기준이며 **seen을 바꾸지 않습니다**. 같은 200건·스레드 규칙을 적용하고, 상한을 넘으면 기간을 좁히도록 안내합니다.
- `cardsV2`와 구형 `cards`의 카드 본문도 제목·섹션·코드블록·버튼 링크 등을 마크다운 텍스트로 펼칩니다. 메시지 텍스트가 함께 있으면 텍스트 다음에 카드를 표시합니다.
- `--only bot|human`은 해당 발신자 유형의 새 메시지만 보여주며 **seen을 바꾸지 않습니다**. 거른 조회로 커서를 전진시키면 거른 쪽 메시지가 기본 조회에서 영구히 빠지기 때문입니다. `--since`와 함께 쓸 수 있고, 같은 스레드의 다른 유형 메시지는 이전 맥락으로 보일 수 있습니다.
- 수집에 실패해도 `mailman fetch`는 기존 DB를 보여줍니다. `--no-collect`로 수집을 건너뛸 수 있습니다. 오류 안내와 마지막 성공 수집 시각을 함께 확인하세요.

증분 필터는 생성 시각 기준이므로 **예전에 생성된 메시지의 수정분은 백필로 갱신**합니다. 수집 창 밖의 과거 원문/답글은 DB에 없을 수 있습니다. 필요한 경우 백필 기간을 늘리세요. 수집은 100개씩 최대 1,000페이지이며, 실패/상한 초과 때는 저장과 커서 갱신을 하지 않습니다.

## 인증과 전송

인증은 임의 포트 `127.0.0.1` loopback, PKCE S256, state 검증을 사용합니다. refresh token·이메일·허용 스코프·Google 계정 ID(`user_name: users/<sub>`)를 0600 파일에 저장하며, access token은 매 실행마다 새로 발급받아 메모리에서만 사용합니다. 기존 토큰에 계정 ID가 없으면 첫 대기 때 userinfo로 한 번 보완합니다. id_token 원문은 저장하지 않습니다.

요청 스코프는 다음 여덟 개입니다. 기존 필수 권한 4개+`openid`는 그대로이며, 리액션·디렉터리 검색·DM 생성 권한은 선택입니다.

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages.readonly`
- `https://www.googleapis.com/auth/chat.messages.create`
- `https://www.googleapis.com/auth/chat.messages.reactions.create` (선택: 리액션)
- `https://www.googleapis.com/auth/directory.readonly` (선택: 회사 디렉터리 이름·이메일 검색)
- `https://www.googleapis.com/auth/chat.spaces.create` (선택: 첫 DM 생성)

기존 사용자는 v2.4 기능을 쓰기 전에 클라이언트 프로젝트의 **People API 사용 설정**과 **Google Auth Platform 데이터 액세스의 두 스코프 추가**를 마친 뒤 `mailman auth`를 다시 실행하세요([업그레이드 안내](https://thewronghand-bigs.github.io/mailman/setup#upgrade-v2-4)). 동료 프로젝트를 쓰면 콘솔 설정은 프로젝트 소유자가 한 번만 하고 각자 재인증합니다. 선택 권한이 없는 토큰도 기존 조회·전송·대기는 정상 동작하며, 해당 기능을 사용할 때만 안내합니다. 리액션 권한도 필요할 때 재인증하면 됩니다.

`mailman send`는 **로그인한 사용자 명의**로 본문 앞에 `[🤖 <라벨>] ` 태그를 붙입니다. 라벨은 `--agent claude|codex`(대소문자 무시)로 `Claude`/`Codex`를 지정하고, 없으면 환경변수 `MAILMAN_AGENT`(같은 값)를, 둘 다 없으면 중립 라벨 `AI`(`[🤖 AI] `)를 씁니다. 그 밖의 값은 오류입니다. `/mailman` 커맨드는 `--agent claude`, Codex `$mailman` 스킬은 `--agent codex`로 보냅니다.

태그를 빼려면 설정 파일 최상위에 `"sendTag": false`를 두거나(항상), 호출할 때 `--no-tag`를 줍니다(이번 전송만, 설정보다 우선). `--no-tag`와 `--agent`를 함께 주면 의도가 충돌하므로 오류로 거절합니다. 태그 없이 보내면 성공 출력에 `태그 없이 전송했습니다`가 한 줄 붙습니다.

`--thread`를 주면 원 스레드에 답글을 보내며, API가 답글을 만들 수 없으면 새 스레드로 전환합니다. 실패 시 자동 재시도하지 않습니다. 슬래시 커맨드에서는 초안을 보여주고 **사용자 승인 후** 전송합니다.

사용자 인증 전송은 텍스트와 파일 첨부를 지원합니다. `cardsV2`는 [commands/mailman.md](commands/mailman.md)의 기존 웹훅 curl 절차를 계속 사용합니다. [Chat API 전송 규격](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create)을 참고하세요.

`send --attach <파일>`을 반복해 최대 10개·각 200MB(200×1024² 바이트) 이하 일반 파일을 보냅니다. 심볼릭 링크는 거절하며 중간 디렉터리 링크를 쓰더라도 미리보기·성공 출력에는 실제 경로(realpath)를 표시합니다. 모든 파일의 존재·종류·크기를 검증한 뒤 basename과 원본 바이트를 순서대로 업로드하고, 전부 성공했을 때만 참조를 넣어 메시지를 생성합니다. 중간 업로드 실패 시 메시지는 보내지 않고 이미 올라간 업로드는 무시해도 된다고 안내합니다. 업로드 POST는 재시도하지 않습니다. 기존 `chat.messages.create` 권한을 사용하며 403이면 권한 확인과 `mailman auth` 재실행을 안내합니다. 추가 스코프는 요청하지 않습니다. [media.upload 규격](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/upload)을 따릅니다.

본문이 있으면 태그+본문, 비어 있고 첨부만 있으면 태그만 보냅니다. 태그를 끄면 텍스트 없이 첨부만 보냅니다. TTY에서는 본문 입력 없이 첨부만 보낼 수 있고 파이프에서는 `< /dev/null`로 빈 본문을 지정할 수 있습니다. `--thread`·`--wait`·`--agent`·`--no-tag`·`--dry-run`과 함께 쓸 수 있으며 기존 옵션 간 배타 규칙은 유지됩니다. `--dry-run`은 업로드하지 않고 파일 경로·이름·크기를 표시하며 성공 출력에는 첨부 이름 목록과 실제 경로가 나옵니다.

Claude/Codex는 사용자가 지정한 파일만 첨부하며 경로·이름·크기를 전송 미리보기에 포함해 승인받습니다. `.env`·키·토큰·자격증명 파일은 첨부하지 않고 경고하며, 이 제한은 완화할 수 없습니다. 동료용 OAuth 클라이언트 JSON도 **mailman으로 보내지 말고 사내 메신저에서 직접 첨부해 DM으로 보내세요**([전달 절차](https://thewronghand-bigs.github.io/mailman/setup#colleague-client)). 핸드오버 md 작성·전송 요청은 먼저 파일로 쓴 뒤 그 경로를 미리보기에 넣어 승인받고 첨부합니다.

## 첨부와 리액션

첨부 줄의 `mailman download <메시지 name>`으로 업로드 파일을 내려받습니다. 메시지가 DB에 있으면 원본 JSON을 쓰고, 없으면 `messages.get`으로 조회합니다. 기본 위치는 `$MAILMAN_HOME/mailman/attachments/<space id>/<message id>/`이며 `--out <디렉터리>`로 바꿉니다. 기본 디렉터리 0700·파일 0600, 정리한 파일명에 충돌 접미사를 붙이고 기존 파일을 덮어쓰지 않습니다. 기본 경로에서는 같은 다운로드 참조·파일명·저장 크기의 캐시를 재사용합니다. `--out`은 기존 디렉터리 권한을 유지하고 새 디렉터리만 0700으로 만듭니다. `--out`에는 재사용 기록을 남기지 않고 매번 새 파일로 받습니다. 파일당 상한은 50MB이며 30초 무수신 또는 전체 10분 초과 시 중단합니다. 리다이렉트는 HTTPS의 `*.googleapis.com`·`*.googleusercontent.com`·`*.google.com`만 최대 5회 따릅니다. 호스트가 바뀌면 Authorization을 제거하고 허용 범위 밖에는 요청하지 않습니다.

`download --print`는 텍스트 확장자/Content-Type의 256KB 이하 UTF-8 내용만 코드블록으로 출력하고, 바이너리·큰 파일은 경로만 표시합니다. `fetch`, `wait`, `send --wait`의 `--with-attachments`는 표시하는 메시지당 텍스트 첨부 최대 3개를 각 256KB까지 받아 펼칩니다. 실패 사유를 표시하고 조회는 계속합니다. Drive 첨부는 링크/파일 ID와 미지원 안내만 표시합니다. 업로드 다운로드는 기존 읽기 권한을 사용하며 403이면 필요한 스코프 확인과 `mailman auth` 재실행을 안내합니다. 권한을 추측해 추가하지 않습니다. [media.download 규격](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/download)을 따릅니다.

`mailman react <메시지 name> <이모지>`는 👀·✅만 받습니다. Claude/Codex가 작업 관련 스펙·요청·핸드오버를 읽고 보고했을 때 👀를 승인 없이 자동으로 답니다. ✅는 해당 내용을 실제 반영 완료한 뒤 대상과 이모지를 보여 주고 사용자 승인 후 답니다. 잡담에는 달지 않고 같은 메시지·이모지에 중복으로 달지 않습니다. 리액션은 **해당 내용을 보낸 메시지(스펙·요청·핸드오버 그 자체)**의 `message name`에 답니다. 사용자 본인 메시지에는 달지 않습니다. 409/ALREADY_EXISTS는 `이미 있음` 성공으로 처리합니다. `local.md`로 자동 👀 조건은 바꿀 수 있지만 ✅ 승인과 전송 승인은 완화할 수 없습니다.

## 데이터와 환경변수

| 항목 | 기본 경로/설정 |
|------|----------------|
| 실행 파일 | `~/.claude/bin/mailman` (직전 백업 `mailman.bak`) |
| 슬래시 커맨드 | `~/.claude/commands/mailman.md`, `mailman-deep.md` |
| Codex 스킬 | `${CODEX_HOME:-~/.codex}/skills/mailman/SKILL.md` |
| 설정 (`MAILMAN_CONFIG`) | `$MAILMAN_HOME/mailman/config.json` |
| 개인 컨벤션 (선택) | `$MAILMAN_HOME/mailman/local.md` |
| DB | `$MAILMAN_HOME/inbox/mailman-v2.db` |
| 내려받은 첨부 | `$MAILMAN_HOME/mailman/attachments/` (`--out`으로 변경) |
| 요약 로그 | `$MAILMAN_HOME/logs/mailman.log` |
| `MAILMAN_HOME` | `~/.claude` |
| `MAILMAN_CLIENT_FILE` | `~/.claude/secrets/mailman-oauth.json` |
| `MAILMAN_TOKEN_FILE` | `~/.claude/secrets/mailman-token.json` |
| `MAILMAN_DEEP=1` | `--deep`과 같음, 최근 30일 백필 재수집 |
| `MAILMAN_AGENT` | `claude` 또는 `codex`, `--agent`가 없을 때 전송 태그 라벨 |
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
