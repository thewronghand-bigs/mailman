# Mailman Sandbox Plugin

Standalone distributable Codex plugin for importing Google Chat messages into Mailman from sandbox sessions.

Once installed, the short skill name `mailman` is available in addition to `mailman-sandbox`.

## Structure

- `.codex-plugin/plugin.json`: plugin manifest
- `skills/mailman-sandbox/SKILL.md`: Codex workflow
- `scripts/extract_google_chat_messages.js`: browser extraction snippet
- `scripts/import_snapshot.sh`: snapshot import wrapper
- `runtime/`: bundled Mailman snapshot runtime

## Quick start

```bash
cd runtime
cp config.example.json config.json
bun install
```

Then in a sandboxed workspace:

```bash
export MAILMAN_HOME="$PWD/.mailman"
mkdir -p "$MAILMAN_HOME"
```

Use browser tools to open Google Chat, extract JSON to `$PWD/.mailman/chat.json`, then:

```bash
MAILMAN_HOME="$PWD/.mailman" \
MAILMAN_SNAPSHOT_FILE="$PWD/.mailman/chat.json" \
bash scripts/import_snapshot.sh myspace
```

Read latest threads:

```bash
MAILMAN_HOME="$PWD/.mailman" bash runtime/fetch.sh myspace specbot 3
```
