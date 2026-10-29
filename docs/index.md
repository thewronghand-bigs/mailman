---
title: mailman
permalink: /
---

# mailman

**mailman**은 Google Chat 스페이스의 메시지를 내 Mac의 로컬 SQLite에 모아 두고, Claude Code의 `/mailman` 슬래시 커맨드, Codex의 `$mailman` 스킬, 또는 터미널에서 조회·전송하는 macOS용 CLI입니다.

- **첫 DM**: 처음 보내는 사람도 이름만으로 회사 디렉터리에서 찾고 DM을 만들어 보냅니다. 확정한 한 명만 로컬에 등록해 다음 세션부터 바로 찾습니다.
- **스페이스 생성**: 이름 있는 스페이스를 만들고 지정한 사람들을 초대합니다. 이름·멤버 미리보기와 사용자 승인 절차를 따릅니다.
- **대상 찾기**: 스페이스 표시 이름이나 사람 이름·이메일로 찾습니다. 명시 대상은 config 없이 동작하고, 원하면 새 방 별칭으로 저장합니다.
- **사람 등록부**: `mailman people [검색어]`로 이름·ID·이메일·출처를 보고 `--forget users/숫자ID`로 지웁니다.
- **조회**: 선택한 스페이스의 새 메시지를 스레드 단위로 정리해 보여 줍니다. 사람/봇 메시지만 골라 볼 수도 있습니다(`--only human`, `--only bot`).
- **전송**: 사용자가 승인한 텍스트·지정 파일을 본인 명의로 원 스레드에 답글로 보냅니다.
- **답장 대기**: 짧게 나누어 온 답장을 조용해진 뒤 한 묶음으로 읽습니다.
- **첨부**: 업로드 첨부를 로컬에 저장하고 작은 텍스트 첨부를 펼쳐 읽습니다. Drive 첨부는 링크만 안내합니다.
- **리액션**: 작업 관련 메시지를 읽고 보고하면 👀, 실제 반영 완료 뒤 사용자 승인으로 ✅를 답니다.
- **설정 점검**: `mailman doctor`가 설정·인증·Chat API 접근을 확인하고 해결 단계로 안내합니다.
- **로컬 저장**: 메시지·토큰·로그는 모두 사용자 기기에만 저장됩니다. 별도 서버가 없습니다.
- **사용자별 OAuth 클라이언트**: 본인 프로젝트에서 만들거나, 설정을 마친 동료의 프로젝트에서 사람마다 따로 발급받습니다. 배포물에는 어떤 클라이언트 정보도 들어 있지 않습니다.

## 설치

macOS(Apple Silicon / Intel)에서 실행합니다. bun이나 Node.js는 필요 없습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand/mailman/main/install.sh | bash
```

실행 파일은 `~/.claude/bin/mailman`, 슬래시 커맨드는 `~/.claude/commands/`에 설치됩니다. Codex 스킬도 함께 설치하려면 `MAILMAN_TARGET=all`(Codex만이면 `codex`)을 붙입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand/mailman/main/install.sh | MAILMAN_TARGET=all bash
```

## 시작하기

