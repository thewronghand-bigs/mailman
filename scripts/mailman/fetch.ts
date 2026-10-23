// seen 커서 이후의 메시지를 먼저 고른 뒤, 필요한 이전 맥락만 스레드별로 붙인다.
import type { Database } from "bun:sqlite";
import { renderCards } from "./cards";
import { isRecord } from "./errors";
import { getMeta, setMeta, type MessageRow } from "./store";
import { normalizeTime } from "./time";

export const MAX_NEW_MESSAGES = 200;
const MAX_CONTEXT_MESSAGES = 5;
export type SenderType = "BOT" | "HUMAN";
// only: 새 메시지를 해당 발신자 유형으로만 거른다. 이전 맥락은 유형과 무관하게 붙인다.
export type InboxOptions = { spaceKey: string; space: string; since?: string; only?: SenderType; now?: Date };
export type InboxThread = {
  name: string | null;
  firstMessageName: string;
  messages: MessageRow[];
  context: MessageRow[];
  omittedContext: number;
};
export type InboxPage = {
  threads: InboxThread[];
  newCount: number;
  remaining: number;
  lastNew?: Pick<MessageRow, "create_time" | "name">;
};

function threadKey(message: Pick<MessageRow, "name" | "thread_name">): string {
  return message.thread_name ?? message.name;
}

export function queryInbox(db: Database, options: InboxOptions): InboxPage {
  return db.transaction(() => {
    const seen = options.since === undefined ? getMeta(db, `seenCreateTime:${options.space}`) : undefined;
    const after = normalizeTime(options.since ?? seen ?? new Date((options.now ?? new Date()).getTime() - 86_400_000).toISOString());
    // 200건 경계에서 같은 시각의 메시지가 잘려도 다음 조회에서 이어서 보여준다.
    const afterName = seen ? getMeta(db, `seenMessageName:${options.space}`) ?? null : null;
    const params: Array<string | null> = [options.space, after, after, afterName];
    let condition = "space=? AND (create_time>? OR (create_time=? AND name>?))";
    if (options.only) {
      condition += " AND sender_type=?";
      params.push(options.only);
    }
    const total = db.query<{ count: number }, typeof params>(`SELECT COUNT(*) AS count FROM messages WHERE ${condition}`).get(...params)!.count;
    const messages = db.query<MessageRow, [...typeof params, number]>(
      `SELECT * FROM messages WHERE ${condition} ORDER BY create_time ASC, name ASC LIMIT ?`,
    ).all(...params, MAX_NEW_MESSAGES);
    const selected = new Map<string, InboxThread>();
    // 입력이 새 메시지 시각순이므로 Map도 스레드의 가장 이른 새 메시지 시각순이다.
    for (const row of messages) {
      const key = threadKey(row);
      let thread = selected.get(key);
      if (!thread) {
        thread = { name: row.thread_name, firstMessageName: row.name, messages: [], context: [], omittedContext: 0 };
        selected.set(key, thread);
      }
      thread.messages.push(row);
    }
    const previousCondition = "space=? AND thread_name=? AND (create_time<? OR (create_time=? AND name<?))";
    const previousMessages = db.query<MessageRow, [string, string, string, string, string, number]>(
      `SELECT * FROM messages WHERE ${previousCondition} ORDER BY create_time DESC, name DESC LIMIT ?`,
    );
    const previousCount = db.query<{ count: number }, [string, string, string, string, string]>(
      `SELECT COUNT(*) AS count FROM messages WHERE ${previousCondition}`,
    );
    const firstMessage = db.query<{ name: string }, [string, string]>(
      "SELECT name FROM messages WHERE space=? AND thread_name=? ORDER BY create_time ASC, name ASC LIMIT 1",
    );
    for (const thread of selected.values()) {
      if (thread.name === null) continue;
      const firstNew = thread.messages[0]!;
      const contextParams: [string, string, string, string, string] = [options.space, thread.name, firstNew.create_time, firstNew.create_time, firstNew.name];
      thread.context = previousMessages.all(...contextParams, MAX_CONTEXT_MESSAGES).reverse();
      thread.omittedContext = previousCount.get(...contextParams)!.count - thread.context.length;
      thread.firstMessageName = firstMessage.get(options.space, thread.name)!.name;
    }
    return { threads: [...selected.values()], newCount: messages.length, remaining: total - messages.length, lastNew: messages.at(-1) };
  })();
}

function attachmentNames(json: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map(item => [item.contentName, item.contentType, item.name]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "이름 없음");
}

