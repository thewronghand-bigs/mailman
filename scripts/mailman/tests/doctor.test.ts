import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REQUIRED_SCOPES, SCOPES, saveToken } from "../auth";
import { main, parseArguments, VERSION } from "../cli";
import { SETUP_GUIDE_URL, type RuntimePaths } from "../runtime";
import { CLIENT, cleanupFixtures, fixture, json, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);

const ACCESS = "fixture-doctor-access-secret";
const REFRESH = "fixture-doctor-refresh-secret";
const SECRET = "fixture-doctor-client-secret";
const CLIENT_ID = "fixture-doctor-client.apps.googleusercontent.com";
const WEBHOOK = "https://chat.googleapis.com/v1/spaces/fixture/messages?key=fixture-doctor-key&token=fixture-doctor-hook";
const ID_TOKEN = "fixture-doctor-id-token";
const ROTATED = "fixture-doctor-rotated-token";
const PRIVATE_VALUES = [ACCESS, REFRESH, SECRET, CLIENT_ID, WEBHOOK, ID_TOKEN, ROTATED, "fixture-doctor-key", "fixture-doctor-hook"];

function doctorFixture() {
  const paths = fixture();
  writeFileSync(paths.clientFile, JSON.stringify({ installed: { ...CLIENT, client_id: CLIENT_ID, client_secret: SECRET } }));
  writeFileSync(paths.configFile, JSON.stringify({ defaultSpace: "tn", spaces: { tn: { space: SPACE, webhookUrl: WEBHOOK } } }));
  saveToken(paths.tokenFile, { refresh_token: REFRESH, email: "tester@example.test", scopes: [...SCOPES] });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  writeFileSync(paths.dbPath, "fixture-db-must-stay-unopened");
  for (const path of [paths.clientFile, paths.configFile, paths.dbPath]) chmodSync(path, 0o600);
  return paths;
}

function successApi() {
  return mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: ACCESS })
    : json({ spaces: [{ name: SPACE, displayName: "테스트 방", spaceType: "SPACE" }], nextPageToken: "fixture-next-page" }));
}

async function diagnose(paths: RuntimePaths, api = successApi(), args = ["doctor"]) {
  const output: string[] = [], errors: string[] = [];
  const exit = await main(args, { paths, env: {}, fetcher: api.fetcher, stdout: text => output.push(text), stderr: text => errors.push(text) });
  const text = output.join("\n"), stderr = errors.join("\n");
  for (const secret of PRIVATE_VALUES) expect(text + stderr).not.toContain(secret);
  for (const line of output) expect(line.split("\n")).toHaveLength(1);
  return { exit, text, stderr, calls: api.calls };
}

function guide(step: number) { return `해결: 설정 가이드 ${step}단계 — ${SETUP_GUIDE_URL}#step-${step}`; }

