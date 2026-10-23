import { spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPES, saveToken, type OAuthClient } from "../auth";
import type { ChatMessage } from "../chat";
import type { Fetch } from "../http";
import { getRuntimePaths } from "../runtime";

// 모든 테스트에서 실제 네트워크를 막는다. 각 테스트는 주입한 fetch만 쓴다.
spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("테스트의 실제 네트워크 호출은 금지됩니다."); });

export const SPACE = "spaces/test-space";
export const THREAD = `${SPACE}/threads/thread-1`;
export const CLIENT: OAuthClient = {
  client_id: "fixture-client-id",
  client_secret: "fixture-client-secret",
  auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

export function message(id: string, time = "2026-10-21T00:00:00Z", extra: Partial<ChatMessage> = {}): ChatMessage {
  return { name: `${SPACE}/messages/${id}`, createTime: time, text: id, sender: { type: "BOT" }, thread: { name: THREAD }, ...extra };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function mockFetch(handler: (url: URL, init: RequestInit, index: number) => Response | Promise<Response>) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetcher: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  };
  return { fetcher, calls };
}

const directories: string[] = [];
export function cleanupFixtures(): void {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function fixture(withCredentials = true) {
  // 레포 밖의 실제 설정이나 인증정보는 건드리지 않는다.
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".mailman-test-"));
  directories.push(dir);
  const paths = getRuntimePaths({
    MAILMAN_HOME: dir, MAILMAN_CLIENT_FILE: join(dir, "client.json"), MAILMAN_TOKEN_FILE: join(dir, "token.json"),
  });
  mkdirSync(dirname(paths.configFile), { recursive: true });
  writeFileSync(paths.configFile, JSON.stringify({ defaultSpace: "tn", spaces: { tn: { space: SPACE } } }));
  if (withCredentials) {
    writeFileSync(paths.clientFile, JSON.stringify({ installed: CLIENT }));
    saveToken(paths.tokenFile, { refresh_token: "fixture-refresh-secret", email: "tester@example.test", scopes: [...SCOPES] });
  }
  return paths;
}
