import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { authorizationUrl, createPkce, exchangeCode, getAccessToken, loadClient, loadToken, parseOAuthCallback, saveToken, SCOPES } from "../auth";
import { errorMessage, MailmanError } from "../errors";
import { CLIENT, cleanupFixtures, fixture, json, mockFetch } from "./helpers";

afterEach(cleanupFixtures);

describe("OAuth URL과 콜백", () => {
  test("PKCE S256/state/offline/consent와 기존 5개+리액션 스코프만 요청한다", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
    expect(createPkce().state).not.toBe(pkce.state);
    const url = authorizationUrl(CLIENT, "http://127.0.0.1:54321", pkce);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([...SCOPES]);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:54321");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("state")).toBe(pkce.state);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.toString()).not.toContain(pkce.verifier);
    expect(url.toString()).not.toContain(CLIENT.client_secret);
  });

  test("state/코드 누락·중복·거부 콜백을 거절한다", () => {
    expect(parseOAuthCallback(new URL("http://127.0.0.1/?state=expected&code=ok"), "expected")).toBe("ok");
    for (const query of ["code=ok", "state=wrong&code=ok", "state=expected", "state=expected&error=denied", "state=expected&code=a&code=b", "state=expected&state=wrong&code=a"]) {
      expect(() => parseOAuthCallback(new URL(`http://127.0.0.1/?${query}`), "expected")).toThrow();
    }
  });
});

