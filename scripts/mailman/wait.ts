// 짧게 나누어 보낸 답장을 조용해진 뒤 한 묶음으로 보여 준다.
import type { Database } from "bun:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatClient } from "./chat";
import { collectMessages } from "./collector";
import { errorMessage, MailmanError, RequestError, throwIfAborted } from "./errors";
import { advanceSeen, groupMessages, renderInbox } from "./fetch";
import { getMeta, toRow, upsertRows, type MessageRow } from "./store";
import { nanosecondBefore, normalizeTime } from "./time";

export const MAX_BATCH_WAIT_MS = 10 * 60_000;
export const MAX_WAIT_MS = 2 * 60 * 60_000;
export const MAX_FAILURE_MS = 5 * 60_000;
export const WAIT_DEFAULTS = { quietMs: 60_000, timeoutMs: 30 * 60_000, intervalMs: 15_000 };
export type WaitClock = { now: () => number; sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void> };
export const realClock: WaitClock = {
  now: Date.now,
  sleep: async (milliseconds, signal) => {
    try {
      for (let remaining = milliseconds; remaining > 0;) {
        const chunk = Math.min(remaining, 60_000);
        await delay(chunk, undefined, { signal });
        remaining -= chunk;
      }
    }
    catch { throwIfAborted(signal); throw new MailmanError("대기 타이머에 실패했습니다."); }
  },
};

export type WaitOptions = {
  space: string;
  spaceKey: string;
  startTime: string;
  self: string;
  otherSelf?: string;
  from?: string;
  thread?: string;
  quietMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
  backfillDays?: number;
  signal?: AbortSignal;
  warn?: (text: string) => void;
};

export function parseDuration(value: string, flag: string): number {
  const match = /^([1-9]\d*)(s|m|h)$/.exec(value);
  const milliseconds = match ? Number(match[1]) * (match[2] === "s" ? 1000 : match[2] === "m" ? 60_000 : 3_600_000) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new MailmanError(`${flag}는 15s, 30m, 1h 같은 양의 정수 기간이어야 합니다.`);
  if (flag === "--timeout" && milliseconds > MAX_WAIT_MS) throw new MailmanError("--timeout은 최대 2시간(2h)입니다.");
  return milliseconds;
}

type WaitClient = Pick<ChatClient, "listMessages"> & Partial<Pick<ChatClient, "findDirectMessage">>;

// 폴링의 여러 페이지와 토큰 갱신도 전체/묶음 제한을 넘겨 대기를 늘릴 수 없게 한다.
async function withinDeadline<T>(request: (signal: AbortSignal) => Promise<T>, deadline: number, clock: WaitClock, external?: AbortSignal): Promise<T> {
  throwIfAborted(external);
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new MailmanError("대기 제한 시간에 도달했습니다.", 4);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new MailmanError("대기 제한 시간에 도달했습니다.", 4)), Math.min(remaining, 2_147_483_647));
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  let onAbort = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { try { throwIfAborted(signal); } catch (error: unknown) { reject(error); } };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([request(signal), interrupted]);
    throwIfAborted(signal);
    if (clock.now() > deadline) throw new MailmanError("대기 제한 시간에 도달했습니다.", 4);
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function isDeadline(error: unknown): boolean { return error instanceof MailmanError && error.exitCode === 4; }

