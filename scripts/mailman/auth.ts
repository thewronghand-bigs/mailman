// 사용자 OAuth: 임의 포트 loopback + PKCE. access token은 메모리에서만 사용한다.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRecord, MailmanError, RequestError, registerSecret } from "./errors";
import { requestJson, type Fetch } from "./http";
import type { RuntimePaths } from "./runtime";
import { writePrivateFile } from "./private-file";

export const REQUIRED_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.messages.create",
] as const;
export const REACTION_SCOPE = "https://www.googleapis.com/auth/chat.messages.reactions.create";
export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/directory.readonly";
export const SPACE_CREATE_SCOPE = "https://www.googleapis.com/auth/chat.spaces.create";
// 선택 권한이 없는 기존 토큰도 조회·전송에 쓸 수 있다.
export const SCOPES = [...REQUIRED_SCOPES, REACTION_SCOPE, DIRECTORY_SCOPE, SPACE_CREATE_SCOPE] as const;

export type OAuthClient = { client_id: string; client_secret: string; auth_uri: string; token_uri: string };
export type SavedToken = { refresh_token: string; email: string; scopes: string[]; user_name?: string };
export type Pkce = { verifier: string; challenge: string; state: string };

export function createPkce(): Pkce {
  const verifier = randomBytes(64).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  };
}

export function authorizationUrl(client: OAuthClient, redirectUri: string, pkce: Pkce): URL {
  const url = new URL(client.auth_uri);
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return url;
}

