// claude-mailman: 수집된 메시지를 slash command 용 markdown 으로 출력 (멀티 스페이스 지원)
//
// 사용: bun run fetch.ts [스페이스별칭] [봇별칭] [개수]
//   인자 순서 자유. 스페이스 별칭 생략 시 defaultSpace.
//   개수 생략 시 5. 봇 별칭 생략 시 해당 스페이스의 모든 메시지.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { getRuntimePaths, loadConfig } from "./runtime";

const paths = getRuntimePaths(import.meta.url);
const config = loadConfig(paths.scriptDir);
const spaces: Record<string, { bots?: Record<string, string>; defaultBot?: string }> = config.spaces ?? {};

// 인자 파싱: [스페이스별칭] [봇별칭] [개수] — 순서 자유
const args = process.argv.slice(2);
let spaceKey = "";
let botDisplayName = "";
let limit = 5;

for (const a of args) {
  if (/^\d+$/.test(a)) {
    limit = Math.max(1, Math.min(50, Number(a)));
  } else if (spaces[a]) {
    spaceKey = a;
  } else {
    // 각 스페이스의 bots에서 별칭 검색
    for (const [sk, sv] of Object.entries(spaces)) {
      if (sv.bots?.[a]) {
        botDisplayName = sv.bots[a]!;
        if (!spaceKey) spaceKey = sk; // 봇 별칭으로 스페이스도 유추
        break;
      }
    }
  }
}

if (!spaceKey) spaceKey = config.defaultSpace ?? Object.keys(spaces)[0] ?? "";
const space = spaces[spaceKey];

// 스페이스 내 봇 별칭으로 봇 이름 결정
if (!botDisplayName && space?.bots) {
  for (const a of args) {
    if (space.bots[a]) {
      botDisplayName = space.bots[a]!;
      break;
    }
  }
}

if (!existsSync(paths.dbPath)) {
  console.log("수집된 데이터가 없습니다. 먼저 `bash ./scripts/mailman/run.sh` 를 실행하세요.");
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

// space 컬럼 존재 여부 확인
let hasSpaceColumn = false;
try {
  const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
  hasSpaceColumn = cols.some((c) => c.name === "space");
} catch {
  // 무시
}

// 스페이스 + 봇 필터로 최신 thread N개
const conditions: string[] = [];
const params: Array<string | number> = [];

if (hasSpaceColumn && spaceKey) {
  conditions.push("space = ?");
  params.push(spaceKey);
}
if (botDisplayName) {
  conditions.push("sender_display_name = ?");
  params.push(botDisplayName);
}

const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

const threadQuery = `
  SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time
  FROM messages
  ${whereClause}
  GROUP BY tid
  ORDER BY last_time DESC
  LIMIT ?
`;
params.push(limit);

const threadRows = db.prepare(threadQuery).all(...params) as Array<{ tid: string; last_time: string }>;

if (threadRows.length === 0) {
  const spaceName = spaceKey || "(전체)";
  console.log(
    `[${spaceName}] 수집된 메시지가 없습니다. 로그인 세션이 살아있는지, 스페이스 설정이 맞는지 확인하세요.`,
  );
  process.exit(0);
}

const msgStmt = db.prepare(
  `SELECT id, createTime, sender_display_name, text, thread_name
   FROM messages
   WHERE COALESCE(thread_name, id) = ?
   ORDER BY createTime ASC`,
);

const spaceName = spaceKey || "(전체)";
console.log(`[${spaceName}] 최근 ${threadRows.length}개 스레드 (최신순):\n`);

for (const t of threadRows) {
  const msgs = msgStmt.all(t.tid) as Row[];
  if (msgs.length === 0) continue;

  const first = msgs[0]!;
  const sender = first.sender_display_name ?? "(unknown)";
  console.log(`## ${first.createTime} — ${sender}`);
  if (msgs.length > 1) {
    console.log(`(스레드: ${msgs.length}개 메시지)`);
  }
  console.log();

  console.log(first.text.trim());

  for (let i = 1; i < msgs.length; i++) {
    const m = msgs[i]!;
    console.log(`\n↳ ${m.createTime}`);
    console.log();
    console.log(m.text.trim());
  }

  console.log("\n---\n");
}

// 메타 정보: 마지막 수집 성공 시각 표시
// (수집 자체가 실패해도 옛 DB 내용을 그대로 출력하는 구조라
//  사용자가 "결과가 오래됐는지" 알아채기 어렵기 때문에 노출)
try {
  const metaStmt = db.prepare("SELECT value FROM meta WHERE key = ?");
  const spaceKeyName = spaceKey ? `lastSync:${spaceKey}` : "";
  const spaceSync = spaceKeyName
    ? (metaStmt.get(spaceKeyName) as { value: string } | undefined)
    : undefined;
  const globalSync = metaStmt.get("lastSync") as
    | { value: string }
    | undefined;
  const lastSync = spaceSync?.value ?? globalSync?.value ?? null;

  console.log("## 메타");
  if (lastSync) {
    const ageMs = Date.now() - new Date(lastSync).getTime();
    const ageMinutes = Math.floor(ageMs / 60000);
    const ageHours = Math.floor(ageMinutes / 60);
    const ageDays = Math.floor(ageHours / 24);
    let ageLabel: string;
    if (ageDays >= 1) ageLabel = `${ageDays}일 전`;
    else if (ageHours >= 1) ageLabel = `${ageHours}시간 전`;
    else if (ageMinutes >= 1) ageLabel = `${ageMinutes}분 전`;
    else ageLabel = "방금";

    const stale = ageMs > 24 * 60 * 60 * 1000; // 24시간 초과면 stale 표시
    console.log(`- 마지막 성공 수집: ${lastSync} (${ageLabel})`);
    if (stale) {
      console.log(
        "- ⚠️ 결과가 오래됐을 수 있습니다. 위 stderr 메시지로 수집 실패 여부를 확인하거나 `bash ~/.claude/scripts/mailman/run.sh auth` 로 세션을 갱신하세요.",
      );
    }
  } else {
    console.log("- 마지막 성공 수집: (기록 없음)");
  }
} catch {
  // 메타 조회 실패는 무시 (출력 자체엔 영향 없음)
}