// SQLite의 create_time/name BINARY 정렬과 같은 순서를 쓴다. localeCompare는 대소문자 순서가 다르다.
function compareRows(left: MessageRow, right: MessageRow): number {
  for (const key of ["create_time", "name"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export async function waitForReplies(db: Database, client: WaitClient, options: WaitOptions,
  write: (text: string) => unknown, clock: WaitClock = realClock): Promise<number> {
  const { quietMs = WAIT_DEFAULTS.quietMs, timeoutMs = WAIT_DEFAULTS.timeoutMs, intervalMs = WAIT_DEFAULTS.intervalMs } = options;
  for (const value of [quietMs, timeoutMs, intervalMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new MailmanError("대기 시간은 양의 정수 밀리초여야 합니다.");
  }
  if (timeoutMs > MAX_WAIT_MS) throw new MailmanError("--timeout은 최대 2시간(2h)입니다.");
  const start = normalizeTime(options.startTime);
  const enteredAt = clock.now();
  const deadline = enteredAt + timeoutMs;
  let firstReplyAt: number | undefined;
  let lastReplyAt: number | undefined;
  const budget = () => firstReplyAt === undefined ? deadline : Math.min(deadline, firstReplyAt + MAX_BATCH_WAIT_MS);
  const limited: WaitClient = {
    listMessages: async (space, after, maxPages) => {
      let failedAt: number | undefined;
      let attempts = 0;
      for (;;) {
        const failureDeadline = failedAt === undefined ? Infinity : failedAt + MAX_FAILURE_MS;
        try {
          return await withinDeadline(signal => client.listMessages(space, after, maxPages, signal), Math.min(budget(), failureDeadline), clock, options.signal);
        } catch (error: unknown) {
          throwIfAborted(options.signal);
          if (isDeadline(error) && failureDeadline <= budget() && clock.now() >= failureDeadline) {
            throw new MailmanError("API 연속 실패가 5분을 넘어 대기를 종료합니다.", 3);
          }
          if (isDeadline(error) && failedAt !== undefined) throw new MailmanError("API 오류를 재시도하던 중 대기 제한 시간에 도달했습니다.", 3);
          if (!(error instanceof RequestError) || !(error.status === undefined || error.status === 429 || error.status >= 500 && error.status <= 599)) throw error;
          failedAt ??= clock.now();
          if (clock.now() >= failedAt + MAX_FAILURE_MS) throw new MailmanError("API 연속 실패가 5분을 넘어 대기를 종료합니다.", 3);
          const pause = Math.min(intervalMs * 2 ** Math.min(attempts++, 6), 60_000, budget() - clock.now(), failedAt + MAX_FAILURE_MS - clock.now());
          if (pause <= 0) throw new MailmanError("API 오류를 재시도할 대기 시간이 남지 않았습니다.", 3);
          (options.warn ?? console.error)(`[mailman] 대기 API 오류: ${errorMessage(error)} ${pause / 1000}초 후 재시도합니다.`.replace(/[\r\n\x00-\x1f\x7f]+/g, " "));
          await clock.sleep(pause, options.signal);
        }
      }
    },
  };
  const self = new Set([options.self, ...(options.otherSelf ? [options.otherSelf] : [])]);
  const eligible = (row: MessageRow): boolean => !self.has(row.sender_name ?? "") &&
    (!options.thread || row.thread_name === options.thread) && (!options.from || row.sender_type !== "BOT" && row.sender_name === options.from);
  const seen = getMeta(db, `seenCreateTime:${options.space}`);
  const after = normalizeTime(seen ?? new Date(Date.parse(start) - 86_400_000).toISOString());
  const afterName = seen ? getMeta(db, `seenMessageName:${options.space}`) ?? null : null;
  const replies = new Map<string, MessageRow>();
  const acceptReplies = (rows: MessageRow[], through: string) => {
    for (const row of rows) {
      if (row.create_time <= start || row.create_time > through || !eligible(row)) continue;
      if (!replies.has(row.name)) {
        firstReplyAt ??= clock.now();
        lastReplyAt = clock.now();
      }
      replies.set(row.name, row);
    }
  };
  let cursor = { create_time: start, name: "" };
  const boundaryNames = new Set<string>();
  const advancePoll = (rows: MessageRow[]) => {
    for (const row of rows) {
      if (row.create_time > cursor.create_time) { cursor = row; boundaryNames.clear(); }
      if (row.create_time === cursor.create_time) {
        boundaryNames.add(row.name);
        if (row.name > cursor.name) cursor = row;
      }
    }
  };
  let reason = "조용해진 뒤 묶음";
  let failure: MailmanError | undefined;
  try {
    throwIfAborted(options.signal);
    // 실행 전 안 읽은 메시지도 보충한다. 폴링으로 수집 커서를 건너뛰지 않는다.
    await collectMessages(db, limited, options.space, { deep: false, backfillDays: options.backfillDays ?? 7, now: new Date(enteredAt) });
    throwIfAborted(options.signal);
    const collected = db.query<MessageRow, [string, string]>("SELECT * FROM messages WHERE space=? AND create_time>? ORDER BY create_time, name").all(options.space, start);
    acceptReplies(collected, normalizeTime(new Date(deadline).toISOString()));
    advancePoll(collected);
    for (;;) {
      throwIfAborted(options.signal);
      const acceptThrough = normalizeTime(new Date(budget()).toISOString());
      const messages = await limited.listMessages(options.space, cursor.create_time === start ? start : nanosecondBefore(cursor.create_time));
      throwIfAborted(options.signal);
      const rows = messages.map(message => toRow(message, options.space, new Date(clock.now()).toISOString()))
        .filter(row => row.create_time > cursor.create_time || row.create_time === cursor.create_time && !boundaryNames.has(row.name));
      db.transaction(() => upsertRows(db, rows))();
      acceptReplies(rows, acceptThrough);
      advancePoll(rows);
      throwIfAborted(options.signal);
      const now = clock.now();
      const batchDeadline = budget();
      const quietDeadline = lastReplyAt === undefined ? deadline : lastReplyAt + quietMs;
      if (now >= Math.min(batchDeadline, quietDeadline)) {
        if (replies.size && now < quietDeadline) reason = now >= deadline ? "전체 대기 제한으로 묶음" : "최대 묶음 대기로 묶음";
        break;
      }
      await clock.sleep(Math.min(intervalMs, batchDeadline - now, quietDeadline - now), options.signal);
    }
  } catch (error: unknown) {
    throwIfAborted(options.signal);
    if (isDeadline(error)) reason = clock.now() >= deadline ? "전체 대기 제한으로 묶음" : "최대 묶음 대기로 묶음";
    else { failure = error instanceof MailmanError ? error : new MailmanError(errorMessage(error), 3); reason = "대기 오류로 받은 답장까지 묶음"; }
  }
  throwIfAborted(options.signal);
  const previous = db.query<MessageRow, [string, string, string, string | null, string]>(
    "SELECT * FROM messages WHERE space=? AND (create_time>? OR (create_time=? AND name>?)) AND create_time<=? ORDER BY create_time, name",
  ).all(options.space, after, after, afterName, start);
  // thread/from은 새 답장 판정에만 적용한다. 실행 전 안 읽은 다른 사람 메시지는 모두 보여 준다.
  const unread = previous.filter(row => !self.has(row.sender_name ?? ""));
  const orderedReplies = [...replies.values()].sort(compareRows);
  const output: string[] = [];
  const inboxOptions = { spaceKey: options.spaceKey, space: options.space };
  if (unread.length) {
    output.push("# 대기 전부터 있던 안 읽은 메시지", renderInbox(db, inboxOptions, groupMessages(db, options.space, unread)));
  }
  if (orderedReplies.length) {
    output.push(`# 답장 ${orderedReplies.length}건(${reason})`, renderInbox(db, inboxOptions, groupMessages(db, options.space, orderedReplies)));
  } else output.push("답장 없음");
  if (options.from || options.thread) output.push("필터가 있는 대기는 seen 커서를 유지합니다.");
  if (failure !== undefined) output.push(`대기 실패: ${errorMessage(failure)} seen 커서를 유지합니다.`);
  throwIfAborted(options.signal);
  await write(output.join("\n\n"));
  // 출력 도중 중단되어도 seen은 그대로 둔다.
  throwIfAborted(options.signal);
  if (failure === undefined && !options.from && !options.thread) {
    const displayed = [...unread, ...orderedReplies].sort(compareRows);
    const last = displayed.at(-1);
    if (last) advanceSeen(db, options.space, last);
  }
  if (failure !== undefined) throw failure;
  return orderedReplies.length ? 0 : 4;
}
