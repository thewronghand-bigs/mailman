// claude-mailman: 수집된 메시지를 slash command 용 markdown 으로 출력
//
// 사용:
//   bun run fetch.ts              → 최신 스레드 1개
//   bun run fetch.ts 2738-2       → [2738-2] 식별자로 시작하는 스레드 1개 (없으면 빈 결과)
//   bun run fetch.ts 2738         → [2738-*] 로 시작하는 스레드 중 최신 1개 (시퀀스 생략 허용)
//   bun run fetch.ts 5            → 최신 스레드 5개 (숫자 단독, 구버전 호환)
//
// 식별자 포맷:
//   - 메시지 본문 선두에 `[티켓-시퀀스]` 가 붙어온다. 예: `[2738-1]`, `[2738-2]`
//   - 대괄호 내부 공백 및 대괄호 주변 공백 모두 허용.

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const DB_PATH = `${homedir()}/.claude/inbox/mailman.db`;
const arg = (process.argv[2] ?? "").trim();

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

const msgStmt = db.prepare(
  `SELECT id, createTime, sender_display_name, text, thread_name
   FROM messages
   WHERE COALESCE(thread_name, id) = ?
   ORDER BY createTime ASC`,
);

// 인자 해석
type Mode =
  | { kind: "latest"; limit: number }
  | { kind: "ticket"; ticket: string; sequence: string | null };

const parseArg = (raw: string): Mode => {
  if (!raw) return { kind: "latest", limit: 1 };

  // 티켓-시퀀스 식별자: 숫자-숫자 or 숫자 단독 (단, 단독 숫자는 limit 와 모호하므로
  // 뒤에 "-숫자" 가 붙은 경우에만 식별자로 간주. 그냥 숫자만 오면 limit 로 처리.)
  const fullMatch = raw.match(/^(\d+)-(\d+)$/);
  if (fullMatch) {
    return { kind: "ticket", ticket: fullMatch[1]!, sequence: fullMatch[2]! };
  }
  if (/^\d+$/.test(raw)) {
    return { kind: "latest", limit: Math.max(1, Math.min(50, Number(raw))) };
  }

  // 티켓-only ("T2738" 같은 변형) 는 이번 스펙에 없음. fallback: latest 1.
  return { kind: "latest", limit: 1 };
};

const mode = parseArg(arg);

const threadIdsToFetch: string[] = [];

if (mode.kind === "latest") {
  const rows = db
    .prepare(
      `SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time
       FROM messages
       GROUP BY tid
       ORDER BY last_time DESC
       LIMIT ?`,
    )
    .all(mode.limit) as Array<{ tid: string; last_time: string }>;
  threadIdsToFetch.push(...rows.map((r) => r.tid));
} else {
  // 티켓 식별자 매칭: 각 스레드의 "첫 메시지 본문"이 [TICKET-SEQUENCE] 로 시작하는지 검사.
  // SQL LIKE 로 우선 필터한 뒤, 코드에서 정규식으로 엄격히 재검사.
  const likePattern = `%[${mode.ticket}-${mode.sequence}]%`;
  const candidates = db
    .prepare(
      `SELECT COALESCE(thread_name, id) AS tid, MAX(createTime) AS last_time, text
       FROM messages
       WHERE text LIKE ?
       GROUP BY tid
       ORDER BY last_time DESC`,
    )
    .all(likePattern) as Array<{ tid: string; last_time: string; text: string }>;

  const re = new RegExp(
    `^\\s*\\[\\s*${mode.ticket}\\s*-\\s*${mode.sequence}\\s*\\]`,
  );
  for (const c of candidates) {
    // 각 스레드의 첫 메시지 본문이 식별자로 시작하는지 확인
    const first = msgStmt.all(c.tid) as Row[];
    if (first.length > 0 && re.test(first[0]!.text)) {
      threadIdsToFetch.push(c.tid);
      break; // 가장 최신 1개만
    }
  }
}

if (threadIdsToFetch.length === 0) {
  if (mode.kind === "ticket") {
    console.log(
      `[${mode.ticket}-${mode.sequence}] 식별자를 가진 메시지를 찾지 못했습니다. 아직 도착 전이거나 collector 수집이 실패했을 수 있습니다.`,
    );
  } else {
    console.log(
      "수집된 메시지가 없습니다. 로그인 세션이 살아있는지, MAILMAN_SPACE_URL 이 맞는지 확인하세요.",
    );
  }
  process.exit(0);
}

const header =
  mode.kind === "ticket"
    ? `[${mode.ticket}-${mode.sequence}] 식별자로 매칭된 스레드:\n`
    : `최근 ${threadIdsToFetch.length}개 스레드 (최신순):\n`;
console.log(header);

for (const tid of threadIdsToFetch) {
  const msgs = msgStmt.all(tid) as Row[];
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
