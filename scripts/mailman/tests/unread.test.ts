import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ChatMessage } from "../chat";
import { collectMessages } from "../collector";
import { SEND_PREFIX } from "../content";
import { printInbox, queryInbox, renderInbox } from "../fetch";
import { getMeta, openDatabase, setMeta, toRow, upsertRows } from "../store";
import { normalizeTime, parseSince } from "../time";
import { message, SPACE, THREAD } from "./helpers";

const NOW = new Date("2026-10-22T12:00:00Z");
const OPTIONS = { spaceKey: "tn", space: SPACE, now: NOW };
const SEEN = `seenCreateTime:${SPACE}`;
const SEEN_NAME = `seenMessageName:${SPACE}`;

function save(db: Database, items: ChatMessage[]): void {
  upsertRows(db, items.map(item => toRow(item, SPACE, NOW.toISOString())));
}

function batch(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => message(`new-${String(index).padStart(3, "0")}`,
    new Date(NOW.getTime() - 3_600_000 + index * 1000).toISOString(), { text: `새 본문 ${index}` }));
}

describe("안 읽은 메시지와 seen 커서", () => {
  test("첫 조회는 24시간 이후의 모든 발신자를 표시하고 본문과 전송 태그를 그대로 둔다", async () => {
    const db = openDatabase(":memory:");
    try {
      const items = [
        message("old", "2026-10-21T11:59:59Z", { thread: undefined }),
        message("boundary", "2026-10-21T12:00:00Z", { thread: undefined }),
        message("human", "2026-10-21T12:00:00.000000001Z", { sender: { type: "HUMAN", displayName: "홍길동" }, text: "일반 사람 대화", thread: undefined }),
        message("bot", "2026-10-22T09:00:00Z", { sender: { type: "BOT", displayName: "알림봇" }, thread: undefined }),
        message("self", "2026-10-22T10:00:00Z", { sender: { type: "HUMAN" }, text: `${SEND_PREFIX}완료`, thread: undefined }),
        message("literal", "2026-10-22T11:00:00Z", { sender: { type: "HUMAN" }, text: "@mailman 예전 본문", thread: undefined }),
        message("unknown", "2026-10-22T11:30:00Z", { sender: undefined, thread: undefined }),
      ];
      save(db, items);
      const page = queryInbox(db, OPTIONS);
      expect(page.threads.flatMap(thread => thread.messages.map(row => row.name))).toEqual(items.slice(2).map(item => item.name));
      expect(page.newCount).toBe(5);
      expect(getMeta(db, SEEN)).toBeUndefined();
      let output = "";
      await printInbox(db, OPTIONS, text => {
        output = text;
        expect(getMeta(db, SEEN)).toBeUndefined();
      });
      expect(output).toContain("일반 사람 대화");
      expect(output).toContain("— 홍길동 (HUMAN) [새 메시지]");
      expect(output).toContain("— 알림봇 (BOT) [새 메시지]");
      expect(output).toContain(`${SEND_PREFIX}완료`);
      expect(output).toContain("@mailman 예전 본문");
      expect(output).toContain("(UNKNOWN) [새 메시지]");
      expect(getMeta(db, SEEN)).toBe(normalizeTime(items.at(-1)!.createTime));
    } finally { db.close(); }
  });

  test("기존 커서 이후만 새 메시지로 고르고 24시간보다 오래된 미조회 메시지도 포함한다", async () => {
    const db = openDatabase(":memory:");
    try {
      setMeta(db, SEEN, "2026-10-19T00:00:00Z");
      setMeta(db, "seenCreateTime:spaces/other", "2026-10-22T12:00:00Z");
      save(db, [
        message("before", "2026-10-18T23:59:59Z", { thread: undefined }),
        message("equal", "2026-10-19T00:00:00Z", { thread: undefined }),
        message("after", "2026-10-19T00:00:00.000000001Z", { thread: undefined }),
      ]);
      upsertRows(db, [toRow(message("other", "2026-10-22T11:00:00Z"), "spaces/other", NOW.toISOString())]);
      const page = queryInbox(db, OPTIONS);
      expect(page.newCount).toBe(1);
      expect(page.lastNew?.name).toBe(`${SPACE}/messages/after`);
      await printInbox(db, { ...OPTIONS, spaceKey: "같은방별칭" }, () => {});
      expect(getMeta(db, SEEN)).toBe("2026-10-19T00:00:00.000000001Z");
      expect(queryInbox(db, OPTIONS).newCount).toBe(0);
      expect(getMeta(db, "seenCreateTime:spaces/other")).toBe("2026-10-22T12:00:00Z");
    } finally { db.close(); }
  });

  test("오래된 스레드는 새 답글 직전의 최근 5건만 이전 맥락으로 표시하고 첫 메시지 name을 보존한다", () => {
    const db = openDatabase(":memory:");
    try {
      const old = Array.from({ length: 8 }, (_, index) => message(`old-${index}`, `2026-10-0${index + 1}T00:00:00Z`, { text: `이전 본문 ${index}` }));
      save(db, [...old, message("reply", "2026-10-22T09:00:00Z", { text: "새 답글" })]);
      const page = queryInbox(db, OPTIONS);
      expect(page.newCount).toBe(1);
      expect(page.threads[0]?.context.map(row => row.text)).toEqual(old.slice(3).map(item => item.text));
      expect(page.threads[0]?.omittedContext).toBe(3);
      const output = renderInbox(db, OPTIONS, page);
      expect(output).toContain(`thread_name: \`${THREAD}\``);
      expect(output).toContain(`첫 메시지 name (DB 기준): \`${old[0]!.name}\``);
      expect(output).toContain("이전 맥락 3건 생략");
      expect(output.match(/\[이전 맥락\]/g)).toHaveLength(5);
      expect(output.match(/\[새 메시지\]/g)).toHaveLength(1);
      expect(output.indexOf("이전 본문 3")).toBeLessThan(output.indexOf("이전 본문 7"));
      expect(output.indexOf("이전 본문 7")).toBeLessThan(output.indexOf("새 답글"));
      expect(output).not.toContain("이전 본문 0");
    } finally { db.close(); }
  });

  test("스레드는 가장 이른 새 메시지순, 내부는 시간순이며 커서는 출력 순서와 무관한 최대 시각이다", async () => {
    const db = openDatabase(":memory:");
    try {
      const thread2 = `${SPACE}/threads/thread-2`;
      save(db, [
        message("b-root", "2026-10-01T00:00:00Z", { thread: { name: thread2 } }),
        message("a-late", "2026-10-22T11:00:00Z"),
        message("b-late", "2026-10-22T10:00:00Z", { thread: { name: thread2 } }),
        message("a-first", "2026-10-22T08:00:00Z"),
        message("b-first", "2026-10-22T09:00:00Z", { thread: { name: thread2 } }),
      ]);
      const page = queryInbox(db, OPTIONS);
      expect(page.threads.map(thread => thread.name)).toEqual([THREAD, thread2]);
      expect(page.threads.map(thread => thread.messages.map(row => row.text))).toEqual([["a-first", "a-late"], ["b-first", "b-late"]]);
      let output = "";
      await printInbox(db, OPTIONS, text => { output = text; });
      expect(output.indexOf(`thread_name: \`${THREAD}\``)).toBeLessThan(output.indexOf(`thread_name: \`${thread2}\``));
      expect(getMeta(db, SEEN)).toBe("2026-10-22T11:00:00.000000000Z");
    } finally { db.close(); }
  });

  test("200건 상한은 이전 맥락을 제외한 새 메시지 수이며 마지막 표시분까지만 커서를 전진한다", async () => {
    const db = openDatabase(":memory:");
    try {
      const items = batch(203);
      save(db, [message("root", "2026-10-01T00:00:00Z"), ...items]);
      const page = queryInbox(db, OPTIONS);
      expect(page.newCount).toBe(200);
      expect(page.remaining).toBe(3);
      expect(page.threads[0]?.context).toHaveLength(1);
      let output = "";
      await printInbox(db, OPTIONS, text => { output = text; });
      expect(output.match(/\[새 메시지\]/g)).toHaveLength(200);
      expect(output).toContain("새 본문 199");
      expect(output).not.toContain("새 본문 200");
      expect(output).toContain("3건 더 남음 — 다시 실행하면 이어서");
      expect(getMeta(db, SEEN)).toBe(normalizeTime(items[199]!.createTime));
      const next = queryInbox(db, OPTIONS);
      expect(next.newCount).toBe(3);
      expect(next.threads[0]?.messages.map(row => row.name)).toEqual(items.slice(200).map(item => item.name));
      expect(next.threads[0]?.context).toHaveLength(5);
      await printInbox(db, OPTIONS, () => {});
      expect(getMeta(db, SEEN)).toBe(normalizeTime(items[202]!.createTime));
      expect(queryInbox(db, OPTIONS).newCount).toBe(0);
    } finally { db.close(); }
  });

  test("200건 경계에 생성 시각이 같은 메시지가 있어도 누락 없이 이어서 보여준다", async () => {
    const db = openDatabase(":memory:");
    try {
      const items = batch(203).map(item => ({ ...item, createTime: "2026-10-22T11:00:00.123456789Z", thread: undefined }));
      save(db, items.toReversed());
      await printInbox(db, OPTIONS, () => {});
      expect(getMeta(db, SEEN)).toBe(items[199]!.createTime);
      expect(getMeta(db, SEEN_NAME)).toBe(items[199]!.name);
      expect(queryInbox(db, OPTIONS).threads.flatMap(thread => thread.messages.map(row => row.name))).toEqual(items.slice(200).map(item => item.name));
      await printInbox(db, OPTIONS, () => {});
      expect(getMeta(db, SEEN)).toBe(items[202]!.createTime);
      expect(getMeta(db, SEEN_NAME)).toBe(items[202]!.name);
      expect(queryInbox(db, OPTIONS).newCount).toBe(0);
    } finally { db.close(); }
  });

  test("새 메시지 0건은 정해진 문구와 수집 메타만 표시하고 seen을 생성하거나 바꾸지 않는다", async () => {
    for (const existing of [undefined, "2026-10-22T00:00:00Z"]) {
      const db = openDatabase(":memory:");
      try {
        if (existing) { setMeta(db, SEEN, existing); setMeta(db, SEEN_NAME, "기존 이름"); }
        setMeta(db, `lastSync:${SPACE}`, NOW.toISOString());
        setMeta(db, `lastCreateTime:${SPACE}`, "2026-10-20T00:00:00Z");
        save(db, [message("old", "2026-10-20T00:00:00Z")]);
        let output = "";
        await printInbox(db, OPTIONS, text => { output = text; });
        expect(output).toBe(`[tn] 새 메시지가 없습니다.\n## 메타\n- 마지막 성공 수집: ${NOW.toISOString()}\n- 수집 createTime 커서: 2026-10-20T00:00:00Z`);
        expect(getMeta(db, SEEN)).toBe(existing);
        expect(getMeta(db, SEEN_NAME)).toBe(existing ? "기존 이름" : undefined);
      } finally { db.close(); }
    }
  });

  test("동기/비동기 출력이 실패하면 기존 seen을 유지하고 첫 seen도 만들지 않는다", async () => {
    for (const existing of [undefined, "2026-10-22T00:00:00Z"]) {
      for (const asynchronous of [false, true]) {
        const db = openDatabase(":memory:");
        try {
          if (existing) { setMeta(db, SEEN, existing); setMeta(db, SEEN_NAME, "기존 이름"); }
          save(db, [message("new", "2026-10-22T11:00:00Z")]);
          const fail = () => { throw new Error("출력 중단"); };
          await expect(printInbox(db, OPTIONS, asynchronous ? async () => { await Promise.resolve(); fail(); } : fail)).rejects.toThrow("출력 중단");
          expect(getMeta(db, SEEN)).toBe(existing);
          expect(getMeta(db, SEEN_NAME)).toBe(existing ? "기존 이름" : undefined);
          expect(queryInbox(db, OPTIONS).newCount).toBe(1);
        } finally { db.close(); }
      }
    }
  });

  test("출력 중 다른 조회가 전진시킨 seen을 되돌리지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      save(db, batch(1));
      await printInbox(db, OPTIONS, async () => {
        await Promise.resolve();
        setMeta(db, SEEN, "2026-10-22T12:00:00.000000000Z");
        setMeta(db, SEEN_NAME, "더 뒤의 메시지");
      });
      expect(getMeta(db, SEEN)).toBe("2026-10-22T12:00:00.000000000Z");
      expect(getMeta(db, SEEN_NAME)).toBe("더 뒤의 메시지");
    } finally { db.close(); }
  });

  test("DEEP은 과거 맥락을 보충하되 조회는 기존 seen 이후로 유지한다", async () => {
    const db = openDatabase(":memory:");
    try {
      const seen = "2026-10-21T00:00:00.000000000Z";
      setMeta(db, SEEN, seen);
      await collectMessages(db, { listMessages: async (_space, after) => {
        expect(after).toBe("2026-09-22T12:00:00.000000000Z");
        return [message("old", "2026-10-01T00:00:00Z"), message("new", "2026-10-22T11:00:00Z")];
      } }, SPACE, { deep: true, backfillDays: 30, now: NOW });
      expect(getMeta(db, SEEN)).toBe(seen);
      const page = queryInbox(db, OPTIONS);
      expect(page.newCount).toBe(1);
      expect(page.threads[0]?.context[0]?.text).toBe("old");
      expect(page.threads[0]?.messages[0]?.text).toBe("new");
    } finally { db.close(); }
  });
});

