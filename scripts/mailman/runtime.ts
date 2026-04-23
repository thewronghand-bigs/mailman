import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type MailmanSpace = {
  url: string;
  webhookUrl?: string;
  bots?: Record<string, string>;
  defaultBot?: string;
  mentionFilter?: string;
};

export type MailmanConfig = {
  spaces?: Record<string, MailmanSpace>;
  defaultSpace?: string;
};

const LEGACY_MAC_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function getScriptDir(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}

export function loadConfig(scriptDir: string): MailmanConfig {
  return JSON.parse(readFileSync(join(scriptDir, "config.json"), "utf8")) as MailmanConfig;
}

export function getMailmanHome(): string {
  return process.env.MAILMAN_HOME || join(homedir(), ".claude");
}

export function getRuntimePaths(importMetaUrl: string) {
  const scriptDir = getScriptDir(importMetaUrl);
  const home = getMailmanHome();

  return {
    scriptDir,
    home,
    profileDir: join(home, "state", "mailman-chrome"),
    dbPath: join(home, "inbox", "mailman.db"),
    logFile: join(home, "logs", "mailman.log"),
  };
}

export function ensureRuntimeDirs(paths: { profileDir: string; dbPath: string; logFile: string }) {
  mkdirSync(paths.profileDir, { recursive: true });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(dirname(paths.logFile), { recursive: true });
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
    throw new Error(
      `[mailman] 스페이스를 찾을 수 없습니다: "${requestedKey || "(기본)"}". config.json의 spaces를 확인하세요.`,
    );
  }

  return { spaceKey, space };
}

export function resolveBotDisplayName(space: MailmanSpace): string {
  const bots = space.bots ?? {};
  const defaultBotAlias = space.defaultBot ?? Object.keys(bots)[0] ?? "";
  return bots[defaultBotAlias] || "";
}

export function resolveChromePath(): string | undefined {
  if (process.env.MAILMAN_CHROME_PATH) return process.env.MAILMAN_CHROME_PATH;
  if (existsSync(LEGACY_MAC_CHROME_PATH)) return LEGACY_MAC_CHROME_PATH;
  return undefined;
}
