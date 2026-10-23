# 설치 가이드 — v2.3

## 준비

- macOS (Apple Silicon 또는 Intel). `mailman auth`가 기본 브라우저를 `open`으로 실행합니다.
- 대상 Google Chat 스페이스의 멤버인 회사 Google Workspace 계정. 직접 프로젝트를 만들 때는 개인 Gmail도 필요합니다.
- **A. 설정을 마친 동료에게 클라이언트 JSON을 받았다면 [8단계부터(약 5분)](https://thewronghand-bigs.github.io/mailman/setup#step-8), B. 처음부터 혼자 설정한다면 [1단계부터(약 20분)](https://thewronghand-bigs.github.io/mailman/setup#step-1)** 진행합니다([레포 안의 설정 가이드](docs/setup.md)).

릴리스 설치에는 bun·Node.js가 필요 없습니다. 개발 설치(`--dev`)만 bun이 필요합니다.

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/install.sh | bash
```

- GitHub 최신 릴리스에서 아키텍처에 맞는 `mailman-darwin-arm64` 또는 `mailman-darwin-x64`를 받아 `~/.claude/bin/mailman`에 설치합니다. Rosetta 셸에서도 Apple Silicon이면 arm64를 받습니다.
- 같은 릴리스 태그의 `commands/mailman.md`, `commands/mailman-deep.md`를 `~/.claude/commands/`에 설치합니다.
- 설치기는 설정 파일을 만들거나 수정하지 않습니다. 첫 `--save`가 `~/.claude/mailman/config.json`을 0600으로 만들고 그 별칭을 기본 방으로 정합니다. `config.example.json`은 문서 참고용으로만 남습니다.
- 실행 파일·커맨드·스킬을 모두 임시 디렉터리에 받아 검증한 뒤 한꺼번에 설치합니다. 다운로드가 하나라도 실패하면 `[mailman] 다운로드 실패: …` 안내와 함께 기존 설치를 그대로 두고 끝납니다.
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

## 최초 설정과 인증

동료에게 받은 JSON 또는 [설정 가이드](https://thewronghand-bigs.github.io/mailman/setup)에서 직접 만든 데스크톱 앱 JSON으로 **본인 회사 계정**에 로그인합니다. 동료 프로젝트의 IAM 멤버일 필요는 없습니다. JSON은 비밀번호처럼 다루고 공개·커밋하지 않습니다. 동료에게 발급할 때는 [사람별 클라이언트 전달 절차](https://thewronghand-bigs.github.io/mailman/setup#colleague-client)를 따르세요.

```bash
~/.claude/bin/mailman auth --client ~/Downloads/client_secret_XXXX.json
~/.claude/bin/mailman doctor
```

오류가 나면 먼저 `mailman doctor`를 실행하고 출력된 해결 단계로 이동하세요. `doctor`는 파일 경로·0600 권한, 설정 JSON, 클라이언트·토큰·스코프, 토큰 갱신·Chat API 접근을 점검합니다. 설정·파일·DB를 바꾸지 않으며, 실패는 exit 1, 경고만 있으면 exit 0입니다.

방 등록은 `mailman spaces '검색어' --save dev`로 합니다. 후보가 여러 개면 출력된 표시 이름으로 범위를 좁히세요. **처음 저장한 별칭이 기본 방이며, 바꾸려면 `--save <별칭> --default`**를 사용합니다. `mailman spaces --save dev --default`는 기존 별칭의 기본 지정만 바꾸고 방 값은 덮어쓰지 않습니다. 설정 파일을 직접 편집할 필요가 없습니다. 이후 `/mailman dev` 또는 `$mailman`으로 저장한 별칭을 지정해 조회하세요. 재인증은 `mailman auth`만 실행합니다. 환경변수로 경로를 바꾸는 방법은 [런타임 문서](scripts/mailman/README.md#설정과-경로)를 참고하세요.

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

실행 파일(직전 백업 `mailman.bak` 포함)·슬래시 커맨드·Codex 스킬만 지웁니다. `--save`로 만든 설정(이전 설치의 설정 포함)·`local.md`·DB·로그·OAuth 클라이언트·토큰과 커맨드·스킬 백업(`.bak.<타임스탬프>`)은 위치만 안내합니다. 이전 설치 경로 `~/.claude/scripts/mailman`은 심볼릭 링크면 지우고, 실제 디렉터리면 남겨 둡니다.

## 문제 해결

설정·인증·API 오류는 먼저 `mailman doctor`를 실행하고 [설정 가이드의 증상별 표](https://thewronghand-bigs.github.io/mailman/setup#자주-막히는-곳)를 확인하세요. Codex에서만 쓰기·네트워크 오류가 나면 위 [Codex](#codex) 항목을 확인합니다.

설치 중 `다운로드 실패`는 기존 설치를 유지합니다. 네트워크와 지정한 릴리스 태그를 확인한 뒤 다시 실행하세요. 과거 메시지를 다시 보려면 `--since 7d`, 수정분·누락 보완은 `--deep`을 사용합니다.

DB는 `~/.claude/inbox/mailman-v2.db`, 요약 로그는 `~/.claude/logs/mailman.log`에 있습니다. 스키마와 테스트는 [런타임 문서](scripts/mailman/README.md)를 참고하세요.