export function parseOAuthCallback(url: URL, expectedState: string): string {
  const state = Buffer.from(url.searchParams.get("state") ?? "");
  const expected = Buffer.from(expectedState);
  if (state.length !== expected.length || !timingSafeEqual(state, expected)) {
    throw new MailmanError("OAuth state가 일치하지 않습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  if (url.searchParams.has("error")) {
    throw new MailmanError("Google 인증이 거부되었습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.getAll("code").length !== 1 || url.searchParams.getAll("state").length !== 1) {
    throw new MailmanError("OAuth 인증 코드가 없습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  return code;
}

function checkScopes(scopes: string[]): string[] {
  // Google이 email 별칭을 반환하는 경우에도 같은 권한으로 취급한다.
  const granted = [...new Set(scopes.map(scope => scope === "email" ? SCOPES[1] : scope))];
  const missing = REQUIRED_SCOPES.filter(scope => !granted.includes(scope));
  if (missing.length > 0) {
    throw new MailmanError(`필수 스코프가 빠졌습니다: ${missing.join(", ")}. 다시 mailman auth를 실행하세요.`, 3);
  }
  if (granted.some(scope => !(SCOPES as readonly string[]).includes(scope))) {
    throw new MailmanError("허용 목록 밖의 OAuth 스코프가 있습니다. 이 클라이언트의 기존 동의를 취소한 뒤 다시 mailman auth를 실행하세요.", 3);
  }
  return granted;
}

export function requireReactionScope(tokenFile: string): void {
  if (!loadToken(tokenFile).scopes.includes(REACTION_SCOPE)) {
    throw new MailmanError(`리액션 권한이 없습니다 (${REACTION_SCOPE}). mailman auth를 다시 실행하세요.`, 2);
  }
}

export function requireSpaceCreateScope(tokenFile: string): void {
  if (!loadToken(tokenFile).scopes.includes(SPACE_CREATE_SCOPE)) {
    throw new MailmanError(`DM 생성 권한이 없습니다 (${SPACE_CREATE_SCOPE}). mailman auth를 다시 실행하세요.`, 2);
  }
}

function scopesFromResponse(body: Record<string, unknown>): string[] {
  if (typeof body.scope !== "string") throw new MailmanError("OAuth 응답의 허용 스코프를 확인할 수 없습니다.", 3);
  return checkScopes(body.scope.split(/\s+/).filter(Boolean));
}

export function loadClient(path: string): OAuthClient {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new MailmanError("OAuth 클라이언트 파일을 읽을 수 없습니다. MAILMAN_CLIENT_FILE과 데스크톱 앱 JSON 파일을 확인하세요.");
  }
  if (!isRecord(value) || !isRecord(value.installed)) {
    throw new MailmanError('OAuth 클라이언트는 Google의 {"installed": {...}} 형식이어야 합니다. 클라이언트를 "데스크톱 앱" 유형으로 만들어 JSON을 다시 받으세요.');
  }
  const client = value.installed;
  if (typeof client.client_id !== "string" || !client.client_id || typeof client.client_secret !== "string" || !client.client_secret ||
      typeof client.auth_uri !== "string" || !["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"].includes(client.auth_uri) ||
      client.token_uri !== "https://oauth2.googleapis.com/token") {
    throw new MailmanError("Google 데스크톱 앱 OAuth 클라이언트의 필수 필드와 인증 주소를 확인하세요.");
  }
  registerSecret(client.client_secret);
  registerSecret(client.client_id);
  return { client_id: client.client_id, client_secret: client.client_secret, auth_uri: client.auth_uri, token_uri: client.token_uri };
}

export function loadToken(path: string): SavedToken {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      throw new MailmanError("토큰 파일이 없습니다. 먼저 mailman auth를 실행하세요.", 2);
    }
    throw new MailmanError("토큰 파일을 읽을 수 없습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  if (!isRecord(value) || typeof value.refresh_token !== "string" || !value.refresh_token ||
      typeof value.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(value.email) ||
      !Array.isArray(value.scopes) || !value.scopes.every((scope: unknown) => typeof scope === "string") ||
      (value.user_name !== undefined && (typeof value.user_name !== "string" || !/^users\/[A-Za-z0-9_-]+$/.test(value.user_name)))) {
    throw new MailmanError("토큰 파일 형식이 올바르지 않습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  registerSecret(value.refresh_token);
  return { refresh_token: value.refresh_token, email: value.email, scopes: checkScopes(value.scopes),
    ...(typeof value.user_name === "string" ? { user_name: value.user_name } : {}) };
}

// 검증한 클라이언트 JSON을 0600으로 복사한다. 원본 내용을 그대로 옮기며 출력하지 않는다.
export function installClient(source: string, destination: string): void {
  loadClient(source);
  if (resolve(source) === resolve(destination)) {
    chmodSync(destination, 0o600);
    return;
  }
  writePrivateFile(destination, readFileSync(source), ".mailman-client-",
    "OAuth 클라이언트 파일을 저장할 수 없습니다. MAILMAN_CLIENT_FILE의 디렉터리 권한을 확인하세요.");
}

export function saveToken(path: string, token: SavedToken): void {
  registerSecret(token.refresh_token);
  // 객체를 명시해서 access_token/id_token이 파일에 섞여 들어갈 수 없게 한다.
  writePrivateFile(path, JSON.stringify({ refresh_token: token.refresh_token, email: token.email, scopes: token.scopes, user_name: token.user_name }, null, 2) + "\n",
    ".mailman-token-", "토큰 파일을 저장할 수 없습니다. MAILMAN_TOKEN_FILE의 디렉터리 권한을 확인하세요.");
}

async function tokenRequest(client: OAuthClient, params: Record<string, string>, fetcher: Fetch): Promise<Record<string, unknown>> {
  const { response, body } = await requestJson(fetcher, client.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: client.client_id, client_secret: client.client_secret }),
  });
  if (isRecord(body) && typeof body.access_token === "string") registerSecret(body.access_token);
  if (isRecord(body) && typeof body.refresh_token === "string") registerSecret(body.refresh_token);
  if (isRecord(body) && typeof body.id_token === "string") registerSecret(body.id_token);
  if (isRecord(body) && body.error === "invalid_grant") {
    throw new RequestError("OAuth 인증이 만료되었거나 취소되었습니다. 다시 mailman auth를 실행하세요.", response.status, "invalid_grant");
  }
  if (!response.ok || !isRecord(body) || typeof body.access_token !== "string" || !body.access_token) {
    // error_description에는 요청의 비밀값이 섞일 수 있어서 그대로 출력하지 않는다.
    const apiStatus = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    throw new RequestError(`OAuth 토큰 발급 실패 (HTTP ${response.status}). OAuth 설정을 확인하거나 다시 mailman auth를 실행하세요.`, response.status, apiStatus);
  }
  return body;
}

export async function exchangeCode(client: OAuthClient, code: string, redirectUri: string, verifier: string, fetcher: Fetch = fetch) {
  const body = await tokenRequest(client, {
    grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier,
  }, fetcher);
  if (typeof body.refresh_token !== "string" || !body.refresh_token) {
    throw new MailmanError("refresh token을 받지 못했습니다. 다시 mailman auth를 실행해 동의하세요.", 3);
  }
  const scopes = scopesFromResponse(body);
  const accessToken = body.access_token as string;
  const { response, body: user } = await requestJson(fetcher, "https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET", headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok || !isRecord(user) || typeof user.email !== "string" || !/^[^@\s]+@[^@\s]+$/.test(user.email) || user.email_verified !== true) {
    throw new MailmanError(`Google 계정 이메일을 확인할 수 없습니다 (HTTP ${response.status}).`, 3);
  }
  // TLS로 직접 받은 토큰 응답에서 sub만 읽는다. id_token 자체는 저장하지 않는다.
  let subject: unknown = user.sub;
  if (body.id_token !== undefined) {
    try {
      if (typeof body.id_token !== "string" || body.id_token.split(".").length !== 3) throw new Error();
      const claims: unknown = JSON.parse(Buffer.from(body.id_token.split(".")[1]!, "base64url").toString("utf8"));
      if (!isRecord(claims)) throw new Error();
      subject = claims.sub;
      if (user.sub !== undefined && user.sub !== subject) throw new Error();
    } catch { throw new MailmanError("Google 계정 ID를 확인할 수 없습니다. 다시 mailman auth를 실행하세요.", 3); }
  }
  return { refresh_token: body.refresh_token, email: user.email, scopes, user_name: userNameFromSub(subject) } satisfies SavedToken;
}

function userNameFromSub(sub: unknown): string {
  if (typeof sub !== "string" || !/^[A-Za-z0-9_-]+$/.test(sub)) {
    throw new MailmanError("Google 계정 ID를 확인할 수 없습니다. 다시 mailman auth를 실행하세요.", 3);
  }
  return `users/${sub}`;
}

// 이전 토큰은 대기 모드가 계정 ID를 필요로 할 때 한 번만 보완한다.
export async function getSelfUser(paths: Pick<RuntimePaths, "tokenFile">, accessToken: string, fetcher: Fetch = fetch): Promise<string> {
  const saved = loadToken(paths.tokenFile);
  if (saved.user_name) return saved.user_name;
  registerSecret(accessToken);
  const { response, body } = await requestJson(fetcher, "https://openidconnect.googleapis.com/v1/userinfo", {
    method: "GET", headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok || !isRecord(body)) throw new MailmanError(`Google 계정 ID 조회 실패 (HTTP ${response.status}).`, 3);
  const user_name = userNameFromSub(body.sub);
  // 동시에 회전된 refresh token을 이전 값으로 되돌리지 않는다.
  saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name });
  return user_name;
}

