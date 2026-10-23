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
| `https://www.googleapis.com/auth/chat.spaces.readonly` | 내가 속한 스페이스 목록과 기존 1:1 DM 찾기 |
| `https://www.googleapis.com/auth/chat.messages.readonly` | 사용자가 선택한 스페이스의 메시지 수집·조회·답장 대기 |
| `https://www.googleapis.com/auth/chat.messages.create` | 사용자가 승인한 텍스트 메시지를 사용자 명의로 전송 |

메시지 수집은 설정의 기본/지정 별칭 또는 사용자가 이름·리소스 이름·`--dm`으로 선택한 스페이스에 한정됩니다. 미등록 방은 해당 호출에서만 사용하며 자동 등록하지 않습니다. 전송은 사용자가 명령을 실행했을 때만 이루어집니다. v2.1에서도 요청 스코프는 추가하지 않습니다.

## 2. 저장하는 정보와 위치

모든 정보는 **사용자 기기에만** 저장됩니다. 사용자가 선택한 스페이스의 메시지는 발신자(사람·봇)와 관계없이 모두 저장됩니다. 답장 대기 중 받은 메시지도 같은 DB에 저장합니다.

**`~/.claude/inbox/` — SQLite 데이터베이스(새로 만들 때 파일 권한 0600)**

메시지마다 다음을 저장합니다.

- 메시지 본문(텍스트)
- 발신자의 리소스 이름(`users/<ID>` 형식의 사용자 ID), 표시 이름, 유형(사람/봇)
- 스페이스·스레드·메시지의 리소스 이름
- 생성 시각과 마지막 수정 시각, 수집한 시각
- 첨부 파일 메타데이터(파일 이름, 형식, 리소스 이름, 다운로드 참조 등). 첨부 파일 내용 자체는 내려받지 않습니다.
- **Google Chat API가 돌려준 메시지 원본 JSON 전체.** 위 항목 외에도 메시지에 들어 있는 멘션(언급된 다른 사용자의 ID·표시 이름 등), 카드 내용, 첨부 메타데이터, 리액션 요약처럼 API 응답에 포함된 정보가 그대로 남습니다.

스페이스별로 수집 위치(마지막 수집 메시지 시각, 마지막 성공 수집 시각)와 조회 위치(마지막으로 보여 준 메시지의 시각과 리소스 이름)도 저장합니다.

`spaces` 목록 캐시에는 사용자가 속한 스페이스의 리소스 이름, 표시 이름, 종류(SPACE/GROUP_CHAT/DIRECT_MESSAGE), 갱신 시각을 저장합니다. 목록 갱신 시각도 저장합니다. DM 찾기 결과도 같은 목록 테이블에 캐시할 수 있습니다. 사람 이름 해석에는 이미 저장된 메시지의 발신자 표시 이름과 사용자 ID를 사용합니다.

**`~/.claude/secrets/` — 인증 정보(파일 권한 0600)**

- OAuth 클라이언트 파일: 사용자가 자기 Google Cloud 프로젝트에서 받아 `mailman auth --client`로 등록한 데스크톱 앱 클라이언트 JSON(client id/secret)
- 토큰 파일: refresh token, 로그인한 계정의 이메일 주소, 허용된 스코프 목록, Google 계정 ID(`user_name: users/<sub>`). 계정 ID는 대기 중 내 메시지를 제외하는 데 사용합니다.

access token은 저장하지 않고 실행할 때마다 새로 받아 메모리에서만 사용합니다. auth에서 받은 id_token의 계정 ID(sub)만 저장하고 id_token 원문은 저장하지 않습니다. 이전 토큰 파일에 계정 ID가 없으면 첫 대기 때 Google userinfo로 한 번 조회해 보완합니다.

**`~/.claude/logs/` — 수집 로그**

수집할 때마다 시각, 스페이스 리소스 이름, 받은 건수·저장한 건수를 한 줄씩 남기고, 실패하면 오류 요약 문구를 남깁니다. 대기 중 일시 API 오류의 요약과 재시도 간격도 기록합니다. 메시지 본문, 토큰, 비밀값은 기록하지 않습니다.

