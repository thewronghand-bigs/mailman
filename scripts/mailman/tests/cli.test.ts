import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { main, parseArguments } from "../cli";
import { getRuntimePaths, loadConfig, resolveSendPrefix, resolveSpace, SETUP_GUIDE_URL, type Environment, type RuntimePaths } from "../runtime";
import { getMeta, openDatabase, setMeta, toRow, upsertRows } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-22T12:00:00Z");

describe("CLI와 경로", () => {
  test("데이터 경로와 인증정보 경로를 각각 덮어쓴다", () => {
    const paths = getRuntimePaths({ MAILMAN_HOME: "/custom/data" });
    expect(paths.dbPath).toBe("/custom/data/inbox/mailman-v2.db");
    expect(paths.tokenFile).toBe(join(homedir(), ".claude/secrets/mailman-token.json"));
    const overridden = getRuntimePaths({ MAILMAN_CLIENT_FILE: "/custom/client.json", MAILMAN_TOKEN_FILE: "/custom/token.json" });
    expect(overridden.clientFile).toBe("/custom/client.json");
    expect(overridden.tokenFile).toBe("/custom/token.json");
  });

  test("설정 파일은 스크립트 위치가 아닌 $MAILMAN_HOME/mailman/config.json이고 MAILMAN_CONFIG로 덮는다", () => {
    expect(getRuntimePaths({}).configFile).toBe(join(homedir(), ".claude/mailman/config.json"));
    expect(getRuntimePaths({ MAILMAN_HOME: "/custom/data" }).configFile).toBe("/custom/data/mailman/config.json");
    expect(getRuntimePaths({ MAILMAN_HOME: "/custom/data", MAILMAN_CONFIG: "/etc/mailman.json" }).configFile).toBe("/etc/mailman.json");
    expect(getRuntimePaths({ MAILMAN_CONFIG: "~/conf/mailman.json" }).configFile).toBe(join(homedir(), "conf/mailman.json"));
    const missing = join(fixture(false).home, "없는 설정.json");
    expect(() => loadConfig(missing)).toThrow(missing);
    expect(() => loadConfig(missing)).toThrow(SETUP_GUIDE_URL);
  });

  test("별칭 생략은 기본 스페이스, 잘못된 별칭은 에러다", () => {
    const config = loadConfig(fixture().configFile);
    expect(resolveSpace(config).space.space).toBe(SPACE);
    expect(() => resolveSpace(config, "없는별칭")).toThrow("등록되지 않은");
    expect(parseArguments("fetch", []).spaceKey).toBeUndefined();
    expect(parseArguments("fetch", ["tn", "--since", "7d"], NOW)).toMatchObject({ spaceKey: "tn", since: "2026-10-15T12:00:00.000000000Z" });
    expect(parseArguments("fetch", ["--since", "24h", "tn"], NOW)).toMatchObject({ spaceKey: "tn", since: "2026-10-21T12:00:00.000000000Z" });
    expect(parseArguments("fetch", ["--since", "2026-10-01"], NOW).since).toBeDefined();
    for (const args of [["tn", "3"], ["--all"], ["tn", "봇별칭"], ["--since"], ["--since", "--helpful"], ["--since", "0d"], ["--since", "7d", "--since", "3d"]]) {
      expect(() => parseArguments("fetch", args, NOW)).toThrow();
    }
    expect(() => parseArguments("collect", ["--since", "7d"])).toThrow();
    expect(() => parseArguments("send", ["--since", "7d"])).toThrow();
  });

  test("토큰 없음은 collect exit 2이고 fetch는 기존 DB를 계속 보여준다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("cached", "2026-10-22T11:00:00Z", { text: "기존 DB 본문" }), SPACE, NOW.toISOString())]);
    db.close();
    const output: string[] = [];
    const errors: string[] = [];
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    const dependencies = { paths, fetcher, now: NOW, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
    expect(await main(["collect", "tn"], dependencies)).toBe(2);
    expect(await main(["fetch", "tn"], dependencies)).toBe(0);
    expect(output.join("\n")).toContain("기존 DB 본문");
    expect(errors.join("\n")).toContain("기존 DB 내용을 표시");
    expect(calls).toHaveLength(0);
    const log = readFileSync(paths.logFile, "utf8").trim().split("\n");
    expect(log).toHaveLength(2);
    for (const line of log) expect(line).toContain(`space=${SPACE} 수집 실패: 토큰 파일이 없습니다.`);
  });

  test("fetch는 기간 조회/출력 실패 때 seen을 유지하고 기본 조회 성공 뒤에만 저장한다", async () => {
    const paths = fixture(false);
    const seenKey = `seenCreateTime:${SPACE}`;
    const initialSeen = "2026-10-20T00:00:00.000000000Z";
    const db = openDatabase(paths.dbPath);
    try {
      setMeta(db, seenKey, initialSeen);
      upsertRows(db, [toRow(message("new", "2026-10-22T11:00:00Z", { text: "안 읽은 본문" }), SPACE, NOW.toISOString())]);
    } finally { db.close(); }
    const readSeen = () => {
      const stored = openDatabase(paths.dbPath);
      try { return getMeta(stored, seenKey); } finally { stored.close(); }
    };
    const output: string[] = [];
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    const dependencies = { paths, fetcher, now: NOW, stderr: () => {}, stdout: (text: string) => output.push(text) };
    expect(await main(["fetch", "tn", "--since", "7d"], dependencies)).toBe(0);
    expect(output.at(-1)).toContain("안 읽은 본문");
    expect(readSeen()).toBe(initialSeen);
    expect(await main(["fetch", "tn"], { ...dependencies, stdout: async () => { throw new Error("출력 실패"); } })).toBe(1);
    expect(readSeen()).toBe(initialSeen);
    expect(await main(["fetch", "tn"], dependencies)).toBe(0);
    expect(readSeen()).toBe("2026-10-22T11:00:00.000000000Z");
    expect(await main(["fetch", "tn"], dependencies)).toBe(0);
    expect(output.at(-1)).toStartWith(`[대상] tn (SPACE_TYPE_UNSPECIFIED, ${SPACE})\n[tn] 새 메시지가 없습니다.`);
    expect(readSeen()).toBe("2026-10-22T11:00:00.000000000Z");
    expect(calls).toHaveLength(0);
  });

  test("실제 stdout 파이프가 닫혀도 seen을 저장하지 않는다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    try {
      upsertRows(db, [toRow(message("new", "2026-10-22T11:00:00Z"), SPACE, NOW.toISOString())]);
    } finally { db.close(); }
    const script = `import { main } from ${JSON.stringify(new URL("../cli.ts", import.meta.url).href)};
      process.exitCode = await main(["fetch"], { paths: ${JSON.stringify(paths)}, now: new Date(${JSON.stringify(NOW.toISOString())}),
        fetcher: async () => { throw new Error("실제 네트워크 호출 금지"); } });`;
    const child = Bun.spawnSync(["/bin/bash", "-c", 'set -o pipefail\n"$1" --eval "$2" | /usr/bin/true', "mailman-stdout-test", process.execPath, script]);
    expect(child.exitCode).toBe(1);
    expect(child.stderr.toString()).toContain("처리 중 오류가 발생했습니다.");
    const stored = openDatabase(paths.dbPath);
    try {
      expect(getMeta(stored, `seenCreateTime:${SPACE}`)).toBeUndefined();
      expect(getMeta(stored, `seenMessageName:${SPACE}`)).toBeUndefined();
    } finally { stored.close(); }
  });

  test("invalid_grant 안내와 Google 오류를 처리하고 비밀값을 출력하지 않는다", async () => {
    const paths = fixture();
    const { fetcher, calls } = mockFetch(() => json({ error: "invalid_grant", error_description: "fixture-refresh-secret fixture-client-secret" }, 400));
    const errors: string[] = [];
    expect(await main(["collect"], { paths, fetcher, stderr: text => errors.push(text) })).toBe(3);
    expect(errors.join("\n")).toContain("다시 mailman auth");
    expect(errors.join("\n")).not.toContain("fixture-refresh-secret");
    expect(errors.join("\n")).not.toContain("fixture-client-secret");
    const log = readFileSync(paths.logFile, "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain(`space=${SPACE} 수집 실패:`);
    expect(log).toContain("다시 mailman auth");
    expect(log).not.toContain("fixture-refresh-secret");
    expect(log).not.toContain("fixture-client-secret");
    expect(calls).toHaveLength(1);
    expect(existsSync(paths.dbPath)).toBe(false);
  });

  test("수집 로그는 스페이스와 건수만 한 줄로 남긴다", async () => {
    const paths = fixture();
    const { fetcher } = mockFetch((_url, _init, index) => index === 0
      ? json({ access_token: "fixture-access-secret" }) : json({ messages: [message("one")] }));
    expect(await main(["collect"], { paths, fetcher, stderr: () => {} })).toBe(0);
    const log = readFileSync(paths.logFile, "utf8");
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(log).toContain(`space=${SPACE} received=1 saved=1`);
    expect(log).not.toContain("fixture-access-secret");
  });

  test("collect/fetch의 네트워크·API 실패를 비밀값 없이 한 줄로 기록하고 stderr도 유지한다", async () => {
    for (const command of ["collect", "fetch"]) {
      for (const failure of ["network", "api"]) {
        const paths = fixture();
        const errors: string[] = [];
        const { fetcher } = mockFetch((_url, _init, index) => {
          if (index === 0) return json({ access_token: "fixture-access-secret" });
          if (failure === "network") throw new Error("fixture-access-secret fixture-refresh-secret fixture-client-secret");
          return json({ error: { message: "권한 없음\nfixture-access-secret fixture-refresh-secret fixture-client-secret Bearer fixture-bearer-secret https://chat.googleapis.com/v1/spaces/test/messages?key=fixture-webhook-key&token=fixture-webhook-token" } }, 403);
        });
        expect(await main([command], { paths, fetcher, stderr: text => errors.push(text), stdout: () => {} })).toBe(command === "collect" ? 3 : 0);
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
    expect(await main(["collect"], { paths, stderr: text => errors.push(text) })).toBe(2);
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
      expect(JSON.parse(String(init.body))).toEqual({ text: "[🤖 AI] 본문", thread: { name: THREAD } });
      return json({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
    });
    expect(await main(["send", "tn", "--thread", THREAD], { paths, fetcher: success.fetcher, env: {}, stdin: () => "본문", stdout: text => output.push(text) })).toBe(0);
    expect(output.join("\n")).toContain(`${SPACE}/messages/created`);
    expect(output.join("\n")).not.toContain("태그 없이");
    expect(output.join("\n")).toContain(THREAD);
    const errors: string[] = [];
    const failure = mockFetch((_url, _init, index) => index === 0 ? json({ access_token: "fixture-access-secret" }) : json({ error: { message: "Permission denied" } }, 403));
    expect(await main(["send", "tn"], { paths, fetcher: failure.fetcher, env: {}, stdin: () => "본문", stderr: text => errors.push(text) })).toBe(3);
    expect(errors.join("\n")).toContain("HTTP 403: Permission denied");
    expect(failure.calls).toHaveLength(2);
  });

  test("빈 전송 본문과 다른 스페이스의 thread는 refresh 전에 거부한다", async () => {
    const paths = fixture();
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    expect(await main(["send"], { paths, fetcher, env: {}, stdin: () => " \n", stderr: () => {} })).toBe(1);
    expect(await main(["send", "--thread", "spaces/other/threads/thread"], { paths, fetcher, env: {}, stdin: () => "답글", stderr: () => {} })).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("mailman-dev의 help/버전/인자 오류는 설정을 읽거나 런타임 파일을 만들지 않는다", () => {
    const paths = fixture(false);
    const devRunner = join(import.meta.dir, "..", "mailman-dev");
    const cases: Array<[string[], number]> = [
      [["--help"], 0], [["--version"], 0], [["auth", "--help"], 0], [["collect", "--help"], 0], [["fetch", "--help"], 0], [["send", "--help"], 0], [["spaces", "--help"], 0], [["wait", "--help"], 0],
      [[], 1], [["bogus"], 1], [["run"], 1], [["auth", "extra"], 1], [["auth", "--client"], 1], [["collect", "--since", "7d"], 1],
      [["fetch", "tn", "3"], 1], [["fetch", "--all"], 1], [["fetch", "--since"], 1], [["fetch", "--since", "2026-02-30"], 1],
      [["fetch", "--only"], 1], [["fetch", "--only", "robot"], 1], [["fetch", "--deep", "--no-collect"], 1], [["send", "--thread"], 1],
      [["send", "--agent"], 1], [["send", "--agent", "gpt"], 1], [["send", "--no-tag", "--agent", "claude"], 1], [["send", "--no-tag", "--no-tag"], 1],
      [["wait", "--timeout", "0s"], 1], [["wait", "tn", "--dm", "가온"], 1], [["spaces", "--dm", "가온"], 1],
    ];
    for (const [args, status] of cases) {
      const result = Bun.spawnSync(["bash", devRunner, ...args], {
        env: { ...process.env, MAILMAN_HOME: paths.home, MAILMAN_CONFIG: join(paths.home, "없는-설정.json"),
          MAILMAN_CLIENT_FILE: paths.clientFile, MAILMAN_TOKEN_FILE: paths.tokenFile },
        stdin: Buffer.from(""),
      });
      expect([args, result.exitCode]).toEqual([args, status]);
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain("SyntaxError");
    }
    expect(existsSync(paths.dbPath)).toBe(false);
    expect(existsSync(paths.logFile)).toBe(false);
  });
});

describe("전송 태그", () => {
  function writeConfig(paths: RuntimePaths, extra: Record<string, unknown>): void {
    writeFileSync(paths.configFile, JSON.stringify({ defaultSpace: "tn", spaces: { tn: { space: SPACE } }, ...extra }));
  }

  // access token 응답 뒤 전송 요청 본문을 기록한다. 실제 네트워크는 쓰지 않는다.
  async function send(paths: RuntimePaths, args: string[], env: Environment, text = "본문") {
    const bodies: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const { fetcher, calls } = mockFetch((_url, init, index) => {
      if (index === 0) return json({ access_token: "fixture-access-secret" });
      const body: unknown = JSON.parse(String(init.body));
      bodies.push(typeof body === "object" && body !== null && "text" in body ? String(body.text) : "");
      return json({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
    });
    const status = await main(["send", ...args], { paths, fetcher, env, stdin: () => text,
      stdout: line => output.push(line), stderr: line => errors.push(line) });
    return { status, body: bodies[0], output: output.join("\n"), errors: errors.join("\n"), calls };
  }

  test("라벨은 --agent > MAILMAN_AGENT > 중립 AI 순서로 정하고 대소문자를 무시한다", async () => {
    const paths = fixture();
    expect((await send(paths, [], {})).body).toBe("[🤖 AI] 본문");
    expect((await send(paths, [], { MAILMAN_AGENT: "" })).body).toBe("[🤖 AI] 본문");
    expect((await send(paths, [], { MAILMAN_AGENT: "codex" })).body).toBe("[🤖 Codex] 본문");
    expect((await send(paths, [], { MAILMAN_AGENT: "CLAUDE" })).body).toBe("[🤖 Claude] 본문");
    expect((await send(paths, ["--agent", "claude"], { MAILMAN_AGENT: "codex" })).body).toBe("[🤖 Claude] 본문");
    expect((await send(paths, ["tn", "--agent", "CoDeX"], {})).body).toBe("[🤖 Codex] 본문");
    // 플래그가 있으면 잘못된 환경변수는 읽지 않는다.
    expect((await send(paths, ["--agent", "codex"], { MAILMAN_AGENT: "gpt" })).body).toBe("[🤖 Codex] 본문");
    expect(parseArguments("send", ["--agent", "Claude"]).agent).toBe("claude");
    expect(parseArguments("send", []).agent).toBeUndefined();
  });

  test("태그는 여러 줄 본문의 첫 줄 앞에만 한 번 붙는다", async () => {
    const result = await send(fixture(), ["--agent", "claude"], {}, "첫 줄\n둘째 줄\n\n넷째 줄");
    expect(result.body).toBe("[🤖 Claude] 첫 줄\n둘째 줄\n\n넷째 줄");
    expect(result.body?.split("[🤖").length).toBe(2);
  });

  test("잘못된 --agent·MAILMAN_AGENT 값은 허용값을 안내하고 refresh 전에 exit 1이다", async () => {
    for (const args of [["--agent", "gpt"], ["--agent"], ["--agent", "--no-tag"], ["--agent", "claude", "--agent", "codex"]]) {
      expect(() => parseArguments("send", args)).toThrow();
    }
    expect(() => parseArguments("send", ["--agent", "gpt"])).toThrow("claude 또는 codex");
    const paths = fixture();
    const flag = await send(paths, ["--agent", "gpt"], {});
    expect(flag.status).toBe(1);
    expect(flag.errors).toContain("claude 또는 codex");
    expect(flag.calls).toHaveLength(0);
    const env = await send(paths, [], { MAILMAN_AGENT: "gpt" });
    expect(env.status).toBe(1);
    expect(env.errors).toContain("MAILMAN_AGENT");
    expect(env.errors).toContain("claude 또는 codex");
    expect(env.calls).toHaveLength(0);
  });

  test("설정 sendTag: false면 태그 없이 보내고 성공 출력에 한 줄로 알린다", async () => {
    const paths = fixture();
    writeConfig(paths, { sendTag: false });
    for (const args of [[], ["--agent", "codex"]]) {
      const result = await send(paths, args, { MAILMAN_AGENT: "claude" });
      expect(result.status).toBe(0);
      expect(result.body).toBe("본문");
      expect(result.output).toContain("✅ 전송 완료\n태그 없이 전송했습니다 (설정 sendTag: false).\nmessage name:");
    }
  });

  test("--no-tag는 설정 sendTag: true보다 우선해 이번 전송만 태그를 뺀다", async () => {
    const paths = fixture();
    writeConfig(paths, { sendTag: true });
    const untagged = await send(paths, ["--no-tag"], { MAILMAN_AGENT: "codex" });
    expect(untagged.body).toBe("본문");
    expect(untagged.output).toContain("태그 없이 전송했습니다 (--no-tag).");
    expect((await send(paths, [], { MAILMAN_AGENT: "codex" })).body).toBe("[🤖 Codex] 본문");
    expect(parseArguments("send", ["--no-tag"]).tag).toBe(false);
    expect(parseArguments("send", []).tag).toBe(true);
  });

  test("--no-tag와 --agent를 같이 주면 순서와 무관하게 거절한다", async () => {
    for (const args of [["--no-tag", "--agent", "claude"], ["--agent", "codex", "--no-tag"]]) {
      expect(() => parseArguments("send", args)).toThrow("--agent와 --no-tag");
      const result = await send(fixture(), args, {});
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(0);
    }
    for (const args of [["--agent", "claude"], ["--no-tag"]]) expect(() => parseArguments("fetch", args)).toThrow();
  });

  test("sendTag는 생략 시 true, 불리언이 아니면 설정 오류다", async () => {
    const paths = fixture();
    expect(loadConfig(paths.configFile).sendTag).toBe(true);
    writeConfig(paths, { sendTag: false });
    expect(loadConfig(paths.configFile).sendTag).toBe(false);
    for (const value of ["false", 0, 1, null, {}]) {
      writeConfig(paths, { sendTag: value });
      expect(() => loadConfig(paths.configFile)).toThrow("sendTag는 true 또는 false");
      const result = await send(paths, [], {});
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(0);
    }
    expect(resolveSendPrefix({ tag: true }, { sendTag: true }, {})).toEqual({ prefix: "[🤖 AI] " });
    expect(resolveSendPrefix({ tag: false }, { sendTag: true }, {})).toEqual({ prefix: "", untaggedReason: "--no-tag" });
  });
});
