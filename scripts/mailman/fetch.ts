// 조회 필터는 스레드를 고를 때만 쓴다. 골라진 스레드 안에서는 사람/봇 답글을 모두 보여준다.
import type { Database } from "bun:sqlite";
import { renderCards } from "./cards";
import { displayText, matchesDefaultFilter } from "./content";
import { isRecord } from "./errors";
import { getMeta, type MessageRow } from "./store";

export type InboxOptions = { spaceKey: string; space: string; limit: number; all: boolean };
export type InboxThread = { name: string | null; messages: MessageRow[] };

function threadKey(message: Pick<MessageRow, "name" | "thread_name">): string {
  return message.thread_name ?? message.name;
}

export function queryThreads(db: Database, options: InboxOptions): InboxThread[] {
  const candidates = db.prepare<Pick<MessageRow, "name" | "thread_name" | "sender_type" | "text">, [string]>(
    "SELECT name,thread_name,sender_type,text FROM messages WHERE space=? ORDER BY create_time DESC, name DESC",
  );
  const selected = new Map<string, InboxThread>();
  // 최신 '필터 통과 메시지' 순으로 스레드를 선정한다. 필터 없는 답글로는 순위를 올리지 않는다.
  try {
    for (const row of candidates.iterate(options.space)) {
      if (!options.all && !matchesDefaultFilter(row.sender_type, row.text)) continue;
      const key = threadKey(row);
      if (!selected.has(key)) selected.set(key, { name: row.thread_name, messages: [] });
      if (selected.size >= options.limit) break;
    }
  } finally { candidates.finalize(); }
  // 고른 스레드만 본문/첨부/raw를 읽는다. 작은 조회에서 DB 전체를 메모리에 올리지 않는다.
  const threadMessages = db.query<MessageRow, [string, string]>(
    "SELECT * FROM messages WHERE space=? AND thread_name=? ORDER BY create_time ASC, name ASC",
  );
  const standalone = db.query<MessageRow, [string, string]>(
    "SELECT * FROM messages WHERE space=? AND name=? AND thread_name IS NULL",
  );
  for (const [key, thread] of selected) {
    thread.messages = thread.name ? threadMessages.all(options.space, thread.name) : standalone.all(options.space, key);
  }
  return [...selected.values()];
}

function attachmentNames(json: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map(item => [item.contentName, item.contentType, item.name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "이름 없음");
}

function renderMessage(row: MessageRow): string {
  const text = displayText(row.sender_type, row.text);
  const attachments = attachmentNames(row.attachments_json);
  const lines: string[] = [];
  if (text) lines.push(text);
  lines.push(...renderCards(row.raw_json));
  if (attachments.length > 0) lines.push(`(첨부: ${attachments.join(", ")})`);
  return lines.join("\n\n") || "(본문 없음)";
}

export function renderInbox(db: Database, options: InboxOptions): string {
  const threads = queryThreads(db, options);
  const output: string[] = [];
  if (threads.length === 0) {
    output.push(`[${options.spaceKey}] 조회 조건에 맞는 수집된 메시지가 없습니다.`);
  } else {
    output.push(`[${options.spaceKey}] 최근 ${threads.length}개 스레드 (최신순${options.all ? ", 전체 메시지" : ""}):\n`);
    for (const thread of threads) {
      const first = thread.messages[0]!;
      const sender = first.sender_display_name || first.sender_name || "(이름 비공개)";
      output.push(`## ${first.create_time} — ${sender}`);
      output.push(`- thread_name: \`${thread.name ?? "(없음)"}\``);
      output.push(`- 첫 메시지 name (DB 기준): \`${first.name}\``);
      output.push(`- 스레드 메시지: ${thread.messages.length}개\n`);
      for (let index = 0; index < thread.messages.length; index++) {
        const message = thread.messages[index]!;
        const author = message.sender_display_name || message.sender_name || "(이름 비공개)";
        if (index > 0) output.push(`\n↳ ${message.create_time} — ${author} (${message.sender_type ?? "UNKNOWN"})\n`);
        output.push(renderMessage(message));
      }
      output.push("\n---\n");
    }
  }
  output.push("## 메타");
  output.push(`- 마지막 성공 수집: ${getMeta(db, `lastSync:${options.space}`) ?? "(기록 없음)"}`);
  output.push(`- 수집 createTime 커서: ${getMeta(db, `lastCreateTime:${options.space}`) ?? "(기록 없음)"}`);
  return output.join("\n");
}
