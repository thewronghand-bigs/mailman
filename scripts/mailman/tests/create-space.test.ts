import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { loadToken, saveToken, SPACE_CREATE_SCOPE } from "../auth";
import { ChatClient } from "../chat";
import { main, parseArguments } from "../cli";
import { loadConfig } from "../runtime";
import { cachedSpaces, openDatabase, registeredPeople, toRow, upsertPerson, upsertRows, type Person } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-27T00:00:00Z");
const SELF = "users/100099";
const USER = "users/100001";
const OTHER = "users/100002";
const CREATED = { name: "spaces/created-space", displayName: "새 프로젝트", spaceType: "SPACE" };
const person = (userName = USER, displayName = "가온", email: string | null = "peer@example.test"): Person =>
  ({ userName, displayName, email, source: "manual", updatedAt: "2026-10-20T00:00:00Z" });
const profile = (id = "100002", displayName = "나래", email = "other@example.test") =>
  ({ resourceName: `people/${id}`, names: [{ displayName }], emailAddresses: [{ value: email }] });

function setupFixture() {
  const paths = fixture();
  saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
  return paths;
}

function readState(path: string) {
  const db = openDatabase(path);
  try { return { people: registeredPeople(db), spaces: cachedSpaces(db) }; } finally { db.close(); }
}

function setupApi(people: unknown[] = [profile()]) {
  return mockFetch((url, init) => {
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
    if (url.hostname === "people.googleapis.com") return json({ people });
    expect(url.href).toBe("https://chat.googleapis.com/v1/spaces:setup");
    expect(init.method).toBe("POST");
    return json(CREATED);
  });
}

describe("스페이스 생성 인자", () => {
  test("필수 이름·멤버와 배타 옵션은 파일/API 접근 전에 검증한다", async () => {
    const paths = fixture(false);
    const api = mockFetch(() => { throw new Error("API 금지"); });
    for (const args of [[], ["새 프로젝트"], ["--member", USER], ["", "--member", USER], [" \t", "--member", USER],
      ["새 프로젝트", "--member"], ["새 프로젝트", "--member", " "], ["새 프로젝트", "중복 이름", "--member", USER],
      ["새 프로젝트", "--member", USER, "--default"], ["새 프로젝트", "--member", USER, "--save", " "],
      ["새 프로젝트", "--member", USER, "--dm", OTHER], ["새 프로젝트", "--member", USER, "--wait"]]) {
      expect(() => parseArguments("create-space", args)).toThrow();
      expect(await main(["create-space", ...args], { paths, fetcher: api.fetcher, stderr: () => {} })).toBe(1);
    }
    expect(existsSync(paths.dbPath)).toBe(false);
    expect(api.calls).toHaveLength(0);
    expect(() => parseArguments("send", ["--member", USER])).toThrow();
    const output: string[] = [];
    for (const args of [["--help"], ["create-space", "--help"]]) {
      expect(await main(args, { paths, stdout: text => output.push(text) })).toBe(0);
      expect(output.at(-1)).toContain("create-space <표시 이름>");
    }
    expect(output.at(-1)).toContain("--dry-run");
    expect(output.at(-1)).toContain("chat.spaces.create");
  });
});

