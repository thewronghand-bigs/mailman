import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DIRECTORY_SCOPE, loadToken, REQUIRED_SCOPES, saveToken, SCOPES, SPACE_CREATE_SCOPE } from "../auth";
import { ChatClient } from "../chat";
import { main, parseArguments } from "../cli";
import { loadConfig } from "../runtime";
import { resolveTarget } from "../resolve";
import { cachedSpaces, openDatabase, registeredPeople, toRow, upsertPerson, upsertRows, type Person } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-27T00:00:00Z");
const USER = "users/100001";
const OTHER = "users/100002";
const DM = { name: SPACE, displayName: "", spaceType: "DIRECT_MESSAGE" };
const person = (userName = USER, displayName = "가온", source: Person["source"] = "manual"): Person =>
  ({ userName, displayName, email: "peer@example.test", source, updatedAt: "2026-10-20T00:00:00Z" });
const profile = (id = "100001", displayName = "가온", email = "peer@example.test") =>
  ({ resourceName: `people/${id}`, names: [{ displayName }], emailAddresses: [{ value: email }] });

function readPeople(path: string): Person[] {
  const db = openDatabase(path);
  try { return registeredPeople(db); } finally { db.close(); }
}

function setupApi(people: unknown[] = [profile()], existingDm = false) {
  return mockFetch((url, init) => {
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
    if (url.hostname === "people.googleapis.com") return json({ people });
    if (url.pathname.endsWith(":findDirectMessage")) return existingDm ? json(DM) : json({}, 404);
    if (url.pathname.endsWith(":setup")) return json(DM);
    expect(url.pathname).toBe(`/v1/${SPACE}/messages`);
    expect(init.method).toBe("POST");
    return json({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
  });
}

describe("기본 방 없는 명시 대상", () => {
  for (const config of [undefined, { defaultSpace: "", spaces: {} }, { spaces: {} }]) {
    test(`${config === undefined ? "설정 파일 없음" : JSON.stringify(config)}에서 명시 대상만 허용한다`, async () => {
      const paths = fixture();
      if (config === undefined) unlinkSync(paths.configFile);
      else writeFileSync(paths.configFile, JSON.stringify(config));
      const before = existsSync(paths.configFile) ? readFileSync(paths.configFile, "utf8") : undefined;
      expect(loadConfig(paths.configFile)).toEqual({ defaultSpace: "", spaces: {}, sendTag: true });
      const api = setupApi([], true);
      const output: string[] = [], errors: string[] = [];
      const deps = { paths, env: {}, now: NOW, fetcher: api.fetcher, stdin: () => "본문", stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
      expect(await main(["send", "--dm", USER, "--dry-run"], deps)).toBe(0);
      expect(output.at(-1)).toContain(USER);
      expect(await main(["send", SPACE, "--dry-run"], deps)).toBe(0);
      expect(output.at(-1)).toContain(SPACE);
      const calls = api.calls.length;
      for (const command of ["send", "fetch", "collect", "wait"]) {
        expect(await main([command], deps)).toBe(1);
        expect(errors.at(-1)).toContain("대상을 지정하거나 mailman spaces '검색어' --save <별칭>");
      }
      expect(api.calls).toHaveLength(calls);
      expect(api.calls.every(call => call.init.method === "GET" || call.url.hostname === "oauth2.googleapis.com")).toBe(true);
      expect(existsSync(paths.configFile) ? readFileSync(paths.configFile, "utf8") : undefined).toBe(before);
    });
  }

  test("잘못된 JSON·형식·기본 별칭·읽기 권한은 빈 설정으로 덮지 않는다", async () => {
    const paths = fixture();
    const api = setupApi();
    for (const content of ["{", "null", "{}", '{"spaces":[],"defaultSpace":""}', '{"spaces":{},"defaultSpace":null}', '{"spaces":{},"defaultSpace":"typo"}']) {
      writeFileSync(paths.configFile, content);
      expect(() => loadConfig(paths.configFile)).toThrow();
      expect(await main(["send", SPACE, "--dry-run"], { paths, fetcher: api.fetcher, stdin: () => "본문", stderr: () => {} })).toBe(1);
      expect(readFileSync(paths.configFile, "utf8")).toBe(content);
    }
    writeFileSync(paths.configFile, '{"spaces":{}}');
    chmodSync(paths.configFile, 0o000);
    try { expect(() => loadConfig(paths.configFile)).toThrow("설정 파일을 읽을 수 없습니다"); }
    finally { chmodSync(paths.configFile, 0o600); }
    expect(api.calls).toHaveLength(0);
  });

  test("기본 방이 빈 기존 설정도 안내된 첫 --save로 기본 방을 등록한다", async () => {
    for (const config of [{ spaces: {}, defaultSpace: "" }, { spaces: {} }]) {
      const paths = fixture(false);
      writeFileSync(paths.configFile, JSON.stringify({ ...config, sendTag: false, custom: "유지" }));
      const deps = { paths, env: {}, stdin: () => "본문", stdout: () => {}, stderr: () => {} };
      expect(await main(["send", SPACE, "--save", "dev", "--dry-run"], deps)).toBe(0);
      expect(loadConfig(paths.configFile).defaultSpace).toBe("");
      expect(await main(["spaces", SPACE, "--save", "dev"], deps)).toBe(0);
      expect(JSON.parse(readFileSync(paths.configFile, "utf8"))).toEqual({ spaces: { dev: { space: SPACE } }, defaultSpace: "dev", sendTag: false, custom: "유지" });
      expect(await main(["send", "--dry-run"], deps)).toBe(0);
    }
  });
});

describe("사람 등록과 해석 순서", () => {
  test("기존 DB에 테이블만 추가하며 재실행·한 명 삭제도 메시지는 보존한다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("preserved"), SPACE, NOW.toISOString())]);
    db.exec("DROP TABLE people");
    db.close();
    const migrated = openDatabase(paths.dbPath);
    upsertPerson(migrated, person());
    upsertPerson(migrated, { ...person(), email: null, updatedAt: NOW.toISOString() });
    expect(registeredPeople(migrated)).toEqual([{ ...person(), updatedAt: NOW.toISOString() }]);
    migrated.close();
    const api = mockFetch(() => { throw new Error("네트워크 금지"); });
    const output: string[] = [];
    const deps = { paths, fetcher: api.fetcher, stdout: (text: string) => output.push(text), stderr: () => {} };
    unlinkSync(paths.configFile);
    expect(await main(["people"], deps)).toBe(0);
    for (const value of ["가온", USER, "peer@example.test", "manual"]) expect(output.at(-1)).toContain(value);
    expect(await main(["people", "PEER@EXAMPLE.TEST"], deps)).toBe(0);
    expect(output.at(-1)).toContain(USER);
    expect(await main(["people", "없는 이름"], deps)).toBe(0);
    expect(output.at(-1)).not.toContain(USER);
    expect(await main(["people", "--forget", USER], deps)).toBe(0);
    expect(readPeople(paths.dbPath)).toEqual([]);
    const stored = openDatabase(paths.dbPath);
    try { expect(stored.query("SELECT name FROM messages").all()).toHaveLength(1); } finally { stored.close(); }
    expect(api.calls).toHaveLength(0);
  });

  test("people는 DB·설정·토큰이 없어도 빈 목록을 출력하며 인자 오류는 파일을 만들지 않는다", async () => {
    const paths = fixture(false);
    unlinkSync(paths.configFile);
    expect(await main(["people"], { paths, stdout: () => {} })).toBe(0);
    expect(await main(["people", "--forget", USER], { paths, stdout: () => {} })).toBe(0);
    for (const args of [["--forget"], ["--forget", "users/email@example.test"], ["--forget", USER, "검색어"], ["--forget", USER, "--forget", OTHER], ["--dm", USER], ["   "]]) {
      expect(() => parseArguments("people", args)).toThrow();
    }
    expect(existsSync(paths.dbPath)).toBe(false);
  });

  test("등록된 사람의 정규화 정확 일치는 발신자·디렉터리보다 우선하며 리터럴은 그대로 쓴다", async () => {
    const db = openDatabase(":memory:");
    const api = setupApi([], true);
    try {
      upsertPerson(db, person(USER, "Ａlice 가온"));
      upsertRows(db, [toRow(message("other", undefined, { sender: { name: OTHER, displayName: "Alice가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
      const client = async () => new ChatClient("fixture-access-secret", api.fetcher);
      const config = { defaultSpace: "", spaces: {}, sendTag: true };
      expect((await resolveTarget(config, db, client, { dm: " alice 가온 ", directoryEnabled: () => { throw new Error("스코프 조회 금지"); } }, NOW)).dmUser).toBe(USER);
      for (const value of [OTHER, "peer@example.test", "users/peer@example.test"]) {
        expect((await resolveTarget(config, db, client, { dm: value }, NOW)).dmUser).toBe(value.includes("/") ? value : `users/${value}`);
      }
      expect(api.calls.every(call => call.url.pathname.endsWith(":findDirectMessage"))).toBe(true);
      expect(registeredPeople(db)[0]?.updatedAt).toBe(NOW.toISOString());
    } finally { db.close(); }
  });

  test("등록부 동명이인은 후보·이메일을 출력하고 발신자나 디렉터리로 추측하지 않는다", async () => {
    const db = openDatabase(":memory:");
    try {
      upsertPerson(db, person());
      upsertPerson(db, { ...person(OTHER), email: "other@example.test" });
      const before = registeredPeople(db);
      await expect(resolveTarget({ defaultSpace: "", spaces: {}, sendTag: true }, db, async () => { throw new Error("API 금지"); },
        { dm: "가 온", directoryEnabled: () => { throw new Error("스코프 조회 금지"); } }, NOW)).rejects.toThrow("other@example.test");
      expect(registeredPeople(db)).toEqual(before);
    } finally { db.close(); }
  });

  test("발신자로 확정한 한 명은 sender로 등록하며 dry-run은 등록·갱신하지 않는다", async () => {
    const paths = fixture();
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("sender", undefined, { sender: { name: USER, displayName: "가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
    db.close();
    const api = setupApi([], true);
    const deps = { paths, now: NOW, env: {}, fetcher: api.fetcher, stdin: () => "본문", stdout: () => {}, stderr: () => {} };
    expect(await main(["send", "--dm", "가온", "--dry-run"], deps)).toBe(0);
    expect(readPeople(paths.dbPath)).toEqual([]);
    expect(await main(["send", "--dm", "가온"], deps)).toBe(0);
    expect(readPeople(paths.dbPath)).toEqual([{ userName: USER, displayName: "가온", email: null, source: "sender", updatedAt: NOW.toISOString() }]);
    expect(await main(["send", "--dm", "가온", "--dry-run"], { ...deps, now: new Date(NOW.getTime() + 1000) })).toBe(0);
    expect(readPeople(paths.dbPath)[0]?.updatedAt).toBe(NOW.toISOString());
    expect(api.calls.some(call => call.url.hostname === "people.googleapis.com")).toBe(false);
  });
});

describe("회사 디렉터리 검색", () => {
  test("정확 일치를 우선해 한 명만 저장하고 다음 세션은 디렉터리 없이 이름을 해석한다", async () => {
    const paths = fixture();
    unlinkSync(paths.configFile);
    const api = setupApi([profile("100002", "가온 두번째"), profile()], true);
    const deps = { paths, now: NOW, env: {}, fetcher: api.fetcher, stdin: () => "본문", stdout: () => {}, stderr: () => {} };
    expect(await main(["send", "--dm", "가 온", "--agent", "codex"], deps)).toBe(0);
    const search = api.calls.find(call => call.url.hostname === "people.googleapis.com")!;
    expect(search.url.pathname).toBe("/v1/people:searchDirectoryPeople");
    expect(Object.fromEntries(search.url.searchParams)).toEqual({ query: "가 온", readMask: "names,emailAddresses", sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", pageSize: "10" });
    expect(new Headers(search.init.headers).get("Authorization")).toBe("Bearer fixture-access-secret");
    expect(readPeople(paths.dbPath)).toEqual([{ ...person(USER, "가온", "directory"), updatedAt: NOW.toISOString() }]);
    const next = setupApi([], true);
    expect(await main(["send", "--dm", "가온"], { ...deps, fetcher: next.fetcher })).toBe(0);
    expect(next.calls.some(call => call.url.hostname === "people.googleapis.com")).toBe(false);
  });

  test("부분 일치도 유일할 때만 확정하고 dry-run은 사람·스페이스를 저장하지 않는다", async () => {
    const paths = fixture();
    const api = setupApi([profile("100001", "가온 테스트")]);
    const output: string[] = [];
    expect(await main(["send", "--dm", "가온", "--dry-run", "--save", "peer"], {
      paths, env: {}, now: NOW, fetcher: api.fetcher, stdin: () => "본문", stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    expect(output.at(-1)).toContain("새 DM을 만들어 보냄");
    expect(output.at(-1)).toContain("가온 테스트 → users/100001");
    expect(loadConfig(paths.configFile).spaces.peer).toBeUndefined();
    expect(readPeople(paths.dbPath)).toEqual([]);
    const db = openDatabase(paths.dbPath);
    try { expect(cachedSpaces(db)).toEqual([]); } finally { db.close(); }
    expect(api.calls.some(call => call.url.hostname !== "oauth2.googleapis.com" && call.init.method === "POST")).toBe(false);
  });

  for (const names of [["가온", "가 온"], ["가온 첫째", "가온 둘째"]]) {
    test(`동명이인·부분 일치 다중 후보(${names.join(", ")})는 저장하거나 전송하지 않는다`, async () => {
      const paths = fixture();
      const api = setupApi([profile("100001", names[0]!, "one@example.test"), profile("100002", names[1]!, "two@example.test")]);
      const errors: string[] = [];
      expect(await main(["send", "--dm", "가온"], { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", stderr: text => errors.push(text) })).toBe(1);
      for (const value of [USER, OTHER, "one@example.test", "two@example.test"]) expect(errors.join("\n")).toContain(value);
      expect(readPeople(paths.dbPath)).toEqual([]);
      expect(api.calls).toHaveLength(2);
    });
  }

  test("0명·무관한 이름은 공유 정책과 이메일을 안내하며 저장하지 않는다", async () => {
    for (const people of [[], [profile("100001", "다른 사람")]]) {
      const paths = fixture();
      const api = setupApi(people);
      const errors: string[] = [];
      expect(await main(["send", "--dm", "가온"], { paths, fetcher: api.fetcher, stderr: text => errors.push(text) })).toBe(1);
      expect(errors.join("\n")).toContain("디렉터리에서 찾지 못함 (관리자가 디렉터리 공유를 막았을 수 있음)");
      expect(errors.join("\n")).toContain("이메일");
      expect(readPeople(paths.dbPath)).toEqual([]);
    }
  });

  test("다음 페이지의 동명이인도 확인하고 반복 토큰·잘못된 사용자 ID는 거절한다", async () => {
    const pages = mockFetch((url, _init, index) => {
      expect(url.searchParams.get("pageToken")).toBe(index === 0 ? null : "next");
      return json(index === 0 ? { people: [profile()], nextPageToken: "next" } : { people: [profile("100002")] });
    });
    expect(await new ChatClient("fixture-access-secret", pages.fetcher).searchDirectoryPeople("가온")).toHaveLength(2);
    const repeated = mockFetch(() => json({ nextPageToken: "same" }));
    await expect(new ChatClient("fixture-access-secret", repeated.fetcher).searchDirectoryPeople("가온")).rejects.toThrow("반복");
    expect(repeated.calls).toHaveLength(2);
    for (const bad of [{ people: "bad" }, { people: [profile("not-numeric")] }, { people: [{ resourceName: "people/1", names: "bad" }] }]) {
      await expect(new ChatClient("fixture-access-secret", mockFetch(() => json(bad)).fetcher).searchDirectoryPeople("가온")).rejects.toThrow("응답 형식");
    }
  });

  test("People API 403은 미사용·스코프·정책 원인을 구분하고 응답 원문을 노출하지 않는다", async () => {
    for (const [reason, phrase] of [["SERVICE_DISABLED", "People API 사용 설정"], ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "mailman auth"], ["ADMIN_POLICY_ENFORCED", "디렉터리 공유 정책"]]) {
      const api = mockFetch(() => json({ error: { message: "fixture-directory-private", details: [{ reason }] } }, 403));
      try { await new ChatClient("fixture-access-secret", api.fetcher).searchDirectoryPeople("가온"); throw new Error("실패해야 함"); }
      catch (error: unknown) {
        expect(String(error)).toContain(phrase!);
        expect(String(error)).not.toContain("fixture-directory-private");
      }
      expect(api.calls).toHaveLength(1);
    }
  });

  test("People API GET 401은 갱신 뒤 한 번만 재시도한다", async () => {
    let refreshed = 0;
    const api = mockFetch((_url, init, index) => {
      expect(new Headers(init.headers).get("Authorization")).toBe(index ? "Bearer fixture-new-access" : "Bearer fixture-access-secret");
      return index ? json({ people: [profile()] }) : json({}, 401);
    });
    expect(await new ChatClient("fixture-access-secret", api.fetcher, undefined, async () => { refreshed++; return "fixture-new-access"; }).searchDirectoryPeople("가온")).toEqual([
      { userName: USER, displayName: "가온", email: "peer@example.test" },
    ]);
    expect(refreshed).toBe(1);
    const denied = mockFetch(() => json({}, 401));
    await expect(new ChatClient("fixture-access-secret", denied.fetcher, undefined, async () => "fixture-new-access").searchDirectoryPeople("가온")).rejects.toThrow("HTTP 401");
    expect(denied.calls).toHaveLength(2);
  });

  test("선택 스코프가 없는 기존 토큰은 기존 DM 전송을 유지하고 이름 검색만 재인증을 안내한다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: [...REQUIRED_SCOPES] });
    const api = setupApi([], true);
    const errors: string[] = [];
    const deps = { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", stdout: () => {}, stderr: (text: string) => errors.push(text) };
    expect(await main(["send", "--dm", USER], deps)).toBe(0);
    const calls = api.calls.length;
    expect(await main(["send", "--dm", "가온"], deps)).toBe(2);
    expect(errors.at(-1)).toContain("이메일로 지정하거나");
    expect(errors.at(-1)).toContain("mailman auth");
    expect(api.calls).toHaveLength(calls);
    for (const missing of [DIRECTORY_SCOPE, SPACE_CREATE_SCOPE]) {
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: SCOPES.filter(scope => scope !== missing) });
      expect(loadToken(paths.tokenFile).scopes).not.toContain(missing);
    }
  });
});

describe("첫 DM 생성", () => {
  test("이름 검색·DM 조회·생성·전송을 순서대로 한 번씩 실행하고 만든 방을 캐시한다", async () => {
    const paths = fixture();
    unlinkSync(paths.configFile);
    const api = setupApi();
    const output: string[] = [];
    expect(await main(["send", "--dm", "가온", "--agent", "codex", "--save", "peer"], {
      paths, env: {}, now: NOW, fetcher: api.fetcher, stdin: () => "승인된 본문", stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    expect(api.calls.map(call => [call.init.method, call.url.pathname])).toEqual([
      ["POST", "/token"], ["GET", "/v1/people:searchDirectoryPeople"], ["GET", "/v1/spaces:findDirectMessage"], ["POST", "/v1/spaces:setup"], ["POST", `/v1/${SPACE}/messages`],
    ]);
    expect(JSON.parse(String(api.calls[3]!.init.body))).toEqual({ space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: USER, type: "HUMAN" } }] });
    expect(JSON.parse(String(api.calls[4]!.init.body))).toEqual({ text: "[🤖 Codex] 승인된 본문" });
    expect(output.at(-1)).toContain("가온 → users/100001");
    expect(output.at(-1)).toContain("✅ 전송 완료");
    expect(loadConfig(paths.configFile).spaces.peer?.space).toBe(SPACE);
    const db = openDatabase(paths.dbPath);
    try { expect(cachedSpaces(db)).toEqual([DM]); } finally { db.close(); }
  });

  for (const command of ["fetch", "collect", "wait"]) {
    test(`${command}는 없는 DM을 만들지 않는다`, async () => {
      const paths = fixture();
      const api = setupApi();
      const errors: string[] = [];
      expect(await main([command, "--dm", USER], { paths, fetcher: api.fetcher, stderr: text => errors.push(text) })).toBe(3);
      expect(errors.at(-1)).toContain("아직 대화가 없는 DM");
      expect(api.calls.some(call => call.url.pathname.endsWith(":setup"))).toBe(false);
    });
  }

  test("생성 스코프가 없어도 미리보기는 가능하며 실제 전송만 exit 2이다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: SCOPES.filter(scope => scope !== SPACE_CREATE_SCOPE) });
    const api = setupApi();
    const output: string[] = [], errors: string[] = [];
    const deps = { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await main(["send", "--dm", USER, "--dry-run"], deps)).toBe(0);
    expect(output.at(-1)).toContain("새 DM을 만들어 보냄");
    expect(await main(["send", "--dm", USER], deps)).toBe(2);
    expect(errors.at(-1)).toContain("chat.spaces.create");
    expect(errors.at(-1)).toContain("mailman auth");
    expect(api.calls.some(call => call.url.pathname.endsWith(":setup"))).toBe(false);
  });

  test("본문·thread·별칭 검증 실패는 새 DM을 만들지 않는다", async () => {
    for (const [args, text] of [[[], "  "], [["--thread", THREAD], "본문"], [["--save", "tn"], "본문"]] as [string[], string][]) {
      const paths = fixture();
      const api = setupApi();
      expect(await main(["send", "--dm", USER, ...args], { paths, env: {}, fetcher: api.fetcher, stdin: () => text, stderr: () => {} })).toBe(1);
      expect(api.calls.some(call => call.url.pathname.endsWith(":setup"))).toBe(false);
    }
  });

  test("생성 POST의 401·403·5xx·연결 실패는 재시도하거나 메시지를 전송하지 않는다", async () => {
    for (const status of [401, 403, 503, undefined]) {
      const paths = fixture();
      const api = mockFetch(url => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        if (url.pathname.endsWith(":findDirectMessage")) return json({}, 404);
        expect(url.pathname).toBe("/v1/spaces:setup");
        if (status === undefined) throw new Error("fixture-private-network");
        return json({ error: { message: "Permission denied" } }, status);
      });
      const errors: string[] = [];
      expect(await main(["send", "--dm", USER], { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", stderr: text => errors.push(text) })).toBe(3);
      if (status === 403) expect(errors.at(-1)).toContain("chat.spaces.create");
      expect(api.calls).toHaveLength(3);
      expect(api.calls.filter(call => call.url.pathname.endsWith(":setup"))).toHaveLength(1);
      expect(errors.at(-1)).not.toContain("전송은 완료됨");
      const db = openDatabase(paths.dbPath);
      try { expect(cachedSpaces(db)).toEqual([]); } finally { db.close(); }
    }
  });

  test("새 DM의 send --wait도 확정한 이름으로 발신자를 제한하고 답장을 읽는다", async () => {
    const paths = fixture();
    const self = "users/100099";
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: self });
    let ticks = NOW.getTime();
    const clock = { now: () => ticks, sleep: async (ms: number) => { ticks += ms; } };
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      if (url.hostname === "people.googleapis.com") return json({ people: [profile()] });
      if (url.pathname.endsWith(":findDirectMessage")) return json({}, 404);
      if (url.pathname.endsWith(":setup")) return json(DM);
      expect(url.pathname).toBe(`/v1/${SPACE}/messages`);
      return init.method === "POST" ? json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: NOW.toISOString(), sender: { name: self } })
        : json({ messages: [message("reply", new Date(NOW.getTime() + 500).toISOString(), { sender: { name: USER, type: "HUMAN" }, text: "새 DM 답장" })] });
    });
    const output: string[] = [];
    expect(await main(["send", "--dm", "가온", "--wait", "--from", "가온", "--quiet", "1s", "--timeout", "2s", "--interval", "1s"], {
      paths, env: {}, clock, fetcher: api.fetcher, stdin: () => "질문", stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    expect(output.join("\n")).toContain("새 DM 답장");
    expect(output.join("\n")).toContain("답장 1건");
    expect(api.calls.filter(call => call.url.pathname.endsWith(":setup"))).toHaveLength(1);
    expect(api.calls.filter(call => call.url.pathname.endsWith("/messages") && call.init.method === "POST")).toHaveLength(1);
  });
});
