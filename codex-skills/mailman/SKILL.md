---
name: mailman
description: Google Chat 스페이스의 새 메시지를 mailman CLI로 수집·조회해 작업에 영향 주는 내용만 보고하고, 사용자 승인 후 텍스트 답장이나 카드를 보낸다. 사용자가 $mailman, "메일맨", "채팅 확인", "백엔드 스펙 왔는지 봐줘", "Chat에 보내줘"라고 할 때 쓴다.
---

# mailman (Codex)

mailman은 Google Chat 스페이스의 메시지를 로컬 SQLite에 모아 두고 조회·전송하는 CLI다. 실행 파일은 `~/.claude/bin/mailman` 하나이며 Claude Code의 `/mailman`과 같은 실행 파일·DB·seen 커서를 공유한다.

## 시작 전

`$MAILMAN_HOME/mailman/local.md`(기본 `~/.claude/mailman/local.md`)가 있으면 먼저 읽고, 그 안의 개인 컨벤션(카드 스타일·말투 등)을 이 문서보다 우선해 따른다. 단 전송 전 사용자 승인과 웹훅 URL 비노출 규칙은 바꾸지 않는다. 없으면 무시한다.

## 샌드박스

mailman은 작업 폴더 밖인 `~/.claude/{inbox,logs,secrets,mailman}`에 읽고 쓰며 Google API(`oauth2.googleapis.com`, `chat.googleapis.com` 등)로 네트워크를 쓴다. 기본 `workspace-write` 샌드박스에서는 쓰기나 네트워크가 막혀 실패할 수 있다.