describe("스페이스 생성", () => {
  test("공통 사람 해석으로 모든 멤버를 확정하고 SPACE 요청·캐시·사람 등록을 수행한다", async () => {
    const paths = setupFixture();
    unlinkSync(paths.configFile);
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("sender", undefined, { sender: { name: USER, displayName: "가온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
    db.close();
    const api = setupApi();
    const output: string[] = [], errors: string[] = [];
    expect(await main(["create-space", CREATED.displayName, "--member", "가 온", "--member", "나래"], {
      paths, now: NOW, env: {}, fetcher: api.fetcher, stdout: text => output.push(text), stderr: text => errors.push(text),
    })).toBe(0);
    expect(errors).toEqual([]);
    expect(api.calls.map(call => [call.init.method, call.url.pathname])).toEqual([
      ["POST", "/token"], ["GET", "/v1/people:searchDirectoryPeople"], ["POST", "/v1/spaces:setup"],
    ]);
    expect(JSON.parse(String(api.calls[2]!.init.body))).toEqual({ space: { spaceType: "SPACE", displayName: CREATED.displayName },
      memberships: [{ member: { name: USER, type: "HUMAN" } }, { member: { name: OTHER, type: "HUMAN" } }] });
    expect(new Headers(api.calls[2]!.init.headers).get("Authorization")).toBe("Bearer fixture-access-secret");
    for (const value of ["스페이스 생성 완료", CREATED.displayName, CREATED.name, "가온", "나래", USER, OTHER]) expect(output.join("\n")).toContain(value);
    expect(readState(paths.dbPath)).toEqual({ spaces: [CREATED], people: [
      { ...person(USER, "가온", null), source: "sender", updatedAt: NOW.toISOString() },
      { ...person(OTHER, "나래", "other@example.test"), source: "directory", updatedAt: NOW.toISOString() },
    ] });
    expect(existsSync(paths.configFile)).toBe(false);
  });

  test("리터럴은 디렉터리나 DM을 조회하지 않으며 20명까지 한 요청으로 초대한다", async () => {
    const paths = setupFixture();
    const api = setupApi();
    const users = ["peer@example.test", ...Array.from({ length: 19 }, (_, i) => `users/${i + 1}`)];
    expect(await main(["create-space", CREATED.displayName, ...users.flatMap(user => ["--member", user])], {
      paths, fetcher: api.fetcher, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    expect(api.calls).toHaveLength(2);
    expect(JSON.parse(String(api.calls[1]!.init.body)).memberships).toEqual(users.map(user => ({ member: { name: user.includes("/") ? user : `users/${user}`, type: "HUMAN" } })));
    expect(readState(paths.dbPath).people).toEqual([]);
  });

  test("20명 상한은 중복을 합친 뒤 적용하고 초과하면 생성 요청 전에 중단한다", async () => {
    const paths = setupFixture();
    const api = setupApi();
    const users = Array.from({ length: 21 }, (_, i) => `users/${i + 1}`);
    const members = [...users.slice(0, 20), users[0]!, users[1]!, users[0]!];
    expect(await main(["create-space", CREATED.displayName, ...members.flatMap(user => ["--member", user])], {
      paths, fetcher: api.fetcher, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    const created = api.calls.find(call => call.url.pathname.endsWith(":setup"))!;
    expect(JSON.parse(String(created.init.body)).memberships).toEqual(users.slice(0, 20).map(name => ({ member: { name, type: "HUMAN" } })));

    const overflowPaths = setupFixture();
    const overflowApi = setupApi();
    const errors: string[] = [];
    for (const flags of [[], ["--dry-run"]]) {
      expect(await main(["create-space", CREATED.displayName, ...users.flatMap(user => ["--member", user]), ...flags], {
        paths: overflowPaths, fetcher: overflowApi.fetcher, stderr: text => errors.push(text),
      })).toBe(1);
      expect(errors.at(-1)).toContain("멤버는 1~20명");
    }
    expect(overflowApi.calls).toHaveLength(0);
    expect(readState(overflowPaths.dbPath)).toEqual({ people: [], spaces: [] });
  });

  test("모호한 멤버는 해당 인자를 표시하고 API 요청·앞선 사람 등록 없이 중단한다", async () => {
    const paths = setupFixture();
    const db = openDatabase(paths.dbPath);
    upsertPerson(db, person());
    upsertPerson(db, person(OTHER));
    upsertRows(db, [toRow(message("sender", undefined, { sender: { name: "users/100003", displayName: "다온", type: "HUMAN" } }), SPACE, NOW.toISOString())]);
    db.close();
    const before = readState(paths.dbPath);
    const api = setupApi();
    const errors: string[] = [];
    expect(await main(["create-space", CREATED.displayName, "--member", "다온", "--member", "가온"], {
      paths, fetcher: api.fetcher, stderr: text => errors.push(text),
    })).toBe(1);
    expect(errors.join("\n")).toContain('--member "가온"');
    expect(errors.join("\n")).toContain("같은 이름의 사람이 여러 명입니다");
    expect(api.calls).toHaveLength(0);
    expect(readState(paths.dbPath)).toEqual(before);
  });

  test("미발견·디렉터리 다중 후보도 문제 인자와 후보를 표시하고 생성·등록하지 않는다", async () => {
    for (const people of [[], [profile("100001", "나래 첫째"), profile("100002", "나래 둘째")]]) {
      const paths = setupFixture();
      const api = setupApi(people);
      const errors: string[] = [];
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--member", "나래"], {
        paths, fetcher: api.fetcher, stderr: text => errors.push(text),
      })).toBe(1);
      expect(errors.join("\n")).toContain('--member "나래"');
      expect(errors.join("\n")).toContain(people.length ? "이름이 일치하는 후보가 여러 명입니다" : "디렉터리에서 찾지 못함");
      expect(api.calls.some(call => call.url.pathname.endsWith(":setup"))).toBe(false);
      expect(readState(paths.dbPath)).toEqual({ people: [], spaces: [] });
    }
  });

  test("본인 ID·이메일·이름·users/me 지정은 인자 오류이며 초대하지 않는다", async () => {
    for (const value of [SELF, "TESTER@example.test", "users/tester@example.test", "본인", "users/me"]) {
      const paths = setupFixture();
      const db = openDatabase(paths.dbPath);
      upsertPerson(db, person(SELF, "본인", "tester@example.test"));
      db.close();
      const before = readState(paths.dbPath);
      const api = setupApi();
      const errors: string[] = [];
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--member", value], {
        paths, fetcher: api.fetcher, stderr: text => errors.push(text),
      })).toBe(1);
      expect(errors.join("\n")).toContain(`--member ${JSON.stringify(value)}`);
      expect(errors.join("\n")).toContain("본인 계정");
      expect(api.calls).toHaveLength(0);
      expect(readState(paths.dbPath)).toEqual(before);
    }
  });

  test("계정 ID가 없는 이전 토큰도 userinfo로 본인 ID를 확인해 생성 전에 거절한다", async () => {
    const paths = fixture();
    const api = mockFetch(url => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
      expect(url.href).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      return json({ sub: SELF.slice("users/".length) });
    });
    const errors: string[] = [];
    expect(await main(["create-space", CREATED.displayName, "--member", SELF], {
      paths, fetcher: api.fetcher, stderr: text => errors.push(text),
    })).toBe(1);
    expect(errors.join("\n")).toContain("본인 계정");
    expect(api.calls).toHaveLength(2);
    expect(loadToken(paths.tokenFile).user_name).toBe(SELF);
  });

  test("중복 이름·ID·알려진 이메일을 같은 사람으로 합치며 이름 검색 결과도 함께 사용한다", async () => {
    const paths = setupFixture();
    const api = setupApi([profile("100001", "가온", "peer@example.test")]);
    const output: string[] = [];
    expect(await main(["create-space", CREATED.displayName, "--member", "peer@example.test", "--member", USER,
      "--member", "가온", "--member", "users/PEER@example.test", "--member", USER], {
      paths, now: NOW, fetcher: api.fetcher, stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    const created = api.calls.find(call => call.url.pathname.endsWith(":setup"))!;
    expect(JSON.parse(String(created.init.body)).memberships).toEqual([{ member: { name: USER, type: "HUMAN" } }]);
    expect(output.join("\n")).toContain("초대한 멤버 (1명)");
    expect(readState(paths.dbPath).people).toEqual([{ ...person(), source: "directory", updatedAt: NOW.toISOString() }]);
  });

  test("dry-run은 멤버 미리보기만 출력하고 생성·등록·갱신·캐시·별칭·기본 방을 바꾸지 않는다", async () => {
    const paths = setupFixture();
    const db = openDatabase(paths.dbPath);
    upsertPerson(db, person());
    db.close();
    const before = readState(paths.dbPath);
    const configBefore = readFileSync(paths.configFile, "utf8");
    const modeBefore = statSync(paths.configFile).mode;
    const api = setupApi();
    const output: string[] = [];
    expect(await main(["create-space", CREATED.displayName, "--member", "가온", "--member", "나래", "--save", "project", "--default", "--dry-run"], {
      paths, now: NOW, fetcher: api.fetcher, stdout: text => output.push(text), stderr: () => {},
    })).toBe(0);
    for (const value of ["스페이스 생성 미리보기", CREATED.displayName, "가온", "나래", USER, OTHER, "기본 방으로 지정할 예정"]) expect(output.join("\n")).toContain(value);
    expect(api.calls.map(call => call.url.pathname)).toEqual(["/token", "/v1/people:searchDirectoryPeople"]);
    expect(readState(paths.dbPath)).toEqual(before);
    expect(readFileSync(paths.configFile, "utf8")).toBe(configBefore);
    expect(statSync(paths.configFile).mode).toBe(modeBefore);
    unlinkSync(paths.configFile);
    expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "first", "--dry-run"], {
      paths, fetcher: api.fetcher, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  test("생성 스코프가 없으면 실행은 exit 2로 재인증을 안내하고 dry-run은 허용한다", async () => {
    const paths = setupFixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: loadToken(paths.tokenFile).scopes.filter(scope => scope !== SPACE_CREATE_SCOPE) });
    const api = setupApi();
    const errors: string[] = [];
    const deps = { paths, fetcher: api.fetcher, stdout: () => {}, stderr: (text: string) => errors.push(text) };
    expect(await main(["create-space", CREATED.displayName, "--member", USER, "--dry-run"], deps)).toBe(0);
    expect(await main(["create-space", CREATED.displayName, "--member", USER], deps)).toBe(2);
    expect(errors.join("\n")).toContain("chat.spaces.create");
    expect(errors.join("\n")).toContain("mailman auth");
    expect(api.calls).toHaveLength(0);
    expect(readState(paths.dbPath)).toEqual({ people: [], spaces: [] });
  });

  test("--save는 0600 별칭을 저장하고 --default와 기존 추가 필드를 보존한다", async () => {
    for (const makeDefault of [false, true]) {
      const paths = setupFixture();
      const original = { defaultSpace: "tn", spaces: { tn: { space: SPACE, custom: "유지" } }, sendTag: false, custom: "유지" };
      writeFileSync(paths.configFile, JSON.stringify(original));
      const api = setupApi();
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "project", ...(makeDefault ? ["--default"] : [])], {
        paths, fetcher: api.fetcher, stdout: () => {}, stderr: () => {},
      })).toBe(0);
      expect(JSON.parse(readFileSync(paths.configFile, "utf8"))).toEqual({ ...original, defaultSpace: makeDefault ? "project" : "tn",
        spaces: { ...original.spaces, project: { space: CREATED.name } } });
      expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    }
    const paths = setupFixture();
    unlinkSync(paths.configFile);
    expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "first"], {
      paths, fetcher: setupApi().fetcher, stdout: () => {}, stderr: () => {},
    })).toBe(0);
    expect(loadConfig(paths.configFile)).toMatchObject({ defaultSpace: "first", spaces: { first: { space: CREATED.name } } });
  });

  test("기존 별칭 충돌은 --default·dry-run에서도 생성 전에 거절한다", async () => {
    const paths = setupFixture();
    const before = readFileSync(paths.configFile, "utf8");
    const api = setupApi();
    const errors: string[] = [];
    for (const flags of [[], ["--default"], ["--dry-run"], ["--default", "--dry-run"]]) {
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "tn", ...flags], {
        paths, fetcher: api.fetcher, stderr: text => errors.push(text),
      })).toBe(1);
      expect(errors.at(-1)).toContain("--save는 덮어쓰지 않습니다");
    }
    expect(api.calls).toHaveLength(0);
    expect(readFileSync(paths.configFile, "utf8")).toBe(before);
  });

  test("생성 POST의 401·403·5xx·연결·응답 유실은 한 번만 요청하고 확인 안내로 끝낸다", async () => {
    for (const failure of [401, 403, 503, "network", "json", "shape"]) {
      const paths = setupFixture();
      const api = mockFetch(url => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        expect(url.pathname).toBe("/v1/spaces:setup");
        if (failure === "network") throw new Error("fixture-private-network");
        if (failure === "json") return new Response("invalid json");
        if (failure === "shape") return json({ name: "invalid" });
        return json({ error: { message: "fixture-private-error" } }, Number(failure));
      });
      const errors: string[] = [];
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "project"], {
        paths, fetcher: api.fetcher, stderr: text => errors.push(text),
      })).toBe(3);
      expect(api.calls).toHaveLength(2);
      expect(api.calls.filter(call => call.url.pathname.endsWith(":setup"))).toHaveLength(1);
      expect(errors.join("\n")).toContain(failure === 403 ? "chat.spaces.create" : "Chat에서 생성 여부를 확인한 뒤 재실행");
      expect(errors.join("\n")).not.toContain("fixture-private-network");
      expect(readState(paths.dbPath)).toEqual({ people: [], spaces: [] });
      expect(loadConfig(paths.configFile).spaces.project).toBeUndefined();
    }
  });

  test("생성 뒤 별칭 저장 실패나 출력 실패는 생성 결과와 재생성 금지를 알린다", async () => {
    for (const failure of ["alias", "stdout"]) {
      const paths = setupFixture();
      const api = mockFetch(url => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access-secret" });
        expect(url.pathname).toBe("/v1/spaces:setup");
        if (failure === "alias") writeFileSync(paths.configFile, JSON.stringify({ spaces: { project: { space: SPACE } } }));
        return json(CREATED);
      });
      const errors: string[] = [];
      expect(await main(["create-space", CREATED.displayName, "--member", USER, "--save", "project"], {
        paths, fetcher: api.fetcher, stdout: () => { if (failure === "stdout") throw new Error("출력 실패"); }, stderr: text => errors.push(text),
      })).toBe(1);
      expect(errors.join("\n")).toContain(CREATED.name);
      expect(errors.join("\n")).toContain("재생성하지 말 것");
      expect(readState(paths.dbPath).spaces).toEqual([CREATED]);
      expect(api.calls).toHaveLength(2);
      expect(loadConfig(paths.configFile).spaces.project?.space).toBe(failure === "alias" ? SPACE : CREATED.name);
    }
  });

  test("API 래퍼도 빈 이름·0명·21명·잘못된 ID는 요청 전에 거절한다", async () => {
    const api = setupApi();
    const client = new ChatClient("fixture-access-secret", api.fetcher);
    for (const [name, members] of [[" ", [USER]], [CREATED.displayName, []], [CREATED.displayName, Array(21).fill(USER)], [CREATED.displayName, ["invalid"]]] as [string, string[]][]) {
      await expect(client.setupSpace(name, members)).rejects.toThrow();
    }
    expect(api.calls).toHaveLength(0);
  });
});
