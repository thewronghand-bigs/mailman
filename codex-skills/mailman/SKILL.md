---
name: mailman
description: Pull recent Google Chat spec messages into the current Codex CLI conversation with a short mailman command.
user-invokable: true
---

# Mailman

Use this skill when the user wants to pull recent Google Chat spec messages into the current Codex CLI conversation with a short `mailman` command.

Interpret natural requests like these as a `mailman` fetch request:

- "mailman으로 최근 스펙 가져와"
- "tn 방에서 specbot 최근 3개 보여줘"
- "이 작업에 필요한 최신 API 메시지 컨텍스트에 넣어줘"

## What to do

1. Prefer the local `mailman` command instead of rebuilding the workflow manually.
2. Treat plain `mailman [space] [bot] [count]` as the fast path for “bring recent specs into context”.
3. If the user speaks naturally instead of giving shell syntax, map it to `mailman [space] [bot] [count]` yourself.
4. Use `mailman auth` only when the local Playwright login profile is missing or expired.
5. Use `mailman send <space>` only after explicit user approval for outgoing Chat messages.

## Command cheatsheet

```bash
mailman
mailman tn
mailman tn specbot 3
mailman auth
```

## Notes

- The command defaults `MAILMAN_HOME` to `~/.mailman` for Codex CLI so it does not interfere with an existing Claude setup unless the user overrides it.
- Runtime scripts still live at `~/.claude/scripts/mailman` by default for compatibility with Claude `/mailman`.
- If the command is missing, tell the user to run the Codex install path from the repository install guide.
