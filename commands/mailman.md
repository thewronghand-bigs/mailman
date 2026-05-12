---
description: Google Chat에서 수집한 최신 메시지(API 스펙 등) 가져오기 (가벼운 스캔)
argument-hint: "[스페이스] [봇별칭] [개수=5]  예: 인준 3 / tn 희조봇 3"
allowed-tools: Bash(~/.claude/scripts/mailman/run.sh:*), Bash(~/.claude/scripts/mailman/fetch.sh:*), Bash(~/.claude/scripts/mailman/send.sh:*)
---

!`~/.claude/scripts/mailman/fetch.sh $ARGUMENTS`

위는 구글챗 DM에서 mailman이 수집한 최근 메시지입니다.
작업 중인 티켓과 관련된 API 스펙이 있다면 타입 정의와 요청 작성에 활용하세요.

## 동작 모드

- **`/mailman` (기본 — 가벼운 스캔)**: 채팅방을 위로 끌어올리지 않고 현재 viewport에 보이는 스레드만 수집한다. reply가 달린 스레드는 **최근 10개까지** 펼쳐서 답글 본문을 함께 가져온다. 빠르고 부담 적음.
- **`/mailman-deep` (무거운 스캔)**: 채팅방을 끝까지 위로 스크롤해 과거 스레드를 lazy-load 하고, reply 달린 **모든 스레드**를 펼쳐 답글까지 수집한다. 채팅방을 처음 인덱싱하거나 한참 동안 안 가져왔을 때만 사용.

## 수집 대상

기본 수집 대상은 두 종류다:

1. **봇 메시지 전부** — 채팅방에 등장하는 모든 봇(`data-member-id="user/bot/..."`) 메시지는 이름 매칭 없이 자동 수집한다 (예: Codex, 미래봇 등).
2. **사람 메시지 중 `@mailman` 마커 붙은 것** — 사람 발신자(개인 계정)는 채팅방에 잡담도 많이 섞이므로, 본문 **첫 줄이 `@mailman` 으로 시작**해야만 수집한다 (대소문자 무시).
   - 예: 최미래님이 본인 계정에서 API 스펙을 공유할 때 `@mailman API 스펙 변경...` 식으로 첫 줄에 마커를 붙임.
   - 저장 시 마커는 떼고 본문만 남는다.

사용자가 "특정 발신자 메시지만 보여줘" 같이 요청하면 `/mailman` 결과에서 발신자 기준으로 필터링해서 보여주면 된다.

## 스페이스 별칭

- `tn` — MONIFY / TN 그룹 DM (기본)
- `인준` — 송인준 개인 DM

스페이스를 생략하면 기본 스페이스(tn)에서 가져옵니다.

## 작업 완료 시 Google Chat 전송 (승인 필수)

이 `/mailman` 세션에서 가져온 API 스펙을 바탕으로 실제 구현/수정 작업을 진행했고,
그 작업이 완료된 시점에 다음을 수행하라:

1. **요약 초안 작성** — 아래 포맷으로 간결하게 작성:
   ```
   [작업 완료 알림]
   도메인: {파악된 경우}
   변경 요약:
   - {핵심 변경 1}
   - {핵심 변경 2}
   변경 파일:
   - path/to/file1
   - path/to/file2
   남은 이슈/질문: {있는 경우만, 없으면 "없음"}
   ```
   5~10줄 이내. 불필요한 수식어 금지.

2. **사용자 승인 요청** — 초안을 출력한 뒤 "이 내용으로 Google Chat에 전송할까요?" 라고 묻는다.
   승인 전에는 절대 전송하지 않는다. 수정 요청 시 반영 후 재승인 요청.

3. **전송 실행** — 승인되면, 메시지를 가져온 스페이스로 전송:
   ```
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh [스페이스별칭]
   [초안 내용]
   MAILMAN_EOF
   ```
   `✅ 전송 완료` 확인 후 사용자에게 보고. 실패 시 재시도하지 않고 알린다.

## 카드(Cards v2) 형식으로 보내기

작업 완료 알림처럼 **시각적으로 강조가 필요한 메시지**는 일반 텍스트 대신 Google Chat Cards v2 형식을 쓴다.
헤더 이미지(GIF 포함) + 섹션별 라벨/색상/이탤릭 등이 적용되어 일반 텍스트보다 정보 전달과 분위기 모두 좋다.

`send.sh` 는 텍스트 전용이라 카드는 **`curl` 로 webhook URL에 직접 POST** 한다 (webhookUrl 은 `config.json` 의 해당 스페이스에서 꺼낸다).

### 기본 페이로드 템플릿

