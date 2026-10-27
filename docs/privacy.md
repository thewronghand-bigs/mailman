---
title: 개인정보처리방침
permalink: /privacy
---

# mailman 개인정보처리방침

시행일: 2026-10-27

mailman(이하 "앱")은 사용자의 Mac에서만 실행되는 오픈소스 명령줄 도구입니다. 이 방침은 앱이 Google 사용자 데이터를 어떻게 다루는지 설명합니다.

## 1. 요청하는 권한(OAuth 스코프)

앱은 다음 여덟 가지 권한만 요청합니다. 필수 검사는 기존 4개+openid를 유지하며 리액션·회사 디렉터리 검색·DM 생성 권한은 선택입니다. 해당 선택 권한이 없는 기존 토큰도 다른 기능은 동작합니다.

| 스코프 | 용도 |
|--------|------|
| `openid` | 로그인한 계정 식별 |
| `https://www.googleapis.com/auth/userinfo.email` | 로그인한 계정의 이메일 주소 확인 |
| `https://www.googleapis.com/auth/chat.spaces.readonly` | 내가 속한 스페이스 목록과 기존 1:1 DM 찾기 |
| `https://www.googleapis.com/auth/chat.messages.readonly` | 선택한 스페이스의 메시지 수집·조회·답장 대기, 첨부 대상 메시지 조회와 업로드 파일 다운로드, 이메일 --from 확인을 위한 상대 DM 최근 메시지 조회(이 확인 결과는 저장하지 않음) |
| `https://www.googleapis.com/auth/chat.messages.create` | 사용자가 승인한 텍스트·지정 파일을 사용자 명의로 전송, 해당 파일의 Chat 미디어 업로드 |
| `https://www.googleapis.com/auth/chat.messages.reactions.create` | 작업 관련 메시지에 사용자 명의 👀·✅ 리액션 추가(선택) |
| `https://www.googleapis.com/auth/directory.readonly` | 회사 디렉터리의 이름·이메일 조회로 사용자가 지정한 사람 찾기(선택) |
| `https://www.googleapis.com/auth/chat.spaces.create` | 사용자가 전송할 상대와 기존 대화가 없을 때 1:1 DM 생성(선택) |

메시지 수집·DB 저장 대상은 설정의 기본/지정 별칭 또는 사용자가 이름·리소스 이름·`--dm`으로 선택한 스페이스입니다. 이메일 `--from` 확인 시에는 대상 방 외에 상대의 기존 DM 최근 메시지도 읽을 수 있으며 이 확인 결과는 메모리에서만 사용합니다. `download`는 지정한 메시지가 DB에 없으면 그 메시지를 조회합니다. 미등록 방은 해당 호출에서만 사용하며 자동 등록하지 않습니다. 텍스트·지정 파일·카드 전송은 사용자 승인 후 이루어집니다. Claude/Codex 스킬·커맨드는 작업 관련 스펙·요청·핸드오버를 읽고 보고한 뒤 👀를 자동으로 달고, 실제 반영 완료 뒤 ✅는 사용자 승인 후 답니다. 잡담과 중복 리액션은 피합니다. `local.md`도 ✅ 승인·전송 승인을 완화할 수 없습니다.

## 2. 저장하는 정보와 위치

앱의 DB·설정·인증정보·로그·내려받은 첨부는 **사용자 기기에** 저장됩니다. 사용자가 선택한 스페이스의 메시지는 발신자(사람·봇)와 관계없이 모두 저장됩니다. 답장 대기 중 받은 메시지도 같은 DB에 저장합니다. 사용자가 지정해 전송하는 파일은 3절처럼 Google Chat에 업로드됩니다.

**`~/.claude/inbox/` — SQLite 데이터베이스(새로 만들 때 파일 권한 0600)**

메시지마다 다음을 저장합니다.

- 메시지 본문(텍스트)
- 발신자의 리소스 이름(`users/<ID>` 형식의 사용자 ID), 표시 이름, 유형(사람/봇)
- 스페이스·스레드·메시지의 리소스 이름
- 생성 시각과 마지막 수정 시각, 수집한 시각
- 첨부 파일 메타데이터(파일 이름, 형식, 리소스 이름, 다운로드 참조 등). 파일 내용은 download 또는 --with-attachments를 요청할 때 아래 attachments/에 별도 저장합니다.
- **Google Chat API가 돌려준 메시지 원본 JSON 전체.** 위 항목 외에도 메시지에 들어 있는 멘션(언급된 다른 사용자의 ID·표시 이름 등), 카드 내용, 첨부 메타데이터, 리액션 요약처럼 API 응답에 포함된 정보가 그대로 남습니다.

