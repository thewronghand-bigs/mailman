# Mailman Sandbox Plugin

Repo-local Codex plugin for importing Google Chat messages into Mailman from sandbox sessions.

## Main pieces

- `skills/mailman-sandbox/SKILL.md`: sandbox workflow guidance
- `scripts/extract_google_chat_messages.js`: browser extraction snippet
- `scripts/import_snapshot.sh`: snapshot import wrapper

## Intended flow

1. Open Google Chat in the browser tool.
2. Extract message JSON with the provided script.
3. Save it to `.mailman/chat.json`.
4. Import with `MAILMAN_DRIVER=snapshot`.
5. Read results with `scripts/mailman/fetch.sh`.
