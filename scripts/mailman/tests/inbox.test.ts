import { describe, expect, test } from "bun:test";
import { ChatClient, type ChatMessage } from "../chat";
import { collectMessages } from "../collector";
import { SEND_PREFIX, displayText, matchesDefaultFilter } from "../content";
import { queryThreads, renderInbox } from "../fetch";
import { collectionOptions } from "../runtime";
import { getMeta, openDatabase, setMeta, toRow, upsertRows, type MessageRow } from "../store";
import { normalizeTime } from "../time";
import { json, message, mockFetch, SPACE, THREAD } from "./helpers";
import apiCard from "./fixtures/api-card.json";

const NOW = new Date("2026-10-22T12:00:00Z");
const SETTINGS = { deep: false, backfillDays: 7, now: NOW };

describe("수집과 증분 저장", () => {
  test("최초 7일 창에서 사람/봇/자기 메시지 모두 저장하고 스페이스별 증분 커서를 쓴다", async () => {
    const db = openDatabase(":memory:");
    try {
      const { fetcher, calls } = mockFetch((_url, _init, index) => json(index === 0 ? { messages: [
        message("bot", "2026-10-20T00:00:00Z"),
        message("human", "2026-10-21T00:00:00.000000001Z", { sender: { type: "HUMAN" }, text: "일반 대화" }),
        message("self", "2026-10-21T00:00:00.000000002Z", { sender: { type: "HUMAN" }, text: `${SEND_PREFIX}전송문` }),
      ] } : {}));
      const client = new ChatClient("fixture-access-secret", fetcher);
      const first = await collectMessages(db, client, SPACE, SETTINGS);
      expect(first.after).toBe("2026-10-15T12:00:00.000000000Z");
      expect(first.received).toBe(3);
      expect(first.saved).toBe(3);
      expect(first.cursor).toBe("2026-10-21T00:00:00.000000002Z");
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(3);
      await collectMessages(db, client, SPACE, SETTINGS);
      expect(calls[1]!.url.searchParams.get("filter")).toBe('createTime > "2026-10-21T00:00:00.000000002Z"');
      expect(getMeta(db, `lastSync:${SPACE}`)).toBe(NOW.toISOString());
      await collectMessages(db, client, "spaces/another", SETTINGS);
      expect(calls[2]!.url.searchParams.get("filter")).toBe('createTime > "2026-10-15T12:00:00.000000000Z"');
      expect(getMeta(db, "lastCreateTime:spaces/another")).toBeUndefined();
    } finally { db.close(); }
  });

  test("DEEP은 meta와 무관하게 30일 창을 조회하며 수정 메시지를 upsert한다", async () => {
    const db = openDatabase(":memory:");
    try {
      let body = message("editable", "2026-10-21T00:00:00Z", { text: "원본" });
      const { fetcher } = mockFetch(() => json({ messages: [body] }));
      const client = new ChatClient("fixture-access-secret", fetcher);
      await collectMessages(db, client, SPACE, SETTINGS);
      body = { ...body, text: "수정본", lastUpdateTime: "2026-10-22T00:00:00.123456789Z", attachment: [{ contentName: "명세.pdf", contentType: "application/pdf" }] };
      const result = await collectMessages(db, client, SPACE, { ...SETTINGS, ...collectionOptions({ MAILMAN_DEEP: "1" }) });
      expect(result.after).toBe("2026-09-22T12:00:00.000000000Z");
      expect(result.saved).toBe(1);
      const row = db.query<MessageRow, []>("SELECT * FROM messages").get()!;
      expect(row.text).toBe("수정본");
      expect(row.last_update_time).toBe("2026-10-22T00:00:00.123456789Z");
      expect(JSON.parse(row.attachments_json)).toEqual([{ contentName: "명세.pdf", contentType: "application/pdf" }]);
      expect(JSON.parse(row.raw_json).text).toBe("수정본");
      expect((await collectMessages(db, client, SPACE, { ...SETTINGS, deep: true })).saved).toBe(0);
      body = { ...body, text: "오래된 응답", lastUpdateTime: "2026-10-21T01:00:00Z" };
      expect((await collectMessages(db, client, SPACE, { ...SETTINGS, deep: true })).saved).toBe(0);
      expect(db.query<MessageRow, []>("SELECT * FROM messages").get()?.text).toBe("수정본");
      expect(getMeta(db, `lastCreateTime:${SPACE}`)).toBe("2026-10-21T00:00:00.000000000Z");
    } finally { db.close(); }
  });

  test("백필의 오래된 메시지와 빈 응답이 기존 커서를 되돌리지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      const { fetcher } = mockFetch((_url, _init, index) => json(index < 2 ? { messages: [
        message(String(index), index === 0 ? "2026-10-21T00:00:00Z" : "2026-10-01T00:00:00Z"),
      ] } : {}));
      const client = new ChatClient("fixture-access-secret", fetcher);
      await collectMessages(db, client, SPACE, SETTINGS);
      for (let index = 0; index < 2; index++) {
        const result = await collectMessages(db, client, SPACE, { ...SETTINGS, deep: true });
        expect(result.cursor).toBe("2026-10-21T00:00:00.000000000Z");
      }
    } finally { db.close(); }
  });

  test("페이지 중간 실패와 상한 초과에서 부분 저장/커서 갱신을 하지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      const initial = mockFetch(() => json({ messages: [message("initial")] }));
      await collectMessages(db, new ChatClient("fixture-access-secret", initial.fetcher), SPACE, SETTINGS);
      const cursor = getMeta(db, `lastCreateTime:${SPACE}`);
      const failing = mockFetch((_url, _init, index) => index === 0
        ? json({ messages: [message("partial", "2026-10-22T00:00:00Z")], nextPageToken: "next" })
        : json({ error: { message: "Permission denied" } }, 403));
      await expect(collectMessages(db, new ChatClient("fixture-access-secret", failing.fetcher), SPACE, SETTINGS)).rejects.toThrow("HTTP 403");
      const capped = mockFetch(() => json({ messages: [message("partial")], nextPageToken: "next" }));
      const client = new ChatClient("fixture-access-secret", capped.fetcher);
      await expect(collectMessages(db, { listMessages: (space, after) => client.listMessages(space, after, 1) }, SPACE, SETTINGS)).rejects.toThrow("수집 상한");
      expect(getMeta(db, `lastCreateTime:${SPACE}`)).toBe(cursor);
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(1);
    } finally { db.close(); }
  });

  test("다른 수집이 먼저 전진시킨 커서를 오래된 응답으로 되돌리지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      const result = await collectMessages(db, { listMessages: async () => {
        setMeta(db, `lastCreateTime:${SPACE}`, "2026-10-22T00:00:00.000000000Z");
        return [message("older", "2026-10-21T00:00:00Z")];
      } }, SPACE, SETTINGS);
      expect(result.cursor).toBe("2026-10-22T00:00:00.000000000Z");
      expect(getMeta(db, `lastCreateTime:${SPACE}`)).toBe(result.cursor);
    } finally { db.close(); }
  });

  test("저장 실패에서도 같은 트랜잭션의 메시지와 meta를 롤백한다", async () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON messages WHEN NEW.text='실패' BEGIN SELECT RAISE(ABORT, '테스트 실패'); END;");
      const { fetcher } = mockFetch(() => json({ messages: [message("one"), message("two", "2026-10-21T00:00:01Z", { text: "실패" })] }));
      await expect(collectMessages(db, new ChatClient("fixture-access-secret", fetcher), SPACE, SETTINGS)).rejects.toThrow("테스트 실패");
      expect(getMeta(db, `lastCreateTime:${SPACE}`)).toBeUndefined();
      expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(0);
    } finally { db.close(); }
  });

  test("백필 일수 오버라이드와 나노초/시간대 정규화", () => {
    expect(collectionOptions({})).toEqual({ deep: false, backfillDays: 7 });
    expect(collectionOptions({ MAILMAN_DEEP: "1" })).toEqual({ deep: true, backfillDays: 30 });
    expect(collectionOptions({ MAILMAN_DEEP: "1", MAILMAN_BACKFILL_DAYS: "14" }).backfillDays).toBe(14);
    for (const days of ["", "0", "-1", "NaN", "1.5"]) expect(() => collectionOptions({ MAILMAN_BACKFILL_DAYS: days })).toThrow();
    expect(normalizeTime("2026-10-21T09:00:00.123456789+09:00")).toBe("2026-10-21T00:00:00.123456789Z");
    expect(normalizeTime("2026-10-21T00:00:00Z") < normalizeTime("2026-10-21T00:00:00.000000001Z")).toBe(true);
  });
});