describe("doctor 파일·권한·옵션", () => {
  test("정상 설정은 모두 ✅, 스페이스는 pageSize=1 한 번만 조회하고 DB·로그를 열지 않는다", async () => {
    const paths = doctorFixture();
    const result = await diagnose(paths);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.text).toContain(`✅ mailman ${VERSION}`);
    expect(result.text).not.toMatch(/⚠️|❌|건너뜀/);
    expect(result.text).toContain("로그인 계정 tester@example.test, 접근 가능한 스페이스 있음");
    for (const path of [paths.configFile, paths.clientFile, paths.tokenFile, paths.dbPath]) expect(result.text).toContain(path);
    expect(result.calls.map(call => [call.url.toString(), call.init.method])).toEqual([
      [CLIENT.token_uri, "POST"], ["https://chat.googleapis.com/v1/spaces?pageSize=1", "GET"],
    ]);
    expect(new Headers(result.calls[1]!.init.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(readFileSync(paths.dbPath, "utf8")).toBe("fixture-db-must-stay-unopened");
    expect(existsSync(paths.logFile)).toBe(false);
    expect(existsSync(`${paths.dbPath}-wal`)).toBe(false);
  });

  test("0600이 아닌 권한은 모두 경고하고 내용·권한을 수정하지 않는다", async () => {
    const paths = doctorFixture();
    const files = [paths.configFile, paths.clientFile, paths.tokenFile, paths.dbPath];
    const before = files.map(path => readFileSync(path, "utf8"));
    for (const path of files) chmodSync(path, 0o640);
    const result = await diagnose(paths);
    expect(result.exit).toBe(0);
    expect(result.text.match(/권한 0640/g)).toHaveLength(4);
    for (const label of ["설정", "클라이언트", "토큰", "DB"]) expect(result.text).toMatch(new RegExp(`^⚠️ ${label} 경로:`, "m"));
    expect(result.text).not.toContain("❌");
    for (let index = 0; index < files.length; index++) {
      expect(statSync(files[index]!).mode & 0o7777).toBe(0o640);
      expect(readFileSync(files[index]!, "utf8")).toBe(before[index]!);
    }
  });

  test("설정·DB 없음은 경고만 내고 인증은 독립적으로 점검하며 파일을 만들지 않는다", async () => {
    const paths = doctorFixture();
    unlinkSync(paths.configFile);
    unlinkSync(paths.dbPath);
    const result = await diagnose(paths);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("⚠️ 설정 파일: 아직 기본 방이 없습니다 (설정 파일 없음)");
    expect(result.text).toContain("mailman spaces <검색어> --save <별칭>");
    expect(result.text).toContain(guide(10));
    expect(result.calls).toHaveLength(2);
    expect(existsSync(paths.configFile)).toBe(false);
    expect(existsSync(paths.dbPath)).toBe(false);
  });

  test("이전 설치의 자리표시 기본 방은 경고하고 --save·--default를 안내하며 파일을 바꾸지 않는다", async () => {
    for (const space of ["spaces/SPACE_ID", "spaces/AAAAxxxxxxx", "spaces/AAAAxxxxxxxxxxx", "spaces/YOUR_SPACE_ID"]) {
      const paths = doctorFixture();
      const raw = JSON.stringify({ defaultSpace: "team", sendTag: false, spaces: { team: { space }, real: { space: SPACE } } });
      writeFileSync(paths.configFile, raw);
      const result = await diagnose(paths);
      expect(result.exit).toBe(0);
      expect(result.text).toContain("⚠️ 설정 파일: 아직 기본 방이 없습니다 (예시 자리표시)");
      expect(result.text).toContain("mailman spaces <검색어> --save <별칭>");
      expect(result.text).toContain("--default도 붙여");
      expect(result.text).toContain(guide(10));
      expect(result.text).not.toContain("✅ 설정 파일");
      expect(result.text).not.toContain("❌");
      expect(result.calls).toHaveLength(2);
      expect(readFileSync(paths.configFile, "utf8")).toBe(raw);
      expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    }
    // 기본 방 외의 예시 항목이나 실제 ID의 AAAA 접두사만으로는 경고하지 않는다.
    const paths = doctorFixture();
    writeFileSync(paths.configFile, JSON.stringify({ defaultSpace: "real", spaces: {
      real: { space: "spaces/AAAAfixture" }, example: { space: "spaces/SPACE_ID" },
    } }));
    const result = await diagnose(paths);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("✅ 설정 파일");
    expect(result.text).not.toContain("아직 기본 방");
  });

  test("깨진 JSON·누락된 defaultSpace·잘못된 설정 형식은 exit 1이며 인증 점검은 계속한다", async () => {
    for (const config of ['{"fixture-doctor-private-broken-json":', '{"defaultSpace":"missing","spaces":{}}', '{"spaces":{}}', '{"defaultSpace":"tn","spaces":{"tn":{"space":"bad"}}}']) {
      const paths = doctorFixture();
      writeFileSync(paths.configFile, config);
      const result = await diagnose(paths);
      expect(result.exit).toBe(1);
      expect(result.text).toContain("❌ 설정 파일: JSON·형식 오류 또는 defaultSpace가 spaces에 없음");
      expect(result.text).not.toContain("fixture-doctor-private-broken-json");
      expect(result.text).toContain(guide(10));
      expect(result.calls).toHaveLength(2);
    }
  });

  test("help·미지원 옵션·위치 인자는 파일·네트워크 접근 전에 처리하며 --json은 제공하지 않는다", async () => {
    const paths = fixture(false);
    for (const args of [["doctor", "--json"], ["doctor", "team"], ["doctor", "--client", "client.json"], ["doctor", "--refresh"]]) {
      const result = await diagnose(paths, successApi(), args);
      expect(result.exit).toBe(1);
      expect(result.calls).toHaveLength(0);
    }
    expect(parseArguments("doctor", []).help).toBe(false);
    const help = await main(["doctor", "--help"], { paths, stdout: () => {}, stderr: () => {}, fetcher: async () => { throw new Error("네트워크 금지"); } });
    expect(help).toBe(0);
    expect(existsSync(paths.dbPath)).toBe(false);
  });
});

describe("doctor 인증과 건너뜀", () => {
  test("web 유형·깨진 클라이언트는 원인을 구분해 6단계로 안내하고 갱신/API는 건너뛴다", async () => {
    for (const content of [JSON.stringify({ web: { ...CLIENT, client_id: CLIENT_ID, client_secret: SECRET } }), '{"client_secret":"fixture-doctor-private-json":']) {
      const paths = doctorFixture();
      writeFileSync(paths.clientFile, content);
      const result = await diagnose(paths);
      expect(result.exit).toBe(1);
      const line = result.text.split("\n").find(line => line.startsWith("❌ 클라이언트 파일:"))!;
      expect(line).toContain(content.startsWith('{"web"') ? "web(웹 애플리케이션) 유형은 사용할 수 없습니다" : "JSON·형식 오류");
      if (!content.startsWith('{"web"')) expect(line).not.toContain("web(");
      expect(result.text).not.toContain("fixture-doctor-private-json");
      expect(line).toContain(guide(6));
      expect(result.text).toContain("✅ 토큰: 파일 유효");
      expect(result.text).toContain("토큰 갱신: 건너뜀");
      expect(result.text).toContain("Chat API: 건너뜀");
      expect(result.calls).toHaveLength(0);
    }
  });

  test("클라이언트 없음은 받은 JSON의 8단계 등록과 처음 만드는 6단계를 함께 안내한다", async () => {
    const paths = doctorFixture();
    unlinkSync(paths.clientFile);
    const result = await diagnose(paths);
    expect(result.exit).toBe(1);
    const line = result.text.split("\n").find(line => line.startsWith("❌ 클라이언트 파일 없음"))!;
    expect(line).toContain("받은 JSON이 있으면 8단계");
    expect(line).toContain("mailman auth --client <파일>");
    expect(line).toContain("처음 설정한다면 6단계");
    expect(line).toContain(`${SETUP_GUIDE_URL}#step-6`);
    expect(line).toContain(guide(8));
    expect(result.text).not.toContain("web(");
    expect(result.text).toContain("✅ 토큰: 파일 유효");
    expect(result.text.match(/건너뜀/g)).toHaveLength(2);
    expect(result.calls).toHaveLength(0);
  });

  test("토큰 없음은 exit 1·8단계이며 인증 창이나 네트워크를 열지 않는다", async () => {
    const paths = doctorFixture();
    unlinkSync(paths.tokenFile);
    const result = await diagnose(paths);
    expect(result.exit).toBe(1);
    expect(result.text).toContain("❌ 토큰: 토큰 파일이 없음");
    expect(result.text).toContain("mailman auth를 실행하고");
    expect(result.text).not.toContain("다시 실행");
    expect(result.text).toContain(guide(8));
    expect(result.text.match(/건너뜀/g)).toHaveLength(2);
    expect(result.calls).toHaveLength(0);
  });

  test("필수 스코프 각각 누락은 8단계, 기존 email 별칭은 유효하다", async () => {
    for (const missing of REQUIRED_SCOPES) {
      const paths = doctorFixture();
      saveToken(paths.tokenFile, { refresh_token: REFRESH, email: "tester@example.test", scopes: SCOPES.filter(scope => scope !== missing) });
      const result = await diagnose(paths);
      expect(result.exit).toBe(1);
      expect(result.text).toContain("필수 스코프가 부족함");
      expect(result.text).toContain(guide(8));
      expect(result.calls).toHaveLength(0);
    }
    const paths = doctorFixture();
    saveToken(paths.tokenFile, { refresh_token: REFRESH, email: "tester@example.test", scopes: SCOPES.map(scope => scope === REQUIRED_SCOPES[1] ? "email" : scope) });
    expect((await diagnose(paths)).exit).toBe(0);
  });

  test("선택 리액션 스코프만 없으면 경고·exit 0이고 나머지 점검을 계속한다", async () => {
    const paths = doctorFixture();
    saveToken(paths.tokenFile, { refresh_token: REFRESH, email: "tester@example.test", scopes: [...REQUIRED_SCOPES] });
    const result = await diagnose(paths);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("⚠️ 리액션 스코프 없음 — react만 불가");
    expect(result.text).toContain(guide(8));
    expect(result.calls).toHaveLength(2);
  });

  test("invalid_grant는 7일 만료를 단정하지 않고 게시·재인증을 안내하며 Chat API를 건너뛴다", async () => {
    const api = mockFetch(() => json({ error: "invalid_grant", error_description: PRIVATE_VALUES.join(" ") }, 400));
    const result = await diagnose(doctorFixture(), api);
    expect(result.exit).toBe(1);
    expect(result.text).toContain("❌ 토큰 갱신: 로그인이 만료됨");
    expect(result.text).toContain("7일 만료(테스트 모드)였다면");
    expect(result.text).toContain("mailman auth");
    expect(result.text).toContain(guide(5));
    expect(result.text).toContain("Chat API: 건너뜀");
    expect(result.calls).toHaveLength(1);
  });

  test("OAuth의 동의 거부·관리자 정책·일반 실패도 원문 없이 안내한다", async () => {
    for (const [error, phrase, step] of [["access_denied", "인증 접근이 거부됨", 5], ["admin_policy_enforced", "관리자 정책으로 차단됨", 8], ["unknown_error", "토큰 갱신 실패", 8]] as const) {
      const result = await diagnose(doctorFixture(), mockFetch(() => json({ error, error_description: PRIVATE_VALUES.join(" ") }, 403)));
      expect(result.exit).toBe(1);
      expect(result.text).toContain(phrase);
      expect(result.text).toContain(guide(step));
      expect(result.calls).toHaveLength(1);
    }
  });

  test("삭제·비활성화된 클라이언트는 HTTP 상태보다 OAuth 오류를 우선해 새 JSON과 6단계를 안내한다", async () => {
    for (const error of ["invalid_client", "deleted_client", "unauthorized_client"]) {
      for (const status of [400, 401, 403]) {
        const result = await diagnose(doctorFixture(), mockFetch(() => json({ error, error_description: PRIVATE_VALUES.join(" ") }, status)));
        expect(result.exit).toBe(1);
        expect(result.text).toContain("❌ 토큰 갱신: 이 OAuth 클라이언트가 삭제·비활성화됨");
        expect(result.text).toContain("클라이언트를 준 사람에게 새 JSON을 받거나 6단계에서 직접 만든 뒤 mailman auth --client");
        expect(result.text).toContain(guide(6));
        expect(result.text).not.toContain("인증이 거부됨 (HTTP 401)");
        expect(result.text).not.toContain("mailman auth를 다시 실행");
        expect(result.text).toContain("Chat API: 건너뜀");
        expect(result.calls).toHaveLength(1);
      }
    }
  });

  test("토큰 갱신이 스코프 부족을 반환해도 API를 호출하지 않는다", async () => {
    const result = await diagnose(doctorFixture(), mockFetch(() => json({ access_token: ACCESS, scope: "openid" })));
    expect(result.exit).toBe(1);
    expect(result.text).toContain(guide(8));
    expect(result.text).toContain("Chat API: 건너뜀");
    expect(result.calls).toHaveLength(1);
  });

  test("회전된 refresh token과 id_token은 출력하거나 파일에 저장하지 않는다", async () => {
    const paths = doctorFixture();
    const before = readFileSync(paths.tokenFile, "utf8");
    const api = mockFetch(url => url.hostname === "oauth2.googleapis.com"
      ? json({ access_token: ACCESS, refresh_token: ROTATED, id_token: ID_TOKEN }) : json({}));
    const result = await diagnose(paths, api);
    expect(result.exit).toBe(0);
    expect(result.text).toContain("접근 성공 (스페이스 없음");
    expect(result.text).not.toContain("접근 가능한 스페이스 있음");
    expect(readFileSync(paths.tokenFile, "utf8")).toBe(before);
  });
});

describe("doctor Chat API 오류 분류와 비밀값 보호", () => {
  const cases: Array<{ status: number; message: string; phrase: string; step: number; apiStatus?: string; reason?: string }> = [
    { status: 404, message: "not found", phrase: "Chat app not found", step: 7 },
    { status: 400, message: "Google Chat app not found", phrase: "Chat app not found", step: 7 },
    { status: 403, message: "Google Chat API has not been used in project fixture before or it is disabled", phrase: "SERVICE_DISABLED", step: 2 },
    { status: 403, message: "API disabled", apiStatus: "SERVICE_DISABLED", phrase: "SERVICE_DISABLED", step: 2 },
    { status: 403, message: "Permission denied", reason: "SERVICE_DISABLED", phrase: "SERVICE_DISABLED", step: 2 },
    { status: 403, message: "Blocked by administrator policy", phrase: "관리자 정책으로 차단됨", step: 8 },
    { status: 403, message: "Permission denied", reason: "ADMIN_POLICY_ENFORCED", phrase: "관리자 정책으로 차단됨", step: 8 },
    { status: 401, message: "Unauthenticated", phrase: "인증이 거부됨 (HTTP 401)", step: 8 },
    { status: 403, message: "Permission denied", phrase: "접근 권한 부족 (HTTP 403)", step: 7 },
    { status: 503, message: "unavailable", phrase: "Chat API 점검 실패", step: 9 },
  ];
  for (const entry of cases) {
    test(`HTTP ${entry.status} ${entry.message} ${entry.reason ?? entry.apiStatus ?? ""} → ${entry.step}단계`, async () => {
      const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: ACCESS }) : json({ error: {
        message: `${entry.message}\n${PRIVATE_VALUES.join(" ")} Bearer fixture-doctor-unregistered-secret`, status: entry.apiStatus,
        details: entry.reason ? [{ reason: entry.reason, metadata: { private: PRIVATE_VALUES } }] : undefined,
      } }, entry.status));
      const result = await diagnose(doctorFixture(), api);
      expect(result.exit).toBe(1);
      expect(result.text).toContain(entry.phrase);
      expect(result.text).toContain(guide(entry.step));
      expect(result.text).not.toContain("fixture-doctor-unregistered-secret");
      expect(result.calls).toHaveLength(2);
    });
  }

  test("갱신·Chat API의 연결 실패는 네트워크 안내와 exit 1, 재시도는 하지 않는다", async () => {
    for (const failAt of [0, 1]) {
      const api = mockFetch((_url, _init, index) => {
        if (index === failAt) throw new Error(PRIVATE_VALUES.join(" "));
        return json({ access_token: ACCESS });
      });
      const result = await diagnose(doctorFixture(), api);
      expect(result.exit).toBe(1);
      expect(result.text).toContain("네트워크 연결 실패");
      expect(result.text).toContain(guide(9));
      expect(result.calls).toHaveLength(failAt + 1);
      if (failAt === 0) expect(result.text).toContain("Chat API: 건너뜀");
    }
  });

  test("비JSON 401과 잘못된 성공 응답도 원문 없이 실패하고 재시도하지 않는다", async () => {
    for (const response of [new Response(PRIVATE_VALUES.join(" "), { status: 401 }), json({ spaces: "fixture-invalid-response" })]) {
      const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: ACCESS }) : response);
      const result = await diagnose(doctorFixture(), api);
      expect(result.exit).toBe(1);
      expect(result.text).toContain(response.status === 401 ? guide(8) : guide(9));
      expect(result.calls).toHaveLength(2);
    }
  });

  test("출력 실패는 exit 1이고 남은 네트워크 점검을 시작하지 않는다", async () => {
    const api = successApi();
    const paths = doctorFixture();
    const errors: string[] = [];
    expect(await main(["doctor"], { paths, fetcher: api.fetcher,
      stdout: async () => { throw new Error(SECRET); }, stderr: text => errors.push(text) })).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(errors.join("\n")).not.toContain(SECRET);
    expect(existsSync(join(paths.home, "logs"))).toBe(false);
  });
});
