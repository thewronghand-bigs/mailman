import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { ChatClient, type ChatSpace } from "../chat";
import { main, parseArguments } from "../cli";
import { listSpaces, normalizeName, resolvePerson, resolveTarget, saveAlias, targetHeader, SPACE_CACHE_MAX_AGE_MS } from "../resolve";
import { loadConfig } from "../runtime";
import { cachedSpaces, cacheSpaces, getMeta, openDatabase, toRow, upsertRows } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-22T12:00:00Z");
const named = (id: string, displayName: string, spaceType = "SPACE"): ChatSpace => ({ name: `spaces/${id}`, displayName, spaceType });
const noClient = async (): Promise<ChatClient> => { throw new Error("API 호출 금지"); };

describe("스페이스 목록과 캐시", () => {
  test("설정 없이 페이지네이션·검색하고 캐시를 재사용하며 refresh만 다시 호출한다", async () => {
    const paths = fixture();
    writeFileSync(paths.configFile, "설정을 읽으면 실패해야 함");
    const api = mockFetch((url, _init, index) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      expect(url.pathname).toBe("/v1/spaces");
      expect(url.searchParams.get("pageSize")).toBe("100");
      if (index === 1) return json({ spaces: [named("alpha", "Build Team")], nextPageToken: "next" });
      if (index === 2) { expect(url.searchParams.get("pageToken")).toBe("next"); return json({ spaces: [named("group", "Other", "GROUP_CHAT")] }); }
      return json({ spaces: [named("dm", "동료", "DIRECT_MESSAGE")] });
    });
    const output: string[] = [];
    const deps = { paths, fetcher: api.fetcher, now: NOW, stdout: (text: string) => output.push(text), stderr: () => {} };
    expect(await main(["spaces", " bUiLd\tTEAM "], deps)).toBe(0);
    expect(output.at(-1)).toBe("- Build Team (SPACE, spaces/alpha)");
    expect(await main(["spaces"], deps)).toBe(0);
    expect(api.calls).toHaveLength(3);
    expect(output.at(-1)).toContain("Other (GROUP_CHAT, spaces/group)");
    expect(await main(["spaces", "--refresh"], deps)).toBe(0);
    expect(api.calls).toHaveLength(5);
    expect(output.at(-1)).toContain("DIRECT_MESSAGE");
    const db = openDatabase(paths.dbPath);
    try { expect(cachedSpaces(db)).toEqual([named("dm", "동료", "DIRECT_MESSAGE")]); } finally { db.close(); }
  });

  test("빈 캐시도 재사용하고 실패·반복 토큰·상한에서 기존 캐시를 유지한다", async () => {
    const db = openDatabase(":memory:");
    try {
      let calls = 0;
      const empty = async () => ({ listSpaces: async () => { calls++; return []; }, findDirectMessage: async () => named("dm", "") });
      await listSpaces(db, empty);
      await listSpaces(db, noClient);
      expect(calls).toBe(1);
      cacheSpaces(db, [named("old", "기존")], NOW.toISOString());
      for (const mode of ["limit", "repeat", "http", "malformed"]) {
        const api = mockFetch((_url, _init, index) => {
          if (mode === "http" && index === 1) return json({ error: { message: "fixture-access-secret" } }, 403);
          if (mode === "malformed") return json({ spaces: [null] });
          return json({ spaces: [named("partial", "부분")], nextPageToken: mode === "limit" ? `page-${index}` : "same" });
        });
        const client = new ChatClient("fixture-access-secret", api.fetcher);
        await expect(listSpaces(db, async () => ({ listSpaces: () => client.listSpaces(2), findDirectMessage: user => client.findDirectMessage(user) }), true)).rejects.toThrow();
        expect(cachedSpaces(db)).toEqual([named("old", "기존")]);
        expect(getMeta(db, "spacesUpdatedAt")).toBe(NOW.toISOString());
      }
    } finally { db.close(); }
  });
});

