---
title: 설정 가이드 — 사용자별 OAuth 클라이언트
permalink: /setup
---

# 설정 가이드 — 사용자별 OAuth 클라이언트

mailman은 각 사용자가 **자기 Google Cloud 프로젝트에 직접 만든 OAuth 클라이언트**로 동작합니다. 실행 파일·레포·릴리스에는 어떤 client id/secret도 들어 있지 않습니다.

준비할 계정은 둘입니다.

- **개인 Google 계정** — Google Cloud 프로젝트 소유자. 앱 브랜딩의 지원 이메일·개발자 연락처로 씁니다.
- **회사(Google Workspace) 계정** — 실제로 Chat 메시지를 읽고 보낼 계정. Chat API의 앱 구성(Configuration) 화면은 **Workspace 계정으로 접속해야 열립니다.** 그래서 이 계정을 프로젝트 편집자로 넣고 그 계정으로 Chat 앱을 구성합니다.

> **주의:** 회사 Workspace 관리자가 확인되지 않은 서드파티 앱의 접근을 차단해 두었다면 8단계 로그인이 "액세스 차단됨"으로 막힙니다. 이 경우 관리자에게 본인 OAuth 클라이언트 ID를 신뢰할 수 있는 앱으로 허용해 달라고 요청해야 합니다.

## 1. 개인 계정으로 프로젝트 만들기

