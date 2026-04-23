---
name: mailman
description: Pull recent Google Chat spec messages into the current Codex sandbox conversation.
user-invokable: true
---

# Mailman

Use this skill when Codex is running in a sandboxed session and the user wants the fastest path to pull recent Google Chat spec messages into the current conversation.

Interpret natural requests like these as valid mailman tasks:

- "mailman으로 최근 스펙 가져와"
- "tn 방에서 희조봇 메시지 3개만 가져와"
- "이 작업에 필요한 최근 API 스펙만 컨텍스트에 넣어줘"

This is the short-name alias for `mailman-sandbox`. Follow the same workflow:

1. Open the configured Google Chat space with browser tools.
2. Expand relevant threads and scroll until the needed messages are visible.
3. Extract a JSON snapshot.
4. Import it into the bundled Mailman runtime.
5. Render the latest threads back into the current Codex conversation.

When possible, infer `space`, `sender`, and `count` from the user's wording yourself so the interaction feels as short as Claude `/mailman`.
When possible, ask the runtime for only the user-requested space, sender, and count so the response stays compact.
