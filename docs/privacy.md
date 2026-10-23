---
title: 개인정보처리방침
permalink: /privacy
---

# mailman 개인정보처리방침

시행일: 2026-10-23

mailman(이하 "앱")은 사용자의 Mac에서만 실행되는 오픈소스 명령줄 도구입니다. 이 방침은 앱이 Google 사용자 데이터를 어떻게 다루는지 설명합니다.

## 1. 요청하는 권한(OAuth 스코프)

앱은 다음 다섯 가지 권한만 요청합니다.

| 스코프 | 용도 |
|--------|------|
| `openid` | 로그인한 계정 식별 |
| `https://www.googleapis.com/auth/userinfo.email` | 로그인한 계정의 이메일 주소 확인 |
| `https://www.googleapis.com/auth/chat.spaces.readonly` | 사용자가 등록한 스페이스 정보 읽기 |
| `https://www.googleapis.com/auth/chat.messages.readonly` | 사용자가 등록한 스페이스의 메시지 읽기 |
| `https://www.googleapis.com/auth/chat.messages.create` | 사용자가 승인한 텍스트 메시지를 사용자 명의로 전송 |

메시지 수집은 사용자가 설정 파일에 직접 등록한 스페이스에 한정되며, 전송은 사용자가 명령을 실행했을 때만 이루어집니다.

## 2. 저장하는 정보와 위치

모든 정보는 **사용자 기기에만** 저장됩니다. 사용자가 설정 파일에 등록한 스페이스의 메시지는 발신자(사람·봇)와 관계없이 모두 저장됩니다.

**`~/.claude/inbox/` — SQLite 데이터베이스(새로 만들 때 파일 권한 0600)**

메시지마다 다음을 저장합니다.

- 메시지 본문(텍스트)
- 발신자의 리소스 이름(`users/<ID>` 형식의 사용자 ID), 표시 이름, 유형(사람/봇)
- 스페이스·스레드·메시지의 리소스 이름
- 생성 시각과 마지막 수정 시각, 수집한 시각
- 첨부 파일 메타데이터(파일 이름, 형식, 리소스 이름, 다운로드 참조 등). 첨부 파일 내용 자체는 내려받지 않습니다.
- **Google Chat API가 돌려준 메시지 원본 JSON 전체.** 위 항목 외에도 메시지에 들어 있는 멘션(언급된 다른 사용자의 ID·표시 이름 등), 카드 내용, 첨부 메타데이터, 리액션 요약처럼 API 응답에 포함된 정보가 그대로 남습니다.

스페이스별로 수집 위치(마지막 수집 메시지 시각, 마지막 성공 수집 시각)와 조회 위치(마지막으로 보여 준 메시지의 시각과 리소스 이름)도 저장합니다.

**`~/.claude/secrets/` — 인증 정보(파일 권한 0600)**

- OAuth 클라이언트 파일: 사용자가 자기 Google Cloud 프로젝트에서 받아 `mailman auth --client`로 등록한 데스크톱 앱 클라이언트 JSON(client id/secret)
- 토큰 파일: refresh token, 로그인한 계정의 이메일 주소, 허용된 스코프 목록

access token은 저장하지 않고 실행할 때마다 새로 받아 메모리에서만 사용합니다.

**`~/.claude/logs/` — 수집 로그**

수집할 때마다 시각, 스페이스 리소스 이름, 받은 건수·저장한 건수를 한 줄씩 남기고, 실패하면 오류 요약 문구를 남깁니다. 메시지 본문, 토큰, 비밀값은 기록하지 않습니다.

**`~/.claude/mailman/` — 설정 파일**

사용자가 작성한 스페이스 별칭과 스페이스 리소스 이름, 선택적 웹훅 URL. 같은 위치에 사용자가 직접 만든 개인 컨벤션 문서(`local.md`)를 둘 수 있으며, 이 문서는 AI 도구의 슬래시 커맨드·스킬이 읽기만 합니다.

환경 변수(`MAILMAN_HOME`, `MAILMAN_CONFIG`, `MAILMAN_CLIENT_FILE`, `MAILMAN_TOKEN_FILE`)로 위치를 바꾼 경우 그 위치에 저장됩니다.

## 3. 전송과 공유

- 앱은 Google API(계정 인증, Google Chat API)와만 통신합니다. 수집한 데이터를 **개발자나 제3자의 서버로 전송하지 않으며**, 판매·광고·분석에 사용하지 않습니다.
- 각 사용자는 **자기 Google Cloud 프로젝트의 OAuth 클라이언트**를 사용합니다. 따라서 개발자는 사용자의 토큰이나 데이터에 접근할 수 없습니다.
- 사용자가 Claude Code·Codex 같은 AI 도구에서 `/mailman` 슬래시 커맨드나 `$mailman` 스킬로 조회 결과를 열면, 그 출력은 사용자가 실행 중인 해당 도구의 세션에 입력됩니다. 이 처리는 사용자와 해당 도구 제공자 사이의 약관을 따르며, 앱 개발자는 관여하지 않습니다.
- 앱의 Google API 사용자 데이터 사용은 [Google API 서비스 사용자 데이터 정책](https://developers.google.com/terms/api-services-user-data-policy)(제한적 사용 요건 포함)을 따릅니다.

## 4. 보관과 삭제

데이터는 사용자가 삭제할 때까지 기기에 남습니다. 위 디렉터리의 파일을 지우면 삭제됩니다. `uninstall.sh`는 실행 파일과 슬래시 커맨드만 지우고 데이터 위치를 안내합니다.

## 5. 권한 철회

Google 계정 → 보안 → [서드파티 연결](https://myaccount.google.com/connections)에서 이 앱(사용자가 정한 앱 이름)의 접근 권한을 삭제하면 refresh token이 무효화됩니다.

## 6. 문의와 변경

문의는 [GitHub Issues](https://github.com/thewronghand-bigs/mailman/issues)로 받습니다. 방침이 바뀌면 이 페이지를 갱신하고 시행일을 고칩니다.

---

## Summary (English)

mailman is an open-source command-line tool that runs only on the user's Mac. It requests the `openid`, `userinfo.email`, `chat.spaces.readonly`, `chat.messages.readonly`, and `chat.messages.create` scopes to read messages from Google Chat spaces the user registers and to send text messages the user approves. All data is stored only on the user's device. `~/.claude/inbox` holds a SQLite database with every message from the registered spaces: message text, sender resource name (`users/<ID>`), display name and type, space/thread/message resource names, creation and update times, attachment metadata, and the **full raw message JSON returned by the Chat API** (including mentions of other users, card content, and attachment metadata), plus per-space collection and read cursors. `~/.claude/secrets` holds the user's own OAuth client file and a token file with the refresh token, account email, and granted scopes (access tokens are never stored). `~/.claude/logs` holds one line per collection run (time, space name, counts, error summary) without message content or secrets. `~/.claude/mailman` holds the user's configuration file. Nothing is sent to the developer or any third-party server. Each user runs mailman with their own OAuth client, so the developer cannot access user data. Use of Google user data complies with the Google API Services User Data Policy, including the Limited Use requirements. Revoke access at Google Account → Security → [Third-party connections](https://myaccount.google.com/connections). Contact: [GitHub Issues](https://github.com/thewronghand-bigs/mailman/issues). Effective date: 2026-10-23.