describe("토큰 교환과 저장", () => {
  test("auth 응답 id_token의 sub를 users/ID로 저장하고 id_token은 남기지 않는다", async () => {
    const paths = fixture();
    const idToken = `fixture-header.${Buffer.from(JSON.stringify({ sub: "fixture-self" })).toString("base64url")}.fixture-signature`;
    const api = mockFetch((_url, _init, index) => index === 0
      ? json({ access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", scope: SCOPES.join(" "), id_token: idToken })
      : json({ email: "tester@example.test", email_verified: true, sub: "fixture-self" }));
    const token = await exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", api.fetcher);
    saveToken(paths.tokenFile, token);
    expect(loadToken(paths.tokenFile).user_name).toBe("users/fixture-self");
    const stored = readFileSync(paths.tokenFile, "utf8");
    expect(stored).not.toContain("id_token");
    expect(stored).not.toContain("access_token");
    const refresh = mockFetch(() => json({ access_token: "fixture-next-access", refresh_token: "fixture-rotated-refresh" }));
    await getAccessToken(paths, refresh.fetcher);
    expect(loadToken(paths.tokenFile).user_name).toBe("users/fixture-self");
    expect(loadToken(paths.tokenFile).refresh_token).toBe("fixture-rotated-refresh");
  });

  test("id_token과 userinfo의 sub가 다르거나 잘못되면 계정 ID를 저장하지 않는다", async () => {
    for (const id_token of ["broken", `header.${Buffer.from(JSON.stringify({ sub: "fixture-other" })).toString("base64url")}.signature`]) {
      const api = mockFetch((_url, _init, index) => index === 0
        ? json({ access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", scope: SCOPES.join(" "), id_token })
        : json({ email: "tester@example.test", email_verified: true, sub: "fixture-self" }));
      await expect(exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", api.fetcher)).rejects.toThrow("계정 ID");
    }
  });

  test("PKCE 코드 교환 후 검증된 이메일과 실제 허용 스코프를 받는다", async () => {
    const { fetcher, calls } = mockFetch((url, init, index) => {
      if (index === 0) {
        expect(url.toString()).toBe(CLIENT.token_uri);
        const params = new URLSearchParams(String(init.body));
        expect(params.get("grant_type")).toBe("authorization_code");
        expect(params.get("code_verifier")).toBe("fixture-verifier");
        expect(params.get("redirect_uri")).toBe("http://127.0.0.1:54321");
        expect(params.get("client_secret")).toBe(CLIENT.client_secret);
        return json({ access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", scope: SCOPES.join(" ") });
      }
      expect(url.toString()).toBe("https://openidconnect.googleapis.com/v1/userinfo");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access-secret");
      return json({ email: "tester@example.test", email_verified: true, sub: "fixture-self" });
    });
    const saved = await exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", fetcher);
    expect(saved).toEqual({ refresh_token: "fixture-refresh-secret", email: "tester@example.test", scopes: [...SCOPES], user_name: "users/fixture-self" });
    expect(calls).toHaveLength(2);
  });

  test("필수 스코프/refresh token 누락과 추가 스코프를 실패 처리한다", async () => {
    for (const body of [
      { access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", scope: SCOPES.slice(0, 4).join(" ") },
      { access_token: "fixture-access-secret", scope: SCOPES.join(" ") },
      { access_token: "fixture-access-secret", refresh_token: "fixture-refresh-secret", scope: [...SCOPES, "https://example.test/extra"].join(" ") },
    ]) {
      const { fetcher, calls } = mockFetch(() => json(body));
      await expect(exchangeCode(CLIENT, "fixture-code", "http://127.0.0.1:54321", "fixture-verifier", fetcher)).rejects.toThrow();
      expect(calls).toHaveLength(1);
    }
  });

  test("저장 파일은 기존 권한과 관계없이 0600이고 access token은 없다", () => {
    const paths = fixture();
    chmodSync(paths.tokenFile, 0o644);
    saveToken(paths.tokenFile, { refresh_token: "fixture-refresh-secret", email: "tester@example.test", scopes: [...SCOPES] });
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.tokenFile, "utf8")).not.toContain("access_token");
    expect(loadToken(paths.tokenFile).email).toBe("tester@example.test");
    expect(loadClient(paths.clientFile)).toEqual(CLIENT);
  });

  test("실행할 때마다 refresh하고 access token을 디스크에 저장하지 않는다", async () => {
    const paths = fixture();
    const before = readFileSync(paths.tokenFile, "utf8");
    const { fetcher, calls } = mockFetch((_url, init, index) => {
      const params = new URLSearchParams(String(init.body));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("fixture-refresh-secret");
      return json({ access_token: `fixture-access-${index}` });
    });
    expect(await getAccessToken(paths, fetcher)).toBe("fixture-access-0");
    expect(await getAccessToken(paths, fetcher)).toBe("fixture-access-1");
    expect(calls).toHaveLength(2);
    expect(readFileSync(paths.tokenFile, "utf8")).toBe(before);
  });

  test("토큰 없음은 exit 2, invalid_grant는 exit 3과 재인증 안내", async () => {
    const absent = fixture(false);
    const { fetcher, calls } = mockFetch(() => json({ error: "invalid_grant", error_description: "fixture-refresh-secret" }, 400));
    try { await getAccessToken(absent, fetcher); throw new Error("성공하면 안 됨"); }
    catch (error: unknown) { expect(error).toBeInstanceOf(MailmanError); expect((error as MailmanError).exitCode).toBe(2); }
    expect(calls).toHaveLength(0);
    try { await getAccessToken(fixture(), fetcher); throw new Error("성공하면 안 됨"); }
    catch (error: unknown) {
      expect(error).toBeInstanceOf(MailmanError);
      expect((error as MailmanError).exitCode).toBe(3);
      expect(errorMessage(error)).toContain("다시 mailman auth");
      expect(errorMessage(error)).not.toContain("fixture-refresh-secret");
    }
    expect(calls).toHaveLength(1);
  });

  test("깨진 JSON 오류에서 인증정보 원문을 출력하지 않는다", () => {
    const paths = fixture();
    writeFileSync(paths.tokenFile, '{"fixture-secret-in-broken-json":');
    try { loadToken(paths.tokenFile); throw new Error("성공하면 안 됨"); }
    catch (error: unknown) { expect(errorMessage(error)).not.toContain("fixture-secret-in-broken-json"); }
  });
});
