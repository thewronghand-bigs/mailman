---
title: 설정 가이드 — 처음 시작하기
permalink: /setup
---

# mailman 설정 가이드

## 시작 경로 고르기

Mac에 mailman을 [설치](https://github.com/thewronghand/mailman/blob/main/INSTALL.md)한 뒤, 상황에 맞는 경로로 시작하세요.

| 경로 | 시작 단계 | 예상 시간 |
|------|-----------|-----------|
| **A. 이미 mailman을 설정한 동료에게 클라이언트 JSON을 받은 경우** | **[8단계부터](#step-8)** — 받은 JSON으로 `mailman auth --client` 실행 | **약 5분** |
| **B. 처음부터 혼자 설정하는 경우** | **[1단계부터](#step-1)** — 프로젝트 만들기부터 진행 | **약 20분** |

**A 경로**는 동료 프로젝트의 Chat 앱 구성·브랜딩·프로덕션 게시가 끝나 있으므로 **1~7단계가 필요 없습니다.** 받은 JSON과 본인 회사 Google Workspace 계정으로 인증하면 됩니다. **동료 프로젝트의 IAM 멤버일 필요도 없습니다.** 설정을 마친 사람이 JSON을 발급하는 방법은 [동료에게 클라이언트 만들어 주기](#colleague-client)를 참고하세요.

첫 DM을 이름으로 찾는 v2.4 기능도 **프로젝트 소유자가 People API 사용 설정과 두 스코프 추가를 한 번만** 마치면 됩니다. 동료마다 콘솔 설정이나 프로젝트를 새로 만들 필요 없이 각자 `mailman auth`로 권한을 허용합니다. 기존 프로젝트라면 [업그레이드 안내](#upgrade-v2-4)를 먼저 확인하세요.

**B 경로 준비물: 개인 Google 계정(Gmail), 회사 Google Workspace 계정, 약 20분.** Google Cloud를 처음 써도 아래 순서대로 진행하면 됩니다.

회사 계정은 보통 Google Cloud 프로젝트를 만들 수 없어, 개인 계정으로 프로젝트를 만듭니다.<br>
Chat 앱 구성은 Google Workspace 계정으로만 할 수 있어, 회사 계정을 그 프로젝트에 초대합니다.<br>
프로젝트·OAuth 설정은 개인 계정으로 마치고, 회사 계정으로 한 번 전환해 Chat 앱을 구성한 뒤 로그인합니다.

OAuth 클라이언트는 본인 프로젝트에서 만들거나, 설정을 마친 동료의 프로젝트에서 **사람마다 따로 발급**받습니다. 각자 회사 계정으로 로그인하며 토큰을 공유하지 않습니다. 실행 파일·레포·릴리스에는 client id/secret이 들어 있지 않습니다.

아래는 전체 단계입니다. A 경로는 8단계부터 진행하세요.

| 단계 | 사용할 계정 | 할 일 |
|------|-------------|-------|
| [1](#step-1) | 개인 | 프로젝트 만들기·프로젝트 ID 메모 |
| [2](#step-2) | 개인 | Google Chat API·People API 사용 설정 |
| [3](#step-3) | 개인 | Chat 앱을 구성할 본인 회사 계정을 프로젝트 편집자로 추가 |
| [4](#step-4) | 개인 | 앱 브랜딩·동의 화면·데이터 액세스 스코프 설정 |
| [5](#step-5) | 개인 | 프로덕션 게시 또는 테스트 사용자 등록 |
| [6](#step-6) | 개인 | 데스크톱 앱 OAuth 클라이언트 JSON 다운로드 |
| [7](#step-7) | 회사 | Chat 앱 구성·저장 |
| [8](#step-8) | 터미널 → 회사 | mailman 인증 |
| [9](#step-9) | 터미널 | `mailman doctor`로 점검 |
| [10](#step-10) | 터미널·Claude Code·Codex | 방 찾기·별칭 저장·첫 조회 |

> **팁:** 브라우저 프로필을 개인/회사로 나눠 두면 편합니다. 아래 콘솔 주소의 `<PROJECT_ID>`는 1단계에서 메모한 값으로 바꿔 주소 표시줄에 붙여넣으세요. 모든 단계에서 콘솔 상단의 프로젝트와 오른쪽 위 로그인 계정을 확인합니다.

## 1~6단계 — 개인 계정

여기부터 6단계까지는 **개인 Gmail 계정**으로 진행합니다.

처음 콘솔에 들어가면 **Google Cloud 약관 동의**와 **무료 체험(결제 정보 입력)** 안내가 뜰 수 있습니다. **약관만 동의하고 무료 체험·결제 등록은 하지 않습니다.** mailman에는 결제 계정이 필요 없습니다([비용과 할당량](#비용과-할당량)).

<a id="step-1"></a>

### [개인 계정] 1. 프로젝트 만들기

1. [새 프로젝트 만들기](https://console.cloud.google.com/projectcreate)를 엽니다.
2. 프로젝트 이름을 입력합니다. 예: `mailman`.
3. **만들기**를 누른 뒤, 만든 프로젝트를 선택합니다.
4. **프로젝트 ID**를 메모합니다. 프로젝트 이름이나 프로젝트 번호가 아니라 **ID**입니다. 이후 주소의 `<PROJECT_ID>`에 이 값을 넣습니다.

<a id="step-2"></a>

### [개인 계정] 2. Google Chat API·People API 사용 설정

다음 주소를 엽니다.

```text
https://console.cloud.google.com/apis/library/chat.googleapis.com?project=<PROJECT_ID>
```

**사용 설정**을 누릅니다. 이미 사용 설정되어 있다면 다음 단계로 넘어갑니다.

회사 디렉터리에서 사람 이름·이메일을 찾으려면 같은 프로젝트의 **People API도 사용 설정**합니다.

```text
https://console.cloud.google.com/apis/library/people.googleapis.com?project=<PROJECT_ID>
```

디렉터리 검색 권한을 허용했어도 이 API가 꺼져 있으면 `SERVICE_DISABLED`가 발생합니다. 프로젝트 단위 설정이므로 동료용 클라이언트를 여러 개 발급해도 한 번만 하면 됩니다.

<a id="step-3"></a>

### [개인 계정] 3. 회사 계정을 편집자로 추가

```text
https://console.cloud.google.com/iam-admin/iam?project=<PROJECT_ID>
```

1. **액세스 권한 부여**를 누릅니다.
2. 새 주 구성원에 **본인 회사 이메일**을 입력합니다.
3. 역할에서 **기본 → 편집자**를 고르고 저장합니다.

소유자 역할은 초대 수락 절차가 있어 번거롭습니다. 이 설정에는 편집자 역할을 사용합니다. 아직 회사 계정으로 전환하지 않습니다. 이 권한은 **7단계에서 Chat 앱을 구성할 본인 회사 계정**에 주는 것입니다. 이미 구성된 앱을 사용하는 동료는 IAM에 추가하지 않습니다.

<a id="step-4"></a>

### [개인 계정] 4. 브랜딩·동의 화면 설정

```text
https://console.cloud.google.com/auth/branding?project=<PROJECT_ID>
```

처음에는 **시작하기** 마법사가 나옵니다. 아래 내용을 차례로 입력합니다.

| 항목 | 입력·선택할 값 |
|------|----------------|
| 앱 이름 | `mailman` |
| 사용자 지원 이메일 | 본인 개인 Gmail |
| 대상 | **외부(External)** |
| 연락처 이메일 | 본인 개인 Gmail |
| Google API 서비스 사용자 데이터 정책 동의 | 내용을 확인하고 동의 |

완료 후 **브랜딩** 페이지에서 다음 항목도 입력하고 저장합니다.

| 항목 | 입력·선택할 값 |
|------|----------------|
| 애플리케이션 홈페이지 | `https://thewronghand.github.io/mailman/` |
| 개인정보처리방침 | `https://thewronghand.github.io/mailman/privacy` |
| 서비스 약관(Terms of Service) 링크 | **비워 둡니다** |
| 승인된 도메인 | `thewronghand.github.io` |
| 앱 로고 | **올리지 않습니다** |

**로고를 올리면 Google 브랜딩 검증 대상이 되어 게시가 막힐 수 있습니다.** 로고 없이 진행하세요. 아래 5단계의 테스트 모드로 먼저 써 볼 때는 홈페이지·개인정보처리방침 URL 입력을 생략할 수 있습니다.

#### 데이터 액세스 — OAuth 스코프 추가

같은 프로젝트의 **Google Auth Platform → 데이터 액세스**에서 **범위 추가 또는 삭제**를 열어 다음 스코프를 추가하고 저장합니다. 검색에 나오지 않으면 전체 URL을 직접 입력합니다.

```text
https://console.cloud.google.com/auth/scopes?project=<PROJECT_ID>
```

| 스코프 | 용도 |
|--------|------|
| `openid` | 계정 식별 |
| `https://www.googleapis.com/auth/userinfo.email` | 이메일 확인 |
| `https://www.googleapis.com/auth/chat.spaces.readonly` | 방 목록·기존 DM 찾기 |
| `https://www.googleapis.com/auth/chat.messages.readonly` | 메시지·첨부 읽기 |
| `https://www.googleapis.com/auth/chat.messages.create` | 승인된 메시지·첨부 전송 |
| `https://www.googleapis.com/auth/chat.messages.reactions.create` | 리액션 (선택) |
| `https://www.googleapis.com/auth/directory.readonly` | 회사 디렉터리 이름·이메일 검색 (v2.4 선택) |
| `https://www.googleapis.com/auth/chat.spaces.create` | 첫 DM 생성, 이름 있는 스페이스 생성·멤버 초대 (v2.4 선택) |

기존 필수 권한은 앞의 다섯 개입니다. 선택 스코프가 없어도 기존 조회·전송은 동작하며, 필요한 기능을 쓸 때만 재인증을 안내합니다. 이 콘솔 설정도 프로젝트 소유자가 한 번만 합니다.

<a id="step-5"></a>

### [개인 계정] 5. 프로덕션으로 게시

```text
https://console.cloud.google.com/auth/audience?project=<PROJECT_ID>
```

1. 대상이 **외부(External)**인지 확인합니다.
2. **앱 게시**를 누르고 확인합니다.
3. 게시 상태가 **프로덕션 단계**로 바뀌면 완료입니다.

**“인증을 위해 제출해야 합니다” / “앱을 인증해야 합니다” 안내가 떠도 제출하지 않습니다.** 민감 범위를 사용하는 미검증 앱에 표시되는 안내입니다. 이 개인 사용 설정에서는 게시 상태가 프로덕션 단계인지 확인하면 됩니다. 로그인할 때는 미검증 앱 경고가 나올 수 있으며, 8단계에서 진행합니다.

#### 간이 경로 — 빨리 써 보고 싶을 때

게시 대신 같은 페이지의 **테스트 사용자**에 **본인 회사 이메일**을 추가하고 저장해도 됩니다. 이때는 4단계의 홈페이지·개인정보처리방침 URL을 생략할 수 있습니다.

단, 테스트 모드에서는 refresh token이 **7일 뒤 만료**되어 `mailman auth`를 다시 실행해야 합니다. 계속 쓸 때는 4단계 URL을 채우고 프로덕션으로 게시한 뒤 다시 인증하세요. `doctor`는 게시 상태를 직접 읽지 못하며, 만료된 로그인에 대해 이 경로를 안내합니다.

<a id="step-6"></a>

### [개인 계정] 6. 데스크톱 앱 OAuth 클라이언트 만들기

```text
https://console.cloud.google.com/auth/clients/create?project=<PROJECT_ID>
```

1. 애플리케이션 유형을 **데스크톱 앱**으로 고릅니다. **웹 애플리케이션을 고르면 안 됩니다.**
2. 이름을 입력하고 **만들기**를 누릅니다.
3. **만든 직후** 생성 완료 창에서 **JSON 다운로드**를 눌러 파일을 받습니다. 이후 secret을 다시 볼 수 없는 경우가 있으므로 바로 다운로드하세요. 8단계에서 이 파일을 사용합니다.

파일은 `{"installed": {...}}` 형태여야 합니다. **JSON을 비밀번호처럼 다루고 Git에 커밋하지 않습니다.** 본인용 JSON이나 로그인 토큰을 돌려 쓰지 마세요. 동료에게는 [별도 클라이언트를 발급](#colleague-client)합니다.

## 7단계 — 회사 계정

개인 계정 작업은 끝났습니다. 이제 **회사 Google Workspace 계정으로 한 번 전환**합니다.

<a id="step-7"></a>

### [회사 계정] 7. Chat 앱 구성

콘솔 오른쪽 위에서 회사 계정으로 전환하거나, 회사 브라우저 프로필에서 다음 주소를 엽니다.

```text
https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=<PROJECT_ID>
```

프로젝트 선택기에 프로젝트가 안 보이면 **조직** 드롭다운을 **조직 없음**으로 바꾸세요. 개인 계정이 만든 프로젝트라 회사 조직 아래에 표시되지 않을 수 있습니다.

**확인 포인트:** 상단에 **“Google Chat API는 Google Workspace 사용자에게만 제공됩니다”** 문구가 없고, 입력칸이 활성화되어 있어야 합니다. 여전히 잠겨 있다면 개인 계정으로 보고 있는지 확인하고 회사 계정으로 다시 여세요.

| 항목 | 입력·선택할 값 |
|------|----------------|
| 앱 이름 | `mailman` — 영숫자 25자 이내 |
| 아바타 URL | `https://developers.google.com/chat/images/quickstart-app-avatar.png` |
| 설명 | 예: `mailman inbox reader` — 40자 이내 |
| Build this Chat app as a Workspace add-on | **체크 상태를 유지합니다. 해제하지 마세요. 되돌릴 수 없습니다.** |
| Enable Interactive features(대화형 기능) | **끈 상태로 둡니다.** mailman은 메시지를 폴링하므로 대화형 기능이 필요 없습니다. |
| Markup syntax | **기본값 `MARKDOWN`을 바꾸지 않습니다.** mailman의 전송 서식 안내는 이 설정 기준입니다. |
| 공개 범위(Visibility) | **대화형 기능이 꺼져 있으면 해당 없음.** 입력칸이 나오지 않습니다. |

**대화형 기능을 꺼 두면 트리거 URL·공개 범위(Visibility) 입력칸 자체가 나오지 않습니다.** 위 내용을 입력하고 **저장**하세요. 앱 상태가 **LIVE - available to users**이면 정상입니다. 저장까지 끝내야 `Google Chat app not found` 오류를 피할 수 있습니다.

> **예외 — 대화형 기능을 끌 수 없는 경우에만:** 트리거별 HTTP 엔드포인트 URL은 **모든 트리거에 공통 URL** 옵션에 `https://example.com/mailman`을 자리표시로 입력합니다. mailman은 이 주소를 호출하지 않습니다. 이때 표시되는 공개 범위는 특정 사용자 및 그룹으로 제한하고 **본인 회사 이메일만** 입력합니다.

## 8~10단계 — 터미널

<a id="step-8"></a>

### [터미널 → 회사 계정] 8. mailman 인증

Mac 터미널에서 실행합니다. 파일명은 **동료에게 받은 JSON** 또는 **6단계에서 내려받은 JSON**의 실제 이름으로 바꾸세요. A 경로는 여기서부터 시작합니다.

```bash
~/.claude/bin/mailman auth --client ~/Downloads/client_secret_XXXX.json
```

1. 열린 브라우저에서 **회사 계정**을 선택합니다. 프로젝트를 만든 개인 계정이 아닙니다.
2. **“Google에서 확인하지 않은 앱” / “Google hasn't verified this app”** 화면이 나오면 **고급(Advanced)** → **mailman(으)로 이동(Go to mailman)**을 누릅니다. 앱 이름을 다르게 정했다면 그 이름이 표시됩니다.
3. 요청하는 권한을 **모두 허용**합니다.
4. 터미널에 **`✅ 인증 완료`와 회사 이메일·허용 스코프**가 나오면 성공입니다. 브라우저 탭을 닫아도 됩니다.

클라이언트 파일과 토큰은 각각 기본 `~/.claude/secrets/mailman-oauth.json`, `~/.claude/secrets/mailman-token.json`에 0600 권한으로 저장됩니다. 인증 대기는 최대 5분입니다. 이후 재로그인할 때는 `~/.claude/bin/mailman auth`만 실행합니다.

**`auth --client`가 성공하면 다운로드 폴더의 원본 JSON은 삭제하는 것을 권장합니다.** A 경로로 동료에게 받은 파일도 같습니다. 등록된 클라이언트 파일은 위 경로에 보관됩니다.

권한은 `openid`, 이메일 확인, 스페이스 읽기, 메시지 읽기·생성, 리액션 생성, 회사 디렉터리 검색, DM 생성의 여덟 가지입니다. 마지막 세 권한은 선택이며, 없는 기존 토큰도 나머지 기능은 동작합니다. 새 사람 이름 검색과 첫 DM 생성에는 해당 선택 권한을 허용하세요.

`admin_policy_enforced`로 막히면 회사 Google Workspace 관리자 정책입니다. 관리자에게 앱 접근 허용을 문의하세요. `doctor`가 Google Cloud 설정이나 관리자 정책을 바꾸지는 않습니다.

<a id="step-9"></a>

### [터미널] 9. 설정 점검

```bash
~/.claude/bin/mailman doctor
```

버전과 파일 경로·0600 권한, 설정 JSON, 데스크톱 클라이언트, 토큰·스코프, 토큰 갱신, Chat API 접근을 순서대로 점검합니다. 파일 내용·토큰·secret·클라이언트 ID 전체·웹훅 URL은 출력하지 않습니다. 설정·파일 권한·DB를 자동 수정하지 않으며, Chat API는 스페이스 1건만 조회합니다.

디렉터리 검색·DM 생성 스코프 유무도 표시합니다. 디렉터리 스코프가 있으면 본인 이메일 앞부분으로 People API를 pageSize=1로 한 번 확인합니다. 선택 기능의 API 실패는 경고로만 표시하고 전체 실패로 만들지 않습니다.

- **✅**: 해당 점검 통과. 모두 ✅면 완료입니다.
- **⚠️**: 확인할 사항. 설정 파일·기본 방이 없어도 명시 대상(--dm·방 이름)은 설정 없이 동작합니다. 선택 스코프나 People API 설정이 빠져 있으면 필요한 기능에 대해서만 안내합니다.
- **❌**: 실패. 해당 줄의 **“해결: 설정 가이드 N단계”** 링크로 이동해 수정한 뒤 다시 실행합니다.
- **건너뜀**: 앞 단계가 실패해 실행할 수 없는 점검입니다. 클라이언트·토큰을 먼저 고쳐야 토큰 갱신과 Chat API 점검을 합니다. 설정 파일 오류는 독립적인 인증 점검을 막지 않습니다.

실패가 하나라도 있으면 종료 코드 1, 경고만 있으면 0입니다. 브라우저에서만 볼 수 있는 동의 화면·게시 상태는 직접 진단할 수 없습니다. 그 경우 아래 표의 화면 증상과 함께 확인하세요.

네트워크 연결 실패라면 인터넷·프록시·방화벽을 확인합니다. Claude Code·Codex에서만 실패하면 해당 실행 환경의 경로·네트워크 권한도 확인하세요([설치 문서](https://github.com/thewronghand/mailman/blob/main/INSTALL.md#codex)).

<a id="step-10"></a>

### [터미널·Claude Code·Codex] 10. 방 찾기와 첫 사용

이하 `mailman`은 `~/.claude/bin/mailman`의 줄임말입니다. PATH에 없다면 전체 경로로 실행하세요.

처음 보내는 사람에게도 이름만으로 DM을 보낼 수 있습니다. **config 파일이나 방 등록은 필요 없습니다.** 수신자·본문을 확인한 뒤 실행하세요.

```bash
mailman send --dm '사람 이름' --agent codex --dry-run < 본문.txt
mailman send --dm '사람 이름' --agent codex < 본문.txt
mailman people                 # 확정해 등록한 사람 목록
mailman people --forget users/100001
```

미리보기는 DM 생성·사람 등록을 하지 않습니다. 실제 전송에서는 로컬 등록부 → 수집 발신자 → 회사 디렉터리 순서로 찾고, 기존 DM이 없으면 만듭니다. 동명이인은 이메일·ID 후보로 구분하며 임의로 고르지 않습니다. 조회·수집·대기는 없는 DM을 만들지 않습니다.

기본 방으로 조회하려면 다음처럼 별칭을 저장합니다.

```bash
mailman spaces '검색어'
mailman spaces '정확한 방 표시 이름' --save dev
mailman fetch dev
```

첫 명령으로 방 이름을 찾고, 두 번째 명령으로 **새 별칭** `dev`를 저장한 뒤 조회합니다. 설치기는 설정 파일을 만들지 않습니다. **처음 저장한 별칭이 기본 방**이 되며, 첫 `--save`가 설정 파일을 0600 권한으로 만듭니다. 설정 파일을 직접 편집할 필요가 없습니다. 후보가 여러 개면 출력된 이름으로 범위를 좁히세요. ID를 직접 찾거나 입력할 필요가 없습니다. `fetch '표시 이름' --save dev`로 조회하면서 저장해도 됩니다.

**기본 방을 바꾸려면 `--save <별칭> --default`를 사용합니다.** 새 방을 저장하면서 기본으로 정하거나, 이미 저장한 별칭의 기본 지정만 바꿀 수 있습니다.

```bash
mailman spaces '다른 방 표시 이름' --save team --default
mailman spaces --save dev --default   # 기존 dev를 기본 방으로 변경
```

`--save`는 기존 별칭의 `space` 값을 덮어쓰지 않습니다. 기존 별칭에 `--default`를 붙일 때도 같은 방이어야 하며, 다른 방을 저장하려면 새 별칭을 고릅니다. 이전 설치의 예시 설정(`spaces/SPACE_ID`, `spaces/AAAAxxxxxxx` 등)이 남아 있다면, 실제 방을 저장할 때 **`--default`도 붙여** 기본 방을 바꾸세요. `--save`를 빼면 등록 없이 이번 호출에서만 사용합니다.

```text
Claude Code: /mailman dev
Codex:       $mailman
```

대상을 생략한 `/mailman`·`$mailman`·`mailman fetch`는 기본 방을 조회합니다. 다른 방은 저장한 별칭을 지정하세요. 두 도구는 같은 DB와 조회 커서를 공유합니다.

설정 파일이 없거나 `defaultSpace`가 빈 문자열/생략된 경우에는 명시 대상만 지정하면 됩니다. 대상 생략 시에는 기본 방 등록을 안내합니다. 설정 JSON이 깨졌거나 비어 있지 않은 `defaultSpace`가 `spaces`에 없는 경우에는 `doctor`가 ❌를 표시합니다. 기존 설정을 보존하면서 JSON 문법과 기본 별칭의 등록 여부를 확인하세요. 인증부터 다시 할 필요는 없습니다.

<a id="upgrade-v2-4"></a>

## 기존 사용자 — v2.4 업그레이드

실행 파일을 업데이트한 뒤 새 이름 검색·첫 DM 생성을 쓰려면 다음 순서로 진행합니다. 기존 클라이언트 JSON과 메시지 DB는 그대로 사용합니다.

1. 클라이언트가 속한 프로젝트에서 [2단계](#step-2)의 **People API 사용 설정**을 합니다.
2. 같은 프로젝트의 [4단계 데이터 액세스](#step-4)에 **`https://www.googleapis.com/auth/directory.readonly`**와 **`https://www.googleapis.com/auth/chat.spaces.create`**를 추가하고 저장합니다.
3. 각 사용자 기기에서 **`mailman auth`를 다시 실행**해 새 권한을 허용합니다. `--client`는 다시 지정할 필요가 없습니다.
4. `mailman doctor`에서 두 스코프와 People API 접근을 확인합니다.

동료가 발급한 클라이언트를 쓰는 A 경로라면 **1·2번 콘솔 설정은 프로젝트 소유자가 한 번만** 합니다. 동료들은 3번 재인증만 하면 되고 IAM에 추가될 필요도 없습니다. 디렉터리에서 0명이 나오면 회사 관리자가 디렉터리 공유를 막았을 수 있으므로 이메일로 지정하거나 관리자에게 확인하세요. 새 선택 권한이 없어도 기존 DM·방의 조회와 전송은 계속 동작합니다.

<a id="colleague-client"></a>

## 동료에게 클라이언트 만들어 주기

B 경로로 설정을 마친 사람이 **프로젝트를 만든 개인 계정**으로 진행합니다. [5단계의 프로덕션 게시](#step-5)와 [7단계의 Chat 앱 구성](#step-7)이 끝나 있어야 동료가 A 경로로 바로 인증할 수 있습니다. 테스트 모드로만 써 봤다면 먼저 프로덕션으로 게시하세요.

v2.4의 이름 검색·첫 DM 생성을 함께 쓰려면 [2단계의 People API](#step-2)와 [4단계의 두 선택 스코프](#step-4)도 소유자 프로젝트에서 한 번 설정하세요. 동료마다 반복하지 않습니다.

```text
https://console.cloud.google.com/auth/clients/create?project=<PROJECT_ID>
```

1. 애플리케이션 유형을 **데스크톱 앱**으로 고릅니다.
2. 이름을 사람별로 입력합니다. 예: **`mailman-홍길동`**. 이 이름은 콘솔에서 본인만 보는 관리용 이름입니다. 상대의 동의 화면에는 브랜딩에서 정한 앱 이름 **mailman**이 보입니다.
3. **만들기**를 누르고 **만든 직후 JSON 다운로드**를 합니다. 이후 secret을 다시 볼 수 없는 경우가 있습니다.
4. JSON은 **mailman으로 보내지 말고 사내 메신저에서 직접 첨부해 DM으로 보냅니다.** 상대에게 **[8단계부터](#step-8)** 진행하라고 안내합니다. **이메일·공개 채널·레포로는 전달하지 않습니다.**
5. 전달 뒤 **본인 다운로드 폴더의 사본은 삭제하는 것을 권장**합니다. 나중에 필요하면 콘솔에서 새로 발급하세요.

**사람마다 클라이언트를 따로 만드세요.** 퇴사하거나 문제가 생겼을 때 그 사람의 클라이언트만 삭제해 접근을 끊을 수 있습니다. 여러 사람에게 같은 JSON을 돌려 쓰지 않습니다.

**동료를 IAM 편집자로 추가하지 마세요.** 편집자는 프로젝트 설정·OAuth 클라이언트·동의 화면까지 바꿀 수 있어 사용 권한으로는 과합니다. 동료에게 필요한 것은 **그 사람용 클라이언트 JSON뿐**입니다. 3단계에서 본인 회사 계정에 준 편집자 권한과 구분하세요.

알아 둘 점:

- 동료의 동의 화면에 프로젝트 소유자의 **지원·연락처 이메일(개인 메일)**이 보입니다.
- **미검증 앱의 누적 사용자 100명 한도**와 **Chat API 할당량**은 같은 프로젝트의 모든 클라이언트가 함께 씁니다. 클라이언트를 나눠도 이 한도는 늘어나지 않습니다.
- Claude/Codex 커맨드·스킬은 **자격증명 파일을 첨부하지 않고 경고하며, 이 제한은 완화할 수 없습니다.** 동료용 클라이언트 JSON도 **mailman으로 보내지 말고 사내 메신저에서 직접 첨부해 DM으로 보내세요.**

## 비용과 할당량

**Google Chat API는 사용량 과금이 없고, 분당 요청 수 같은 할당량만 있습니다. 결제 계정(빌링)은 연결할 필요가 없으며, 연결하지 않는 것을 권장합니다.** mailman은 Pub/Sub 같은 유료 서비스를 사용하지 않습니다.

한도를 넘으면 요청이 잠시 **HTTP 429**로 거절됩니다. mailman의 `wait`·`send --wait`는 **답장 조회 중** 429를 만나면 대기 간격을 늘려 재시도합니다. 전송 POST는 자동 재시도하지 않습니다.

## 자주 막히는 곳

| 증상(화면 문구·오류) | 원인 | 해결 단계 | `mailman doctor`가 이렇게 표시 |
|--------------------|------|-----------|--------------------------------|
| “Google Chat API는 Google Workspace 사용자에게만 제공됩니다”와 잠긴 입력칸 | 개인 계정으로 Chat 앱 구성 페이지를 봄 | [7단계](#step-7), 회사 계정으로 전환 | 저장이 안 된 상태에서는 `❌ Google Chat 앱 구성이 없음`일 수 있음. 브라우저의 현재 계정은 직접 확인하지 못함 |
| `Google Chat app not found` / 스페이스 목록 HTTP 404 | Chat 앱 구성이 저장되지 않음 | [7단계](#step-7) 완료 | `❌ Chat API: Google Chat 앱 구성이 없음 (Chat app not found)` |
| `has not been used in project` / `SERVICE_DISABLED` | 해당 프로젝트의 Chat API 비활성화 | [2단계](#step-2) | `❌ Chat API: Google Chat API가 사용 설정되지 않음 (SERVICE_DISABLED)` |
| 동의 화면 `access_denied`, 테스트 사용자가 아님 | 테스트 모드에 회사 이메일 미등록 또는 동의 거부 | [5단계](#step-5), 게시하거나 테스트 사용자 추가 후 [8단계](#step-8) | 인증 전이면 `❌ 토큰: 토큰 파일이 없음`. 갱신 응답이 `access_denied`면 `❌ 인증 접근이 거부됨` |
| 게시할 때 홈페이지·개인정보처리방침 필요 | 브랜딩 URL 미입력 | [4단계](#step-4) 입력 후 [5단계](#step-5) | 브랜딩 자체는 진단하지 못함. 로그인 미완료면 `❌ 토큰: 토큰 파일이 없음`, 기존 유효 토큰이면 ✅일 수도 있음 |
| “Google에서 확인하지 않은 앱” / “Google hasn't verified this app” | 미검증 앱에 표시되는 정상 경고 | [8단계](#step-8), 고급 → mailman으로 이동 | 인증 전이면 토큰 없음, 인증 후에는 `✅ 토큰 갱신: 성공`과 `✅ Chat API` |
| `admin_policy_enforced` / 관리자 정책 차단 | 회사 Workspace의 서드파티 앱 제한 | [8단계](#step-8), Workspace 관리자 문의 | 인증 전이면 토큰 없음. 갱신/API 응답에서 정책을 확인하면 `❌ 관리자 정책으로 차단됨` |
| 7일마다 로그인 풀림 / `invalid_grant` | 테스트 모드의 7일 토큰 만료일 수 있음. 권한 철회 등도 가능 | [5단계](#step-5) 게시 후 [8단계](#step-8) 재인증 | `❌ 토큰 갱신: 로그인이 만료됨 — 7일 만료(테스트 모드)였다면…` |
| 클라이언트 유형 오류 / `web` JSON | 웹 애플리케이션 유형으로 생성 | [6단계](#step-6), 데스크톱 앱으로 다시 만들어 [8단계](#step-8)에서 등록 | `❌ 클라이언트 파일: web(웹 애플리케이션) 유형은 사용할 수 없습니다` |
| 클라이언트 파일 없음 | JSON 다운로드 또는 등록 전 | 받은 JSON이 있으면 [8단계](#step-8)의 `auth --client`, 처음 설정한다면 [6단계](#step-6) | `❌ 클라이언트 파일 없음 — 받은 JSON이 있으면 8단계…` |
| `invalid_client` / `deleted_client` / `unauthorized_client` | 사용하던 OAuth 클라이언트가 삭제·비활성화됨 | 클라이언트를 준 사람에게 새 JSON을 받거나 [6단계](#step-6)에서 직접 만든 뒤 [8단계](#step-8)의 `auth --client`로 등록 | `❌ 토큰 갱신: 이 OAuth 클라이언트가 삭제·비활성화됨` |
| 설정 파일 없음 / 예시 설정이 남음 | 기본 방 미등록 | [10단계](#step-10), 실제 방을 `--save`로 등록. 기존 예시 설정은 `--default`도 지정 | `⚠️ 설정 파일: 아직 기본 방이 없습니다` |
| 필수 스코프 누락 / HTTP 401 | 권한 동의 누락 또는 인증 거부 | [8단계](#step-8), `mailman auth` 재실행 | `❌ 토큰: 필수 스코프가 부족함` 또는 `❌ 인증이 거부됨 (HTTP 401)` |
| 리액션 권한 없음 | 기존 토큰에 선택 스코프 없음 | 리액션을 쓸 때 [8단계](#step-8) 재인증 | `⚠️ 리액션 스코프 없음 — react만 불가` |
| People API `SERVICE_DISABLED` | People API 사용 설정 안 됨 | 소유자가 [2단계](#step-2) 설정 | `⚠️ People API (선택): … People API 사용 설정이 필요합니다` |
| 디렉터리 검색·DM 생성 권한 없음 | 기존 토큰에 새 선택 스코프 없음 | [v2.4 업그레이드](#upgrade-v2-4) 후 `mailman auth` | 해당 선택 스코프 없음 경고, 나머지 기능은 정상 |
| 연결 오류·시간 초과 | 인터넷·프록시·방화벽·실행 환경 권한 | [9단계](#step-9) | `❌ 네트워크 연결 실패`, 갱신 실패 뒤 Chat API는 `건너뜀` |

[mailman 홈](index.md) · [개인정보처리방침](privacy.md)
