// 전부 받은 뒤 하나의 트랜잭션으로 저장한다. 실패/페이지 상한에서는 증분 커서를 전진시키지 않는다.
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatClient } from "./chat";
import { errorMessage } from "./errors";
import { getMeta, setMeta, toRow, upsertRows } from "./store";
import { normalizeTime } from "./time";

export type CollectOptions = { deep: boolean; backfillDays: number; now?: Date };

export async function collectMessages(db: Database, client: Pick<ChatClient, "listMessages">, space: string, options: CollectOptions) {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const cursorKey = `lastCreateTime:${space}`;
  const previous = getMeta(db, cursorKey);
  const after = !options.deep && previous
    ? normalizeTime(previous)
    : normalizeTime(new Date(now.getTime() - options.backfillDays * 86_400_000).toISOString());
  const messages = await client.listMessages(space, after);
  const rows = messages.map(message => toRow(message, space, fetchedAt));
  let cursor = previous ? normalizeTime(previous) : undefined;
  for (const row of rows) {
    if (!cursor || row.create_time > cursor) cursor = row.create_time;
  }
  const saved = db.transaction(() => {
    // 동시에 실행한 수집이 먼저 커서를 전진시켰을 수 있다.
    const current = getMeta(db, cursorKey);
    if (current && (!cursor || normalizeTime(current) > cursor)) cursor = normalizeTime(current);
    const count = upsertRows(db, rows);
    if (cursor) setMeta(db, cursorKey, cursor);
    setMeta(db, `lastSync:${space}`, fetchedAt);
    return count;
  })();
  return { space, received: messages.length, saved, after, cursor, fetchedAt };
}

function appendLog(logFile: string, line: string): void {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, line + "\n");
}

export function logCollection(logFile: string, result: { space: string; received: number; saved: number; fetchedAt: string }): void {
  appendLog(logFile, `[mailman] ${result.fetchedAt} space=${result.space} received=${result.received} saved=${result.saved}`);
}

export function logCollectionFailure(logFile: string, space: string, error: unknown): void {
  const message = errorMessage(error).replace(/[\r\n\x00-\x1f\x7f]+/g, " ");
  appendLog(logFile, `[mailman] ${new Date().toISOString()} space=${space} 수집 실패: ${message}`);
}

export function logWaitWarning(logFile: string, space: string, message: string): void {
  appendLog(logFile, `[mailman] ${new Date().toISOString()} space=${space} ${message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ")}`);
}
