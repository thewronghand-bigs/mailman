import { afterEach, describe, expect, test } from "bun:test";
import { loadToken, saveToken } from "../auth";
import { main } from "../cli";
import { printInbox, renderInbox } from "../fetch";
import { cacheSpaces, getMeta, openDatabase, toRow, upsertRows } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-22T12:00:00Z");
const SELF = "users/fixture-self", PEER = "users/fixture-peer";

describe("DM과 단발 메시지 출력", () => {
  test("단발은 시간순 간결 목록, 그룹의 실제 스레드는 기존 머리와 맥락을 유지한다", async () => {
    const db = openDatabase(":memory:");
    try {
      const rows = [message("single-a", "2026-10-22T08:00:00Z", { thread: { name: `${SPACE}/threads/single-a` } }),
        message("single-b", "2026-10-22T09:00:00Z", { thread: undefined }),
        message("root", "2026-10-22T10:00:00Z"), message("reply", "2026-10-22T11:00:00Z")];
      upsertRows(db, rows.map(row => toRow(row, SPACE, NOW.toISOString())));
      let output = "";
      await printInbox(db, { space: SPACE, spaceKey: "alias", spaceLabel: "표시 이름", now: NOW }, text => { output = text; });
      expect(output).toStartWith("[표시 이름] 새 메시지 4건, 1개 스레드");
      expect(output.match(/thread_name:/g)).toHaveLength(1);
      expect(output).toContain(`thread_name: \`${THREAD}\``);
      expect(output).toContain(`첫 메시지 name (DB 기준): \`${SPACE}/messages/root\``);
      expect(output).toContain(`message name: \`${SPACE}/messages/single-a\``);
      expect(output).toContain(`message name: \`${SPACE}/messages/single-a\`\nthread name: \`${SPACE}/threads/single-a\``);
      expect(output).toContain(`message name: \`${SPACE}/messages/single-b\`\nthread name: \`(없음)\``);
      expect(output.match(/thread name:/g)).toHaveLength(2);
      expect(output).toContain(`[새 메시지]\nmessage name: \`${SPACE}/messages/root\``);
      expect(output).toContain(`[새 메시지]\nmessage name: \`${SPACE}/messages/reply\``);
      expect(output.match(/message name:/g)).toHaveLength(4);
      expect(output.indexOf("/messages/single-a`")).toBeLessThan(output.indexOf("/messages/single-b`"));
      expect(getMeta(db, `seenMessageName:${SPACE}`)).toBe(`${SPACE}/messages/reply`);
      const dm = renderInbox(db, { space: SPACE, spaceKey: "alias", spaceLabel: "DM: 가온", isDm: true, since: "2026-10-22T00:00:00Z" });
      expect(dm).toStartWith("[DM: 가온] 새 메시지 4건");
      expect(dm).not.toContain("개 스레드");
      expect(dm).not.toContain("thread_name:");
      expect(dm).toContain(`message name: \`${SPACE}/messages/root\`\nthread name: \`${THREAD}\``);
      expect(dm.match(/thread name:/g)).toHaveLength(4);
      expect(dm.match(/message name:/g)).toHaveLength(4);
    } finally { db.close(); }
  });

  test("그룹의 이전 맥락과 새 답글 모두 해당 메시지 name을 표시하고 DM에서는 이전 맥락을 생략한다", () => {
    const db = openDatabase(":memory:");
    try {
      upsertRows(db, [message("old-root", "2026-10-21T10:00:00Z"), message("new-spec", "2026-10-22T11:00:00Z")]
        .map(row => toRow(row, SPACE, NOW.toISOString())));
      const options = { space: SPACE, spaceKey: "alias", now: NOW };
      const group = renderInbox(db, options);
      expect(group).toContain(`[이전 맥락]\nmessage name: \`${SPACE}/messages/old-root\``);
      expect(group).toContain(`[새 메시지]\nmessage name: \`${SPACE}/messages/new-spec\``);
      const dm = renderInbox(db, { ...options, isDm: true });
      expect(dm).not.toContain("old-root");
      expect(dm).not.toContain("이전 맥락");
      expect(dm).toContain(`message name: \`${SPACE}/messages/new-spec\``);
    } finally { db.close(); }
  });

  test("DM users/ID 대상은 알면 이름·ID, 모르면 ID 한 번만 출력하고 공간 머리도 DM 라벨", async () => {
    for (const known of [false, true]) {
      const paths = fixture();
      const db = openDatabase(paths.dbPath);
      if (known) upsertRows(db, [toRow(message("known", undefined, { sender: { name: PEER, displayName: "가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
      db.close();
      const output: string[] = [];
      const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access" }) : json({ name: SPACE, spaceType: "DIRECT_MESSAGE" }));
      expect(await main(["fetch", "--dm", PEER, "--no-collect"], { paths, fetcher: api.fetcher, now: NOW, stdout: text => output.push(text), stderr: () => {} })).toBe(0);
      expect(output[0]).toStartWith(known ? `[대상] DM: 가온 → ${PEER} (DIRECT_MESSAGE, ${SPACE})\n[DM: 가온]` : `[대상] DM: ${PEER} (DIRECT_MESSAGE, ${SPACE})\n[DM: ${PEER}]`);
      expect(output[0]).not.toContain(`${PEER} → ${PEER}`);
    }
  });

  test("wait 중 받은 sender로 DM 이름을 갱신하고 세 답장을 시간순 간결 목록·첨부와 출력한다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    let current = NOW.getTime();
    const output: string[] = [];
    const items = [1, 2, 3].map(index => message(`reply-${index}`, new Date(NOW.getTime() + index * 1000).toISOString(), {
      sender: { name: PEER, displayName: "가온", type: "HUMAN" }, thread: { name: `${SPACE}/threads/reply-${index}` },
      attachment: index === 2 ? [{ contentName: "handover.md", attachmentDataRef: { resourceName: "fixture-ref" } }] : undefined,
    }));
    let mediaCalls = 0;
    const api = mockFetch(url => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      if (url.pathname.endsWith(":findDirectMessage")) return json({ name: SPACE });
      if (url.pathname.startsWith("/v1/media/")) { mediaCalls++; return new Response("# waiting spec"); }
      return json({ messages: items.filter(item => Date.parse(item.createTime) <= current) });
    });
    expect(await main(["wait", "--dm", PEER, "--with-attachments", "--quiet", "1s", "--interval", "1s", "--timeout", "10s"], {
      paths, fetcher: api.fetcher, env: {}, clock: { now: () => current, sleep: async milliseconds => { current += milliseconds; } }, stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    expect(output[0]).toStartWith(`[대상] DM: 가온 → ${PEER}`);
    expect(output[0]).toContain("[DM: 가온] 새 메시지 3건");
    expect(output[0]).not.toContain("개 스레드");
    expect(output[0]).not.toContain("첫 메시지 name");
    expect(output[0]).not.toContain("thread_name:");
    for (let index = 1; index <= 3; index++) {
      expect(output[0]).toContain(`message name: \`${SPACE}/messages/reply-${index}\`\nthread name: \`${SPACE}/threads/reply-${index}\``);
    }
    expect(output[0]?.match(/message name:/g)).toHaveLength(3);
    expect(output[0]).toContain("# waiting spec");
    expect(mediaCalls).toBe(1);
  });

  test("일반 스페이스는 별칭 대신 캐시의 표시 이름을 출력 머리에 사용한다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    cacheSpaces(db, [{ name: SPACE, displayName: "Build Team", spaceType: "SPACE" }], NOW.toISOString()); db.close();
    const output: string[] = [];
    expect(await main(["fetch", "--no-collect"], { paths, stdout: text => output.push(text), stderr: () => {}, now: NOW })).toBe(0);
    expect(output[0]).toStartWith(`[대상] Build Team (SPACE, ${SPACE})\n[Build Team]`);
  });
});