스페이스별로 수집 위치(마지막 수집 메시지 시각, 마지막 성공 수집 시각)와 조회 위치(마지막으로 보여 준 메시지의 시각과 리소스 이름)도 저장합니다.

`spaces` 목록 캐시에는 사용자가 속한 스페이스의 리소스 이름, 표시 이름, 종류(SPACE/GROUP_CHAT/DIRECT_MESSAGE), 갱신 시각을 저장합니다. 목록 갱신 시각도 저장합니다. DM 찾기·생성 결과도 같은 목록 테이블에 캐시할 수 있습니다.

`people` 등록부에는 이름 해석으로 **확정된 한 명의 이름·이메일(알면)·사용자 ID(`users/숫자ID`)**, 출처(`sender`·`directory`·`manual`), 갱신 시각을 저장합니다. 회사 디렉터리 검색의 후보 목록이나 원본 응답 전체는 저장하지 않습니다. `--dry-run`은 사람을 등록·갱신하지 않습니다. `mailman people [검색어]`로 확인하고 `mailman people --forget users/숫자ID`로 한 명의 등록을 지울 수 있습니다. 이 삭제는 수집 메시지의 발신자 정보를 지우지 않으며, 다시 이름을 해석하면 등록될 수 있습니다.

**`~/.claude/secrets/` — 인증 정보(파일 권한 0600)**

- OAuth 클라이언트 파일: 본인 프로젝트에서 만들거나 설정을 마친 동료의 프로젝트에서 사람별로 발급받아 `mailman auth --client`로 등록한 데스크톱 앱 클라이언트 JSON(client id/secret)
- 토큰 파일: refresh token, 로그인한 계정의 이메일 주소, 허용된 스코프 목록, Google 계정 ID(`user_name: users/<sub>`). 계정 ID는 대기 중 내 메시지를 제외하는 데 사용합니다.

access token은 저장하지 않고 실행할 때마다 새로 받아 메모리에서만 사용합니다. auth에서 받은 id_token의 계정 ID(sub)만 저장하고 id_token 원문은 저장하지 않습니다. 이전 토큰 파일에 계정 ID가 없으면 첫 대기 때 Google userinfo로 한 번 조회해 보완합니다.

**`~/.claude/logs/` — 수집 로그**

수집할 때마다 시각, 스페이스 리소스 이름, 받은 건수·저장한 건수를 한 줄씩 남기고, 실패하면 오류 요약 문구를 남깁니다. 대기 중 일시 API 오류의 요약과 재시도 간격도 기록합니다. 메시지 본문, 토큰, 비밀값은 기록하지 않습니다.

**`~/.claude/mailman/` — 설정 파일**

사용자가 작성하거나 `--save`로 추가한 스페이스 별칭과 스페이스 리소스 이름, 선택적 웹훅 URL. `--save`는 기존 필드를 보존하고 0600으로 원자 저장하며 기존 별칭을 덮어쓰지 않습니다. 같은 위치에 사용자가 직접 만든 개인 컨벤션 문서(`local.md`)를 둘 수 있으며, 이 문서는 AI 도구의 슬래시 커맨드·스킬이 읽기만 합니다.

환경 변수(`MAILMAN_HOME`, `MAILMAN_CONFIG`, `MAILMAN_CLIENT_FILE`, `MAILMAN_TOKEN_FILE`)로 위치를 바꾼 경우 그 위치에 저장됩니다.

**`$MAILMAN_HOME/mailman/attachments/` — 내려받은 업로드 첨부**

