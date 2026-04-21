---
description: Google Chat에서 수집한 최신 메시지(API 스펙 등) 가져오기
argument-hint: "[식별자 예: 2738-2] | [개수] (생략 시 최신 1개)"
allowed-tools: Bash(~/.claude/scripts/mailman/run.sh:*), Bash(~/.claude/scripts/mailman/fetch.sh:*), Bash(~/.claude/scripts/mailman/send.sh:*)
---

!`~/.claude/scripts/mailman/fetch.sh $ARGUMENTS`

위는 구글챗 그룹 DM에서 mailman이 수집한 최근 메시지입니다.

## 후속 자동 실행

수집된 메시지에 **API 스펙(endpoint, method, request/response 구조 등)** 이 포함돼 있다면,
별도 지시 없이 즉시 `analyze-api-spec` 스킬을 Skill 도구로 호출하여 프론트엔드 구현 계획을 자동 수립하라.
이때 위 메시지 본문을 그대로 `args`로 전달한다.

API 스펙이 없고 단순 대화/공지뿐이라면 스킬 호출 없이 요약만 제공한다.

판단 기준:
- HTTP method + path가 하나라도 명시되어 있으면 API 스펙으로 간주
- JSON request/response 샘플이 있으면 API 스펙으로 간주
- "수집된 데이터가 없습니다" 메시지만 출력된 경우 아무 것도 하지 않는다

## 작업 완료 시 자동 전송 (승인 필수)

**이 절차는 오직 현재 `/mailman` 세션에서 파생된 작업에만 적용한다.**
즉 위 "후속 자동 실행"으로 analyze-api-spec 스킬이 호출되고, 그 결과 사용자가 실제 구현/수정을 진행한 경우에 한정된다.
사용자가 `/mailman`과 무관한 다른 작업을 하는 중에는 이 절차를 절대 적용하지 않는다.

해당 세션의 모든 구현 작업이 완료된 시점에 다음을 수행하라:

1. **요약 초안 작성** — 아래 포맷으로 메시지 초안을 만든다:
   ```
   [{ticketId}-{sequence}]
   [작업 완료 알림]
   티켓/도메인: {파악된 경우}
   변경 요약:
   - {핵심 변경 1}
   - {핵심 변경 2}
   변경 파일:
   - path/to/file1
   - path/to/file2
   남은 이슈/질문: {있는 경우만, 없으면 "없음"}
   ```
   불필요한 수식어/장문 설명 금지. 5~10줄 이내가 적당.

   **식별자 prefix 규칙 (필수)**:
   - 첫 줄은 반드시 `[{ticketId}-{sequence}]` 형식 (예: `[2738-2]`).
   - 값은 이번 세션에서 수신한 API 스펙 메시지 선두의 식별자와 **완전히 동일**하게 맞춘다.
     수신 스펙이 `[2738-1]` 이면 완료 알림도 `[2738-1]` 로 보낸다 (BE 측 페어링용 키).
   - 수신 메시지에 식별자가 없었다면 prefix 줄 전체를 생략한다 (억지로 만들지 않음).

2. **사용자 승인 요청** — 초안을 그대로 출력한 뒤 "이 내용으로 Google Chat에 전송할까요?" 라고 묻는다.
   사용자가 "예/보내/send/네" 계열로 승인하기 전에는 전송하지 않는다.
   수정 요청이 오면 반영 후 다시 승인 요청.

3. **전송 실행** — 승인되면 Bash로 `send.sh`에 STDIN heredoc으로 메시지를 전달해 전송:
   ```
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh
   [초안 내용]
   MAILMAN_EOF
   ```
   stdout/stderr 결과의 `✅ 전송 완료`를 확인하고 사용자에게 보고한다.
   경고 메시지(`전송 실패 가능성`)나 non-zero exit 시 사용자에게 실패 사실을 알리고 재시도하지 않는다.

예외: 아무 코드도 수정되지 않고 분석만 이뤄진 경우에도 초안은 동일 포맷으로 작성하되 "변경 파일: 없음 (분석만 수행)"으로 명시한다.
