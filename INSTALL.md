# 설치 가이드 — v2

## 준비

- macOS (`run.sh auth`가 기본 브라우저를 `open`으로 실행)
- bun (외부 패키지 설치 불필요)
- 대상 Google Chat 스페이스의 멤버인 사용자 계정
- Google Chat API를 활성화한 GCP 프로젝트와 **데스크톱 앱** OAuth 클라이언트

Google의 [데스크톱 OAuth 안내](https://developers.google.com/identity/protocols/oauth2/native-app)에 따라 클라이언트를 만들고 JSON을 내려받습니다.

## 설정 파일

레포 기준:

```bash
cd scripts/mailman
cp config.example.json config.json
```

`config.json`의 `defaultSpace`, `spaces.<별칭>.space`를 편집합니다. `space`는 `spaces/SPACE_ID` 형식이며, 카드 전송용 `webhookUrl`은 선택 사항입니다. 이전 버전의 `url`, `bots`, `defaultBot` 설정은 사용하지 않습니다. 기존 설정·`node_modules/` 정리는 사용자가 직접 합니다.

Google에서 내려받은 `{"installed": {...}}` JSON은 `~/.claude/secrets/mailman-oauth.json`에 저장합니다. 파일 내용은 터미널이나 로그에 출력하지 않습니다.

별도 경로를 쓰려면:

```bash
export MAILMAN_HOME="$PWD/.mailman"
export MAILMAN_CLIENT_FILE="/경로/mailman-oauth.json"
export MAILMAN_TOKEN_FILE="/경로/mailman-token.json"
```

`MAILMAN_HOME`만 바꾸면 DB/로그만 이동합니다. OAuth 파일 기본 경로는 계속 `~/.claude/secrets/`입니다.

## 최초 인증

```bash
bash run.sh auth
```

1. 기본 브라우저에서 사용할 Google 계정으로 로그인합니다.
2. 표시되는 다섯 권한(`openid`, 이메일, 스페이스 읽기, 메시지 읽기, 메시지 생성)에 모두 동의합니다.
3. `127.0.0.1` 임의 포트로 돌아오면 브라우저 탭을 닫아도 됩니다.
4. 터미널에 인증 완료, 이메일, 허용 스코프가 출력되는지 확인합니다.

인증 대기 시간은 5분입니다. 성공하면 refresh token·이메일·허용 스코프를 토큰 파일에 0600으로 저장합니다. access token은 저장하지 않습니다.

## Claude Code 연결

레포 루트에서:

```bash
mkdir -p ~/.claude/scripts ~/.claude/commands
ln -s "$PWD/scripts/mailman" ~/.claude/scripts/mailman
cp commands/mailman.md commands/mailman-deep.md ~/.claude/commands/
```

이미 `~/.claude/scripts/mailman`이 이 레포를 가리키는 심볼릭 링크라면 그대로 사용합니다. `run.sh`, `fetch.sh`, `send.sh` 경로는 v2에서도 같습니다.

배포된 버전의 설치 스크립트는 `bash install.sh claude`로 사용할 수 있습니다. 개발 브랜치를 원격에서 설치할 때는 `MAILMAN_INSTALL_BRANCH=feat/chat-api-v2`를 지정합니다. 로컬 구현/검증에는 설치 스크립트를 실행할 필요가 없습니다.

## 확인

레포 루트에서:

```bash
bash scripts/mailman/fetch.sh tn 5
MAILMAN_DEEP=1 bash scripts/mailman/fetch.sh tn 5
```

CLI의 조회 개수는 최신 스레드 수입니다. `/mailman tn 5`, `/mailman-deep tn 5`도 같은 래퍼를 씁니다.

## 문제 해결

| 증상 | 확인 |
|------|------|
| 토큰 없음 (exit 2) | `bash scripts/mailman/run.sh auth` |
| `invalid_grant` (exit 3) | 같은 명령으로 다시 로그인·동의 |
| 필수 스코프 누락 | 다시 인증하며 다섯 권한 모두 동의 |
| HTTP 403 | 스페이스 멤버십, GCP의 Chat API 활성화, 조직 OAuth 정책 확인 |
| 수정한 명세가 오래된 내용 | `MAILMAN_DEEP=1`로 백필; 필요하면 `MAILMAN_BACKFILL_DAYS` 확대 |
| 기본 조회에 일반 대화가 없음 | `--all` 사용; 사람 명세 공유는 첫 줄 `@mailman` 마커 |
| 수집 실패 뒤 과거 내용 출력 | 오류 안내와 출력 하단 마지막 성공 수집 시각 확인 |

DB는 `~/.claude/inbox/mailman-v2.db`, 요약 로그는 `~/.claude/logs/mailman.log`에 있습니다. 스키마와 테스트는 [런타임 문서](scripts/mailman/README.md)를 참고하세요.
