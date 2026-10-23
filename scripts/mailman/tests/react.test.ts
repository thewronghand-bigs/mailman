import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { authorizationUrl, createPkce, exchangeCode, loadToken, REACTION_SCOPE, REQUIRED_SCOPES, saveToken, SCOPES } from "../auth";
import { ChatClient } from "../chat";
import { main, parseArguments } from "../cli";
import { parseEmoji } from "../react";
import { CLIENT, cleanupFixtures, fixture, json, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NAME = `${SPACE}/messages/reaction-message`;

describe("사용자 리액션", () => {
  test("👀/✅만 허용하고 메시지 name·이모지·다른 옵션 오류는 API 전에 거절한다", async () => {
    const paths = fixture(false);
    const api = mockFetch(() => { throw new Error("호출 금지"); });
    expect(parseEmoji("👀")).toBe("👀");
    expect(parseEmoji("✅")).toBe("✅");
    for (const args of [[NAME, "👍"], [NAME], [NAME, "👀", "extra"], ["spaces/x/messages/..", "👀"], [NAME, "👀", "--save", "x"]]) {
      expect(await main(["react", ...args], { paths, fetcher: api.fetcher, stdout: () => {}, stderr: () => {} })).toBe(1);
    }
    expect(api.calls).toHaveLength(0);
    expect(parseArguments("react", [NAME, "✅"]).emoji).toBe("✅");
  });

  test("정확한 POST 경로/body와 사용자 Bearer를 사용한다", async () => {
    const paths = fixture();
    writeFileSync(paths.configFile, "설정 파일 불필요");
    for (const emoji of ["👀", "✅"]) {
      const output: string[] = [];
      const api = mockFetch((url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
        expect(url.pathname).toBe(`/v1/${NAME}/reactions`);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access");
        expect(JSON.parse(String(init.body))).toEqual({ emoji: { unicode: emoji } });
        return json({ name: `${NAME}/reactions/fixture-reaction` });
      });
      expect(await main(["react", NAME, emoji], { paths, fetcher: api.fetcher, stdout: text => output.push(text), stderr: () => {} })).toBe(0);
      expect(output.join("\n")).toContain(`${emoji} 리액션 완료`);
      expect(api.calls).toHaveLength(2);
    }
  });

  test("409 또는 ALREADY_EXISTS는 이미 있음 성공이며 다른 오류와 POST 401은 재시도하지 않는다", async () => {
    const paths = fixture();
    for (const [status, apiStatus, expected] of [[409, "ALREADY_EXISTS", 0], [409, undefined, 0], [400, "ALREADY_EXISTS", 0], [403, "PERMISSION_DENIED", 3], [401, "UNAUTHENTICATED", 3]] as const) {
      const output: string[] = [];
      const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access" }) : json({ error: { status: apiStatus, message: "fixture error" } }, status));
      expect(await main(["react", NAME, "👀"], { paths, fetcher: api.fetcher, stdout: text => output.push(text), stderr: () => {} })).toBe(expected);
      if (expected === 0) expect(output.join("\n")).toContain("이미 있음");
      expect(api.calls).toHaveLength(2);
    }
  });

  test("리액션 스코프 없는 기존 토큰은 react만 exit 2, collect/fetch/send는 정상", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: [...REQUIRED_SCOPES] });
    const errors: string[] = [];
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access", scope: REQUIRED_SCOPES.join(" ") });
      if (init.method === "POST") return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD } });
      return json({});
    });
    const dependencies = { paths, fetcher: api.fetcher, env: {}, stdin: () => "test", stdout: () => {}, stderr: (text: string) => errors.push(text) };
    expect(await main(["react", NAME, "👀"], dependencies)).toBe(2);
    expect(errors.join("\n")).toContain("mailman auth를 다시 실행");
    expect(api.calls).toHaveLength(0);
    for (const command of ["collect", "fetch", "send"]) expect(await main([command], dependencies)).toBe(0);
    expect(api.calls).toHaveLength(6);
    expect(loadToken(paths.tokenFile).scopes).toEqual([...REQUIRED_SCOPES]);
  });

  test("auth 요청은 기존 네 권한+openid와 선택 리액션만, 필수 검사에는 기존 다섯만 쓴다", async () => {
    expect([...REQUIRED_SCOPES]).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/chat.spaces.readonly", "https://www.googleapis.com/auth/chat.messages.readonly", "https://www.googleapis.com/auth/chat.messages.create"]);
    const requested = authorizationUrl(CLIENT, "http://127.0.0.1:54321", createPkce()).searchParams.get("scope")?.split(" ");
    expect(requested).toEqual([...REQUIRED_SCOPES, "https://www.googleapis.com/auth/chat.messages.reactions.create"]);
    expect(REACTION_SCOPE).toBe(SCOPES.at(-1)!);
    const api = mockFetch((_url, _init, index) => index === 0
      ? json({ access_token: "fixture-access", refresh_token: "fixture-refresh", scope: REQUIRED_SCOPES.join(" ") })
      : json({ email: "tester@example.test", email_verified: true, sub: "fixture-self" }));
    const saved = await exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", api.fetcher);
    expect(saved.scopes).toEqual([...REQUIRED_SCOPES]);
    const missing = mockFetch(() => json({ access_token: "fixture-access", refresh_token: "fixture-refresh", scope: [...REQUIRED_SCOPES.slice(1), REACTION_SCOPE].join(" ") }));
    await expect(exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", missing.fetcher)).rejects.toThrow("필수 스코프");
  });

  test("주입한 refresh 함수가 있어도 리액션 POST 401은 재시도하지 않는다", async () => {
    let refreshes = 0;
    const api = mockFetch(() => json({}, 401));
    const client = new ChatClient("fixture-access", api.fetcher, undefined, async () => { refreshes++; return "fixture-next"; });
    await expect(client.createReaction(NAME, "👀")).rejects.toMatchObject({ status: 401 });
    expect(refreshes).toBe(0);
    expect(api.calls).toHaveLength(1);
  });
});