**A. 설정을 마친 동료에게 클라이언트 JSON을 받았다면 [8단계부터(약 5분)](setup.md#step-8), B. 처음부터 혼자 설정한다면 [1단계부터(약 20분)](setup.md#step-1)** 진행하세요. 회사 Google Workspace 계정이 필요하며, B 경로는 개인 Gmail도 준비합니다. 인증 후 `mailman doctor`로 확인합니다.

가이드 마지막 단계에서 `mailman spaces '검색어' --save <별칭>`으로 방을 저장하고 Claude Code `/mailman <별칭>` 또는 Codex `$mailman`으로 조회합니다. 설치기는 설정 파일을 만들지 않으며 첫 `--save`가 0600 설정 파일을 만듭니다. 처음 저장한 별칭이 기본 방이고 바꾸려면 `--save <별칭> --default`를 사용합니다. 기존 별칭의 방 값은 덮어쓰지 않습니다. 오류가 나면 먼저 출력된 안내를 따르고, 해결되지 않으면 `mailman doctor`의 해결 링크를 확인하세요. Codex 샌드박스 설정은 [README](https://github.com/thewronghand/mailman#codex에서-쓰기)를 참고하세요.

방 이름·`spaces/ID`·`--dm`을 지정하면 설정 파일 없이 시작할 수 있습니다. 기본 방은 대상을 생략할 때만 필요합니다. v2.4의 첫 DM 이름 검색에는 선택 권한과 People API 사용 설정이 필요합니다([기존 사용자 업그레이드](setup.md#upgrade-v2-4)).

## 명령

아래 예시는 `~/.claude/bin`을 PATH에 넣었다고 가정합니다. 넣지 않았다면 `mailman` 대신 `~/.claude/bin/mailman`처럼 전체 경로로 실행하세요. PATH 추가(zsh): `echo 'export PATH="$HOME/.claude/bin:$PATH"' >> ~/.zshrc`

```text
mailman auth [--client <client_secret.json>]
mailman doctor
mailman spaces [검색어] [--refresh] [--save <별칭>] [--default]
mailman create-space <표시 이름> --member <사람> [--member <사람> ...] [--save <별칭>] [--default] [--dry-run]
mailman people [검색어]
mailman people --forget <users/숫자ID>
mailman collect [대상] [--dm <사람>] [--save <별칭>] [--default] [--deep]
mailman fetch [대상] [--dm <사람>] [--save <별칭>] [--default] [--since 24h|3d|YYYY-MM-DD] [--only bot|human] [--no-collect] [--deep] [--with-attachments]
mailman send [대상] [--dm <사람>] [--save <별칭>] [--default] [--attach <파일> ...] [--thread spaces/.../threads/...] [--agent claude|codex | --no-tag] [--dry-run | --wait] < 본문.txt
mailman wait [대상] [--dm <사람>] [--save <별칭>] [--default] [--thread spaces/.../threads/...] [--from <사람>] [--quiet 60s] [--timeout 30m] [--interval 15s]
mailman download <메시지 name> [--out <디렉터리>] [--print]
mailman react <메시지 name> <👀|✅>
mailman --help | --version
```

`send`는 로그인한 사용자 명의로 보내며 본문 앞에 `[🤖 AI] ` 태그를 붙입니다(`--agent claude`면 `[🤖 Claude] `, `--agent codex`면 `[🤖 Codex] `). 태그는 설정 `"sendTag": false`로 끄거나 `--no-tag`로 이번 전송만 뺄 수 있습니다.

`mailman send --dm '사람 이름' --agent codex < 본문.txt`는 등록된 사람 → 수집 발신자 → 회사 디렉터리 순서로 상대를 찾습니다. 동명이인은 이메일·ID 후보를 표시해 선택하게 합니다. DM이 없으면 전송할 때만 만들며, `--dry-run`은 `새 DM을 만들어 보냄` 미리보기만 표시하고 사람·방을 저장하지 않습니다. `fetch`·`collect`·`wait`는 DM을 만들지 않습니다. 디렉터리 검색과 DM 생성 스코프가 없는 기존 토큰도 나머지 기능은 동작합니다.

`mailman create-space '새 프로젝트' --member '사람 이름' --member colleague@example.test --save project --dry-run`으로 만들 이름과 멤버를 확인합니다. `--member`는 `--dm`과 같은 경로로 해석하며, 중복을 합쳐 1~20명을 초대합니다. 호출자는 자동 멤버이며 본인 지정·모호한 후보·미발견 멤버가 있으면 생성하지 않습니다. 이름 없는 그룹 채팅은 만들지 않습니다. 미리보기는 생성·사람 등록·별칭 저장을 하지 않으며, 승인 후 `--dry-run`을 빼 실행합니다. 사용자가 이름·멤버를 명시해 만들라고 했다면 그 요청이 승인입니다. 선택 `chat.spaces.create` 권한이 없으면 재인증을 안내합니다. 성공하면 표시 이름·spaces/ID·멤버를 출력하고 방을 캐시합니다. `--save`는 새 별칭을 저장하고 `--default`와 함께 기본 방을 지정합니다. 생성 요청은 자동 재시도하지 않으므로 실패하면 Chat에서 생성 여부를 확인한 뒤 재실행하세요.

`send --attach ./handover.md`로 지정한 일반 파일을 최대 10개·각 200MB까지 전송합니다. 심볼릭 링크는 거절하며 미리보기·성공 출력의 경로는 실제 경로(realpath)입니다. 모든 파일 검증과 업로드가 성공한 뒤에만 메시지를 생성하며 업로드 실패 시 메시지는 보내지 않습니다. 본문이 없으면 태그만, 태그가 꺼져 있으면 첨부만 보냅니다. `--dry-run`은 업로드 없이 경로·이름·크기를 표시하고 성공 출력은 파일 이름과 실제 경로를 나열합니다. Claude/Codex는 이 목록을 전송 승인에 포함하고 사용자가 지정하지 않은 파일은 첨부하지 않습니다. .env·키·토큰·자격증명 파일은 첨부하지 않고 경고합니다. 작성 요청을 받은 핸드오버 md는 먼저 파일로 쓴 뒤 경로를 승인받아 첨부합니다. 기존 전송 권한만 사용합니다.

첨부 줄의 download 힌트로 파일을 받습니다(파일당 최대 50MB). 기본 저장 위치는 `$MAILMAN_HOME/mailman/attachments/<space id>/<message id>/`, 파일 0600·디렉터리 0700이며 기본 경로에서 같은 소스·이름·저장 크기의 캐시를 재사용합니다. `--out`은 기존 디렉터리 권한을 유지하고 새 디렉터리만 0700으로 만듭니다. `--out`에는 재사용 기록을 남기지 않고 매번 새 파일로 받습니다. 30초 무수신 또는 전체 10분 초과 시 중단합니다. `--print`는 256KB 이하 텍스트만 출력합니다. `fetch`·`wait`·`send --wait`의 `--with-attachments`는 메시지당 작은 텍스트 첨부 최대 3개를 펼치고 실패 사유를 표시해 조회를 계속합니다. Drive 첨부는 링크/파일 ID와 미지원 안내만 표시합니다.

`react`는 👀·✅만 허용하고 이미 같은 리액션이 있으면 성공으로 처리합니다. Claude/Codex는 작업 관련 스펙·요청·핸드오버를 읽고 보고한 뒤 👀를 자동으로 달며, ✅는 실제 반영 완료 후 사용자 승인으로 답니다. 리액션은 해당 내용을 보낸 메시지(스펙·요청·핸드오버 그 자체)의 `message name`에 달고 사용자 본인 메시지에는 달지 않습니다. 잡담에는 달지 않습니다. `local.md`도 ✅ 승인·전송 승인을 완화할 수 없습니다. 기존 사용자는 리액션을 쓰기 전에 `mailman auth`를 다시 실행하세요. 기존 토큰에 선택 리액션 스코프가 없으면 react만 exit 2이며 조회·전송은 그대로 동작합니다.

DM과 단발 메시지는 시각·발신자·본문·message name의 시간순 간결 목록으로 표시합니다. DM은 실제 스레드도 간결 목록이므로 이전 맥락과 생략 건수를 붙이지 않습니다. 그룹 스레드도 각 메시지에 한 줄 message name을 표시합니다. 그룹의 실제 스레드는 기존 머리·이전 맥락을 유지합니다. 방 라벨은 표시 이름 또는 `DM: 이름 또는 users/ID`이며 대기 중 받은 발신자 이름도 반영합니다.

대상은 config 별칭 → `spaces/ID` → `--dm <사람>` → 표시 이름 순서로 해석합니다. 후보가 여러 개면 목록을 보여 주고 선택을 요청하며 임의로 고르지 않습니다. ID를 직접 찾을 필요가 없습니다. 미등록 방도 이번 호출에서만 사용할 수 있고 `--save`만 별칭을 추가합니다(덮어쓰기 금지). `send --dry-run`으로 해석된 대상과 본문을 확인합니다.

`send --wait`도 위 대기 옵션을 받습니다. 내 메시지를 제외하고 마지막 답장부터 quiet 동안 조용해지면 묶어 출력합니다. 첫 답장 후 최대 10분 또는 전체 timeout 중 빠른 시점에도 반환합니다. 답장이 없으면 **exit 4**입니다. **`send --wait`가 exit 5면 전송은 완료됨 — 재전송 금지**입니다. 전송 완료 뒤 대기 오류·출력 실패·시그널은 exit 5이고, 전송 요청 중 중단은 Chat에서 전송 여부를 확인해야 합니다. 단독 `wait`의 SIGINT/SIGTERM은 **130/143**입니다. 대기 전 안 읽은 메시지와 답장 출력 성공 후 seen을 전진하며 `--from`·`--thread` 또는 대기 오류·중단·출력 실패 때는 유지합니다. Claude Code는 승인한 질문을 Bash `run_in_background`로 보내고 완료 알림의 답장을 읽습니다. Codex는 짧은 timeout으로 블로킹 실행합니다.

`--timeout` 상한은 2시간입니다. 연결 오류·5xx·429는 최대 60초 백오프로 재시도하고 연속 실패 5분이면 받은 답장을 출력하고 종료합니다. 401은 토큰 갱신 후 1회 재시도합니다. 이메일 `--from`은 기존 DM의 수집 기록 또는 최근 메시지에서 상대 ID를 전송 전에 확정해야 합니다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 확정하지 못하면 전송하지 않습니다. 이름 캐시는 24시간 초과 시 자동 갱신하고, 오프라인이면 경고 후 재사용합니다. 빈 대상·사람·별칭은 인자 오류이며 `--dry-run --save`는 저장할 예정만 표시합니다. DM 미리보기에는 users/ID도 나옵니다.

## 문서

- [설정 가이드](setup.md) — 사용자별 OAuth 클라이언트 만들기
- [개인정보처리방침](privacy.md)
- [소스 코드](https://github.com/thewronghand/mailman) · [문의(GitHub Issues)](https://github.com/thewronghand/mailman/issues)