describe("공통 대상 해석", () => {
  test("별칭 > 리터럴 > DM > 표시 이름 순서이며 정확 일치가 부분 일치보다 먼저다", async () => {
    const config = loadConfig(fixture().configFile);
    const db = openDatabase(":memory:");
    try {
      cacheSpaces(db, [named("alias-shadow", "tn"), named("exact", "Build Team"), named("partial", "Build Team Extra"), named("one", "Unique Room")], NOW.toISOString());
      expect((await resolveTarget(config, db, noClient, { spaceKey: "tn" })).name).toBe(SPACE);
      config.spaces["spaces/literal"] = { space: SPACE };
      expect((await resolveTarget(config, db, noClient, { spaceKey: "spaces/literal" })).name).toBe(SPACE);
      expect((await resolveTarget(config, db, noClient, { spaceKey: "spaces/direct" })).name).toBe("spaces/direct");
      expect((await resolveTarget(config, db, noClient, { spaceKey: " bUiLd \n TEAM " })).name).toBe("spaces/exact");
      expect((await resolveTarget(config, db, noClient, { spaceKey: " unique " })).name).toBe("spaces/one");
      expect(normalizeName("ＴＥＡＭ\t Room")).toBe("teamroom");
      config.spaces["users/peer"] = { space: SPACE };
      const dm = await resolveTarget(config, db, async () => ({ listSpaces: async () => [], findDirectMessage: async user => {
        expect(user).toBe("users/peer"); return named("dm", "", "DIRECT_MESSAGE");
      } }), { dm: "users/peer" });
      expect(targetHeader(dm)).toBe("[대상] DM: users/peer → users/peer (DIRECT_MESSAGE, spaces/dm)");
    } finally { db.close(); }
  });

  test("정확/부분 다중 후보는 목록과 exit 1, 0개는 한 번만 갱신한다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    const config = loadConfig(paths.configFile);
    try {
      for (const names of [["Team", "TEAM"], ["Team A", "Team B"]]) {
        cacheSpaces(db, names.map((name, i) => named(`room-${i}`, name)), NOW.toISOString());
        await expect(resolveTarget(config, db, noClient, { spaceKey: "team" })).rejects.toThrow("후보가 여러 개");
        const errors: string[] = [];
        expect(await main(["fetch", "team", "--no-collect"], { paths, stdout: () => {}, stderr: text => errors.push(text) })).toBe(1);
        expect(errors.join("\n")).toContain("spaces/room-0");
        expect(errors.join("\n")).toContain("spaces/room-1");
        expect(errors.join("\n")).toContain("SPACE");
      }
      let calls = 0;
      const client = async () => ({ listSpaces: async () => { calls++; return [named("new", "New")]; }, findDirectMessage: async () => named("dm", "") });
      expect((await resolveTarget(config, db, client, { spaceKey: "new" })).name).toBe("spaces/new");
      expect(calls).toBe(1);
      await expect(resolveTarget(config, db, client, { spaceKey: "missing" })).rejects.toThrow("mailman spaces");
      expect(calls).toBe(2);
      db.exec("DELETE FROM spaces; DELETE FROM meta WHERE key='spacesUpdatedAt'");
      await expect(resolveTarget(config, db, client, { spaceKey: "missing" })).rejects.toThrow("mailman spaces");
      expect(calls).toBe(3);
    } finally { db.close(); }
  });

  test("DM users/ID·이메일·수집된 이름을 찾고 동명이인/미등록/404를 거절한다", async () => {
    const db = openDatabase(":memory:");
    const config = loadConfig(fixture().configFile);
    try {
      upsertRows(db, [toRow(message("peer", undefined, { sender: { name: "users/peer", displayName: "가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
      expect(resolvePerson(db, " 가 온 ")).toBe("users/peer");
      upsertRows(db, [toRow(message("long-name", undefined, { sender: { name: "users/long-name", displayName: "가온누리", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
      expect(resolvePerson(db, "가온")).toBe("users/peer");
      expect(() => resolvePerson(db, "가")).toThrow("이메일로 지정");
      const api = mockFetch(url => {
        expect(url.pathname).toBe("/v1/spaces:findDirectMessage");
        expect(["users/peer", "users/peer@example.test"]).toContain(url.searchParams.get("name"));
        return json(named("dm", "", "DIRECT_MESSAGE"));
      });
      for (const dm of ["users/peer", "peer@example.test", "가온"]) {
        const target = await resolveTarget(config, db, async () => new ChatClient("fixture-access-secret", api.fetcher), { dm });
        expect(target.name).toBe("spaces/dm");
        if (dm === "가온") expect(targetHeader(target)).toContain("DM: 가온 → users/peer");
      }
      expect(() => resolvePerson(db, "모르는사람")).toThrow("이메일로 지정");
      upsertRows(db, [toRow(message("duplicate", undefined, { sender: { name: "users/another", displayName: "가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
      expect(() => resolvePerson(db, "가온")).toThrow("users/another");
      expect(() => resolvePerson(db, "가온")).toThrow("users/peer");
      const notFound = mockFetch(() => json({ error: { message: "Not found" } }, 404));
      await expect(resolveTarget(config, db, async () => new ChatClient("fixture-access-secret", notFound.fetcher), { dm: "peer@example.test" })).rejects.toThrow("아직 DM이 없습니다");
      expect(notFound.calls).toHaveLength(1);
    } finally { db.close(); }
  });

  test("--save는 다른 필드를 보존하고 0600 원자 교체하며 충돌을 거절한다", () => {
    const paths = fixture(false);
    const original = { defaultSpace: "tn", sendTag: false, custom: { preserved: true }, spaces: { tn: { space: SPACE, webhookUrl: "https://example.test/fixture-hook", extra: "보존" } } };
    writeFileSync(paths.configFile, JSON.stringify(original));
    chmodSync(paths.configFile, 0o644);
    saveAlias(paths.configFile, "new", "spaces/new");
    expect(JSON.parse(readFileSync(paths.configFile, "utf8"))).toEqual({ ...original, spaces: { ...original.spaces, new: { space: "spaces/new" } } });
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    const saved = readFileSync(paths.configFile, "utf8");
    expect(() => saveAlias(paths.configFile, "new", "spaces/other")).toThrow("덮어쓰지");
    expect(readFileSync(paths.configFile, "utf8")).toBe(saved);
  });

  test("미등록 방도 fetch/collect/send가 같은 해석을 쓰며 save가 없으면 설정을 바꾸지 않는다", async () => {
    for (const command of ["fetch", "collect", "send"] as const) {
      const paths = fixture();
      const db = openDatabase(paths.dbPath);
      cacheSpaces(db, [named("adhoc", "Adhoc Room")], NOW.toISOString());
      db.close();
      const before = readFileSync(paths.configFile, "utf8");
      const api = mockFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        expect(url.pathname).toBe("/v1/spaces/adhoc/messages");
        return init.method === "POST" ? json({ name: "spaces/adhoc/messages/new", thread: { name: "spaces/adhoc/threads/thread" } }) : json({});
      });
      const output: string[] = [];
      expect(await main([command, "Adhoc Room"], { paths, fetcher: api.fetcher, stdin: () => "테스트 본문", now: NOW, env: {}, stdout: text => output.push(text), stderr: () => {} })).toBe(0);
      expect(output[0]).toStartWith("[대상] Adhoc Room (SPACE, spaces/adhoc)");
      expect(readFileSync(paths.configFile, "utf8")).toBe(before);
    }
  });

  test("위치 인자+DM·중복 옵션은 인자 오류이며 미리보기에는 대상과 본문이 나온다", async () => {
    for (const command of ["send", "fetch", "collect", "wait"] as const) {
      expect(() => parseArguments(command, ["tn", "--dm", "가온"])).toThrow("위치 인자와 --dm");
      expect(() => parseArguments(command, ["--dm", "가온", "--dm", "나래"])).toThrow();
    }
    const paths = fixture(false);
    const before = readFileSync(paths.configFile, "utf8");
    const mode = statSync(paths.configFile).mode;
    const output: string[] = [];
    expect(await main(["send", "spaces/preview", "--dry-run", "--save", "preview"], { paths, stdin: () => "검토할 본문", env: {}, stdout: text => output.push(text), stderr: () => {} })).toBe(0);
    expect(output[0]).toStartWith("[대상] spaces/preview (SPACE_TYPE_UNSPECIFIED, spaces/preview)");
    expect(output[0]).toContain("[전송 미리보기]\n[🤖 AI] 검토할 본문");
    expect(output[0]).toContain("preview: 저장할 예정");
    expect(readFileSync(paths.configFile, "utf8")).toBe(before);
    expect(statSync(paths.configFile).mode).toBe(mode);
  });

  test("빈 대상/DM/발신자/별칭은 정규화 후 설정·API 접근 전에 exit 1이다", async () => {
    const paths = fixture(false);
    writeFileSync(paths.configFile, "읽으면 안 되는 설정");
    const api = mockFetch(() => { throw new Error("API 호출 금지"); });
    for (const value of ["", "   ", "\t\u3000"]) {
      for (const command of ["send", "fetch", "collect", "wait", "spaces"] as const) {
        const errors: string[] = [];
        expect(await main([command, value], { paths, fetcher: api.fetcher, stderr: text => errors.push(text) })).toBe(1);
        expect(errors.join("\n")).toContain("비어 있지 않은");
      }
      for (const flag of ["--dm", "--from", "--save"]) {
        expect(await main(["send", "--wait", flag, value], { paths, fetcher: api.fetcher, stderr: () => {} })).toBe(1);
      }
    }
    expect(api.calls).toHaveLength(0);
  });

  test("해석 API도 빈 키를 거절하며 위치 인자 생략만 기본 방을 사용한다", async () => {
    const config = loadConfig(fixture(false).configFile);
    const db = openDatabase(":memory:");
    try {
      cacheSpaces(db, [named("unnamed", "", "DIRECT_MESSAGE"), named("blank", "   "), named("only", "Team")], NOW.toISOString());
      for (const value of ["", "   ", "\u3000"]) {
        await expect(resolveTarget(config, db, noClient, { spaceKey: value }, NOW)).rejects.toMatchObject({ exitCode: 1 });
        await expect(resolveTarget(config, db, noClient, { dm: value }, NOW)).rejects.toMatchObject({ exitCode: 1 });
        expect(() => resolvePerson(db, value)).toThrow("비어 있지 않은");
        expect(() => saveAlias("읽지 않을 파일", value, SPACE)).toThrow("비어 있지 않은");
      }
      expect((await resolveTarget(config, db, noClient, {}, NOW)).name).toBe(SPACE);
      expect((await resolveTarget(config, db, noClient, { spaceKey: "team" }, NOW)).name).toBe("spaces/only");
    } finally { db.close(); }
  });

  test("24시간 초과 캐시는 이름 해석 전에 한 번 갱신하고 오프라인이면 경고 후 재사용한다", async () => {
    const config = loadConfig(fixture(false).configFile);
    const db = openDatabase(":memory:");
    try {
      cacheSpaces(db, [named("old", "Team")], NOW.toISOString());
      const warnings: string[] = [];
      expect((await resolveTarget(config, db, noClient, { spaceKey: "team" }, new Date(NOW.getTime() + SPACE_CACHE_MAX_AGE_MS), text => warnings.push(text))).name).toBe("spaces/old");
      expect(warnings).toHaveLength(0);
      let calls = 0;
      const provider = async () => ({ listSpaces: async () => { calls++; return [named("new", "Team")]; }, findDirectMessage: async () => named("dm", "") });
      const later = new Date(NOW.getTime() + SPACE_CACHE_MAX_AGE_MS + 1);
      expect((await resolveTarget(config, db, provider, { spaceKey: "team" }, later)).name).toBe("spaces/new");
      expect(calls).toBe(1);
      expect(getMeta(db, "spacesUpdatedAt")).toBe(later.toISOString());
      cacheSpaces(db, [named("old", "Team")], NOW.toISOString());
      let attempts = 0;
      const offline = async () => { attempts++; throw new Error("오프라인"); };
      expect((await resolveTarget(config, db, offline, { spaceKey: "team" }, later, text => warnings.push(text))).name).toBe("spaces/old");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("기존 캐시");
      expect(attempts).toBe(1);
      expect(getMeta(db, "spacesUpdatedAt")).toBe(NOW.toISOString());
      await expect(resolveTarget(config, db, offline, { spaceKey: "missing" }, later, () => {})).rejects.toThrow("mailman spaces");
      expect(attempts).toBe(2);
      cacheSpaces(db, [], NOW.toISOString());
      await expect(resolveTarget(config, db, offline, { spaceKey: "missing" }, later, text => warnings.push(text))).rejects.toThrow("mailman spaces");
      expect(warnings).toHaveLength(2);
      expect(attempts).toBe(3);
    } finally { db.close(); }
  });
});