describe("조회 필터와 스레드", () => {
  test("봇 전체, 사람 첫 줄 마커만 통과하고 자기 전송은 제외한다", () => {
    const cases: Array<[string | null, string, boolean]> = [
      ["BOT", "명세", true], ["BOT", "", true], ["HUMAN", "@MaIlMaN: 명세\n내용", true],
      ["HUMAN", "일반 대화", false], ["HUMAN", "대화\n@mailman", false], ["HUMAN", "\n@mailman", false],
      ["HUMAN", "@mailmaniac", false], [null, "@mailman 명세", false],
      ["BOT", `${SEND_PREFIX}봇 명의라도 제외`, false], ["HUMAN", `${SEND_PREFIX}답장`, false],
    ];
    for (const [type, text, expected] of cases) expect(matchesDefaultFilter(type, text)).toBe(expected);
    expect(displayText("HUMAN", "@MaIlMaN: 명세\n본문")).toBe("명세\n본문");
    expect(displayText("BOT", "@mailman 봇 본문")).toBe("@mailman 봇 본문");
  });

  test("최신 통과 메시지로 N개 스레드를 고르고 무표식 답글/자기 전송까지 시간순으로 포함한다", () => {
    const db = openDatabase(":memory:");
    const thread2 = `${SPACE}/threads/thread-2`;
    try {
      const items = [
        message("root", "2026-10-01T00:00:00Z", { sender: { type: "HUMAN" }, text: "먼저 나눈 대화" }),
        message("bot", "2026-10-02T00:00:00Z"),
        message("marked", "2026-10-03T00:00:00Z", { sender: { type: "HUMAN" }, text: "@MAILMAN: 명세", thread: { name: thread2 } }),
        message("reply2", "2026-10-04T00:00:00Z", { sender: { type: "HUMAN" }, text: "자연스러운 답글", thread: { name: thread2 } }),
        message("reply1", "2026-10-09T00:00:00Z", { sender: { type: "HUMAN" }, text: "최신 일반 답글" }),
        message("own", "2026-10-10T00:00:00Z", { sender: { type: "HUMAN" }, text: `${SEND_PREFIX}응답` }),
        message("plain-only", "2026-10-11T00:00:00Z", { sender: { type: "HUMAN" }, thread: { name: `${SPACE}/threads/plain` } }),
        message("self-only", "2026-10-12T00:00:00Z", { sender: { type: "HUMAN" }, text: `${SEND_PREFIX}독립`, thread: { name: `${SPACE}/threads/self` } }),
      ];
      upsertRows(db, items.map(item => toRow(item, SPACE, NOW.toISOString())));
      const options = { spaceKey: "tn", space: SPACE, limit: 2, all: false };
      const selected = queryThreads(db, options);
      expect(selected.map(thread => thread.name)).toEqual([thread2, THREAD]);
      expect(selected[0]!.messages.map(row => row.text)).toEqual(["@MAILMAN: 명세", "자연스러운 답글"]);
      expect(selected[1]!.messages.map(row => row.name)).toEqual(["root", "bot", "reply1", "own"].map(id => `${SPACE}/messages/${id}`));
      expect(queryThreads(db, { ...options, limit: 1 })).toHaveLength(1);
      expect(queryThreads(db, { ...options, all: true }).map(thread => thread.name)).toEqual([`${SPACE}/threads/self`, `${SPACE}/threads/plain`]);
      const markdown = renderInbox(db, options);
      expect(markdown).toContain(`thread_name: \`${thread2}\``);
      expect(markdown).toContain(`첫 메시지 name (DB 기준): \`${SPACE}/messages/marked\``);
      expect(markdown).not.toContain("@MAILMAN:");
      expect(markdown).toContain("자연스러운 답글");
      expect(markdown).toContain(`${SEND_PREFIX}응답`);
    } finally { db.close(); }
  });

  test("스페이스를 격리하고 thread 없는 메시지/첨부만 있는 메시지도 출력한다", () => {
    const db = openDatabase(":memory:");
    try {
      const resourceName = `${SPACE}/messages/attachment/attachments/unnamed`;
      upsertRows(db, [toRow(message("attachment", undefined, { text: "", thread: undefined, attachment: [
        { name: `${SPACE}/messages/attachment/attachments/pdf`, contentName: "명세.pdf", contentType: "application/pdf" },
        { contentName: "sample.json" },
        { name: `${SPACE}/messages/attachment/attachments/image`, contentName: " ", contentType: "image/png" },
        { name: resourceName, contentName: "", contentType: "" },
      ] }), SPACE, NOW.toISOString())]);
      const options = { spaceKey: "tn", space: SPACE, limit: 5, all: false };
      expect(queryThreads(db, options)[0]?.name).toBeNull();
      expect(renderInbox(db, options)).toContain(`(첨부: 명세.pdf, sample.json, image/png, ${resourceName})`);
      expect(queryThreads(db, { ...options, space: "spaces/other" })).toHaveLength(0);
    } finally { db.close(); }
  });

  test("cardsV2/cards는 굵은 제목을 표시하고 빈 카드는 카드임을 알린다", () => {
    const cases: Array<[Partial<ChatMessage>, string]> = [
      [{ cardsV2: [{ cardId: "v2", card: { header: { title: "배포 완료", subtitle: "개발계" } } }] }, "**배포 완료 - 개발계**"],
      [{ cards: [{ header: { title: "레거시 카드", subtitle: "상태" } }] }, "**레거시 카드 - 상태**"],
      [{ cardsV2: [{ card: { header: { title: "제목만" } } }] }, "**제목만**"],
      [{ cards: [{ header: { subtitle: "부제목만" } }] }, "**부제목만**"],
      [{ cardsV2: [{ card: { sections: [] } }] }, "(카드)"],
      [{ cards: [{}] }, "(카드)"],
      [{ cardsV2: [{ card: { header: {} } }] }, "(카드)"],
      [{ cards: [{ header: { title: "첫 카드" } }, { header: { title: "둘째 카드" } }] }, "**첫 카드**\n\n**둘째 카드**"],
      [{ cardsV2: [{ card: {} }], attachment: [{ contentName: "명세.pdf" }] }, "(카드)\n\n(첨부: 명세.pdf)"],
    ];
    for (const [extra, expected] of cases) {
      const db = openDatabase(":memory:");
      try {
        upsertRows(db, [toRow(message("card", undefined, { text: "", ...extra }), SPACE, NOW.toISOString())]);
        const markdown = renderInbox(db, { spaceKey: "tn", space: SPACE, limit: 5, all: false });
        expect(markdown).toContain(expected);
        expect(markdown).not.toContain("(본문 없음)");
      } finally { db.close(); }
    }
  });

  test("텍스트 다음에 카드를 표시하고 HUMAN displayName과 users/ID 대체 표시를 유지한다", () => {
    const db = openDatabase(":memory:");
    try {
      const items = [
        message("named", undefined, { text: "@mailman 본문", sender: { type: "HUMAN", name: "users/named", displayName: "테스터" }, cardsV2: [{ card: { header: { title: "카드 제목" } } }] }),
        message("unnamed", "2026-10-21T00:00:01Z", { text: "답글", sender: { type: "HUMAN", name: "users/unnamed", displayName: "" } }),
      ];
      upsertRows(db, items.map(item => toRow(item, SPACE, NOW.toISOString())));
      const markdown = renderInbox(db, { spaceKey: "tn", space: SPACE, limit: 5, all: false });
      expect(markdown).toContain("— 테스터");
      expect(markdown).toContain("— users/unnamed (HUMAN)");
      expect(markdown).toContain("본문\n\n**카드 제목**");
      expect(markdown).not.toContain("(카드");
    } finally { db.close(); }
  });

  test("멘션과 분리된 HUMAN 카드 답글도 필터와 관계없이 스레드 전체에 표시한다", () => {
    const db = openDatabase(":memory:");
    try {
      upsertRows(db, [
        message("mention", undefined, { sender: { type: "HUMAN" }, text: "@mailman API 변경 공유" }),
        message("card-reply", "2026-10-21T00:00:01Z", { sender: { type: "HUMAN" }, text: "", cardsV2: [{ card: apiCard }] }),
      ].map(item => toRow(item, SPACE, NOW.toISOString())));
      const options = { spaceKey: "tn", space: SPACE, limit: 1, all: false };
      expect(queryThreads(db, options)[0]?.messages).toHaveLength(2);
      const markdown = renderInbox(db, options);
      expect(markdown).toContain("API 변경 공유");
      expect(markdown).toContain("**권한 메뉴 조회 API 명칭 변경**");
      expect(markdown).toContain("```\nGET /menus\n\nAuthorization: Bearer STRING\n```");
      expect(markdown).toContain('  "message": STRING,');
      expect(markdown).not.toContain("@mailman");
    } finally { db.close(); }
  });
});