- `mailman` 명령은 **샌드박스 밖 실행(권한 상승)을 요청해** 실행한다. 사용자가 승인하지 않으면 실행하지 않고 그 사실을 알린다.
- 매번 승인하기 번거로우면 사용자가 `${CODEX_HOME:-~/.codex}/config.toml`에 쓰기 경로와 네트워크를 열어 둘 수 있다(https://github.com/thewronghand-bigs/mailman#codex에서-쓰기 참조). 이 설정을 Codex가 임의로 고치지 않는다.

## 조회

먼저 다음 명령을 실행해 출력 전체를 읽는다. 조회 전에 수집을 시도하고, 수집이 실패해도 DB에 있는 내용을 출력한다.

```bash
~/.claude/bin/mailman fetch [스페이스] [옵션]
```

- 대상은 config 별칭 → `spaces/ID` → `--dm <사람>` → 스페이스 표시 이름 순서로 해석한다. 생략하면 `defaultSpace`다. 이름·DM으로 선택한 미등록 방도 해당 호출에서만 사용하며 자동 등록하지 않는다.
- **기본**: mailman이 그 방에서 마지막으로 보여 준 시점(seen) 이후의 새 메시지. 첫 조회는 최근 24시간이다. 출력 성공 뒤 seen이 전진한다. seen은 Google Chat 읽음 상태와 무관하다.
- **`--since 24h|3d|7d|YYYY-MM-DD`**: 지정 시점 이후를 조회하며 **seen을 바꾸지 않는다**. 날짜는 로컬 자정 기준이다.
- **`--only bot|human`**: 해당 발신자 유형의 새 메시지만 보여 주며 **seen을 바꾸지 않는다**(거른 쪽 메시지가 기본 조회에서 사라지지 않게). `--since`와 함께 쓸 수 있다. 같은 스레드의 다른 유형 메시지는 `[이전 맥락]`으로 보일 수 있다.
- **`--deep`**: 수집 커서와 관계없이 최근 30일을 백필 재수집한 뒤 기본 조회를 한다. 과거 수정분과 누락된 맥락을 보완할 때 쓴다. `MAILMAN_BACKFILL_DAYS`로 창을 바꿀 수 있다. 백필로 채워진 과거 메시지(생성 시각이 seen보다 이른 것)는 기본 조회에 새 메시지로 뜨지 않으므로 `--since`로 확인한다.
- **`--no-collect`**: 수집 없이 DB만 조회한다.
- 새 메시지는 오래된 것부터 최대 200건이다. 더 남으면 기본 조회는 다시 실행해 이어서 보고, `--since`·`--only` 조회는 `--since`를 지정하거나 좁혀서 나눠 본다.

**Claude와 공유**: Claude Code의 `/mailman`과 같은 DB와 같은 seen 커서를 쓴다. 한쪽에서 기본 조회로 본 메시지는 다른 쪽 기본 조회에서 새 메시지로 나오지 않는다. 다시 보려면 `--since`를 쓴다.

## 대상 찾기

**스페이스 ID를 사용자에게 묻지 않는다.** `~/.claude/bin/mailman spaces '검색어'`로 내가 속한 방의 이름·종류·ID를 찾고 필요하면 `--refresh`로 갱신한다. 표시 이름은 대소문자·공백을 무시한 정확 일치 우선, 없으면 부분 일치다. **후보가 여러 개면 이름·종류·ID 목록을 보여 주고 사용자에게 고르게 한다. 임의로 선택하지 않는다.**

기존 DM은 `--dm colleague@example.test`, `--dm '사람 이름'`, `--dm users/USER_ID`로 찾는다. 사람 이름은 수집된 메시지의 발신자 기록에서 유일해야 한다. 기록이 없거나 동명이인이면 이메일로 구분한다. 새 DM은 만들지 않는다. 위치 인자와 `--dm`은 함께 쓰지 않는다. `--save <새 별칭>`을 명시할 때만 config에 추가하며 기존 별칭은 덮어쓰지 않는다.

출력 첫 줄은 `[대상] 이름 (종류, spaces/...)`다. 별칭/리터럴에 `SPACE_TYPE_UNSPECIFIED`가 나오면 `spaces --refresh`로 실제 표시 정보를 확인한다. 전송 초안에는 해석된 이름·종류·ID를 반드시 표시한다. `send --dry-run`은 본문을 stdin으로 받아 대상·태그 적용 본문을 미리 보여 주며 전송하지 않는다.

## 보고 기준

1. `[새 메시지]`가 이번 조회 대상이고 `[이전 맥락]`은 새 답글을 이해하기 위한 참고다.
2. 다음 내용만 골라 간결하게 보고한다.
   - API 스펙·스펙 변경. 지금 작업과의 관련 여부를 함께 판단하고, 관련 스펙은 타입 정의와 요청 작성에 활용한다.
   - 사용자에게 온 요청·질문·확인 요청.
   - 일정·배포 공지처럼 작업에 영향 주는 내용.
3. 잡담·인사·리액션성 메시지는 보고하지 않는다. 관련 내용이 없으면 출력 머리의 새 메시지 수로 **`새 메시지 N건, 작업 관련 없음`** 한 줄로 끝낸다. 이전 맥락을 새 메시지 수에 더하지 않는다.
4. 출력이 "[별칭] 새 메시지가 없습니다." 또는 "수집된 데이터가 없습니다. 먼저 mailman auth 및 mailman collect를 실행하세요."이면 아무 것도 하지 않는다.
5. 수집 실패 안내가 함께 나오면 오류 문구와 마지막 성공 수집 시각을 알린다.

## 인증

- 최초 인증: `~/.claude/bin/mailman auth --client <다운로드한 client_secret JSON>` ([설정 가이드](https://thewronghand-bigs.github.io/mailman/setup)).
- 토큰 없음(exit 2)이나 `invalid_grant`(exit 3): `~/.claude/bin/mailman auth`로 다시 인증한다.
- 인증은 브라우저 로그인이 필요하므로 사용자에게 직접 실행해 달라고 안내한다. 토큰·client secret·웹훅 URL은 출력하지 않는다.

## 전송 (승인 필수)

사용자가 요청했거나, 이 세션에서 조회한 스펙으로 구현/수정을 마쳤을 때만 전송 초안을 만든다. 질문은 사용자가 명시적으로 보내 달라고 한 경우에만 보낸다.

1. **초안 작성**: 5~10줄 이내로 간결하게 쓴다. 작업 완료 알림이면 변경 요약·변경 파일·남은 이슈를, 질문이면 대상 API와 질문을 적는다. 분석만 했다면 "변경 파일: 없음 (분석만 수행)"으로 쓴다.
2. **미리보기**: 해석된 대상의 **이름·종류·ID를 반드시 표시**하고 답글 대상 `thread_name`, 그리고 **로그인한 사용자 명의**로 나간다는 점을 함께 보여 준다. 본문 앞에 `[🤖 Codex] ` 태그가 붙는다(`--agent codex`). 사용자가 설정에서 끈 경우(`sendTag: false`) 태그 없이 나간다.
3. **승인 요청**: "이 내용으로 Google Chat에 전송할까요?"라고 묻는다. 승인 전에는 절대 전송하지 않는다. 수정 요청이 오면 반영해 다시 승인받는다.
4. **전송**: 승인되면 실행한다. 원 스레드에 답하려면 조회 출력의 `thread_name`을 `--thread`로 넘기고, 새 메시지면 `--thread`를 뺀다.

   ```bash
   cat <<'MAILMAN_EOF' | ~/.claude/bin/mailman send [스페이스별칭] --agent codex --thread spaces/SPACE_ID/threads/THREAD_ID
   [승인된 본문]
   MAILMAN_EOF
   ```

   태그를 본문에 중복해서 넣지 않는다. API가 답글을 만들 수 없으면 새 스레드로 전환된다. `✅ 전송 완료`와 생성된 message/thread 이름을 확인해 보고한다. 실패하면 재시도하지 않고 알린다.

### 답장 대기

답장이 필요한 승인된 질문은 `send --wait`로 보낸다. **Codex에는 Bash 백그라운드 완료 알림이 없으므로 `--timeout 2m`처럼 짧게 잡아 블로킹 실행**한다. 위 샌드박스 권한 상승 안내는 대기 명령에도 적용된다. 예:

```bash
cat <<'MAILMAN_EOF' | ~/.claude/bin/mailman send [대상] --agent codex --wait --quiet 30s --timeout 2m --interval 15s
[승인된 질문]
MAILMAN_EOF
```

원 스레드만 기다리면 `--thread spaces/SPACE_ID/threads/THREAD_ID`, 특정 사람 답장만 기다리면 `--from <사람>`을 추가한다. 짧게 연속으로 온 답장은 마지막 답장 후 quiet가 지날 때까지 모으며, 첫 답장 후 최대 10분/전체 timeout 중 빠른 시점에도 반환한다. 내 메시지는 제외한다. 출력 전체에서 `대기 전부터 있던 안 읽은 메시지`를 먼저 읽고 `답장 N건(조용해진 뒤 묶음)`을 한 묶음으로 이해한 뒤 작업을 이어 간다.

답장 없음은 **exit 4**다. 질문은 이미 전송됐으므로 다시 전송하지 않고 상황을 알린다. **`send --wait`가 exit 5면 전송은 완료됨 — 재전송 금지.** 대기 오류·출력 실패·전송 후 SIGINT/SIGTERM도 exit 5다. 전송 요청 중 중단은 전송 여부가 불확실하므로 Chat에서 확인 후 재전송 여부를 판단한다. 단독 `wait`의 SIGINT/SIGTERM은 130/143이다. 계속 기다리라는 요청이면 `~/.claude/bin/mailman wait [대상] --timeout 2m`으로 새 실행 시각부터 기다린다. 필터 없는 대기는 출력 성공 후 실제 표시한 메시지까지 seen을 전진한다. `--from`·`--thread`, 대기 오류, 출력 실패, 중단에서는 seen을 유지한다.

`--timeout` 상한은 2시간이다. 연결 오류·5xx·429는 최대 60초 백오프로 재시도하고, 연속 실패 5분이면 받은 답장까지 출력한다. 401은 토큰 갱신 후 1회 재시도한다. `--from`은 전송 전에 확정하며 이메일은 기존 DM의 수집 기록 또는 최근 메시지에서 상대 ID를 찾는다(기본 7일, `MAILMAN_BACKFILL_DAYS` 적용). DM이 없거나 ID를 확정하지 못하면 전송하지 않는다. 수집된 정확한 이름이나 users/ID로 지정한다.

빈 대상·`--dm`·`--from`·`--save`는 인자 오류다. 이름 캐시는 24시간 초과 시 자동 갱신하며 실패하면 경고 후 기존 캐시를 쓴다. DM 미리보기의 해석된 users/ID를 확인한다. `--dry-run --save`는 저장할 예정 안내만 하고 config를 바꾸지 않는다.

### 텍스트 서식

사용자 명의 메시지는 마크다운으로 해석된다.

- 줄바꿈 한 번은 무시되고 앞 줄에 이어 붙는다. 문단을 나누려면 빈 줄을 넣는다.
- `*텍스트*`·`_텍스트_`는 기울임, `**텍스트**`는 굵게(미검증), `~텍스트~`는 취소선, `` `코드` ``는 인라인 코드, 코드 펜스는 코드블록이다.
- `- 항목`은 글머리표 목록이다.
- `<url|라벨>` 링크 문법은 동작하지 않는다. URL은 그대로 쓰면 자동 링크되고, 라벨 링크는 `[라벨](url)`을 쓴다(미검증).
- `<users/USER_ID>`는 실제 멘션(알림 발생)이다.

### 카드(Cards v2)

사용자 인증으로는 `cardsV2`를 보낼 수 없으므로 카드는 설정 파일의 해당 스페이스 `webhookUrl`로 `curl`을 써서 직접 보낸다. 웹훅 URL 값은 출력하지 않는다. 카드 스타일은 `local.md`의 개인 컨벤션이 있으면 그것을 따른다.

```bash
MAILMAN_CONFIG_FILE="${MAILMAN_CONFIG:-${MAILMAN_HOME:-$HOME/.claude}/mailman/config.json}" && \
WEBHOOK=$(plutil -extract spaces.team.webhookUrl raw -o - "$MAILMAN_CONFIG_FILE") && \
curl -sS -X POST "$WEBHOOK" -H 'Content-Type: application/json; charset=UTF-8' -d @- <<'EOF'
{
  "cardsV2": [{
    "cardId": "<짧은-식별자>",
    "card": {
      "header": { "title": "<제목>", "subtitle": "<부제목>" },
      "sections": [
        {
          "header": "변경 사항",
          "widgets": [
            { "textParagraph": { "text": "<b><핵심 한 줄 요약></b><br>• <세부 1><br>• <세부 2>" } }
          ]
        }
      ]
    }
  }]
}
EOF
```

- `spaces.team`의 `team`을 승인받은 대상 별칭으로 바꾼다. 웹훅 전송도 네트워크를 쓰므로 샌드박스 밖 실행을 요청한다.
- `textParagraph.text`의 HTML은 `<b>`, `<i>`, `<u>`, `<s>`, `<font color="#hex">`, `<a href>`, `<br>`만 허용된다. CSS·폰트 크기·폰트 패밀리는 쓸 수 없다.
- 카드 JSON 초안에 해석된 대상의 이름·종류·ID도 표시하고 승인받은 뒤 전송한다. 응답에 `"name": "spaces/..."`가 보이면 성공이다.