기본값은 `~/.claude/mailman/attachments/<space id>/<message id>/<파일명>`입니다. `download --out`으로 지정한 디렉터리에도 저장할 수 있습니다. 파일명은 경로 구분자·`..`·제어문자를 제거하고 충돌 접미사를 붙입니다. 파일과 기본 경로의 재사용 기록(`.mailman-attachments.json`: 다운로드 참조·정리한 원래 이름·실제 이름·크기)은 0600, 기본 저장 디렉터리는 0700입니다. `--out`은 기존 디렉터리 권한을 바꾸지 않고 새 디렉터리만 0700으로 만듭니다. `--out`에는 재사용 기록을 남기지 않고 매번 새 파일로 받습니다. 파일당 상한은 50MB이며 기본 경로에서 같은 소스·이름·저장 크기의 파일은 다시 사용합니다. 30초 무수신 또는 전체 10분 초과 시 중단합니다. `--print`는 256KB 이하 텍스트 내용을 stdout에 출력합니다. `fetch`·`wait`·`send --wait`의 `--with-attachments`는 실제 표시하는 메시지당 텍스트 첨부 최대 3개·각 256KB를 내려받아 출력합니다. Drive 파일은 내려받지 않고 Drive 링크/파일 ID와 미지원 안내만 표시합니다.

## 3. 전송과 공유

