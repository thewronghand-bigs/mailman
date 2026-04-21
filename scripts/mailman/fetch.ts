// claude-mailman: 수집된 메시지를 slash command 용 markdown 으로 출력
//
// 사용: bun run fetch.ts [limit]
//   limit: 기본 5 — top-level(thread) 기준 개수. 각 thread 의 답장은 모두 같이 출력됨.
//
// 렌더링 정책:
//   - thread_name 으로 그룹핑 (Google Chat topic = thread)
//   - 각 thread 안에서 createTime ASC (대화 흐름 순)
//   - thread 끼리는 thread 의 "최신 메시지 시각" DESC (최신 스레드 먼저)

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(readFileSync(`${SCRIPT_DIR}/config.json`, "utf8"));
const bots: Record<string, string> = config.bots ?? {};

const DB_PATH = `${homedir()}/.claude/inbox/mailman.db`;

// 인자 파싱: [별칭] [개수]  /  [개수]  /  [별칭]  /  (없음)
const args = process.argv.slice(2);
let botDisplayName = "";
let limit = 5;

for (const a of args) {
  if (bots[a]) {
    botDisplayName = bots[a]!;
  } else if (/^\d+$/.test(a)) {
    limit = Math.max(1, Math.min(50, Number(a)));
  }
}
if (!existsSync(DB_PATH)) {
  console.log("수집된 데이터가 없습니다. 먼저 `bash ~/.claude/scripts/mailman/run.sh` 를 실행하세요.");
  process.exit(0);
}

type Row = {
  id: string;
  createTime: string;
  sender_display_name: string | null;
  text: string;
  thread_name: string | null;
};

const db = new Database(DB_PATH, { readonly: true });

// 최신 thread N 개를 뽑기 위해, 먼저 각 thread 의 최대 createTime 으로 정렬
// botDisplayName 이 있으면 해당 발신자 메시지가 포함된 스레드만 필터
const threadQuery = botDisplayName
  ? `SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time
     FROM messages
     WHERE sender_display_name = ?
     GROUP BY tid
     ORDER BY last_time DESC
     LIMIT ?`
  : `SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time
     FROM messages
     GROUP BY tid
     ORDER BY last_time DESC
     LIMIT ?`;

const threadRows = (
  botDisplayName
    ? db.prepare(threadQuery).all(botDisplayName, limit)
    : db.prepare(threadQuery).all(limit)
) as Array<{ tid: string; last_time: string }>;

if (threadRows.length === 0) {
  console.log(
    "수집된 메시지가 없습니다. 로그인 세션이 살아있는지, MAILMAN_SPACE_URL 이 맞는지 확인하세요.",
  );
  process.exit(0);
}

const msgStmt = db.prepare(
  `SELECT id, createTime, sender_display_name, text, thread_name
   FROM messages
   WHERE COALESCE(thread_name, id) = ?
   ORDER BY createTime ASC`,
);

console.log(`최근 ${threadRows.length}개 스레드 (최신순):\n`);

for (const t of threadRows) {
  const msgs = msgStmt.all(t.tid) as Row[];
  if (msgs.length === 0) continue;

  // 스레드 헤더
  const first = msgs[0]!;
  const sender = first.sender_display_name ?? "(unknown)";
  console.log(`## ${first.createTime} — ${sender}`);
  if (msgs.length > 1) {
    console.log(`(스레드: ${msgs.length}개 메시지)`);
  }
  console.log();

  // 첫 메시지 본문
  console.log(first.text.trim());

  // 답장들 (있다면)
  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    console.log(`\n↳ ${m.createTime}`);
    console.log();
    console.log(m.text.trim());
  }

  console.log("\n---\n");
}