// doctor도 같은 갱신·스코프 검증을 쓰되 로컬 토큰 파일은 변경하지 않는다.
export async function refreshAccessToken(client: OAuthClient, saved: SavedToken, fetcher: Fetch = fetch) {
  const body = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: saved.refresh_token }, fetcher);
  if (body.scope !== undefined) scopesFromResponse(body);
  return { accessToken: body.access_token as string,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined };
}

export async function getAccessToken(paths: Pick<RuntimePaths, "clientFile" | "tokenFile">, fetcher: Fetch = fetch): Promise<string> {
  // 파일이 없으면 클라이언트 확인이나 네트워크 호출보다 먼저 exit 2로 안내한다.
  const saved = loadToken(paths.tokenFile);
  const client = loadClient(paths.clientFile);
  const { accessToken, refreshToken } = await refreshAccessToken(client, saved, fetcher);
  if (refreshToken && refreshToken !== saved.refresh_token) {
    saveToken(paths.tokenFile, { ...saved, refresh_token: refreshToken });
  }
  return accessToken;
}

async function openBrowser(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", [url.toString()], { stdio: "ignore" });
    child.once("error", () => reject(new MailmanError("macOS open으로 브라우저를 열 수 없습니다.")));
    child.once("exit", code => code === 0 ? resolve() : reject(new MailmanError("브라우저 실행에 실패했습니다.")));
  });
}

async function receiveAuthorization(client: OAuthClient, pkce: Pkce): Promise<{ code: string; redirectUri: string }> {
  let resolveCode: (code: string) => void = () => {};
  let rejectCode: (error: MailmanError) => void = () => {};
  const callback = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // 브라우저 실행 중 콜백이 먼저 실패해도 처리되지 않은 rejection이 생기지 않게 한다.
  void callback.catch(() => {});
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== "/") {
        response.writeHead(404).end();
        return;
      }
      const code = parseOAuthCallback(url, pkce.state);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" })
        .end("인증 코드를 받았습니다. 터미널에서 인증 완료 여부를 확인하세요. 이 탭은 닫아도 됩니다.");
      resolveCode(code);
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("인증에 실패했습니다. 터미널에서 다시 시도하세요.");
      rejectCode(new MailmanError("OAuth 콜백 검증에 실패했습니다. 다시 mailman auth를 실행하세요.", 3));
    }
  });
  server.on("error", () => rejectCode(new MailmanError("OAuth loopback 서버 오류가 발생했습니다.", 3)));
  const timeout = setTimeout(() => rejectCode(new MailmanError("인증 대기 시간이 5분을 넘었습니다. 다시 mailman auth를 실행하세요.", 3)), 5 * 60_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new MailmanError("OAuth loopback 서버를 열 수 없습니다.")));
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new MailmanError("OAuth loopback 포트를 확인할 수 없습니다.");
    const redirectUri = `http://127.0.0.1:${address.port}`;
    await openBrowser(authorizationUrl(client, redirectUri, pkce));
    return { code: await callback, redirectUri };
  } finally {
    clearTimeout(timeout);
    server.close();
    server.closeAllConnections();
  }
}

export async function authenticate(paths: Pick<RuntimePaths, "clientFile" | "tokenFile">): Promise<SavedToken> {
  const client = loadClient(paths.clientFile);
  const pkce = createPkce();
  const { code, redirectUri } = await receiveAuthorization(client, pkce);
  const token = await exchangeCode(client, code, redirectUri, pkce.verifier);
  saveToken(paths.tokenFile, token);
  return token;
}
