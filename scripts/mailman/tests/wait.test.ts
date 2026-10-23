import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { getSelfUser, loadToken, saveToken } from "../auth";
import { main, parseArguments } from "../cli";
import type { ChatMessage } from "../chat";
import { getMeta, openDatabase, setMeta, toRow, upsertRows } from "../store";
import { MailmanError, RequestError } from "../errors";
import { resolveWaitPerson } from "../resolve";
import { nanosecondBefore, normalizeTime } from "../time";
import { MAX_BATCH_WAIT_MS, MAX_FAILURE_MS, MAX_WAIT_MS, parseDuration, waitForReplies, type WaitClock, type WaitOptions } from "../wait";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NOW = Date.parse("2026-10-22T12:00:00Z");
const SELF = "users/fixture-self";
const PEER = "users/fixture-peer";
const SEEN = `seenCreateTime:${SPACE}`;
const SEEN_NAME = `seenMessageName:${SPACE}`;
const at = (offset: number) => new Date(NOW + offset).toISOString();
const reply = (id: string, offset: number, extra: Partial<ChatMessage> = {}) => message(id, at(offset), {
  sender: { name: PEER, displayName: "가온", type: "HUMAN" }, thread: undefined, ...extra,
});
const options: WaitOptions = { space: SPACE, spaceKey: "tn", startTime: at(0), self: SELF, quietMs: 3000, intervalMs: 1000, timeoutMs: 20_000 };

function clock(onSleep?: (milliseconds: number) => void) {
  let current = NOW;
  const sleeps: number[] = [];
  const instance: WaitClock = { now: () => current, sleep: async milliseconds => { sleeps.push(milliseconds); current += milliseconds; onSleep?.(milliseconds); } };
  return { ...instance, sleeps, advance: (milliseconds: number) => { current += milliseconds; } };
}

function clientFor(clock: WaitClock, messages: ChatMessage[]) {
  const calls: string[] = [];
  return {
    calls,
    listMessages: async (_space: string, after: string) => {
      calls.push(after);
      return messages.filter(item => normalizeTime(item.createTime) > normalizeTime(after) && Date.parse(item.createTime) <= clock.now());
    },
    findDirectMessage: async () => { throw new Error("DM API 호출 금지"); },
  };
}

function save(db: Database, messages: ChatMessage[]) {
  upsertRows(db, messages.map(item => toRow(item, SPACE, at(0))));
}