- 앱은 Google API(계정 인증, Google Chat API, People API)와만 통신합니다. 수집한 데이터와 회사 디렉터리 검색 결과를 **개발자나 제3자의 서버로 전송하지 않으며**, 판매·광고·분석에 사용하지 않습니다. 아래 사용자가 요청한 Google API 조회·전송 외에 디렉터리 결과를 외부로 전송하는 기능은 없습니다.
- `spaces.list`(`GET /v1/spaces`)로 내가 속한 방 목록을 가져옵니다. 이름 해석 때 캐시가 24시간보다 오래되면 자동 갱신합니다. `spaces.findDirectMessage`(`GET /v1/spaces:findDirectMessage`)에는 사용자가 지정했거나 해석한 users/ID 또는 이메일 별칭을 보내 기존 DM을 찾습니다. 이메일로 발신자를 제한할 때도 전송/대기 전에 기존 DM의 발신자 기록으로 사용자 ID를 확정합니다. 기록이 없으면 그 DM의 최근 메시지를 조회합니다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). 이 발신자 확인 결과는 실행 중 메모리에서 비교하며 대기 중 발신자별 추가 DM 조회는 하지 않습니다.
- 회사 디렉터리 검색은 로컬 등록부·수집 발신자로 사람을 확정하지 못하고 선택 스코프가 있을 때만 People API(`GET https://people.googleapis.com/v1/people:searchDirectoryPeople`)에 사용자가 지정한 검색 이름을 보냅니다. 회사 프로필의 이름·이메일을 조회하고 정확/부분 일치 후보 중 한 명만 확정합니다. 후보 전체는 실행 중 메모리와 필요 시 오류 목록에만 표시하고, 확정된 한 명의 정보만 위 로컬 DB에 저장합니다. `doctor`는 디렉터리 권한이 있으면 본인 이메일 앞부분으로 1건 접근 점검을 하며 결과는 저장하지 않습니다.
- 승인된 전송 상대와 기존 DM이 없으면 `spaces.setup`(`POST /v1/spaces:setup`)에 `DIRECT_MESSAGE`와 상대 사용자 ID(또는 이메일 별칭)를 보내 DM을 만든 뒤 메시지를 전송합니다. `--dry-run`·fetch·collect·wait는 DM을 만들지 않습니다. 생성 권한이 없으면 재인증을 안내합니다.
- Google userinfo(`https://openidconnect.googleapis.com/v1/userinfo`)는 인증 시 이메일·계정 ID 확인 및 기존 토큰의 계정 ID 보완에 사용합니다. 메시지 API는 수집·대기와 승인된 전송에 사용합니다.
- `messages.get`(`GET /v1/{message name}`)은 첨부 대상 메시지가 DB에 없을 때 사용하며 이 단건 조회 결과는 DB에 저장하지 않습니다. 업로드 파일은 `media.download`(`GET /v1/media/{resourceName}?alt=media`)로 받아 로컬에 저장합니다. 다운로드 리다이렉트는 HTTPS의 `*.googleapis.com`·`*.googleusercontent.com`·`*.google.com`만 최대 5회 따릅니다. 호스트가 바뀌면 Authorization 헤더를 제거하고 허용 범위 밖에는 요청하지 않습니다. `reactions.create`(`POST /v1/{message name}/reactions`)에는 지정한 👀 또는 ✅를 보내 로그인한 사용자 명의로 추가합니다. 이미 같은 리액션이 있으면 성공으로 처리합니다. Drive API와 외부 downloadUri에는 요청하지 않습니다.
- `send --attach <파일>`은 사용자가 지정한 로컬 일반 파일을 Google Chat에 업로드합니다. 심볼릭 링크 파일은 거절하며 미리보기·성공 출력의 경로는 실제 경로(realpath)입니다. 최대 10개·각 200MB를 모두 검증하고 `media.upload`(`POST /upload/v1/{space}/attachments:upload?uploadType=multipart`)에 basename 메타데이터(`filename`)와 원본 바이트를 multipart로 보냅니다. 로컬 전체 경로는 업로드 메타데이터로 보내지 않습니다. 기존 chat.messages.create 권한만 사용하며, 받은 attachmentDataRef를 messages.create의 attachment[]에 넣습니다. 전부 업로드해야 메시지를 생성하고 실패 시 메시지는 보내지 않습니다. 이미 성공한 업로드를 삭제하는 API는 호출하지 않습니다. CLI는 전송 파일을 추가로 로컬 복사하지 않습니다. --dry-run은 업로드 없이 경로·이름·크기를 출력하며 성공 출력은 파일 이름과 실제 경로를 표시합니다.
- Claude/Codex 커맨드·스킬은 지정 파일의 경로·이름·크기를 미리보기에 포함해 전송 승인받습니다. 사용자가 지정하지 않은 파일과 .env·키·토큰·자격증명 파일은 첨부하지 않습니다. 핸드오버 md 작성·전송 요청은 먼저 파일로 쓴 뒤 그 경로를 미리보기에서 승인받아 첨부합니다. local.md로 이 파일 제한과 승인을 완화할 수 없습니다.
- 각 사용자는 **본인용으로 발급된 OAuth 클라이언트**와 본인 Google 계정으로 로그인합니다. 프로젝트는 본인이 만들거나 동료의 프로젝트를 사용할 수 있습니다. 로그인 토큰은 사용자 기기에 저장되며, 클라이언트를 발급한 동료나 개발자에게 전달되지 않습니다.
- 사용자가 Claude Code·Codex 같은 AI 도구에서 `/mailman` 슬래시 커맨드나 `$mailman` 스킬로 조회 결과를 열면, 그 출력은 사용자가 실행 중인 해당 도구의 세션에 입력됩니다. 이 처리는 사용자와 해당 도구 제공자 사이의 약관을 따르며, 앱 개발자는 관여하지 않습니다.
- 앱의 Google API 사용자 데이터 사용은 [Google API 서비스 사용자 데이터 정책](https://developers.google.com/terms/api-services-user-data-policy)(제한적 사용 요건 포함)을 따릅니다.

## 4. 보관과 삭제

데이터는 사용자가 삭제할 때까지 기기에 남습니다. 위 디렉터리의 파일을 지우면 삭제됩니다. `uninstall.sh`는 실행 파일과 슬래시 커맨드만 지우고 데이터 위치를 안내합니다.

사람 등록만 삭제하려면 `mailman people --forget users/숫자ID`를 사용합니다. 회사 디렉터리 원본은 Google Workspace 관리 정책을 따르며 이 명령으로 바뀌지 않습니다.

## 5. 권한 철회

Google 계정 → 보안 → [서드파티 연결](https://myaccount.google.com/connections)에서 이 앱(사용자가 정한 앱 이름)의 접근 권한을 삭제하면 refresh token이 무효화됩니다.

## 6. 문의와 변경

문의는 [GitHub Issues](https://github.com/thewronghand-bigs/mailman/issues)로 받습니다. 방침이 바뀌면 이 페이지를 갱신하고 시행일을 고칩니다.

---

## Summary (English)

mailman is an open-source CLI that runs only on the user's Mac. It requests `openid`, `userinfo.email`, `chat.spaces.readonly`, `chat.messages.readonly`, `chat.messages.create`, and the optional `chat.messages.reactions.create`, `directory.readonly`, and `chat.spaces.create` scopes. Only the original five scopes are required for existing commands; older tokens need reauthorization only for the corresponding optional features. It reads and stores messages from spaces selected by alias, resource name, display name, or existing DM, including messages received while waiting. Email --from verification may also read the peer's existing DM, keeping those lookup results only in memory (seven days by default, configurable with `MAILMAN_BACKFILL_DAYS`). Approved sends may create a missing DM using spaces.setup; previews, fetch, collect, and wait never create DMs.

SQLite stores message text, sender IDs/names/types, space/thread/message names, timestamps, attachment metadata, full raw message JSON (including mentions, cards, and reaction summaries), collection/read cursors, and joined-space metadata. Company-directory lookup uses People API to search names and emails when local lookup cannot resolve a name. Only one confirmed person’s name, email, user ID, source, and update time are stored locally in the people table; candidate lists and raw directory responses are not stored or sent to third-party servers. Dry runs never register people. mailman people lists registered people, and people --forget removes one registration without deleting collected messages. Doctor may check one directory result using the signed-in email prefix without storing it. Space names older than 24 hours are refreshed. Tokens store the refresh token, email, granted scopes, and account ID as `users/<sub>`. Access tokens and raw id_tokens are never stored. The ID comes from OAuth or Google userinfo, with a one-time lookup on first wait for older tokens. Configuration contains aliases, optional webhook URLs, and a user-written local.md. Logs contain times, space names, counts, error summaries, and retry delays without message content or secrets.

On request, uploaded attachments are saved under `$MAILMAN_HOME/mailman/attachments/<space id>/<message id>/` (default `~/.claude/mailman/attachments/`) or `download --out`. Files and the default-path reuse manifest (source reference, sanitized original/saved names, size) have mode 0600; default directories have mode 0700. With --out, only newly created directories use 0700; existing directory permissions stay unchanged, no reuse manifest is read or written, and each request downloads a new file. Names are sanitized and collisions receive suffixes; matching source/name/local size is reused only in the default path. Downloads are limited to 50MB per file, with a 30-second idle timeout and a ten-minute total limit. `--print` outputs text up to 256KB; `--with-attachments` downloads and displays up to three text files of 256KB each per displayed message. `messages.get` retrieves a missing attachment target message without saving that response to SQLite. `media.download` downloads uploaded bytes. It follows up to five HTTPS redirects within *.googleapis.com, *.googleusercontent.com, and *.google.com, removes Authorization when the host changes, and makes no requests outside this allowlist. Drive files and external downloadUri URLs are not fetched; only a Drive link/file ID and an unsupported notice are shown. `reactions.create` posts the chosen 👀 or ✅ as the signed-in user. Claude/Codex commands and skills automatically add 👀 after reading and reporting work-related specs, requests, or handovers. ✅ requires actual implementation completion and user approval. Reactions target the message containing the actual spec, request, or handover; the user’s own messages, casual chat, and duplicate reactions are avoided. local.md may customize the policy but cannot relax ✅ or message-sending approval.

`send --attach` uploads user-specified local regular files to Google Chat using the existing chat.messages.create scope. Up to ten files of 200MB each are validated before uploading. File symlinks are rejected. Parent-directory symlinks are allowed, with realpath-resolved paths shown in previews and success output. `media.upload` (POST /upload/v1/{space}/attachments:upload?uploadType=multipart) sends basename-only filename metadata and original bytes; the returned attachmentDataRef goes into messages.create attachment[]. Messages are created only after all uploads succeed. Failed batches do not create a message, and the CLI does not call an API to delete earlier successful uploads. It makes no additional local copy of files being sent. Empty message text with attachments sends only the tag, or no text when tagging is disabled. Dry runs show paths, names, and sizes without uploading; success output lists filenames and resolved paths. Commands and skills include this file list in user approval. They attach only user-specified files and reject .env, keys, tokens, and credential files with a warning. Requested handover Markdown is written to a file first, then attached using the path shown for approval. local.md cannot relax these restrictions or approval.

The CLI communicates only with Google APIs. Local databases, configuration, credentials, logs, and downloaded attachments remain on the device until deleted; approved text and designated files are sent to Google Chat. Nothing is sent to the developer or other third-party servers. Opening CLI output, including attachment contents or file-list previews, in Claude Code or Codex puts it into the user's session with that provider. Each user supplies their own OAuth client. Use of Google user data follows the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including Limited Use. Revoke access at [Google Account connections](https://myaccount.google.com/connections). Contact: [GitHub Issues](https://github.com/thewronghand-bigs/mailman/issues). Effective date: 2026-10-27.