describe("기간 조회", () => {
  test("상대 기간은 실행 시각부터 계산하고 잘못된 기간/날짜는 거부한다", () => {
    expect(parseSince("24h", NOW)).toBe("2026-10-21T12:00:00.000000000Z");
    expect(parseSince("3d", NOW)).toBe("2026-10-19T12:00:00.000000000Z");
    expect(parseSince("7d", NOW)).toBe("2026-10-15T12:00:00.000000000Z");
    expect(parseSince("2024-02-29")).toBe(normalizeTime(new Date(2024, 1, 29).toISOString()));
    for (const invalid of ["", "0h", "-1d", "1.5d", "3w", "24", "999999999999999d", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-10-00", "2026-1-1", "2026-10-01T00:00:00Z"]) {
      expect(() => parseSince(invalid, NOW)).toThrow("--since");
    }
  });

  test("YYYY-MM-DD는 실행 환경의 로컬 자정이다", () => {
    for (const [zone, expected] of [["Asia/Seoul", "2026-10-20T15:00:00.000000000Z"], ["UTC", "2026-10-21T00:00:00.000000000Z"]]) {
      const result = Bun.spawnSync([process.execPath, "-e", 'import { parseSince } from "./time.ts"; console.log(parseSince("2026-10-21"));'], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, TZ: zone },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(expected!);
    }
  });

  test("상대 기간/날짜는 seen을 무시하고 기간 안을 표시하며 기존/미생성 seen을 바꾸지 않는다", async () => {
    for (const value of ["3d", "2026-10-20"]) {
      for (const existing of [undefined, "2026-10-22T11:30:00.000000000Z"]) {
        const db = openDatabase(":memory:");
        try {
          if (existing) { setMeta(db, SEEN, existing); setMeta(db, SEEN_NAME, "기존 이름"); }
          const since = parseSince(value, NOW);
          save(db, [
            message("root", "2026-10-01T00:00:00Z"),
            message("boundary", since),
            message("in-period", "2026-10-21T11:00:00Z"),
            message("latest", "2026-10-22T11:00:00Z"),
          ]);
          const options = { ...OPTIONS, since };
          const page = queryInbox(db, options);
          expect(page.newCount).toBe(2);
          expect(page.threads[0]?.messages.map(row => row.text)).toEqual(["in-period", "latest"]);
          expect(page.threads[0]?.context.map(row => row.text)).toEqual(["root", "boundary"]);
          await printInbox(db, options, () => {});
          expect(getMeta(db, SEEN)).toBe(existing);
          expect(getMeta(db, SEEN_NAME)).toBe(existing ? "기존 이름" : undefined);
        } finally { db.close(); }
      }
    }
  });

  test("기간 조회도 새 메시지 200건만 표시하고 기간을 좁히도록 안내하며 seen은 그대로다", async () => {
    const db = openDatabase(":memory:");
    try {
      const seen = "2026-10-22T11:30:00Z";
      setMeta(db, SEEN, seen);
      save(db, batch(201));
      const options = { ...OPTIONS, since: parseSince("7d", NOW) };
      let output = "";
      await printInbox(db, options, text => { output = text; });
      expect(output.match(/\[새 메시지\]/g)).toHaveLength(200);
      expect(output).not.toContain("새 본문 200");
      expect(output).toContain("1건 더 남음 — --since를 좁혀서");
      expect(output).not.toContain("다시 실행하면 이어서");
      expect(getMeta(db, SEEN)).toBe(seen);
      expect(getMeta(db, SEEN_NAME)).toBeUndefined();
      expect(queryInbox(db, options).newCount).toBe(200);
    } finally { db.close(); }
  });

  test("--only 필터는 상한 계산에도 적용되고 이어보기 대신 기간 조회를 안내하며 seen을 저장하지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      const humans = batch(3).map((item, index) => ({ ...item, name: `${SPACE}/messages/human-${index}`, sender: { type: "HUMAN" } }));
      save(db, [...batch(201), ...humans]);
      const options = { ...OPTIONS, only: "BOT" as const };
      const page = queryInbox(db, options);
      expect(page.newCount).toBe(200);
      expect(page.remaining).toBe(1);
      expect(page.threads.flatMap(thread => thread.messages).every(row => row.sender_type === "BOT")).toBe(true);
      let output = "";
      await printInbox(db, options, text => { output = text; });
      expect(output).toContain("1건 더 남음 — --only 조회는 seen을 바꾸지 않아 다시 실행해도 같은 메시지가 나옵니다. --since를 지정하거나 좁혀서 조회하세요.");
      expect(output).not.toContain("다시 실행하면 이어서");
      expect(getMeta(db, SEEN)).toBeUndefined();
      expect(getMeta(db, SEEN_NAME)).toBeUndefined();
      expect(queryInbox(db, { ...OPTIONS, only: "HUMAN" }).newCount).toBe(3);

      // --since와 함께 쓰면 기간을 좁히라는 안내만 낸다.
      await printInbox(db, { ...options, since: parseSince("7d", NOW) }, text => { output = text; });
      expect(output).toContain("1건 더 남음 — --since를 좁혀서 다시 조회하세요.");
      expect(output).not.toContain("--only 조회는");
    } finally { db.close(); }
  });
});
