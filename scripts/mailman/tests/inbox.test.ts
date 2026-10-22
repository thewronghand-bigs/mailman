import { describe, expect, test } from "bun:test";
import { ChatClient, type ChatMessage } from "../chat";
import { collectMessages } from "../collector";
import { SEND_PREFIX } from "../content";
import { renderInbox, queryInbox } from "../fetch";
import { collectionOptions } from "../runtime";
import { getMeta, openDatabase, setMeta, toRow, upsertRows, type MessageRow } from "../store";
import { normalizeTime } from "../time";
import { json, message, mockFetch, SPACE } from "./helpers";
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

describe("메시지 렌더링", () => {
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
      const options = { spaceKey: "tn", space: SPACE, now: new Date("2026-10-21T12:00:00Z") };
      expect(queryInbox(db, options).threads[0]?.name).toBeNull();
      expect(renderInbox(db, options)).toContain(`(첨부: 명세.pdf, sample.json, image/png, ${resourceName})`);
      expect(queryInbox(db, { ...options, space: "spaces/other" }).threads).toHaveLength(0);
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
        const markdown = renderInbox(db, { spaceKey: "tn", space: SPACE, since: "2026-10-20T00:00:00Z" });
        expect(markdown).toContain(expected);
        expect(markdown).not.toContain("(본문 없음)");
      } finally { db.close(); }
    }
  });

  test("텍스트 다음에 카드를 표시하고 HUMAN displayName과 users/ID 대체 표시를 유지한다", () => {
    const db = openDatabase(":memory:");
    try {
      const items = [
        message("named", undefined, { text: "본문", sender: { type: "HUMAN", name: "users/named", displayName: "테스터" }, cardsV2: [{ card: { header: { title: "카드 제목" } } }] }),
        message("unnamed", "2026-10-21T00:00:01Z", { text: "답글", sender: { type: "HUMAN", name: "users/unnamed", displayName: "" } }),
      ];
      upsertRows(db, items.map(item => toRow(item, SPACE, NOW.toISOString())));
      const markdown = renderInbox(db, { spaceKey: "tn", space: SPACE, since: "2026-10-20T00:00:00Z" });
      expect(markdown).toContain("— 테스터 (HUMAN)");
      expect(markdown).toContain("— users/unnamed (HUMAN)");
      expect(markdown).toContain("본문\n\n**카드 제목**");
      expect(markdown).not.toContain("(카드");
    } finally { db.close(); }
  });

  test("텍스트와 분리된 HUMAN 카드 답글도 같은 스레드에 표시한다", () => {
    const db = openDatabase(":memory:");
    try {
      upsertRows(db, [
        message("mention", undefined, { sender: { type: "HUMAN" }, text: "API 변경 공유" }),
        message("card-reply", "2026-10-21T00:00:01Z", { sender: { type: "HUMAN" }, text: "", cardsV2: [{ card: apiCard }] }),
      ].map(item => toRow(item, SPACE, NOW.toISOString())));
      const options = { spaceKey: "tn", space: SPACE, since: "2026-10-20T00:00:00Z" };
      expect(queryInbox(db, options).threads[0]?.messages).toHaveLength(2);
      const markdown = renderInbox(db, options);
      expect(markdown).toContain("API 변경 공유");
      expect(markdown).toContain("**권한 메뉴 조회 API 명칭 변경**");
      expect(markdown).toContain("```\nGET /menus\n\nAuthorization: Bearer STRING\n```");
      expect(markdown).toContain('  "message": STRING,');
    } finally { db.close(); }
  });
});