describe("답장 대기와 묶음", () => {
  test("나노초 경계를 겹쳐 같은 시각에 늦게 온 이름도 한 번씩 받고 오래된 범위는 다시 받지 않는다", async () => {
    expect(nanosecondBefore(at(1000))).toBe("2026-10-22T12:00:00.999999999Z");
    expect(nanosecondBefore("2026-10-22T12:00:01.123456789Z")).toBe("2026-10-22T12:00:01.123456788Z");
    const db = openDatabase(":memory:");
    const time = clock();
    const afters: string[] = [];
    let output = "";
    try {
      expect(await waitForReplies(db, { listMessages: async (_space, after) => {
        afters.push(after);
        if (time.now() < NOW + 1000) return [];
        const rows = [reply("b", 1000)];
        if (time.now() >= NOW + 2000) rows.push(reply("a", 1000), reply("c", 1000));
        if (time.now() >= NOW + 3000) rows.push(reply("self-later", 3000, { sender: { name: SELF, type: "HUMAN" } }));
        return rows.filter(row => normalizeTime(row.createTime) > after);
      } }, options, text => { output = text; }, time)).toBe(0);
      expect(output).toContain("답장 3건");
      expect(output.match(/\[새 메시지\]/g)).toHaveLength(3);
      expect(time.now()).toBe(NOW + 5000);
      expect(afters.at(-1)).toBe(nanosecondBefore(at(3000)));
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/c`);
    } finally { db.close(); }
  });

  test("연결 오류·503·429는 백오프 후 회복하며 받은 답장을 유지한다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const warnings: string[] = [];
    let calls = 0;
    let output = "";
    try {
      expect(await waitForReplies(db, { listMessages: async () => {
        const call = calls++;
        if (call === 0) return [];
        if (call <= 3) throw new RequestError("일시 오류\n한 줄", [undefined, undefined, 503, 429][call]);
        return [reply("recovered", 1000)];
      } }, { ...options, warn: text => warnings.push(text) }, text => { output = text; }, time)).toBe(0);
      expect(time.sleeps.slice(0, 3)).toEqual([1000, 2000, 4000]);
      expect(warnings).toHaveLength(3);
      expect(warnings.every(text => !text.includes("\n") && text.includes("재시도"))).toBe(true);
      expect(output).toContain("recovered");
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/recovered`);
    } finally { db.close(); }
  });

  test("연속 실패 5분·전체 제한·영구 오류에서 모은 답장을 출력하고 오류 종료하며 seen을 유지한다", async () => {
    for (const mode of ["five-minutes", "timeout", "forbidden"]) {
      const db = openDatabase(":memory:");
      const time = clock();
      let calls = 0;
      let output = "";
      try {
        const timeoutMs = mode === "timeout" ? 10_000 : 20 * 60_000;
        await expect(waitForReplies(db, { listMessages: async () => {
          if (calls++ === 0) return [];
          if (calls === 2) { time.advance(1000); return [reply("kept", 1000)]; }
          throw new RequestError("API 오류", mode === "forbidden" ? 403 : 503);
        } }, { ...options, quietMs: 600_000, timeoutMs, warn: () => {} }, text => { output = text; }, time)).rejects.toMatchObject({ exitCode: 3 });
        expect(output).toContain("답장 1건(대기 오류로 받은 답장까지 묶음)");
        expect(output).toContain("kept");
        expect(output).toContain("대기 실패");
        expect(getMeta(db, SEEN)).toBeUndefined();
        if (mode === "five-minutes") expect(time.now()).toBe(NOW + 2000 + MAX_FAILURE_MS);
        if (mode === "timeout") expect(time.now()).toBe(NOW + timeoutMs);
        expect(time.sleeps.every(ms => ms > 0 && ms <= 60_000)).toBe(true);
      } finally { db.close(); }
    }
  });

  test("3개 연속 답장에 quiet를 재시작하며 중복 폴링은 타이머를 늘리지 않는다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const api = clientFor(time, [reply("first", 1000, { text: "오" }), reply("second", 2000, { text: "이거" }), reply("third", 4000, { text: "고쳐둘게요" })]);
    const output: string[] = [];
    try {
      expect(await waitForReplies(db, api, options, text => output.push(text), time)).toBe(0);
      expect(time.now()).toBe(NOW + 7000);
      expect(output).toHaveLength(1);
      expect(output[0]).toContain("답장 3건(조용해진 뒤 묶음)");
      expect(output[0]).toContain("고쳐둘게요");
      expect(output[0]?.match(/\[새 메시지\]/g)).toHaveLength(3);
      expect(getMeta(db, SEEN)).toBe(normalizeTime(at(4000)));
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/third`);
      expect(api.calls.slice(1, 3)).toEqual([normalizeTime(at(0)), normalizeTime(at(0))]);
      expect(api.calls).toContain(nanosecondBefore(at(1000)));
      expect(api.calls.at(-1)).toBe(nanosecondBefore(at(4000)));
    } finally { db.close(); }
  });

  test("quiet가 interval보다 짧아도 종료 직전에 폴링해 새 답장을 놓치지 않는다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const api = clientFor(time, [reply("one", 1000), reply("two", 3500)]);
    try {
      expect(await waitForReplies(db, api, { ...options, intervalMs: 3000, quietMs: 1000 }, () => {}, time)).toBe(0);
      expect(time.now()).toBe(NOW + 5000);
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/two`);
    } finally { db.close(); }
  });

  test("계속 답장해도 첫 답장부터 10분 또는 전체 timeout까지 묶는다", async () => {
    for (const timeoutMs of [20 * 60_000, 3 * 60_000]) {
      const db = openDatabase(":memory:");
      const time = clock();
      const messages = Array.from({ length: 20 }, (_, i) => reply(`continuous-${i}`, (i + 1) * 60_000));
      let output = "";
      try {
        expect(await waitForReplies(db, clientFor(time, messages), { ...options, quietMs: 120_000, intervalMs: 60_000, timeoutMs }, text => { output = text; }, time)).toBe(0);
        expect(time.now()).toBe(NOW + Math.min(60_000 + MAX_BATCH_WAIT_MS, timeoutMs));
        expect(output).toContain(timeoutMs < MAX_BATCH_WAIT_MS ? "전체 대기 제한으로 묶음" : "최대 묶음 대기로 묶음");
      } finally { db.close(); }
    }
  });

  test("답장이 없으면 exit 4이고 내 메시지는 답장과 quiet에서 제외한다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const api = clientFor(time, [reply("self", 1000, { sender: { name: SELF, type: "HUMAN" } })]);
    let output = "";
    try {
      expect(await waitForReplies(db, api, { ...options, timeoutMs: 5000 }, text => { output = text; }, time)).toBe(4);
      expect(time.now()).toBe(NOW + 5000);
      expect(output).toBe("답장 없음");
      expect(getMeta(db, SEEN)).toBeUndefined();
      expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM messages").get()?.count).toBe(1);
    } finally { db.close(); }
  });

  test("느린 폴링이 timeout 뒤 메시지를 돌려줘도 답장과 seen에 포함하지 않는다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const api = clientFor(time, []);
    try {
      let output = "";
      expect(await waitForReplies(db, { ...api, listMessages: async (_space, after) => {
        if (after !== normalizeTime(at(0))) return [];
        time.advance(10_000);
        return [reply("too-late", 9000)];
      } }, { ...options, timeoutMs: 5000 }, text => { output = text; }, time)).toBe(4);
      expect(output).toBe("답장 없음");
      expect(getMeta(db, SEEN)).toBeUndefined();
    } finally { db.close(); }
  });

  test("API가 끝나지 않아도 전체 timeout에 요청을 중단하고 exit 4로 돌아온다", async () => {
    const db = openDatabase(":memory:");
    try {
      let output = "";
      let aborted = false;
      expect(await waitForReplies(db, { listMessages: (_space, _after, _pages, signal) => {
        signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<ChatMessage[]>(() => {});
      }, findDirectMessage: async () => { throw new Error("DM 호출 금지"); } }, { ...options, timeoutMs: 30 }, text => { output = text; })).toBe(4);
      expect(aborted).toBe(true);
      expect(output).toBe("답장 없음");
      expect(getMeta(db, SEEN)).toBeUndefined();
    } finally { db.close(); }
  });

  test("준비 수집에서 받은 답장은 다음 폴링이 중단돼도 묶음으로 반환한다", async () => {
    const db = openDatabase(":memory:");
    const started = Date.now() - 1000;
    let calls = 0;
    try {
      let output = "";
      expect(await waitForReplies(db, { listMessages: async () => {
        if (calls++ === 0) return [message("already-received", new Date(started + 500).toISOString(), { sender: { name: PEER, type: "HUMAN" } })];
        return new Promise<ChatMessage[]>(() => {});
      }, findDirectMessage: async () => { throw new Error("DM 호출 금지"); } }, { ...options, startTime: new Date(started).toISOString(), timeoutMs: 30 }, text => { output = text; })).toBe(0);
      expect(output).toContain("답장 1건");
      expect(output).toContain("already-received");
    } finally { db.close(); }
  });

  test("--thread/--from는 해당 답장만 출력하고 제외된 메시지를 위해 seen을 유지한다", async () => {
    for (const filter of [{ thread: THREAD }, { from: PEER }, { thread: THREAD, from: PEER }]) {
      const db = openDatabase(":memory:");
      const time = clock();
      const before = normalizeTime(at(-60_000));
      const items = [
        reply("other-user", 1000, { sender: { name: "users/other", type: "HUMAN" }, thread: { name: THREAD } }),
        reply("other-thread", 2000),
        reply("match", 3000, { thread: { name: THREAD } }),
      ];
      try {
        setMeta(db, SEEN, before);
        setMeta(db, SEEN_NAME, "previous-name");
        let output = "";
        expect(await waitForReplies(db, clientFor(time, items), { ...options, ...filter }, text => { output = text; }, time)).toBe(0);
        expect(output).toContain("match");
        const newCount = filter.from && filter.thread ? 1 : 2;
        expect(output).toContain(`답장 ${newCount}건`);
        expect(getMeta(db, SEEN)).toBe(before);
        expect(getMeta(db, SEEN_NAME)).toBe("previous-name");
      } finally { db.close(); }
    }
  });

  test("--from은 사전 확정한 ID만 비교하며 봇/다른 발신자에 추가 조회하지 않는다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const api = clientFor(time, [reply("bot", 500, { sender: { name: PEER, type: "BOT" } }), reply("other", 1000, { sender: { name: "users/other", type: "HUMAN" } }), reply("match", 2000)]);
    const lookedUp: string[] = [];
    try {
      let output = "";
      expect(await waitForReplies(db, { ...api, findDirectMessage: async user => {
        lookedUp.push(user);
        throw new MailmanError("HTTP 400", 3);
      } }, { ...options, from: PEER }, text => { output = text; }, time)).toBe(0);
      expect(output).toContain("답장 1건");
      expect(lookedUp).toHaveLength(0);
      expect(getMeta(db, SEEN)).toBeUndefined();
    } finally { db.close(); }
  });
});