개인 Google 계정으로 [새 프로젝트 만들기](https://console.cloud.google.com/projectcreate)에서 프로젝트를 만듭니다. 이름은 자유입니다(예: `mailman`). 이후 모든 단계에서 상단 프로젝트 선택기가 이 프로젝트인지 확인하세요.

## 2. Google Chat API 사용 설정

[Google Chat API](https://console.cloud.google.com/apis/library/chat.googleapis.com) 페이지에서 **사용**을 누릅니다.

## 3. 회사 계정을 편집자로 추가

[IAM](https://console.cloud.google.com/iam-admin/iam)에서 **액세스 권한 부여**를 누르고, 새 주 구성원에 회사 계정 이메일을 넣은 뒤 역할을 **기본 → 편집자**로 지정해 저장합니다.

## 4. 회사 계정으로 전환해 Chat 앱 구성

콘솔 오른쪽 위 계정 메뉴에서 **회사 계정으로 전환**하고 같은 프로젝트를 선택한 뒤 [Chat API 구성(Configuration)](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat) 탭을 엽니다.

- **앱 이름·아바타 URL·설명**: 자유롭게 입력합니다. 앱 이름은 mailman이 보낸 메시지의 발신자 옆에 표시됩니다.
- **"Google Workspace 부가기능으로 빌드" 체크박스는 해제하지 마세요.** 한 번 바꾸면 되돌릴 수 없습니다.
- **부가기능 트리거 URL**이 필수로 요구되면 "모든 트리거에 공통 HTTP 엔드포인트 URL 사용"을 고르고 자리표시 URL 하나(예: `https://example.invalid/mailman`)를 넣습니다. mailman은 Chat 이벤트를 받지 않으므로 이 URL은 쓰이지 않습니다. 본인이 관리하지 않는 실제 서버 주소는 넣지 마세요.
- **공개 상태(Visibility)**: "도메인의 특정 사용자 및 그룹이 사용할 수 있도록 설정"을 고르고 **본인 회사 이메일만** 넣습니다.

저장합니다.

## 5. 앱 브랜딩

[Google Auth Platform → 브랜딩](https://console.cloud.google.com/auth/branding)을 엽니다. 지원 이메일 목록에는 현재 콘솔에 로그인한 계정의 메일만 나오므로, 개인 메일을 고르려면 **개인 계정으로 다시 전환**해 진행합니다.

- **앱 이름**: 4단계와 같은 이름을 권장합니다.
- **사용자 지원 이메일**·**개발자 연락처 정보**: 개인 메일
- **애플리케이션 홈페이지**: `https://thewronghand-bigs.github.io/mailman/`
- **개인정보처리방침 링크**: `https://thewronghand-bigs.github.io/mailman/privacy`
- **승인된 도메인**: `thewronghand-bigs.github.io`
- **로고는 올리지 마세요.** 로고를 올리면 브랜딩 검증 대상이 됩니다.

## 6. 대상(Audience)에서 앱 게시

[대상(Audience)](https://console.cloud.google.com/auth/audience)에서 사용자 유형이 **외부**인지 확인하고 **앱 게시**를 눌러 게시 상태를 **프로덕션**으로 바꿉니다.

**테스트** 상태로 두면 refresh token이 7일 뒤 만료되어 매주 다시 로그인해야 합니다. 검증을 받지 않은 프로덕션 앱이어도 본인 사용에는 문제가 없으며, 로그인 때 "확인되지 않은 앱" 경고가 표시됩니다(8단계).

## 7. 데스크톱 앱 클라이언트 만들기

[클라이언트](https://console.cloud.google.com/auth/clients)에서 **클라이언트 만들기**를 누르고 애플리케이션 유형을 **데스크톱 앱**으로 고릅니다. 만든 직후 나오는 창에서 **JSON 다운로드**를 눌러 `client_secret_....json` 파일을 받습니다. 나중에는 secret을 다시 내려받지 못할 수 있으니 이때 받아 두세요.

웹 애플리케이션 유형 클라이언트는 쓸 수 없습니다. 파일 안이 `{"installed": {...}}` 형태여야 합니다. 이 파일은 비밀값이므로 다른 사람과 공유하거나 커밋하지 마세요.

## 8. mailman 로그인

```bash
~/.claude/bin/mailman auth --client ~/Downloads/client_secret_XXXX.json
```

mailman이 파일을 검증해 `~/.claude/secrets/mailman-oauth.json`에 0600 권한으로 복사한 뒤 브라우저를 엽니다. 이후 다시 로그인할 때는 `--client` 없이 `mailman auth`만 실행하면 됩니다.

1. **회사 계정**을 고릅니다.
2. "Google에서 확인하지 않은 앱" 경고가 나오면 **고급 → (앱 이름)(으)로 이동(안전하지 않음)**을 누릅니다. 본인이 만든 클라이언트이므로 괜찮습니다.
3. 요청 권한을 확인하고 동의합니다. 기존 필수 권한 4개+openid에 선택 리액션 권한이 추가됩니다.
4. 터미널에 `✅ 인증 완료`와 이메일·허용 스코프가 나오면 끝입니다. 브라우저 탭은 닫아도 됩니다.

요청 스코프 목록:

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/chat.spaces.readonly`
- `https://www.googleapis.com/auth/chat.messages.readonly`
- `https://www.googleapis.com/auth/chat.messages.create`
- `https://www.googleapis.com/auth/chat.messages.reactions.create` (선택)

**v2.2 기존 사용자는 리액션을 사용하려면 `mailman auth`를 다시 실행해 새 권한에 동의해야 합니다.** 기존 5개 필수 스코프만 가진 토큰도 조회·전송·대기는 정상 동작합니다. `react`만 exit 2와 재인증 안내를 냅니다. 업로드 첨부 다운로드는 기존 읽기 스코프를 사용하며, 403이면 필요한 스코프를 확인한 뒤 재인증하세요. 앱은 다른 스코프를 추측해 추가하지 않습니다.

## 9. 스페이스 등록

ID를 직접 찾지 않아도 됩니다. 내 방 목록에서 이름을 확인하고 조회합니다.

```bash
~/.claude/bin/mailman spaces
~/.claude/bin/mailman spaces '개발 팀' --refresh
~/.claude/bin/mailman fetch '개발 팀' --save dev
~/.claude/bin/mailman fetch --dm colleague@example.test --save colleague
```

표시 이름은 대소문자·공백을 무시한 정확 일치를 먼저, 없으면 부분 일치를 사용합니다. 후보가 여러 개면 이름·종류·ID 목록을 보고 하나를 선택하세요. `--dm`은 이메일·users/ID 또는 수집된 발신자 이름으로 기존 1:1 DM만 찾습니다. 이름이 없거나 동명이인이면 이메일을 쓰세요. `--save`를 생략하면 설정을 바꾸지 않고 이번 호출에서만 사용합니다.

`--save`는 기존 별칭을 덮어쓰지 않습니다. 설치 예시의 `team` 대신 새 별칭 `dev`를 저장한 뒤, 기본 방으로 쓰려면 `~/.claude/mailman/config.json`의 `defaultSpace`를 `dev`로 바꿉니다. 다른 설정과 웹훅은 보존되며 파일은 0600으로 원자 저장됩니다. 수동 작성 형식은 다음과 같습니다.

```json
{
  "defaultSpace": "team",
  "sendTag": true,
  "spaces": {
    "team": { "space": "spaces/SPACE_ID", "webhookUrl": "" },
    "dev": { "space": "spaces/OTHER_SPACE_ID" }
  }
}
```

- `defaultSpace`는 별칭을 생략했을 때 쓰는 스페이스입니다.
- `sendTag`(선택, 기본 `true`)를 `false`로 두면 `mailman send`가 본문 앞에 `[🤖 AI]`류 태그를 붙이지 않습니다.
- `webhookUrl`은 선택 사항이며 카드 메시지 전송에만 씁니다. 값이 비밀이므로 이 파일도 공유하지 마세요.
- 설정 파일 위치는 `MAILMAN_CONFIG` 환경 변수로 바꿀 수 있습니다.

확인:

```bash
~/.claude/bin/mailman fetch dev
```

Claude Code에서는 `/mailman dev`로 같은 내용을 봅니다. 승인한 질문을 보낼 때 `send --wait`로 답장을 모아 기다릴 수 있습니다(`--timeout` 최대 2h). 답장이 없으면 exit 4입니다. `send --wait`가 exit 5면 전송은 완료됐고 대기만 실패·중단된 것이므로 재전송하지 마세요. 전송 요청 중 중단은 Chat에서 전송 여부를 먼저 확인하세요. 이메일 `--from`은 기존 DM의 수집 기록 또는 최근 메시지로 상대 ID를 전송 전에 확정해야 합니다. DM이 없거나 확정할 수 없으면 수집된 정확한 이름이나 users/ID를 쓰세요. `--dry-run --save`는 저장할 예정만 표시하고 설정을 바꾸지 않습니다.

## 문제 해결

| 증상 | 확인 |
|------|------|
| `OAuth 클라이언트 파일이 없습니다` (exit 2) | `mailman auth --client <다운로드한 JSON>` |
| `{"installed": ...} 형식이어야 합니다` | 7단계에서 **데스크톱 앱** 유형으로 다시 만듭니다 |
| 로그인 화면에서 "액세스 차단됨" | Workspace 관리자의 서드파티 앱 정책 확인 |
| 7일마다 다시 로그인해야 함 | 6단계에서 앱을 프로덕션으로 게시 |
| `invalid_grant` (exit 3) | `mailman auth`로 다시 로그인 |
| 리액션 권한 없음 (exit 2) | `mailman auth` 재실행 후 선택 리액션 권한 동의 |
| HTTP 403/404 | 스페이스 멤버 여부, Chat API 사용 설정, 4단계 Chat 앱 구성·공개 상태 확인 |

[mailman 홈](index.md) · [개인정보처리방침](privacy.md)
