# Codex

Codex 설명서는 둘로 나눠 본다.

- 설치: [docs/codex-install.md](/Users/euihyeon/dev/claude-mailman/docs/codex-install.md)
- 사용: [docs/codex-usage.md](/Users/euihyeon/dev/claude-mailman/docs/codex-usage.md)

요약만 적으면:

- Codex CLI는 `mailman` 커맨드를 쓴다
- Codex 샌드박스는 `mailman` plugin skill을 쓴다
- Codex CLI 기본 `MAILMAN_HOME` 은 `~/.mailman` 이라 Claude 쪽과 덜 충돌한다

## 샌드박스 snapshot 방식 참고

샌드박스에서는 persistent Chrome 프로필 접근이 불안정할 수 있으니 plugin이 `snapshot` driver를 쓴다.

1. Codex에게 browser/MCP 도구로 `chat.google.com` 을 열고 필요한 스레드 답글을 펼치게 한다.
2. 같은 세션에서 페이지 안의 메시지를 JSON으로 추출해 파일로 저장한다.
   예: Codex가 아래 형태의 배열을 `$PWD/.mailman/chat.json` 로 저장

```json
[
  {
    "id": "msg-1",
    "threadName": "spaces/AAA/threads/BBB",
    "createTime": "2026-04-23T01:23:45.000Z",
    "senderDisplayName": "Spec Bot",
    "text": "GET /v1/widgets"
  }
]
```

브라우저 쪽 추출 로직은 현재 `collector.ts`의 DOM 추출 기준과 같은 필드를 만들면 된다. 예를 들면 browser evaluate에서 아래 JS를 실행해 결과를 파일로 저장하면 된다.

```js
() => {
  const results = [];
  const seen = new Set();
  const allGroups = Array.from(document.querySelectorAll("div[role='group']"));
  const leafGroups = allGroups.filter((g) => {
    const childGroups = g.querySelectorAll("div[role='group']");
    if (childGroups.length === 0) return true;
    return Array.from(childGroups).every((cg) => cg.innerText?.trim() === "");
  });

  for (const g of leafGroups) {
    const heading = g.querySelector("[data-message-id][role='heading']");
    if (!heading) continue;
    const id = heading.getAttribute("data-message-id");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    let threadName = null;
    let p = g.parentElement;
    while (p) {
      if (p.tagName === "C-WIZ" && p.getAttribute("data-topic-id")) {
        threadName = p.getAttribute("data-topic-id");
        break;
      }
      p = p.parentElement;
    }

    let createTime = new Date().toISOString();
    const tsEl = g.querySelector("[data-absolute-timestamp]");
    if (tsEl) {
      const raw = Number(tsEl.getAttribute("data-absolute-timestamp"));
      if (Number.isFinite(raw) && raw > 0) createTime = new Date(raw).toISOString();
    }

    const headingText = heading.innerText ?? "";
    const headingLines = headingText.split("\n").map((s) => s.trim()).filter(Boolean);
    const senderDisplayName = headingLines[0] || "(unknown)";
    const text = (g.innerText ?? "").trim();
    if (!text) continue;

    results.push({ id, threadName, createTime, senderDisplayName, text });
  }

  return results;
}
```
3. 아래 명령으로 적재한다.

```bash
MAILMAN_DRIVER=snapshot \
MAILMAN_SNAPSHOT_FILE="$PWD/.mailman/chat.json" \
MAILMAN_HOME="$PWD/.mailman" \
bash scripts/mailman/run.sh myspace
```

4. 이후 조회는 동일하다.

```bash
MAILMAN_HOME="$PWD/.mailman" bash scripts/mailman/fetch.sh myspace specbot 3
```

주의:

- snapshot 안에 보이는 메시지만 수집된다
- reply thread를 펼치지 않으면 답글은 빠질 수 있다
- JSON 파일은 `id`, `threadName`, `createTime`, `senderDisplayName`, `text` 필드를 가져야 한다

## 전송

```bash
cat <<'EOF' | bash scripts/mailman/send.sh myspace
[작업 완료 알림]
변경 요약:
- ...
EOF
```