function renderMessage(row: MessageRow): string {
  const text = row.text.trim();
  const attachments = attachmentNames(row.attachments_json);
  const lines: string[] = [];
  if (text) lines.push(text);
  lines.push(...renderCards(row.raw_json));
  if (attachments.length > 0) lines.push(`(첨부: ${attachments.join(", ")})`);
  return lines.join("\n\n") || "(본문 없음)";
}

function author(row: MessageRow): string {
  return row.sender_display_name || row.sender_name || "(이름 비공개)";
}

// 상한을 넘었을 때 다음 조회 방법. --only 조회는 seen을 바꾸지 않으므로 재실행해도 같은 메시지가 나온다.
function remainingHint(options: InboxOptions): string {
  if (options.since !== undefined) return "--since를 좁혀서 다시 조회하세요.";
  if (options.only !== undefined) return "--only 조회는 seen을 바꾸지 않아 다시 실행해도 같은 메시지가 나옵니다. --since를 지정하거나 좁혀서 조회하세요.";
  return "다시 실행하면 이어서 표시합니다.";
}

export function renderInbox(db: Database, options: InboxOptions, page = queryInbox(db, options)): string {
  const output: string[] = [];
  if (page.newCount === 0) {
    output.push(`[${options.spaceKey}] 새 메시지가 없습니다.${options.only ? ` (${options.only}만 조회)` : ""}`);
  } else {
    const filter = options.only ? ` (${options.only}만)` : "";
    output.push(`[${options.spaceKey}] 새 메시지 ${page.newCount}건${filter}, ${page.threads.length}개 스레드 (오래된 새 메시지부터):\n`);
    for (const thread of page.threads) {
      const firstNew = thread.messages[0]!;
      output.push(`## ${firstNew.create_time} — ${author(firstNew)}`);
      output.push(`- thread_name: \`${thread.name ?? "(없음)"}\``);
      output.push(`- 첫 메시지 name (DB 기준): \`${thread.firstMessageName}\``);
      output.push(`- 스레드 메시지: ${thread.context.length + thread.messages.length}개 (새 메시지 ${thread.messages.length}개, 이전 맥락 ${thread.context.length}개)\n`);
      if (thread.omittedContext > 0) output.push(`> 이전 맥락 ${thread.omittedContext}건 생략 (최근 ${thread.context.length}건 표시)\n`);
      for (const [label, messages] of [["이전 맥락", thread.context], ["새 메시지", thread.messages]] as const) {
        for (const message of messages) {
          output.push(`↳ ${message.create_time} — ${author(message)} (${message.sender_type ?? "UNKNOWN"}) [${label}]\n`);
          output.push(renderMessage(message), "");
        }
      }
      output.push("\n---\n");
    }
    if (page.remaining > 0) output.push(`${page.remaining}건 더 남음 — ${remainingHint(options)}\n`);
  }
  output.push("## 메타");
  if (options.only) output.push(`- 필터: ${options.only}만 표시 (seen 커서 유지)`);
  output.push(`- 마지막 성공 수집: ${getMeta(db, `lastSync:${options.space}`) ?? "(기록 없음)"}`);
  output.push(`- 수집 createTime 커서: ${getMeta(db, `lastCreateTime:${options.space}`) ?? "(기록 없음)"}`);
  return output.join("\n");
}

export async function printInbox(db: Database, options: InboxOptions, write: (text: string) => unknown): Promise<void> {
  const page = queryInbox(db, options);
  // 출력 완료(비동기 쓰기 포함)를 확인한 뒤에만 seen을 저장한다.
  await write(renderInbox(db, options, page));
  const last = page.lastNew;
  // 기간 조회와 --only 조회는 seen을 바꾸지 않는다. 거른 조회로 전진하면 거른 쪽 메시지가 기본 조회에서 영구히 빠진다.
  if (options.since !== undefined || options.only !== undefined || !last) return;
  db.transaction(() => {
    const timeKey = `seenCreateTime:${options.space}`;
    const nameKey = `seenMessageName:${options.space}`;
    const current = getMeta(db, timeKey);
    const currentName = getMeta(db, nameKey);
    // 다른 조회가 먼저 저장한 더 뒤의 커서를 되돌리지 않는다.
    if (current) {
      const currentTime = normalizeTime(current);
      if (currentTime > last.create_time || (currentTime === last.create_time && (!currentName || currentName >= last.name))) return;
    }
    setMeta(db, timeKey, last.create_time);
    setMeta(db, nameKey, last.name);
  }).immediate();
}
