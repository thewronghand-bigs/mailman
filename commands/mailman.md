---
description: Google Chat API로 수집하고 mailman이 마지막으로 보여준 이후의 새 메시지 가져오기
argument-hint: "[스페이스] [--since <기간|날짜>]  예: tn / 인준 --since 7d"
allowed-tools: Bash(~/.claude/scripts/mailman/run.sh:*), Bash(~/.claude/scripts/mailman/fetch.sh:*), Bash(~/.claude/scripts/mailman/send.sh:*)
---

!`~/.claude/scripts/mailman/fetch.sh $ARGUMENTS`

위는 Google Chat API로 수집한 메시지입니다. 출력 전체를 읽고 아래 처리 절차에 따라 작업에 영향 주는 내용만 보고하세요.

## Claude의 처리 절차

1. 이전 맥락을 포함한 출력 전체를 읽는다. `[새 메시지]`가 이번 조회 대상이며 `[이전 맥락]`은 새 답글을 이해하기 위한 참고다.
2. 다음 내용만 골라 간결하게 요약해 보고한다:
   - API 스펙·스펙 변경. 지금 작업 중인 티켓과의 관련 여부를 함께 판단해 알리고, 관련 스펙은 타입 정의와 요청 작성에 활용한다.
   - 의현에게 온 요청·질문·확인 요청.
   - 일정·배포 공지처럼 작업에 영향 주는 내용.
3. 잡담·인사·리액션성 메시지는 보고하지 않는다. 보고할 관련 메시지가 없으면 출력 머리의 새 메시지 수를 사용해 **`새 메시지 N건, 작업 관련 없음`** 한 줄로 끝낸다. 이전 맥락을 새 메시지 수에 더하지 않는다.

## 동작 모드

- **`/mailman [스페이스]` (기본)**: 수집 후 mailman이 그 방에서 마지막으로 보여준 시점(seen) 이후의 새 메시지를 조회한다. 첫 조회는 최근 24시간이다. seen은 Google Chat 읽음 상태와 무관하다.
- **`/mailman [스페이스] --since 7d`**: 지정 시점 이후를 조회하며 **seen을 바꾸지 않는다**. `24h`, `3d`, `7d` 같은 양의 정수 시간/일 또는 `YYYY-MM-DD`(로컬 자정)를 쓴다.
- 수집은 최초 최근 7일, 이후 스페이스별 마지막 수집 `createTime` 이후의 증분이다. 수집 커서와 조회 seen은 별개다.
- **`/mailman-deep [스페이스]`**: 수집 커서와 관계없이 **최근 30일 백필 재수집** 후 기본 모드(안 읽은 메시지)로 조회한다. 과거 수정분과 누락된 맥락을 보완하는 용도다. `MAILMAN_BACKFILL_DAYS`로 창을 바꿀 수 있다.
- 새 메시지는 오래된 것부터 최대 200건이다. 더 남으면 기본 조회는 다시 실행해 이어서 보고, 기간 조회는 `--since`를 좁힌다. 출력 성공 뒤 실제 보여준 새 메시지의 최대 생성 시각까지 seen을 전진한다. 새 메시지 0건이나 출력 실패에서는 그대로다.
- 백필로 뒤늦게 채워진 과거 메시지(생성 시각이 seen보다 이른 것)는 기본 조회에 **새 메시지로 뜨지 않는다**. 구멍을 메운 뒤에는 `--since`로 그 기간을 확인한다.
- 수집 실패 시에도 기존 DB 내용을 출력하므로 오류 안내와 마지막 성공 수집 시각을 확인한다.

## 저장과 조회 대상

수집 범위는 **config에 등록한 방**으로만 정한다. 그 방의 모든 메시지를 원문 그대로 저장하며 조회도 사람·봇·mailman 전송을 모두 포함한다. 무엇이 중요한지는 Claude가 출력 전체를 읽고 판단한다.

스레드는 가장 이른 새 메시지 시각 기준 오래된 것부터, 내부는 시간순으로 출력한다. 오래된 스레드의 새 답글이면 직전의 저장된 메시지 중 최근 5건을 **이전 맥락**으로 함께 표시하고 나머지 생략 건수도 알린다. 출력 머리의 `thread_name`은 답글 전송에 사용하고 첫 메시지 `name`은 DB 기준이다. 각 메시지의 발신자 표시명과 `(BOT)`/`(HUMAN)` 구분을 참고한다. 수집 창 밖의 과거 원문/답글이 없으면 백필 기간을 늘려야 한다.

`cardsV2`와 구형 `cards`의 카드 본문은 제목·섹션·코드블록·버튼 링크를 포함한 마크다운 텍스트로 펼쳐진다. 텍스트와 카드가 함께 있으면 텍스트가 먼저 나온다. 멘션과 카드가 별도 메시지여도 같은 스레드에 저장되어 있으면 둘 다 표시한다.

사용자가 "특정 발신자 메시지만 보여줘" 같이 요청하면 `/mailman` 결과에서 발신자 기준으로 필터링해서 보여주면 된다.

## 스페이스 별칭

`config.json`의 `spaces`에 등록된 별칭을 쓴다. 생략하면 `defaultSpace`를 사용한다. 봇별칭 인자는 없다.

