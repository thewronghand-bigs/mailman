import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELP, main, parseArguments, USAGE, VERSION } from "../cli";
import packageJson from "../package.json" with { type: "json" };
import { SETUP_GUIDE_URL, type RuntimePaths } from "../runtime";
import { getMeta, openDatabase, setMeta, toRow, upsertRows } from "../store";
import { CLIENT, cleanupFixtures, fixture, message, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);
const NOW = new Date("2026-10-22T12:00:00Z");

function capture() {
  const output: string[] = [];
  const errors: string[] = [];
  return { output, errors, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
}

describe("단일 진입점 라우팅", () => {
  test("--help/--version은 설정 없이 동작하고 버전은 package.json을 따른다", async () => {
    const io = capture();
    expect(VERSION).toBe(packageJson.version);
    expect(await main(["--version"], io)).toBe(0);
    expect(io.output.at(-1)).toBe(`mailman ${packageJson.version}`);
    expect(await main(["--help"], io)).toBe(0);
    expect(io.output.at(-1)).toBe(USAGE);
    for (const command of ["auth", "spaces", "collect", "fetch", "send", "wait", "download", "react"]) expect(USAGE).toContain(`  ${command} `);
    expect(USAGE).toContain(SETUP_GUIDE_URL);
    for (const command of ["auth", "spaces", "collect", "fetch", "send", "wait", "download", "react"] as const) {
      expect(await main([command, "--help"], io)).toBe(0);
      expect(io.output.at(-1)).toBe(HELP[command]);
    }
  });

  test("명령 없음·알 수 없는 명령·옛 run 명령은 exit 1이다", async () => {
    const io = capture();
    expect(await main([], io)).toBe(1);
    expect(io.errors.at(-1)).toBe(USAGE);
    expect(await main(["bogus"], io)).toBe(1);
    expect(io.errors.at(-1)).toContain("알 수 없는 명령입니다: bogus");
    expect(await main(["run"], io)).toBe(1);
    expect(io.output).toHaveLength(0);
  });

  test("명령별 옵션을 해석하고 다른 명령의 옵션은 거부한다", () => {
    expect(parseArguments("auth", []).client).toBeUndefined();
    expect(parseArguments("auth", ["--client", "/tmp/client.json"]).client).toBe("/tmp/client.json");
    expect(parseArguments("collect", ["tn", "--deep"])).toMatchObject({ spaceKey: "tn", deep: true, collect: true });
    expect(parseArguments("fetch", ["--only", "bot", "tn"])).toMatchObject({ spaceKey: "tn", only: "BOT" });
    expect(parseArguments("fetch", ["--only", "HUMAN"]).only).toBe("HUMAN");
    expect(parseArguments("fetch", ["--no-collect"]).collect).toBe(false);
    expect(parseArguments("fetch", ["--deep", "--only", "human", "--since", "3d"], NOW)).toMatchObject({ deep: true, only: "HUMAN", since: "2026-10-19T12:00:00.000000000Z" });
    expect(parseArguments("send", ["tn", "--thread", `${SPACE}/threads/a`]).thread).toBe(`${SPACE}/threads/a`);
    for (const [command, args] of [
      ["auth", ["tn"]], ["auth", ["--client"]], ["auth", ["--deep"]], ["collect", ["--only", "bot"]], ["collect", ["--no-collect"]],
      ["fetch", ["--only", "robot"]], ["fetch", ["--only", "bot", "--only", "human"]], ["fetch", ["--deep", "--no-collect"]],
      ["fetch", ["--client", "x.json"]], ["send", ["--only", "bot"]], ["send", ["--deep"]],
    ] as const) {
      expect(() => parseArguments(command, [...args], NOW)).toThrow();
    }
  });

  test("collect --deep은 저장된 수집 커서와 무관하게 백필 창으로 요청한다", async () => {
    const paths = fixture();
    const db = openDatabase(paths.dbPath);
    try { setMeta(db, `lastCreateTime:${SPACE}`, "2026-10-22T11:00:00.000000000Z"); } finally { db.close(); }
    const { fetcher, calls } = mockFetch((_url, _init, index) => index === 0
      ? Response.json({ access_token: "fixture-access-secret" }) : Response.json({ messages: [] }));
    expect(await main(["collect", "--deep"], { paths, fetcher, stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(calls[1]!.url.searchParams.get("filter")).not.toContain("2026-10-22T11:00:00");
  });
});

describe("fetch --only", () => {
  function seed(paths: RuntimePaths) {
    const db = openDatabase(paths.dbPath);
    try {
      setMeta(db, `seenCreateTime:${SPACE}`, "2026-10-22T09:00:00.000000000Z");
      upsertRows(db, [
        toRow(message("human-1", "2026-10-22T10:00:00Z", { sender: { type: "HUMAN", displayName: "사람" }, text: "사람 본문" }), SPACE, NOW.toISOString()),
        toRow(message("bot-1", "2026-10-22T11:00:00Z", { sender: { type: "BOT", displayName: "알림봇" }, text: "봇 본문" }), SPACE, NOW.toISOString()),
      ]);
    } finally { db.close(); }
  }
  const readSeen = (paths: RuntimePaths) => {
    const db = openDatabase(paths.dbPath);
    try { return [getMeta(db, `seenCreateTime:${SPACE}`), getMeta(db, `seenMessageName:${SPACE}`)]; } finally { db.close(); }
  };

  test("--only 조회는 해당 유형만 새 메시지로 보이고 seen 커서를 움직이지 않는다", async () => {
    const paths = fixture(false);
    seed(paths);
    const before = readSeen(paths);
    const { fetcher, calls } = mockFetch(() => { throw new Error("호출하면 안 됨"); });
    const io = capture();
    const dependencies = { paths, fetcher, now: NOW, stdout: io.stdout, stderr: io.stderr };

    expect(await main(["fetch", "--no-collect", "--only", "bot"], dependencies)).toBe(0);
    const botOutput = io.output.at(-1)!;
    expect(botOutput).toContain("새 메시지 1건 (BOT만)");
    expect(botOutput).toContain("— 알림봇 (BOT) [새 메시지]");
    // 같은 스레드의 앞선 사람 메시지는 유형과 무관하게 이전 맥락으로만 붙는다.
    expect(botOutput).toContain("— 사람 (HUMAN) [이전 맥락]");
    expect(botOutput).not.toContain("(HUMAN) [새 메시지]");
    expect(botOutput).toContain("필터: BOT만 표시 (seen 커서 유지)");
    expect(readSeen(paths)).toEqual(before);

    expect(await main(["fetch", "--no-collect", "--only", "human", "--since", "7d"], dependencies)).toBe(0);
    expect(io.output.at(-1)).toContain("— 사람 (HUMAN) [새 메시지]");
    expect(io.output.at(-1)).not.toContain("(BOT) [새 메시지]");
    expect(readSeen(paths)).toEqual(before);

    // 걸러졌던 메시지가 기본 조회에서 사라지지 않고, 기본 조회만 seen을 전진시킨다.
    expect(await main(["fetch", "--no-collect"], dependencies)).toBe(0);
    expect(io.output.at(-1)).toContain("새 메시지 2건,");
    expect(io.output.at(-1)).toContain("(HUMAN) [새 메시지]");
    expect(io.output.at(-1)).toContain("(BOT) [새 메시지]");
    expect(readSeen(paths)).toEqual(["2026-10-22T11:00:00.000000000Z", `${SPACE}/messages/bot-1`]);

    expect(await main(["fetch", "--no-collect", "--only", "bot"], dependencies)).toBe(0);
    expect(io.output.at(-1)).toStartWith(`[대상] tn (SPACE_TYPE_UNSPECIFIED, ${SPACE})\n[tn] 새 메시지가 없습니다. (BOT만 조회)`);
    expect(calls).toHaveLength(0);
    expect(existsSync(paths.logFile)).toBe(false);
  });

  test("--only 조회는 수집 실패 후에도 기존 DB를 보여주고 seen을 유지한다", async () => {
    const paths = fixture(false);
    seed(paths);
    const before = readSeen(paths);
    const io = capture();
    expect(await main(["fetch", "--only", "human"], { paths, now: NOW, stdout: io.stdout, stderr: io.stderr })).toBe(0);
    expect(io.errors.join("\n")).toContain("기존 DB 내용을 표시");
    expect(io.output.at(-1)).toContain("사람 본문");
    expect(readSeen(paths)).toEqual(before);
  });
});

describe("auth --client", () => {
  const stubAuth = () => {
    const calls: RuntimePaths[] = [];
    const authenticate = async (paths: RuntimePaths) => {
      calls.push(paths);
      return { email: "tester@example.test", scopes: ["openid"] };
    };
    return { calls, authenticate };
  };

  test("데스크톱 클라이언트를 검증해 0600으로 복사한 뒤 로그인하고 비밀값을 출력하지 않는다", async () => {
    const paths = fixture(false);
    const source = join(paths.home, "client_secret_download.json");
    const content = JSON.stringify({ installed: { ...CLIENT, project_id: "fixture-project" } });
    writeFileSync(source, content);
    chmodSync(source, 0o644);
    const io = capture();
    const stub = stubAuth();
    expect(await main(["auth", "--client", source], { paths, ...io, authenticate: stub.authenticate })).toBe(0);
    expect(readFileSync(paths.clientFile, "utf8")).toBe(content);
    expect(statSync(paths.clientFile).mode & 0o777).toBe(0o600);
    expect(statSync(source).mode & 0o777).toBe(0o644);
    expect(stub.calls).toEqual([paths]);
    expect(io.output.join("\n")).toContain("✅ 인증 완료");
    for (const text of [...io.output, ...io.errors]) {
      expect(text).not.toContain(CLIENT.client_secret);
      expect(text).not.toContain(CLIENT.client_id);
    }

    // 기존 클라이언트 파일을 새 클라이언트로 교체한다.
    const replacement = join(paths.home, "client_secret_new.json");
    const newContent = JSON.stringify({ installed: { ...CLIENT, client_id: "fixture-client-id-2" } });
    writeFileSync(replacement, newContent);
    expect(await main(["auth", "--client", replacement], { paths, ...io, authenticate: stub.authenticate })).toBe(0);
    expect(readFileSync(paths.clientFile, "utf8")).toBe(newContent);
    expect(statSync(paths.clientFile).mode & 0o777).toBe(0o600);

    // 이미 클라이언트 경로에 있는 파일을 다시 지정하면 권한만 맞춘다.
    chmodSync(paths.clientFile, 0o644);
    expect(await main(["auth", "--client", paths.clientFile], { paths, ...io, authenticate: stub.authenticate })).toBe(0);
    expect(readFileSync(paths.clientFile, "utf8")).toBe(newContent);
    expect(statSync(paths.clientFile).mode & 0o777).toBe(0o600);
  });

  test("웹 클라이언트·깨진 파일·없는 파일은 복사·로그인 전에 거부한다", async () => {
    const paths = fixture(false);
    const stub = stubAuth();
    const io = capture();
    const web = join(paths.home, "web.json");
    writeFileSync(web, JSON.stringify({ web: CLIENT }));
    const broken = join(paths.home, "broken.json");
    writeFileSync(broken, "{not json");
    const badUri = join(paths.home, "bad-uri.json");
    writeFileSync(badUri, JSON.stringify({ installed: { ...CLIENT, token_uri: "https://attacker.example/token" } }));
    for (const file of [web, broken, badUri, join(paths.home, "missing.json")]) {
      expect(await main(["auth", "--client", file], { paths, ...io, authenticate: stub.authenticate })).toBe(1);
      expect(existsSync(paths.clientFile)).toBe(false);
    }
    expect(io.errors.join("\n")).toContain("데스크톱 앱");
    expect(io.errors.join("\n")).toContain("--client 파일을 찾을 수 없습니다");
    expect(io.errors.join("\n")).not.toContain(CLIENT.client_secret);
    expect(stub.calls).toHaveLength(0);
  });

  test("--client 없이 클라이언트 파일도 없으면 설정 가이드를 안내하고 exit 2, 있으면 그대로 로그인한다", async () => {
    const paths = fixture(false);
    const stub = stubAuth();
    const io = capture();
    expect(await main(["auth"], { paths, ...io, authenticate: stub.authenticate })).toBe(2);
    expect(io.errors.join("\n")).toContain(SETUP_GUIDE_URL);
    expect(io.errors.join("\n")).toContain("mailman auth --client");
    expect(stub.calls).toHaveLength(0);
    writeFileSync(paths.clientFile, JSON.stringify({ installed: CLIENT }));
    expect(await main(["auth"], { paths, ...io, authenticate: stub.authenticate })).toBe(0);
    expect(stub.calls).toHaveLength(1);
  });
});
