---
title: mailman
permalink: /
---

# mailman

**mailman**은 Google Chat 스페이스의 메시지를 내 Mac의 로컬 SQLite에 모아 두고, Claude Code의 `/mailman` 슬래시 커맨드, Codex의 `$mailman` 스킬, 또는 터미널에서 조회·전송하는 macOS용 CLI입니다.

- **조회**: 등록한 스페이스의 새 메시지를 스레드 단위로 정리해 보여 줍니다. 사람/봇 메시지만 골라 볼 수도 있습니다(`--only human`, `--only bot`).
- **전송**: 사용자가 승인한 텍스트를 본인 명의로 원 스레드에 답글로 보냅니다.
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

3. `~/.claude/mailman/config.json`에 조회할 스페이스를 등록합니다.
4. Claude Code에서 `/mailman`을, Codex에서 `$mailman`을 실행합니다. Codex 샌드박스 설정은 [README](https://github.com/thewronghand-bigs/mailman#codex에서-쓰기)를 참고하세요.

## 명령

아래 예시는 `~/.claude/bin`을 PATH에 넣었다고 가정합니다. 넣지 않았다면 `mailman` 대신 `~/.claude/bin/mailman`처럼 전체 경로로 실행하세요. PATH 추가(zsh): `echo 'export PATH="$HOME/.claude/bin:$PATH"' >> ~/.zshrc`

```text
mailman auth [--client <client_secret.json>]
mailman collect [스페이스] [--deep]
mailman fetch [스페이스] [--since 24h|3d|YYYY-MM-DD] [--only bot|human] [--no-collect]
mailman send [스페이스] [--thread spaces/.../threads/...] < 본문.txt
mailman --help | --version
```

## 문서

- [설정 가이드](setup.md) — 사용자별 OAuth 클라이언트 만들기
- [개인정보처리방침](privacy.md)
- [소스 코드](https://github.com/thewronghand-bigs/mailman) · [문의(GitHub Issues)](https://github.com/thewronghand-bigs/mailman/issues)
