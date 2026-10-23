# 설치 가이드 — v2

## 준비

- macOS (Apple Silicon 또는 Intel). `mailman auth`가 기본 브라우저를 `open`으로 실행합니다.
- 대상 Google Chat 스페이스의 멤버인 회사(Workspace) 계정
- 본인 GCP 프로젝트의 **데스크톱 앱** OAuth 클라이언트 — [설정 가이드](https://thewronghand-bigs.github.io/mailman/setup)([docs/setup.md](docs/setup.md))를 따라 직접 만듭니다. 배포물에는 client id/secret이 들어 있지 않습니다.

릴리스 설치에는 bun·Node.js가 필요 없습니다. 개발 설치(`--dev`)만 bun이 필요합니다.

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

- GitHub 최신 릴리스에서 아키텍처에 맞는 `mailman-darwin-arm64` 또는 `mailman-darwin-x64`를 받아 `~/.claude/bin/mailman`에 설치합니다. Rosetta 셸에서도 Apple Silicon이면 arm64를 받습니다.
- 같은 릴리스 태그의 `commands/mailman.md`, `commands/mailman-deep.md`를 `~/.claude/commands/`에 설치합니다.
- 설정 파일이 없으면 예시를 `~/.claude/mailman/config.json`(0600)에 만듭니다. 있으면 건드리지 않습니다.
- 실행 파일·커맨드·스킬·설정 예시를 모두 임시 디렉터리에 받아 검증한 뒤 한꺼번에 설치합니다. 다운로드가 하나라도 실패하면 `[mailman] 다운로드 실패: …` 안내와 함께 기존 설치를 그대로 두고 끝납니다.
- 각 파일은 같은 디렉터리의 임시 파일에서 `mv` 한 번으로 교체됩니다. 실행 파일은 직전 1개만 `~/.claude/bin/mailman.bak`으로 남기고(이전 백업은 덮어씀), 커맨드·스킬 문서는 내용이 다를 때 `<파일>.bak.<타임스탬프>`로 백업합니다.
- 특정 버전은 `MAILMAN_VERSION=v2.0.0`을 붙여 설치합니다.
- 설치 대상은 `--target claude|codex|all` 또는 `MAILMAN_TARGET`으로 고릅니다(기본 `claude`). `codex`/`all`이면 `${CODEX_HOME:-~/.codex}/skills/mailman/SKILL.md`에 `$mailman` 스킬을 설치합니다. 실행 파일은 대상과 관계없이 `~/.claude/bin/mailman` 하나입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_VERSION=v2.0.0 bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | MAILMAN_TARGET=all bash          # Claude + Codex
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash -s -- --target codex       # Codex만
```

터미널에서 `mailman`만으로 실행하려면 `~/.claude/bin`을 PATH에 추가합니다. 추가하지 않으면 `~/.claude/bin/mailman` 전체 경로로 실행합니다.

```bash
echo 'export PATH="$HOME/.claude/bin:$PATH"' >> ~/.zshrc
```

### 개발 설치

레포를 클론한 뒤:

```bash
bash install.sh --dev                 # Claude
bash install.sh --dev --target all    # Claude + Codex
```

`~/.claude/bin/mailman` → `scripts/mailman/mailman-dev`, `~/.claude/commands/*.md` → 레포 `commands/*.md` 심볼릭 링크를 만듭니다. Codex 대상이면 `${CODEX_HOME:-~/.codex}/skills/mailman` 디렉터리를 레포 `codex-skills/mailman`으로 링크합니다(Codex는 링크된 `SKILL.md` 파일은 읽지 않습니다). 그 자리에 있던 비어 있지 않은 디렉터리는 Codex가 중복 스킬로 읽지 않도록 `skills/` 밖의 `${CODEX_HOME:-~/.codex}/mailman-skill.bak.<타임스탬프>`로 옮깁니다. `mailman-dev`는 `~/.bun/bin`, `NVM_BIN`, `~/.nvm/versions/node/*/bin`(버전 내림차순), `/opt/homebrew/bin`, `/usr/local/bin`, 기존 PATH 순서로 bun을 찾아 `cli.ts`를 실행합니다.

## Codex

Codex의 `$mailman` 스킬은 Claude와 같은 실행 파일·DB·seen 커서를 씁니다. mailman은 작업 폴더 밖(`~/.claude/{inbox,logs,secrets,mailman}`)에 쓰고 네트워크를 쓰므로 기본 `workspace-write` 샌드박스에서는 샌드박스 밖 실행 승인이 필요합니다. `~/.codex/config.toml`의 `[sandbox_workspace_write]`에 `writable_roots`와 `network_access = true`를 두는 방법은 [README](README.md#codex에서-쓰기)를 참고하세요.

## 최초 인증

```bash
~/.claude/bin/mailman auth --client ~/Downloads/client_secret_XXXX.json
```

1. 파일이 Google 데스크톱 앱 형식(`{"installed": {...}}`)인지 검증해 `~/.claude/secrets/mailman-oauth.json`에 0600으로 복사합니다. 파일 내용은 출력하지 않습니다.
2. 기본 브라우저에서 회사 계정으로 로그인합니다. "확인되지 않은 앱" 경고는 **고급 → (앱 이름)(으)로 이동**으로 넘깁니다.
3. 다섯 권한(`openid`, 이메일, 스페이스 읽기, 메시지 읽기, 메시지 생성)에 모두 동의합니다.
4. 터미널에 인증 완료, 이메일, 허용 스코프가 출력되는지 확인합니다.

인증 대기 시간은 5분입니다. 성공하면 refresh token·이메일·허용 스코프를 토큰 파일에 0600으로 저장합니다. access token은 저장하지 않습니다. 재인증은 `--client` 없이 `mailman auth`만 실행합니다. 클라이언트 파일이 없으면 설정 가이드를 안내하고 exit 2로 끝납니다.

## 설정 파일

`~/.claude/mailman/config.json`의 `defaultSpace`, `spaces.<별칭>.space`를 편집합니다. `space`는 `spaces/SPACE_ID` 형식이며 Chat 웹 URL 끝의 ID를 씁니다. 카드 전송용 `webhookUrl`은 선택 사항입니다. 이전 버전의 `scripts/mailman/config.json` 위치와 `url`, `bots`, `defaultBot` 설정은 사용하지 않습니다.

경로를 바꾸려면:

```bash
export MAILMAN_CONFIG="/경로/config.json"            # 설정 파일
export MAILMAN_HOME="$PWD/.mailman"                  # DB/로그 (설정 기본값도 $MAILMAN_HOME/mailman/)
export MAILMAN_CLIENT_FILE="/경로/mailman-oauth.json"
export MAILMAN_TOKEN_FILE="/경로/mailman-token.json"
```

OAuth 파일 기본 경로는 `MAILMAN_HOME`과 관계없이 `~/.claude/secrets/`입니다.

## 확인

```bash
~/.claude/bin/mailman fetch team
~/.claude/bin/mailman fetch team --since 7d
~/.claude/bin/mailman fetch team --only human
~/.claude/bin/mailman fetch team --deep
```

`/mailman [스페이스]`, `/mailman [스페이스] --since 7d`, `/mailman [스페이스] --only bot`도 같은 실행 파일을 씁니다. 기본 조회는 mailman이 마지막으로 보여준 이후의 새 메시지이며 첫 조회는 최근 24시간입니다. 모든 발신자를 포함하고, 새 메시지는 오래된 것부터 최대 200건과 스레드당 이전 맥락 최근 5건을 보여줍니다.

출력 성공 뒤 seen 커서가 전진하고, 남은 새 메시지는 재실행으로 이어서 봅니다. `--since`와 `--only`는 seen을 바꾸지 않습니다. `--since`는 양의 정수 `h`/`d` 기간 또는 `YYYY-MM-DD` 로컬 자정 이후를 조회합니다. `/mailman-deep team`은 백필 후에도 안 읽은 메시지 조회를 유지합니다. seen은 Google Chat의 읽음 상태와 무관합니다.

## 제거

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/uninstall.sh | bash
```

실행 파일(직전 백업 `mailman.bak` 포함)·슬래시 커맨드·Codex 스킬만 지웁니다. 설정·`local.md`·DB·로그·OAuth 클라이언트·토큰과 커맨드·스킬 백업(`.bak.<타임스탬프>`)은 위치만 안내합니다. 이전 설치 경로 `~/.claude/scripts/mailman`은 심볼릭 링크면 지우고, 실제 디렉터리면 남겨 둡니다.

## 문제 해결

| 증상 | 확인 |
|------|------|
| 클라이언트 파일 없음 (exit 2) | `mailman auth --client <다운로드한 JSON>` |
| 토큰 없음 (exit 2) | `mailman auth` |
| `invalid_grant` (exit 3) | `mailman auth`로 다시 로그인·동의 |
| 7일마다 재로그인 | 설정 가이드 6단계: 앱을 프로덕션으로 게시 |
| Codex에서 쓰기 실패·네트워크 오류 | 샌드박스 밖 실행을 승인하거나 `config.toml`에 `writable_roots`·`network_access` 설정 |
| 설치 중 `다운로드 실패` | 기존 설치는 그대로. 네트워크·`MAILMAN_VERSION` 태그 확인 후 다시 실행 |
| 필수 스코프 누락 | 다시 인증하며 다섯 권한 모두 동의 |
| HTTP 403 | 스페이스 멤버십, Chat API 활성화·Chat 앱 구성, 조직 OAuth 정책 확인 |
| 수정한 명세가 오래된 내용 | `--deep`으로 백필; 필요하면 `MAILMAN_BACKFILL_DAYS` 확대 |
| 이전에 본 메시지를 다시 조회하려 함 | `--since 7d` 또는 `--since YYYY-MM-DD`로 기간 지정; seen은 유지 |
| 새 메시지가 200건을 넘음 | 기본 조회는 재실행으로 이어서 조회; `--since` 조회는 기간을 좁힘; `--only`만 쓴 조회는 `--since`를 지정하거나 좁힘 |
| 수집 실패 뒤 과거 내용 출력 | 오류 안내와 출력 하단 마지막 성공 수집 시각 확인 |

DB는 `~/.claude/inbox/mailman-v2.db`, 요약 로그는 `~/.claude/logs/mailman.log`에 있습니다. 스키마와 테스트는 [런타임 문서](scripts/mailman/README.md)를 참고하세요.
