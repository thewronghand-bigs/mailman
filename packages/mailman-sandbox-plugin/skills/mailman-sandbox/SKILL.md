---
name: mailman-sandbox
description: Import Google Chat spec messages into Mailman from a Codex sandbox session.
user-invokable: true
---

# Mailman Sandbox

Use this skill when Codex is running in a sandboxed session and needs to pull Google Chat spec messages into Mailman without relying on a persistent local Chrome profile.

Interpret natural requests like these as valid mailman tasks:

- "mailman으로 최근 스펙 가져와"
- "tn 방에서 희조봇 메시지 3개만 가져와"
- "이 작업에 필요한 최근 API 스펙만 컨텍스트에 넣어줘"

## What this plugin does

1. Uses browser tools to open Google Chat and navigate to the configured DM/space.
2. Expands relevant reply threads if needed.
3. Extracts visible messages into a JSON snapshot.
4. Imports that snapshot into the bundled Mailman runtime with `MAILMAN_DRIVER=snapshot`.
5. Optionally renders the latest threads with `fetch.sh`.

Try to infer the requested `space`, `sender`, and `count` from the user's wording so the interaction stays short.

## Preconditions

- `runtime/config.json` exists and has the target space alias.
- `runtime` dependencies are installed with `bun install`.
- Use a writable runtime root such as `$PWD/.mailman`.

## Workflow

### 1. Prepare runtime

Run:

```bash
mkdir -p .mailman
```

If `runtime/config.json` is missing, copy `runtime/config.example.json` and ask the user to fill in the real space URL and bot names before continuing.

### 2. Open Google Chat

Use browser tools to open the configured Google Chat space URL from `runtime/config.json`.

- If the user is not logged in, stop and tell them browser login is required.
- If the relevant spec thread replies are collapsed, expand them before extraction.

### 3. Extract snapshot JSON

Use the browser code in `scripts/extract_google_chat_messages.js`.
Save the returned JSON to:

```text
$PWD/.mailman/chat.json
```

Do not hand-edit the JSON structure. It must remain an array of objects with:

- `id`
- `threadName`
- `createTime`
- `senderDisplayName`
- `text`

### 4. Import into Mailman

Run:

```bash
MAILMAN_HOME="$PWD/.mailman" \
MAILMAN_DRIVER=snapshot \
MAILMAN_SNAPSHOT_FILE="$PWD/.mailman/chat.json" \
bash scripts/import_snapshot.sh <space-alias>
```

### 5. Show latest threads

Run:

```bash
MAILMAN_HOME="$PWD/.mailman" bash runtime/fetch.sh <space-alias> [bot-alias] [count]
```

## Notes

- Snapshot import only includes messages visible in the browser session.
- Reply threads must be expanded before extraction or their replies may be omitted.
- Prefer the workspace-local `.mailman/` directory inside sandbox sessions.
