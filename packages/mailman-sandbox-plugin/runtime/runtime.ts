import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export type MailmanSpace = {
  url: string;
  webhookUrl?: string;
  bots?: Record<string, string>;
  defaultBot?: string;
};

export type MailmanConfig = {
  spaces?: Record<string, MailmanSpace>;
  defaultSpace?: string;
};

export function getScriptDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

export function loadConfig(scriptDir: string): MailmanConfig {
  return JSON.parse(readFileSync(join(scriptDir, "config.json"), "utf8")) as MailmanConfig;
}

export function getMailmanHome(): string {
  return process.env.MAILMAN_HOME || join(homedir(), ".mailman");
}

export function getRuntimePaths(importMetaUrl: string) {
  const scriptDir = getScriptDir(importMetaUrl);
  const home = getMailmanHome();
  return {
    scriptDir,
    home,
    dbPath: join(home, "inbox", "mailman.db"),
    logFile: join(home, "logs", "mailman.log")
  };
}

export function ensureDataDirs(paths: { dbPath: string; logFile: string }) {
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(dirname(paths.logFile), { recursive: true });
}

export function resolveSpace(config: MailmanConfig, requestedKey?: string) {
  const spaces = config.spaces ?? {};
  const defaultKey = config.defaultSpace ?? Object.keys(spaces)[0] ?? "";
  const spaceKey = requestedKey && spaces[requestedKey] ? requestedKey : defaultKey;
  const space = spaces[spaceKey];

  if (!space) {
    throw new Error(`[mailman] 스페이스를 찾을 수 없습니다: "${requestedKey || "(기본)"}". config.json의 spaces를 확인하세요.`);
  }

  return { spaceKey, space };
}

export function resolveBotDisplayName(space: MailmanSpace): string {
  const bots = space.bots ?? {};
  const defaultBotAlias = space.defaultBot ?? Object.keys(bots)[0] ?? "";
  return bots[defaultBotAlias] || "";
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
