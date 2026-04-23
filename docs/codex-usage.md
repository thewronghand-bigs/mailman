# Codex 사용

## Codex CLI

가장 짧은 사용법은 `mailman` 이다.

```bash
mailman
mailman tn
mailman tn specbot 3
```

인증이 필요하면:

```bash
mailman auth
```

전송은 stdin으로 보낸다.

```bash
cat <<'EOF' | mailman send tn
[작업 완료 알림]
변경 요약:
- ...
EOF
```

## Codex 샌드박스

샌드박스에서는 plugin skill `mailman` 을 부르면 된다.

추천 호출 예시:

- `mailman으로 tn 방에서 최근 specbot 메시지 3개 가져와`
- `mailman 써서 인준 방 최근 스펙 요약 가져와`
- `mailman으로 이 작업에 필요한 최근 API 스펙만 컨텍스트에 넣어줘`

skill은 내부적으로 다음 순서로 동작한다.

1. Google Chat 열기
2. 필요한 스레드 답글 펼치기
3. 보이는 메시지를 snapshot JSON으로 추출
4. Mailman runtime에 import
5. 최신 메시지를 현재 Codex 대화에 붙이기

## 제약

- 샌드박스는 현재 보이는 메시지만 가져온다.
- 더 오래된 메시지가 필요하면 스크롤이 필요하다.
- reply thread를 펼치지 않으면 답글이 빠질 수 있다.
- Google Chat DOM이 바뀌면 selector 수정이 필요할 수 있다.