최초 인증은 `bash ~/.claude/scripts/mailman/run.sh auth`. 토큰이 없거나 `invalid_grant` 안내가 나오면 이 명령으로 다시 인증한다.

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
   `send.sh`는 **OAuth로 로그인한 사용자 명의**로 `[🤖 Claude] ` 태그를 본문 앞에 자동으로 붙인다. 초안 미리보기에도 이 태그와 전송 대상 스페이스/스레드를 명시한다.

   원 스레드에 답글을 달려면 출력의 `thread_name`을 사용한다:
   ```bash
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh [스페이스별칭] --thread spaces/SPACE_ID/threads/THREAD_ID
   [초안 내용]
   MAILMAN_EOF
   ```
   태그를 본문에 직접 중복해서 넣지 않는다. API가 해당 스레드에 답글을 달 수 없으면 새 스레드로 전환한다.
   `✅ 전송 완료`와 생성된 message/thread 이름 확인 후 보고한다. 실패 시 재시도하지 않고 알린다.

## 텍스트 전송 서식

사용자 명의 메시지는 **마크다운**(`MARKUP_SYNTAX_MARKDOWN`)으로 해석된다. 웹훅·봇의 Chat 전용 문법과 다르다. 2026-10-22 실제 전송으로 확인한 결과:

- **줄바꿈 한 번은 무시되고 앞 줄에 이어 붙는다.** 문단을 나누려면 빈 줄을 넣는다.
- `*텍스트*`·`_텍스트_` → 기울임. 굵게는 `**텍스트**`(표준 마크다운 기준, 미검증).
- `~텍스트~` → 취소선, `` `코드` `` → 인라인 코드, ```` ``` ```` 블록 → 코드블록(줄바꿈 유지).
- `- 항목` → 글머리표 목록.
- `<url|라벨>` 링크 문법은 **동작하지 않는다**(글자 그대로 노출). URL은 그대로 쓰면 자동 링크된다. 라벨 링크가 필요하면 `[라벨](url)`(미검증).
- `<users/USER_ID>` → 실제 멘션(알림 발생).
- 앱 구성 이름(`mailman`)이 발신자 옆에 표시된다.

## 카드(Cards v2) 형식으로 보내기

작업 완료 알림처럼 **시각적으로 강조가 필요한 메시지**는 일반 텍스트 대신 Google Chat Cards v2 형식을 쓴다.
헤더 이미지(GIF 포함) + 섹션별 라벨/색상/이탤릭 등이 적용되어 일반 텍스트보다 정보 전달과 분위기 모두 좋다.

사용자 OAuth는 `cardsV2`를 보낼 수 없다. `send.sh`는 텍스트 전용이며, 카드는 기존처럼 **`curl`로 webhook URL에 직접 POST** 한다 (`webhookUrl`은 `config.json`의 해당 스페이스에서 꺼낸다). 웹훅 URL은 터미널/로그에 출력하지 않는다.

### 기본 페이로드 템플릿

```bash
WEBHOOK=$(bun -e 'const c = await Bun.file(`${process.env.HOME}/.claude/scripts/mailman/config.json`).json(); process.stdout.write(c.spaces["tn"].webhookUrl)') && \
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

`tn`은 승인받은 전송 대상 별칭으로 바꾼다. `WEBHOOK` 변수 값 자체는 출력하지 않는다.

### 컨벤션

- **타이틀**: `스껄~` 고정. 이모지 없음.
- **서브타이틀**: `<브랜치> · <상태>` (예: `feat/#3208 · 개발계 반영 완료`)
- **헤더 이미지**: `imageType: "SQUARE"`. 기존 GIF는 `https://raw.githubusercontent.com/thewronghand-bigs/mailman/main/scripts/mailman/assets/<filename>.gif`
- **섹션 헤더**: 이모지 + 라벨. 기본 3종 — `📌 변경 사항`, `🚀 상태`, `💬 클로드의 한마디`
- **본문 (`textParagraph.text`)**: 이모지 없이. HTML은 `<b>`, `<i>`, `<u>`, `<s>`, `<font color="#hex">`, `<a href>`, `<br>` 만 허용. CSS / 그라디언트 / 폰트 사이즈 / 폰트 패밀리는 **불가**.
- **상태 강조 색**: 성공 = `#22c55e` (초록), 진행 중 = `#3b82f6` (파랑), 경고 = `#f59e0b` (앰버), 실패 = `#ef4444` (빨강)
- **클로드의 한마디**: 기본 `스껄.` 한 단어. 바리에이션은 `스껄ㅋㅋ`, `스껄ㅠㅠ`, `스껄????` 처럼 **간결하고 무의미하게** (감탄/체념/의문 등 톤만 바꿈). 긴 문장이나 의미 있는 한마디는 사용 금지. 문구 선택 후에도 최종 카드 전송 승인은 필수다.

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

3. **전송 실행** — 메시지를 가져온 스페이스로 전송. 원 스레드에 답하려면 위와 같은 `--thread` 옵션을 추가한다:
   ```
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh [스페이스별칭]
   [초안 내용]
   MAILMAN_EOF
   ```

질문도 사용자 명의 + `[🤖 Claude] ` 태그로 나간다. 태그와 스페이스/스레드를 초안에 표시하고, 전송 본문에는 태그를 중복해서 넣지 않는다. 사용자가 명시적으로 요청한 경우에만 질문을 보낸다. 자의적으로 질문을 생성하지 않는다.

## 공통 예외

- `/mailman`과 무관한 다른 작업 중에는 위 전송 절차들을 적용하지 않는다.
- 코드 수정 없이 분석만 한 경우 "변경 파일: 없음 (분석만 수행)"으로 명시.
- 조회 결과가 "[별칭] 새 메시지가 없습니다." 또는 "수집된 데이터가 없습니다. 먼저 run.sh auth 및 run.sh를 실행하세요."인 경우 아무 것도 하지 않는다. 스페이스 별칭이나 뒤의 메타 정보가 함께 출력되어도 같다.
