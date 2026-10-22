import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { main, parseArguments } from "../cli";
import { SEND_PREFIX } from "../content";
import { getRuntimePaths, loadConfig, resolveSpace } from "../runtime";
import { openDatabase, toRow, upsertRows } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);

describe("CLI와 경로", () => {
  test("데이터 경로와 인증정보 경로를 각각 덮어쓴다", () => {
    const paths = getRuntimePaths(import.meta.url, { MAILMAN_HOME: "/custom/data" });
    expect(paths.dbPath).toBe("/custom/data/inbox/mailman-v2.db");
    expect(paths.tokenFile).toBe(join(homedir(), ".claude/secrets/mailman-token.json"));
    const overridden = getRuntimePaths(import.meta.url, { MAILMAN_CLIENT_FILE: "/custom/client.json", MAILMAN_TOKEN_FILE: "/custom/token.json" });
    expect(overridden.clientFile).toBe("/custom/client.json");
    expect(overridden.tokenFile).toBe("/custom/token.json");
  });

  test("별칭 생략은 기본 스페이스, 잘못된 별칭은 에러다", () => {
    const config = loadConfig(fixture().scriptDir);
    expect(resolveSpace(config).space.space).toBe(SPACE);
    expect(() => resolveSpace(config, "없는별칭")).toThrow("등록되지 않은");
    expect(parseArguments("fetch", ["tn", "3", "--all"])).toMatchObject({ spaceKey: "tn", limit: 3, all: true });
    expect(parseArguments("fetch", ["3"]).spaceKey).toBeUndefined();
    expect(parseArguments("fetch", ["3"]).limit).toBe(3);
    expect(() => parseArguments("fetch", ["tn", "봇별칭", "3"])).toThrow();
    expect(() => parseArguments("fetch", ["0"])).toThrow();
  });

  test("토큰 없음은 run exit 2이고 fetch는 기존 DB를 계속 보여준다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("cached", undefined, { text: "기존 DB 본문" }), SPACE, new Date().toISOString())]);
    db.close();
    const output: string[] = [];
    const errors: string[] = [];
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    const dependencies = { paths, fetcher, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await main(["run", "tn"], dependencies)).toBe(2);
    expect(await main(["fetch", "tn"], dependencies)).toBe(0);
    expect(output.join("\n")).toContain("기존 DB 본문");
    expect(errors.join("\n")).toContain("기존 DB 내용을 표시");
    expect(calls).toHaveLength(0);
    const log = readFileSync(paths.logFile, "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    for (const line of log) expect(line).toContain(`space=${SPACE} 수집 실패: 토큰 파일이 없습니다.`);
  });

  test("invalid_grant 안내와 Google 오류를 처리하고 비밀값을 출력하지 않는다", async () => {
    const paths = fixture();
    const { fetcher, calls } = mockFetch(() => json({ error: "invalid_grant", error_description: "fixture-refresh-secret fixture-client-secret" }, 400));
    const errors: string[] = [];
    expect(await main(["run"], { paths, fetcher, stderr: text => errors.push(text) })).toBe(3);
    expect(errors.join("\n")).toContain("다시 run.sh auth");
    expect(errors.join("\n")).not.toContain("fixture-refresh-secret");
    expect(errors.join("\n")).not.toContain("fixture-client-secret");
    const log = readFileSync(paths.logFile, "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain(`space=${SPACE} 수집 실패:`);
    expect(log).toContain("다시 run.sh auth");
    expect(log).not.toContain("fixture-refresh-secret");
    expect(log).not.toContain("fixture-client-secret");
    expect(calls).toHaveLength(1);
    expect(existsSync(paths.dbPath)).toBe(false);
  });

  test("수집 로그는 스페이스와 건수만 한 줄로 남긴다", async () => {
    const paths = fixture();
    const { fetcher } = mockFetch((_url, _init, index) => index === 0
      ? json({ access_token: "fixture-access-secret" }) : json({ messages: [message("one")] }));
    expect(await main(["run"], { paths, fetcher, stderr: () => {} })).toBe(0);
    const log = readFileSync(paths.logFile, "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain(`space=${SPACE} received=1 saved=1`);
    expect(log).not.toContain("fixture-access-secret");
  });

  test("run/fetch의 네트워크·API 실패를 비밀값 없이 한 줄로 기록하고 stderr도 유지한다", async () => {
    for (const command of ["run", "fetch"]) {
      for (const failure of ["network", "api"]) {
        const paths = fixture();
        const errors: string[] = [];
        const { fetcher } = mockFetch((_url, _init, index) => {
          if (index === 0) return json({ access_token: "fixture-access-secret" });
          if (failure === "network") throw new Error("fixture-access-secret fixture-refresh-secret fixture-client-secret");
          return json({ error: { message: "권한 없음\nfixture-access-secret fixture-refresh-secret fixture-client-secret Bearer fixture-bearer-secret https://chat.googleapis.com/v1/spaces/test/messages?key=fixture-webhook-key&token=fixture-webhook-token" } }, 403);
        });
        expect(await main([command], { paths, fetcher, stderr: text => errors.push(text), stdout: () => {} })).toBe(command === "run" ? 3 : 0);
        const log = readFileSync(paths.logFile, "utf8");
        const expected = failure === "network" ? "네트워크 요청에 실패" : "HTTP 403: 권한 없음";
        expect(log.trim().split("\n")).toHaveLength(1);
        expect(log).toContain(`space=${SPACE} 수집 실패:`);
        expect(log).toContain(expected);
        expect(errors.join("\n")).toContain(expected);
        for (const secret of ["fixture-access-secret", "fixture-refresh-secret", "fixture-client-secret", "fixture-bearer-secret", "fixture-webhook-key", "fixture-webhook-token"]) {
          expect(log).not.toContain(secret);
          expect(errors.join("\n")).not.toContain(secret);
        }
      }
    }
  });

  test("실패 로그를 쓸 수 없어도 원래 인증 오류와 종료 코드를 유지한다", async () => {
    const paths = fixture(false);
    mkdirSync(paths.logFile, { recursive: true });
    const errors: string[] = [];
    expect(await main(["run"], { paths, stderr: text => errors.push(text) })).toBe(2);
    expect(errors.join("\n")).toContain("수집 실패 로그를 기록할 수 없습니다.");
    expect(errors.join("\n")).toContain("토큰 파일이 없습니다.");
  });

  test("새 DB는 0600이고 기존 DB의 내용과 권한은 유지한다", () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    try {
      expect(statSync(paths.dbPath).mode & 0o777).toBe(0o600);
      upsertRows(db, [toRow(message("preserved"), SPACE, new Date().toISOString())]);
    } finally { db.close(); }
    chmodSync(paths.dbPath, 0o640);
    const reopened = openDatabase(paths.dbPath);
    try {
      expect(statSync(paths.dbPath).mode & 0o777).toBe(0o640);
      expect(reopened.query<{ text: string }, []>("SELECT text FROM messages").get()?.text).toBe("preserved");
    } finally { reopened.close(); }
  });

  test("전송 성공 이름을 출력하고 HTTP 실패는 exit 3으로 한 번만 보낸다", async () => {
    const paths = fixture();
    const output: string[] = [];
    const success = mockFetch((_url, init, index) => {
      if (index === 0) return json({ access_token: "fixture-access-secret" });
      expect(JSON.parse(String(init.body))).toEqual({ text: `${SEND_PREFIX}본문`, thread: { name: THREAD } });
      return json({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
    });
    expect(await main(["send", "tn", "--thread", THREAD], { paths, fetcher: success.fetcher, stdin: () => "본문", stdout: text => output.push(text) })).toBe(0);
    expect(output.join("\n")).toContain(`${SPACE}/messages/created`);
    expect(output.join("\n")).toContain(THREAD);
    const errors: string[] = [];
    const failure = mockFetch((_url, _init, index) => index === 0 ? json({ access_token: "fixture-access-secret" }) : json({ error: { message: "Permission denied" } }, 403));
    expect(await main(["send", "tn"], { paths, fetcher: failure.fetcher, stdin: () => "본문", stderr: text => errors.push(text) })).toBe(3);
    expect(errors.join("\n")).toContain("HTTP 403: Permission denied");
    expect(failure.calls).toHaveLength(2);
  });

  test("빈 전송 본문과 다른 스페이스의 thread는 refresh 전에 거부한다", async () => {
    const paths = fixture();
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    expect(await main(["send"], { paths, fetcher, stdin: () => " \n", stderr: () => {} })).toBe(1);
    expect(await main(["send", "--thread", "spaces/other/threads/thread"], { paths, fetcher, stdin: () => "답글", stderr: () => {} })).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("세 래퍼의 help/인자 오류는 설정을 읽거나 런타임 파일을 만들지 않는다", () => {
    const paths = fixture(false);
    const scriptDir = join(import.meta.dir, "..");
    const cases: Array<[string, string[], number]> = [
      ["run", ["--help"], 0], ["fetch", ["--help"], 0], ["send", ["--help"], 0],
      ["run", ["auth", "extra"], 1], ["fetch", ["tn", "봇별칭", "3"], 1], ["send", ["--thread"], 1],
    ];
    for (const [wrapper, args, status] of cases) {
      const result = Bun.spawnSync(["bash", join(scriptDir, `${wrapper}.sh`), ...args], {
        env: { ...process.env, MAILMAN_HOME: paths.home, MAILMAN_CLIENT_FILE: paths.clientFile, MAILMAN_TOKEN_FILE: paths.tokenFile },
        stdin: Buffer.from(""),
      });
      expect(result.exitCode).toBe(status);
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain("SyntaxError");
    }
    expect(existsSync(paths.dbPath)).toBe(false);
    expect(existsSync(paths.logFile)).toBe(false);
  });
});
