---
description: Google Chat API로 최근 30일 백필 재수집 후 최신 스레드 가져오기
argument-hint: "[스페이스] [개수=5] [--all]  예: tn 3 / 인준 5 --all"
allowed-tools: Bash(~/.claude/scripts/mailman/run.sh:*), Bash(~/.claude/scripts/mailman/fetch.sh:*), Bash(~/.claude/scripts/mailman/send.sh:*)
---

!`MAILMAN_DEEP=1 ~/.claude/scripts/mailman/fetch.sh $ARGUMENTS`

위는 mailman v2가 **최근 30일을 백필 재수집**한 뒤 조회한 스레드입니다. 작업 중인 티켓과 관련된 API 스펙이 있다면 타입 정의와 요청 작성에 활용하세요.

## 백필 의미

- 기본 `/mailman`은 최초 최근 7일, 이후 마지막 `createTime` 이후를 증분 수집한다.
- `/mailman-deep`은 저장된 커서와 관계없이 최근 30일 창 전체를 다시 받는다. 이름(`name`) 기준으로 중복 없이 저장하고 `lastUpdateTime`이 바뀐 내용은 갱신한다.
- `MAILMAN_BACKFILL_DAYS`를 설정하면 백필 창을 바꿀 수 있다. 창 밖의 과거 원문/답글은 DB에 없을 수 있다.
- 개수는 최신 스레드 수(1~50), 기본 5개다. 스페이스 생략 시 `config.json`의 `defaultSpace`를 쓴다. 봇별칭 인자는 없다.
- 모든 발신자 메시지를 저장한다. 기본 조회는 BOT 전부 + 첫 줄 `@mailman` HUMAN이며 `[🤖 Claude]` 시작 메시지는 제외한다. `--all`은 필터를 해제한다.
- 고른 스레드의 저장된 답글은 필터와 관계없이 모두 시간순으로 출력한다. 머리에 표시된 `thread_name`과 DB 기준 첫 메시지 `name`을 활용한다.
- `cardsV2`와 구형 `cards`의 카드 본문도 코드블록과 버튼 링크를 포함한 마크다운 텍스트로 펼쳐진다. 텍스트 다음에 카드를 표시하며, 멘션과 분리된 같은 스레드의 카드 메시지도 포함한다.
- 수집 실패 시 기존 DB를 출력하므로 오류와 마지막 성공 수집 시각을 확인한다. 토큰 없음/`invalid_grant`이면 `bash ~/.claude/scripts/mailman/run.sh auth`로 인증한다.

## 작업 완료/질문 전송 (승인 필수)

이 세션의 스펙으로 구현/수정을 완료했을 때만 작업 완료 알림 초안을 작성한다. 도메인, 핵심 변경, 변경 파일, 남은 이슈/질문을 5~10줄 이내로 적는다. 질문은 사용자가 명시적으로 보내 달라고 요청한 경우에만 대상 API와 질문을 짧게 작성한다.

1. **초안 미리보기**: 전송 대상 스페이스와 답글 대상 `thread_name`을 밝힌다. 사용자 명의 + `[🤖 Claude] ` 태그로 전송된다는 점을 보여준다.
2. **사용자 승인**: 초안을 보여주고 "이 내용으로 Google Chat에 전송할까요?"라고 묻는다. 승인 전에는 전송하지 않는다. 수정하면 다시 승인받는다.
3. **승인 후 전송**:

   ```bash
   cat <<'MAILMAN_EOF' | bash ~/.claude/scripts/mailman/send.sh [스페이스별칭] --thread spaces/SPACE_ID/threads/THREAD_ID
   [승인된 본문]
   MAILMAN_EOF
   ```

   새 메시지는 `--thread`를 생략한다. 태그는 `send.sh`가 자동으로 붙이므로 본문에 중복해서 넣지 않는다. 답글 실패 시 API가 새 스레드로 전환할 수 있다. 성공 시 message/thread 이름을 확인해 보고하며, 실패 시 재시도하지 않는다.

카드(`cardsV2`)는 사용자 OAuth 전송 범위 밖이다. [mailman 커맨드 문서](mailman.md)의 기존 웹훅 curl 템플릿을 사용하고, 카드 JSON 초안을 보여준 뒤 사용자 승인 후 전송한다. `config.json`의 `webhookUrl`을 사용하되 값을 출력하지 않는다.

`/mailman`과 무관한 작업에는 이 절차를 적용하지 않는다. 분석만 했다면 "변경 파일: 없음 (분석만 수행)"으로 표시한다. 조회 결과가 "조회 조건에 맞는 수집된 메시지가 없습니다." 또는 "수집된 데이터가 없습니다. 먼저 run.sh auth 및 run.sh를 실행하세요."인 경우 아무 것도 하지 않는다.