**`~/.claude/mailman/` — 설정 파일**

사용자가 작성하거나 `--save`로 추가한 스페이스 별칭과 스페이스 리소스 이름, 선택적 웹훅 URL. `--save`는 기존 필드를 보존하고 0600으로 원자 저장하며 기존 별칭을 덮어쓰지 않습니다. 같은 위치에 사용자가 직접 만든 개인 컨벤션 문서(`local.md`)를 둘 수 있으며, 이 문서는 AI 도구의 슬래시 커맨드·스킬이 읽기만 합니다.

환경 변수(`MAILMAN_HOME`, `MAILMAN_CONFIG`, `MAILMAN_CLIENT_FILE`, `MAILMAN_TOKEN_FILE`)로 위치를 바꾼 경우 그 위치에 저장됩니다.

## 3. 전송과 공유

- 앱은 Google API(계정 인증, Google Chat API)와만 통신합니다. 수집한 데이터를 **개발자나 제3자의 서버로 전송하지 않으며**, 판매·광고·분석에 사용하지 않습니다.
- `spaces.list`(`GET /v1/spaces`)로 내가 속한 방 목록을 가져옵니다. 이름 해석 때 캐시가 24시간보다 오래되면 자동 갱신합니다. `spaces.findDirectMessage`(`GET /v1/spaces:findDirectMessage`)에는 사용자가 지정한 users/ID 또는 이메일 별칭을 보내 기존 DM을 찾습니다. 이메일로 발신자를 제한할 때도 전송/대기 전에 기존 DM의 발신자 기록으로 사용자 ID를 확정합니다. 기록이 없으면 그 DM의 최근 메시지를 조회합니다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 이 확인 결과는 실행 중 메모리에서 비교하며 발신자별 추가 DM 조회나 새 DM 생성은 하지 않습니다.
- Google userinfo(`https://openidconnect.googleapis.com/v1/userinfo`)는 인증 시 이메일·계정 ID 확인 및 기존 토큰의 계정 ID 보완에 사용합니다. 메시지 API는 수집·대기와 승인된 전송에 사용합니다.
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

mailman is an open-source CLI that runs only on the user's Mac. It requests only the existing `openid`, `userinfo.email`, `chat.spaces.readonly`, `chat.messages.readonly`, and `chat.messages.create` scopes. It reads messages from spaces selected by a configured alias, resource name, display name, or existing DM, and sends approved text. Messages fetched while waiting for replies are stored too. The local SQLite database contains message text, sender IDs/display names/types, space/thread/message names, timestamps, attachment metadata, the full raw message JSON (including mentions, cards, and reactions), and collection/read cursors. It also caches joined spaces' resource names, display names, types, and update times. Name resolution refreshes spaces older than 24 hours. The token file stores the refresh token, account email, granted scopes, and Google account ID as `users/<sub>`; access tokens and raw id_tokens are never stored. The account ID comes from the OAuth id_token or Google userinfo, with a one-time userinfo lookup on first wait for older token files. `spaces.findDirectMessage` receives a user ID or email alias to find an existing DM; no DM is created. Email sender filters resolve the peer's ID before sending/waiting using cached DM senders or recent DM messages (seven days by default, configurable with `MAILMAN_BACKFILL_DAYS`), keeping the lookup result in memory without per-sender DM lookups. Configuration includes user-written or explicitly saved aliases and optional webhook URLs. Logs contain collection time, space, counts, error summaries, and wait retry delays without message content or secrets. All data stays on the device; nothing is sent to the developer or third-party servers. Opening CLI output in Claude Code or Codex puts that output into the user's session with that provider. Each user supplies their own OAuth client. Use of Google user data follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including Limited Use. Revoke access at [Google Account connections](https://myaccount.google.com/connections). Contact: [GitHub Issues](https://github.com/thewronghand-bigs/mailman/issues). Effective date: 2026-10-23.