```bash
WEBHOOK=$(node -e 'console.log(require("/Users/euihyeon/.claude/scripts/mailman/config.json").spaces.<스페이스키>.webhookUrl)') && \
curl -sS -X POST "$WEBHOOK" -H 'Content-Type: application/json; charset=UTF-8' -d @- <<'EOF'
{
  "cardsV2": [{
    "cardId": "ticket-<번호>-<짧은-슬러그>",
    "card": {
      "header": {
        "title": "스껄~",
        "subtitle": "feat/#<번호> · <상태>",
        "imageUrl": "https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/scripts/mailman/assets/skrrr-vibrate.gif",
        "imageType": "SQUARE",
        "imageAltText": "skrrr vibrate"
      },
      "sections": [
        {
          "header": "📌 변경 사항",
          "widgets": [
            { "textParagraph": { "text": "<b><핵심 한 줄 요약></b>" } },
            { "textParagraph": { "text": "• <세부 1><br>• <세부 2>" } }
          ]
        },
        {
          "header": "🚀 상태",
          "widgets": [
            { "textParagraph": { "text": "<font color=\"#22c55e\"><b>개발계 배포 완료</b></font>" } }
          ]
        },
        {
          "header": "💬 클로드의 한마디",
          "widgets": [
            { "textParagraph": { "text": "<i><한 줄></i>" } }
          ]
        }
      ]
    }
  }]
}
EOF
```

### 컨벤션

- **타이틀**: `스껄~` 고정. 이모지 없음.
- **서브타이틀**: `<브랜치> · <상태>` (예: `feat/#3208 · 개발계 반영 완료`)
- **헤더 이미지**: `imageType: "SQUARE"`. URL은 `https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/scripts/mailman/assets/<filename>.gif`
- **섹션 헤더**: 이모지 + 라벨. 기본 3종 — `📌 변경 사항`, `🚀 상태`, `💬 클로드의 한마디`
- **본문 (`textParagraph.text`)**: 이모지 없이. HTML은 `<b>`, `<i>`, `<u>`, `<s>`, `<font color="#hex">`, `<a href>`, `<br>` 만 허용. CSS / 그라디언트 / 폰트 사이즈 / 폰트 패밀리는 **불가**.
- **상태 강조 색**: 성공 = `#22c55e` (초록), 진행 중 = `#3b82f6` (파랑), 경고 = `#f59e0b` (앰버), 실패 = `#ef4444` (빨강)
- **클로드의 한마디**: 활기차고 귀엽게, 이모지 없이. **`~스껄`체 사용 금지.** 작업 맥락에 맞춰 즉흥 생성 (사용자 승인 받기).

### 사용 가능한 헤더 이미지

`thewronghand-bigs/mailman` repo `scripts/mailman/assets/` 하위:
- `skrrr-vibrate.gif` — 작업 완료 류 (기본)

새 이미지가 필요하면 사용자에게 받아서 `scripts/mailman/assets/` 에 추가하고 mailman repo 에 커밋/푸시한 뒤 raw URL 로 참조한다.

### 전송 절차 (승인 필수)

1. **카드 페이로드 초안 작성** — 위 템플릿을 채워서 사용자에게 미리보기 (JSON 형태로) 한다.
2. **사용자 승인 요청** — "이 내용으로 Google Chat에 전송할까요?" 묻기. 톤/문구/이모지 변경 요청 시 반영 후 재승인.
3. **전송 실행** — `curl` 명령으로 발사. webhook 응답에 `"name": "spaces/..."` 가 보이면 성공.

## 백엔드에 질문 보내기 (승인 필수)

작업 중 API 스펙에 대해 궁금한 점이 생기면 (nullable 여부, 필드 의미, 예외 케이스 등)
사용자가 "이거 물어봐", "백엔드한테 질문해" 같은 요청을 할 수 있다.

1. **질문 초안 작성** — 아래 포맷으로 간결하게:
   ```
   [API 스펙 질문]
   대상 API: {method} {path}
   질문:
   - {질문 1}
   - {질문 2}
   ```
   맥락이 필요하면 "배경: ..." 한 줄 추가. 장문 금지.

2. **사용자 승인 요청** — "이 내용으로 Google Chat에 전송할까요?" 묻기.
   승인 전에는 절대 전송하지 않는다.

3. **전송 실행** — 메시지를 가져온 스페이스로 전송:
   ```
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh [스페이스별칭]
   [초안 내용]
   MAILMAN_EOF
   ```

사용자가 명시적으로 요청한 경우에만 질문을 보낸다. 자의적으로 질문을 생성하지 않는다.

## 공통 예외

- `/mailman`과 무관한 다른 작업 중에는 위 전송 절차들을 적용하지 않는다.
- 코드 수정 없이 분석만 한 경우 "변경 파일: 없음 (분석만 수행)"으로 명시.
- "수집된 데이터가 없습니다" 메시지만 출력된 경우 아무 것도 하지 않는다.
