---
title: mailman
permalink: /
---

# mailman

**mailman**은 Google Chat 스페이스의 메시지를 내 Mac의 로컬 SQLite에 모아 두고, Claude Code의 `/mailman` 슬래시 커맨드, Codex의 `$mailman` 스킬, 또는 터미널에서 조회·전송하는 macOS용 CLI입니다.

- **대상 찾기**: 스페이스 표시 이름이나 사람 이름·이메일로 기존 방을 찾고, 원하면 새 별칭으로 저장합니다.
- **조회**: 선택한 스페이스의 새 메시지를 스레드 단위로 정리해 보여 줍니다. 사람/봇 메시지만 골라 볼 수도 있습니다(`--only human`, `--only bot`).
- **전송**: 사용자가 승인한 텍스트를 본인 명의로 원 스레드에 답글로 보냅니다.
- **답장 대기**: 짧게 나누어 온 답장을 조용해진 뒤 한 묶음으로 읽습니다.
- **로컬 저장**: 메시지·토큰·로그는 모두 사용자 기기에만 저장됩니다. 별도 서버가 없습니다.
- **사용자별 OAuth 클라이언트**: 각 사용자가 자기 Google Cloud 프로젝트에 OAuth 클라이언트를 만들어 씁니다. 배포물에는 어떤 클라이언트 정보도 들어 있지 않습니다.

## 설치

macOS(Apple Silicon / Intel)에서 실행합니다. bun이나 Node.js는 필요 없습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

실행 파일은 `~/.claude/bin/mailman`, 슬래시 커맨드는 `~/.claude/commands/`에 설치됩니다. Codex 스킬도 함께 설치하려면 `MAILMAN_TARGET=all`(Codex만이면 `codex`)을 붙입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_TARGET=all bash
```

## 시작하기

1. [설정 가이드](setup.md)를 따라 본인 Google Cloud 프로젝트에 데스크톱 앱 OAuth 클라이언트를 만듭니다.
2. 받은 JSON으로 로그인합니다.

   ```bash
   ~/.claude/bin/mailman auth --client ~/Downloads/client_secret_XXXX.json
   ```

3. `mailman spaces`로 방 이름을 확인하고 `mailman fetch '표시 이름' --save <새 별칭>`으로 조회·등록합니다. `--dm colleague@example.test`로 기존 DM을 직접 지정해도 됩니다.
4. Claude Code에서 `/mailman`을, Codex에서 `$mailman`을 실행합니다. Codex 샌드박스 설정은 [README](https://github.com/thewronghand-bigs/mailman#codex에서-쓰기)를 참고하세요.

## 명령

아래 예시는 `~/.claude/bin`을 PATH에 넣었다고 가정합니다. 넣지 않았다면 `mailman` 대신 `~/.claude/bin/mailman`처럼 전체 경로로 실행하세요. PATH 추가(zsh): `echo 'export PATH="$HOME/.claude/bin:$PATH"' >> ~/.zshrc`

```text
mailman auth [--client <client_secret.json>]
mailman spaces [검색어] [--refresh]
mailman collect [대상] [--dm <사람>] [--save <별칭>] [--deep]
mailman fetch [대상] [--dm <사람>] [--save <별칭>] [--since 24h|3d|YYYY-MM-DD] [--only bot|human] [--no-collect] [--deep]
mailman send [대상] [--dm <사람>] [--save <별칭>] [--thread spaces/.../threads/...] [--agent claude|codex | --no-tag] [--dry-run | --wait] < 본문.txt
mailman wait [대상] [--dm <사람>] [--save <별칭>] [--thread spaces/.../threads/...] [--from <사람>] [--quiet 60s] [--timeout 30m] [--interval 15s]
mailman --help | --version
```

`send`는 로그인한 사용자 명의로 보내며 본문 앞에 `[🤖 AI] ` 태그를 붙입니다(`--agent claude`면 `[🤖 Claude] `, `--agent codex`면 `[🤖 Codex] `). 태그는 설정 `"sendTag": false`로 끄거나 `--no-tag`로 이번 전송만 뺄 수 있습니다.

대상은 config 별칭 → `spaces/ID` → `--dm <사람>` → 표시 이름 순서로 해석합니다. 후보가 여러 개면 목록을 보여 주고 선택을 요청하며 임의로 고르지 않습니다. ID를 직접 찾을 필요가 없습니다. 미등록 방도 이번 호출에서만 사용할 수 있고 `--save`만 별칭을 추가합니다(덮어쓰기 금지). `send --dry-run`으로 해석된 대상과 본문을 확인합니다.

`send --wait`도 위 대기 옵션을 받습니다. 내 메시지를 제외하고 마지막 답장부터 quiet 동안 조용해지면 묶어 출력합니다. 첫 답장 후 최대 10분 또는 전체 timeout 중 빠른 시점에도 반환합니다. 답장이 없으면 **exit 4**입니다. **`send --wait`가 exit 5면 전송은 완료됨 — 재전송 금지**입니다. 전송 완료 뒤 대기 오류·출력 실패·시그널은 exit 5이고, 전송 요청 중 중단은 Chat에서 전송 여부를 확인해야 합니다. 단독 `wait`의 SIGINT/SIGTERM은 **130/143**입니다. 대기 전 안 읽은 메시지와 답장 출력 성공 후 seen을 전진하며 `--from`·`--thread` 또는 대기 오류·중단·출력 실패 때는 유지합니다. Claude Code는 승인한 질문을 Bash `run_in_background`로 보내고 완료 알림의 답장을 읽습니다. Codex는 짧은 timeout으로 블로킹 실행합니다.

`--timeout` 상한은 2시간입니다. 연결 오류·5xx·429는 최대 60초 백오프로 재시도하고 연속 실패 5분이면 받은 답장을 출력하고 종료합니다. 401은 토큰 갱신 후 1회 재시도합니다. 이메일 `--from`은 기존 DM의 수집 기록 또는 최근 메시지에서 상대 ID를 전송 전에 확정해야 합니다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 확정하지 못하면 전송하지 않습니다. 이름 캐시는 24시간 초과 시 자동 갱신하고, 오프라인이면 경고 후 재사용합니다. 빈 대상·사람·별칭은 인자 오류이며 `--dry-run --save`는 저장할 예정만 표시합니다. DM 미리보기에는 users/ID도 나옵니다.

## 문서

- [설정 가이드](setup.md) — 사용자별 OAuth 클라이언트 만들기
- [개인정보처리방침](privacy.md)
- [소스 코드](https://github.com/thewronghand-bigs/mailman) · [문의(GitHub Issues)](https://github.com/thewronghand-bigs/mailman/issues)
