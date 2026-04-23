import { Database } from "bun:sqlite";
import { fileExists, getRuntimePaths, loadConfig } from "./runtime";

const paths = getRuntimePaths(import.meta.url);
const config = loadConfig(paths.scriptDir);
const spaces: Record<string, { bots?: Record<string, string>; defaultBot?: string }> = config.spaces ?? {};

const args = process.argv.slice(2);
let spaceKey = "";
let botDisplayName = "";
let limit = 5;

for (const arg of args) {
  if (/^\d+$/.test(arg)) {
    limit = Math.max(1, Math.min(50, Number(arg)));
  } else if (spaces[arg]) {
    spaceKey = arg;
  } else {
    for (const [candidateSpaceKey, candidateSpace] of Object.entries(spaces)) {
      if (candidateSpace.bots?.[arg]) {
        botDisplayName = candidateSpace.bots[arg]!;
        if (!spaceKey) spaceKey = candidateSpaceKey;
        break;
      }
    }
  }
}

if (!spaceKey) spaceKey = config.defaultSpace ?? Object.keys(spaces)[0] ?? "";
const space = spaces[spaceKey];

if (!botDisplayName && space?.bots) {
  for (const arg of args) {
    if (space.bots[arg]) {
      botDisplayName = space.bots[arg]!;
      break;
    }
  }
}

if (!fileExists(paths.dbPath)) {
  console.log("수집된 데이터가 없습니다. 먼저 `bash ./runtime/run.sh` 를 실행하세요.");
  process.exit(0);
}

type Row = {
  id: string;
  createTime: string;
  sender_display_name: string | null;
  text: string;
  thread_name: string | null;
};

const db = new Database(paths.dbPath, { readonly: true });
const conditions: string[] = [];
const params: Array<string | number> = [];

conditions.push("space = ?");
params.push(spaceKey);

if (botDisplayName) {
  conditions.push("sender_display_name = ?");
  params.push(botDisplayName);
}

const threadQuery = `
  SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time
  FROM messages
  WHERE ${conditions.join(" AND ")}
  GROUP BY tid
  ORDER BY last_time DESC
  LIMIT ?
`;
params.push(limit);

const threadRows = db.prepare(threadQuery).all(...params) as Array<{ tid: string; last_time: string }>;

if (threadRows.length === 0) {
  console.log(`[${spaceKey || "(전체)"}] 수집된 메시지가 없습니다. snapshot 추출과 space 설정을 확인하세요.`);
  process.exit(0);
}

const msgStmt = db.prepare(
  `SELECT id, createTime, sender_display_name, text, thread_name
   FROM messages
   WHERE COALESCE(thread_name, id) = ?
   ORDER BY createTime ASC`
);

console.log(`[${spaceKey}] 최근 ${threadRows.length}개 스레드 (최신순):\n`);

for (const thread of threadRows) {
  const messages = msgStmt.all(thread.tid) as Row[];
  if (messages.length === 0) continue;

  const first = messages[0]!;
  const sender = first.sender_display_name ?? "(unknown)";
  console.log(`## ${first.createTime} — ${sender}`);
  if (messages.length > 1) {
    console.log(`(스레드: ${messages.length}개 메시지)`);
  }
  console.log();
  console.log(first.text.trim());

  for (let i = 1; i < messages.length; i++) {
    const message = messages[i]!;
    console.log(`\n↳ ${message.createTime}`);
    console.log();
    console.log(message.text.trim());
  }

  console.log("\n---\n");
}