describe("대기 출력과 seen", () => {
  test("thread/from은 답장에만 적용하고 대기 전 다른 사람의 안 읽은 메시지는 모두 출력한다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    try {
      let output = "";
      const items = [reply("old-other", -1000, { sender: { name: "users/other", type: "HUMAN" } }), reply("new-match", 1000, { thread: { name: THREAD } })];
      expect(await waitForReplies(db, clientFor(time, items), { ...options, thread: THREAD, from: PEER }, text => { output = text; }, time)).toBe(0);
      expect(output).toContain("대기 전부터 있던 안 읽은 메시지");
      expect(output).toContain("old-other");
      expect(output).toContain("답장 1건");
      expect(getMeta(db, SEEN)).toBeUndefined();
    } finally { db.close(); }
  });

  test("답장의 같은 시각 이름 정렬도 SQLite와 같고 동시 조회의 seen은 되돌리지 않는다", async () => {
    for (const concurrent of [false, true]) {
      const db = openDatabase(":memory:");
      const time = clock();
      try {
        expect(await waitForReplies(db, clientFor(time, [reply("a", 1000), reply("B", 1000)]), options, () => {
          if (concurrent) {
            setMeta(db, SEEN, normalizeTime(at(10_000)));
            setMeta(db, SEEN_NAME, "concurrent-name");
          }
        }, time)).toBe(0);
        expect(getMeta(db, SEEN_NAME)).toBe(concurrent ? "concurrent-name" : `${SPACE}/messages/a`);
      } finally { db.close(); }
    }
  });

  test("대기 전 안 읽은 메시지를 먼저 출력하고 카드·첨부·이전 맥락을 재사용한다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const seen = normalizeTime(at(-2000));
    const items = [
      reply("read", -3000, { thread: { name: THREAD } }),
      reply("unread", -1000, { thread: { name: THREAD }, text: "대기 전 질문" }),
      reply("my-old", -500, { sender: { name: SELF, type: "HUMAN" } }),
      reply("reply", 1000, { thread: { name: THREAD }, text: "", cardsV2: [{ card: { header: { title: "카드 답장" } } }], attachment: [{ contentName: "reply.txt" }] }),
    ];
    try {
      setMeta(db, SEEN, seen);
      save(db, items.slice(0, 1));
      let output = "";
      expect(await waitForReplies(db, clientFor(time, items), options, text => { output = text; }, time)).toBe(0);
      expect(output.indexOf("대기 전부터 있던 안 읽은 메시지")).toBeLessThan(output.indexOf("답장 1건"));
      expect(output).toContain("대기 전 질문");
      expect(output).not.toContain("my-old");
      expect(output).toContain("**카드 답장**");
      expect(output).toContain("(첨부: reply.txt)");
      expect(output).toContain("[이전 맥락]");
      expect(getMeta(db, SEEN)).toBe(normalizeTime(at(1000)));
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/reply`);
    } finally { db.close(); }
  });

  test("대기 전 메시지가 200건을 넘어도 모두 출력해 seen 뒤에 누락을 남기지 않는다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    const items = Array.from({ length: 203 }, (_, i) => reply(`old-${i}`, -10_000 + i));
    try {
      let output = "";
      expect(await waitForReplies(db, clientFor(time, [...items, reply("new", 1000)]), options, text => { output = text; }, time)).toBe(0);
      expect(output.match(/\[새 메시지\]/g)).toHaveLength(204);
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/new`);
    } finally { db.close(); }
  });

  test("같은 시각의 보조 커서를 쓰고 timeout에서도 출력한 과거 메시지까지만 전진한다", async () => {
    const db = openDatabase(":memory:");
    const time = clock();
    try {
      const before = normalizeTime(at(-1000));
      setMeta(db, SEEN, before);
      setMeta(db, SEEN_NAME, `${SPACE}/messages/a`);
      let output = "";
      expect(await waitForReplies(db, clientFor(time, [reply("a", -1000), reply("b", -1000)]), { ...options, timeoutMs: 2000 }, text => { output = text; }, time)).toBe(4);
      expect(output).toContain("대기 전부터");
      expect(output).toContain("답장 없음");
      expect(output).not.toContain("/messages/a`");
      expect(getMeta(db, SEEN_NAME)).toBe(`${SPACE}/messages/b`);
    } finally { db.close(); }
  });

  test("동기/비동기 출력 실패와 출력 중 시그널은 seen을 바꾸지 않는다", async () => {
    for (const mode of ["sync", "async", "signal"]) {
      const db = openDatabase(":memory:");
      const time = clock();
      const controller = new AbortController();
      try {
        setMeta(db, SEEN, normalizeTime(at(-2000)));
        setMeta(db, SEEN_NAME, "original");
        const write = () => {
          if (mode === "signal") { controller.abort("SIGINT"); return; }
          throw new Error("출력 실패");
        };
        await expect(waitForReplies(db, clientFor(time, [reply("new", 1000)]), { ...options, signal: controller.signal }, mode === "async" ? async () => { await Promise.resolve(); write(); } : write, time)).rejects.toThrow();
        expect(getMeta(db, SEEN_NAME)).toBe("original");
      } finally { db.close(); }
    }
  });

  test("대기 중 SIGINT/SIGTERM은 130/143이고 seen은 불변이며 리스너를 정리한다", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const beforeListeners = process.listenerCount(signal);
      const time = clock(() => process.emit(signal));
      const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access-secret" }) : json({}));
      const output: string[] = [];
      expect(await main(["wait", "tn"], { paths, clock: time, now: new Date(NOW), fetcher: api.fetcher, env: {}, stdout: text => output.push(text), stderr: () => {} })).toBe(signal === "SIGINT" ? 130 : 143);
      expect(process.listenerCount(signal)).toBe(beforeListeners);
      expect(output).toHaveLength(0);
      const db = openDatabase(paths.dbPath);
      try { expect(getMeta(db, SEEN)).toBeUndefined(); } finally { db.close(); }
    }
  });

  test("실제 프로세스 시그널도 진행 중인 API 요청을 중단하고 130/143으로 끝난다", async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const script = `import { main } from ${JSON.stringify(new URL("../cli.ts", import.meta.url).href)};
        process.exitCode = await main(["wait", "tn"], { paths: ${JSON.stringify(paths)}, env: {}, fetcher: async (input, init) => {
          if (new URL(input).hostname === "oauth2.googleapis.com") return Response.json({ access_token: "fixture-access-secret" });
          return new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("중단")), { once: true }); });
        } });`;
      const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
      const reader = child.stderr.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("답장을 기다립니다");
      child.kill(signal);
      const drain = (async () => { while (!(await reader.read()).done) { /* 남은 오류 출력을 비운다. */ } })();
      expect(await child.exited).toBe(signal === "SIGINT" ? 130 : 143);
      await drain;
      expect(await new Response(child.stdout).text()).toBe("");
      const db = openDatabase(paths.dbPath);
      try { expect(getMeta(db, SEEN)).toBeUndefined(); } finally { db.close(); }
    }
  });
});

