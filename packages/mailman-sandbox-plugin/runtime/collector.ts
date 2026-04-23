import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { ensureDataDirs, fileExists, getRuntimePaths, loadConfig, resolveBotDisplayName, resolveSpace } from "./runtime";
import { parseSnapshotJson } from "./snapshot";

const paths = getRuntimePaths(import.meta.url);
const config = loadConfig(paths.scriptDir);
const requestedSpaceKey = process.argv[2] ?? "";
const { spaceKey, space } = resolveSpace(config, requestedSpaceKey);
const botName = resolveBotDisplayName(space);
const snapshotFile = process.env.MAILMAN_SNAPSHOT_FILE || "";

if (!snapshotFile) {
  console.error("[mailman] MAILMAN_SNAPSHOT_FILE 이 필요합니다.");
  process.exit(1);
}

if (!fileExists(snapshotFile)) {
  console.error(`[mailman] snapshot 파일을 찾을 수 없습니다: ${snapshotFile}`);
  process.exit(1);
}

ensureDataDirs(paths);

const db = new Database(paths.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    createTime TEXT NOT NULL,
    sender_name TEXT,
    sender_display_name TEXT,
    sender_type TEXT,
    text TEXT NOT NULL,
    thread_name TEXT,
    space TEXT,
    fetched_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_createTime ON messages(createTime DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_display_name ON messages(sender_display_name);
  CREATE INDEX IF NOT EXISTS idx_messages_space ON messages(space);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

try {
  db.exec("ALTER TABLE messages ADD COLUMN space TEXT;");
} catch {
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
  (id, createTime, sender_name, sender_display_name, sender_type, text, thread_name, space, fetched_at, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = new Date().toISOString();
const messages = parseSnapshotJson(readFileSync(snapshotFile, "utf8")).filter((message) =>
  botName ? message.senderDisplayName.includes(botName) : true
);

let inserted = 0;
for (const message of messages) {
  const r = insertStmt.run(
    message.id,
    message.createTime,
    null,
    message.senderDisplayName,
    "BOT",
    message.text,
    message.threadName,
    spaceKey,
    now,
    JSON.stringify({ source: "snapshot-import", snapshotFile, space: spaceKey, ...message })
  );
  if (r.changes > 0) inserted++;
}

db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSync', ?)").run(now);
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`lastSync:${spaceKey}`, now);

console.error(`[mailman] driver="snapshot" space="${spaceKey}" scanned=${messages.length} inserted=${inserted} bot="${botName}" url=${space.url}`);