describe("CLI 전송 후 대기", () => {
  test("POST 자체가 실패하면 exit 3이며 전송 완료/exit 5 안내를 하지 않는다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const output: string[] = [], errors: string[] = [];
    const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access" }) : json({}, 403));
    expect(await main(["send", "--wait"], { paths, fetcher: api.fetcher, env: {}, stdin: () => "질문", stdout: text => output.push(text), stderr: text => errors.push(text) })).toBe(3);
    expect(output).toHaveLength(0);
    expect(errors.join("\n")).not.toContain("전송은 완료됨");
    expect(errors.join("\n")).not.toContain("재전송하지 말 것");
    expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com")).toHaveLength(1);
  });

  test("send --wait의 POST 401은 refresh/전송 재시도 없이 exit 3이다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access" }) : json({}, 401));
    expect(await main(["send", "--wait"], { paths, fetcher: api.fetcher, env: {}, stdin: () => "질문", stdout: () => {}, stderr: () => {} })).toBe(3);
    expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com")).toHaveLength(1);
    expect(api.calls.filter(call => call.url.hostname === "oauth2.googleapis.com")).toHaveLength(1);
  });

  test("--from 이메일 DM의 DB 후보가 여럿이면 전송 전에 거절한다", async () => {
    const db = openDatabase(":memory:");
    try {
      save(db, [reply("one", -1000), reply("two", -500, { sender: { name: "users/second-peer", type: "HUMAN" } })]);
      let lists = 0;
      await expect(resolveWaitPerson(db, { findDirectMessage: async () => ({ name: SPACE, displayName: "", spaceType: "DIRECT_MESSAGE" }), listMessages: async () => { lists++; return []; } }, "peer@example.test", SELF)).rejects.toThrow("확정할 수 없습니다");
      expect(lists).toBe(0);
    } finally { db.close(); }
  });

  test("--from 이메일 DM의 DB에서 self를 제외해 자신만 있으면 최근 메시지 확인 후 거절한다", async () => {
    const db = openDatabase(":memory:");
    try {
      save(db, [reply("self-only", -1000, { sender: { name: SELF, type: "HUMAN" } })]);
      let lists = 0;
      await expect(resolveWaitPerson(db, { findDirectMessage: async () => ({ name: SPACE, displayName: "", spaceType: "DIRECT_MESSAGE" }), listMessages: async () => { lists++; return []; } }, "peer@example.test", SELF)).rejects.toThrow("확정할 수 없습니다");
      expect(lists).toBe(1);
    } finally { db.close(); }
  });

  test("내 이메일/users ID/내 표시명 --from은 단독 wait와 send --wait 모두 거절한다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const db = openDatabase(paths.dbPath);
    save(db, [reply("self-row", -1000, { sender: { name: SELF, displayName: "내계정", type: "HUMAN" } })]); db.close();
    for (const args of [["wait"], ["send", "--wait"]]) {
      for (const from of ["tester@example.test", SELF, "내계정"]) {
        const errors: string[] = [];
        const api = mockFetch(url => { expect(url.hostname).toBe("oauth2.googleapis.com"); return json({ access_token: "fixture-access" }); });
        expect(await main([...args, "--from", from], { paths, fetcher: api.fetcher, env: {}, stdin: () => { throw new Error("본문을 읽으면 안 됨"); }, stdout: () => {}, stderr: text => errors.push(text) })).toBe(1);
        expect(errors.join("\n")).toContain("내 계정을 지정할 수 없습니다");
        expect(api.calls).toHaveLength(1);
      }
    }
  });

  test("이메일 --from은 기존 DM 발신자를 전송 전에 확정하며 대기 중에는 ID만 비교한다", async () => {
    for (const cached of [false, true]) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const dm = "spaces/peer-dm";
      if (cached) {
        const db = openDatabase(paths.dbPath);
        upsertRows(db, [toRow({ ...reply("known", -1000), name: `${dm}/messages/known` }, dm, at(0))]);
        db.close();
      }
      const time = clock();
      const output: string[] = [];
      const api = mockFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        if (url.pathname.endsWith(":findDirectMessage")) {
          expect(url.searchParams.get("name")).toBe("users/peer@example.test");
          return json({ name: dm });
        }
        if (url.pathname === `/v1/${dm}/messages`) {
          expect(cached).toBe(false);
          return json({ messages: [
            { ...reply("peer-dm", -1000), name: `${dm}/messages/peer` },
            { ...reply("my-dm", -500, { sender: { name: SELF, type: "HUMAN" } }), name: `${dm}/messages/self` },
            { ...reply("bot-dm", -200, { sender: { name: "users/app", type: "BOT" } }), name: `${dm}/messages/bot` },
          ] });
        }
        if (init.method === "POST") return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: at(0), sender: { name: SELF } });
        return json({ messages: time.now() > NOW ? [reply("other", 1000, { sender: { name: "users/other", type: "HUMAN" } }), reply("matched", 1000)] : [] });
      });
      expect(await main(["send", "--wait", "--from", "peer@example.test", "--quiet", "1s", "--timeout", "5s", "--interval", "1s"], {
        paths, clock: time, fetcher: api.fetcher, env: {}, stdin: () => "질문", stdout: text => output.push(text), stderr: () => {},
      })).toBe(0);
      expect(output[0]).toContain("전송 완료");
      expect(output.at(-1)).toContain("답장 1건");
      expect(api.calls.filter(call => call.url.pathname.endsWith(":findDirectMessage"))).toHaveLength(1);
      const sendIndex = api.calls.findIndex(call => call.url.hostname === "chat.googleapis.com" && call.init.method === "POST");
      expect(api.calls.findIndex(call => call.url.pathname.endsWith(":findDirectMessage"))).toBeLessThan(sendIndex);
      if (!cached) expect(api.calls.findIndex(call => call.url.pathname === `/v1/${dm}/messages`)).toBeLessThan(sendIndex);
    }
  });

  test("--from 사전 해석 실패는 전송하지 않으며 기록의 이메일 별칭은 DM 없이 비교할 수 있다", async () => {
    for (const mode of ["no-dm", "empty-dm", "unknown-name"]) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const api = mockFetch(url => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        if (url.pathname.endsWith(":findDirectMessage")) return mode === "no-dm" ? json({}, 404) : json({ name: "spaces/empty-dm" });
        return json({});
      });
      const errors: string[] = [];
      expect(await main(["send", "--wait", "--from", mode === "unknown-name" ? "미등록" : "peer@example.test"], {
        paths, fetcher: api.fetcher, clock: clock(), env: {}, stdin: () => "질문", stdout: () => {}, stderr: text => errors.push(text),
      })).toBe(1);
      expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com" && call.init.method === "POST")).toHaveLength(0);
      expect(errors.join("\n")).not.toContain("전송은 완료됨");
    }
    const db = openDatabase(":memory:");
    try {
      save(db, [reply("email-alias", -1000, { sender: { name: "users/peer@example.test", type: "HUMAN" } })]);
      expect(await resolveWaitPerson(db, clientFor(clock(), []), "peer@example.test", SELF)).toBe("users/peer@example.test");
    } finally { db.close(); }
  });

  test("전송 완료 뒤 대기 오류·출력 실패·시그널은 exit 5와 재전송 금지로 구분한다", async () => {
    for (const mode of ["missing-time", "invalid-time", "invalid-sender", "forbidden", "output", "SIGINT", "SIGTERM"] as const) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const output: string[] = [];
      const errors: string[] = [];
      const time = clock(() => { if (mode === "SIGINT" || mode === "SIGTERM") process.emit(mode); });
      let posts = 0;
      const api = mockFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        if (init.method === "POST") {
          posts++;
          return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, sender: { name: mode === "invalid-sender" ? 123 : SELF },
            ...(mode === "missing-time" ? {} : { createTime: mode === "invalid-time" ? "invalid" : at(0) }) });
        }
        expect(output[0]).toContain("전송 완료");
        return mode === "forbidden" ? json({}, 403) : json({});
      });
      expect(await main(["send", "--wait", "--timeout", "2s", "--interval", "1s"], {
        paths, fetcher: api.fetcher, clock: time, env: {}, stdin: () => "질문", stdout: text => {
          output.push(text);
          if (mode === "output") throw new Error("출력 실패");
        }, stderr: text => errors.push(text),
      })).toBe(5);
      expect(posts).toBe(1);
      expect(output[0]).toContain("message name:");
      expect(errors.join("\n")).toContain("전송은 완료됨 — 재전송하지 말 것");
      const db = openDatabase(paths.dbPath);
      try { expect(getMeta(db, SEEN)).toBeUndefined(); } finally { db.close(); }
    }
  });

  test("전송 요청 중 SIGINT는 전송 여부 불확실을 표시하고 재시도하지 않는다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const errors: string[] = [];
    const output: string[] = [];
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      process.emit("SIGINT");
      throw new Error("전송 요청 중 중단");
    });
    expect(await main(["send", "--wait"], { paths, fetcher: api.fetcher, env: {}, stdin: () => "질문", stdout: text => output.push(text), stderr: text => errors.push(text) })).toBe(130);
    expect(errors.join("\n")).toContain("전송 여부 불확실 — Chat에서 확인 후 재전송 판단");
    expect(errors.join("\n")).not.toContain("대기를 종료");
    expect(output).toHaveLength(0);
    expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com")).toHaveLength(1);
  });

  test("401은 refresh 후 한 번 재시도하며 재실패는 exit 5, 일시 오류는 stderr와 로그에 남긴다", async () => {
    for (const recover of [false, true]) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const time = clock();
      const errors: string[] = [];
      let tokens = 0;
      let gets = 0;
      const api = mockFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: `fixture-access-${++tokens}` });
        if (init.method === "POST") return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: at(0), sender: { name: SELF } });
        gets++;
        if (gets === 1 || !recover) return json({}, 401);
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access-2");
        if (gets === 2) return json({}, 503);
        return json({});
      });
      expect(await main(["send", "--wait", "--timeout", "3s", "--interval", "1s"], {
        paths, fetcher: api.fetcher, clock: time, env: {}, stdin: () => "질문", stdout: () => {}, stderr: text => errors.push(text),
      })).toBe(recover ? 4 : 5);
      expect(tokens).toBe(2);
      expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com" && call.init.method === "POST")).toHaveLength(1);
      if (recover) {
        expect(errors.join("\n")).toContain("대기 API 오류");
        expect(readFileSync(paths.logFile, "utf8")).toContain("HTTP 503");
      }
    }
  });

  test("단독 wait는 이름을 해석하는 동안 도착한 답장도 CLI 실행 시각부터 포함한다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const configBefore = readFileSync(paths.configFile, "utf8");
    const time = clock();
    const output: string[] = [];
    const api = mockFetch(url => {
      if (url.hostname === "oauth2.googleapis.com") { time.advance(2000); return json({ access_token: "fixture-access-secret" }); }
      if (url.pathname === "/v1/spaces") return json({ spaces: [{ name: SPACE, displayName: "대화방", spaceType: "GROUP_CHAT" }] });
      return json({ messages: [reply("arrived-during-resolution", 1000)] });
    });
    expect(await main(["wait", "대화방", "--quiet", "1s", "--timeout", "5s", "--interval", "1s"], { paths, clock: time, fetcher: api.fetcher, env: {}, stdout: text => output.push(text), stderr: () => {} })).toBe(0);
    expect(output[0]).toStartWith(`[대상] 대화방 (GROUP_CHAT, ${SPACE})`);
    expect(output[0]).toContain("답장 1건");
    expect(api.calls.filter(call => call.url.pathname.endsWith("/messages"))[1]!.url.searchParams.get("filter")).toBe(`createTime > "${nanosecondBefore(at(1000))}"`);
    expect(readFileSync(paths.configFile, "utf8")).toBe(configBefore);
  });

  test("send --wait는 보낸 createTime으로 시작하고 self 불일치를 경고하며 두 ID를 제외한다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const time = clock();
    const output: string[] = [];
    const errors: string[] = [];
    const sentTime = at(123);
    const otherSelf = "users/sender-self";
    let posts = 0;
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      if (init.method === "POST") { posts++; return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: sentTime, sender: { name: otherSelf } }); }
      const after = url.searchParams.get("filter")?.match(/"(.+)"/)?.[1];
      const items = [reply("self", 500, { sender: { name: SELF, type: "HUMAN" } }), reply("sender-self", 800, { sender: { name: otherSelf, type: "HUMAN" } }), reply("peer", 1000)];
      return json({ messages: items.filter(item => Date.parse(item.createTime) <= time.now() && normalizeTime(item.createTime) > (after ?? "")) });
    });
    expect(await main(["send", "tn", "--wait", "--quiet", "1s", "--timeout", "5s", "--interval", "1s"], {
      paths, clock: time, fetcher: api.fetcher, env: {}, stdin: () => "확인 부탁해요", stdout: text => output.push(text), stderr: text => errors.push(text),
    })).toBe(0);
    expect(posts).toBe(1);
    expect(output[0]).toStartWith("[대상]");
    expect(output[0]).toContain("✅ 전송 완료");
    expect(output.at(-1)).toContain("답장 1건");
    expect(errors.join("\n")).toContain("경고");
    expect(errors.join("\n")).toContain("sender.name");
    const filters = api.calls.filter(call => call.init.method === "GET").map(call => call.url.searchParams.get("filter"));
    expect(filters[1]).toBe(`createTime > "${normalizeTime(sentTime)}"`);
    expect(filters.at(-1)).toBe(`createTime > "${nanosecondBefore(at(1000))}"`);
  });

  test("이름 --from은 공통 사람 해석을 쓰고 send --wait 실패 뒤 자동 재전송하지 않는다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const db = openDatabase(paths.dbPath);
    save(db, [reply("known", -1000)]);
    db.close();
    const time = clock();
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      if (init.method === "POST") return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: at(0), sender: { name: SELF } });
      return json({});
    });
    expect(await main(["send", "--wait", "--from", "가온", "--timeout", "2s", "--interval", "1s"], { paths, clock: time, fetcher: api.fetcher, env: {}, stdin: () => "질문", stdout: () => {}, stderr: () => {} })).toBe(4);
    expect(api.calls.filter(call => call.init.method === "POST")).toHaveLength(2); // refresh와 실제 전송 각 1회
    expect(api.calls.filter(call => call.url.hostname === "chat.googleapis.com" && call.init.method === "POST")).toHaveLength(1);
  });

  test("옵션과 기간 오류는 설정·네트워크 전에 거절한다", () => {
    expect(parseDuration("15s", "--interval")).toBe(15_000);
    expect(parseDuration("30m", "--timeout")).toBe(1_800_000);
    expect(parseDuration("1h", "--quiet")).toBe(3_600_000);
    expect(parseArguments("wait", ["--timeout", "2h"]).timeoutMs).toBe(MAX_WAIT_MS);
    for (const value of ["3h", "121m", "7201s"]) expect(() => parseArguments("wait", ["--timeout", value])).toThrow("최대 2시간");
    for (const value of ["0s", "-1s", "1.5m", "20", "1d", "999999999999999999h"]) expect(() => parseDuration(value, "--quiet")).toThrow();
    for (const args of [["--quiet", "1s"], ["--from", "가온"], ["--wait", "--dry-run"], ["--wait", "--timeout", "0s"]]) expect(() => parseArguments("send", args)).toThrow();
    expect(parseArguments("wait", ["--dm", "가온", "--quiet", "2s", "--thread", THREAD])).toMatchObject({ dm: "가온", quietMs: 2000, thread: THREAD });
  });
});

describe("기존 토큰 계정 ID 보완", () => {
  test("userinfo는 한 번만 호출하고 0600 저장 후 재사용한다", async () => {
    const paths = fixture();
    const before = loadToken(paths.tokenFile);
    const api = mockFetch((url, init) => {
      expect(url.toString()).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access-secret");
      return json({ sub: "fixture-self" });
    });
    expect(await getSelfUser(paths, "fixture-access-secret", api.fetcher)).toBe(SELF);
    expect(await getSelfUser(paths, "fixture-access-secret", api.fetcher)).toBe(SELF);
    expect(api.calls).toHaveLength(1);
    expect(loadToken(paths.tokenFile)).toEqual({ ...before, user_name: SELF });
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.tokenFile, "utf8")).not.toContain("access_token");
  });
});
