import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord, MailmanError, registerSecret } from "./errors";

export type MailmanSpace = { space: string; webhookUrl?: string };
export type MailmanConfig = { defaultSpace: string; spaces: Record<string, MailmanSpace> };
export type Environment = Record<string, string | undefined>;
export type RuntimePaths = ReturnType<typeof getRuntimePaths>;

// 사용자별 OAuth 클라이언트 설정 가이드. 클라이언트 파일이 없을 때 안내한다.
export const SETUP_GUIDE_URL = "https://thewronghand-bigs.github.io/mailman/setup";

function expandPath(value: string): string {
  if (value === "~") return homedir();
  return resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

// 단일 실행 파일로도 동작해야 하므로 스크립트 위치(import.meta.url)에 의존하지 않는다.
export function getRuntimePaths(env: Environment = process.env) {
  const defaultHome = join(homedir(), ".claude");
  const home = expandPath(env.MAILMAN_HOME || defaultHome);
  return {
    home,
    configFile: expandPath(env.MAILMAN_CONFIG || join(home, "mailman", "config.json")),
    dbPath: join(home, "inbox", "mailman-v2.db"),
    logFile: join(home, "logs", "mailman.log"),
    // 인증정보는 MAILMAN_HOME과 별도로 지정한다. 데이터만 옮겨도 재로그인이 필요 없다.
    clientFile: expandPath(env.MAILMAN_CLIENT_FILE || join(defaultHome, "secrets", "mailman-oauth.json")),
    tokenFile: expandPath(env.MAILMAN_TOKEN_FILE || join(defaultHome, "secrets", "mailman-token.json")),
  };
}

export function validateSpace(space: string): void {
  if (!/^spaces\/[A-Za-z0-9_-]+$/.test(space)) {
    throw new MailmanError("스페이스는 spaces/SPACE_ID 형식이어야 합니다.");
  }
}

export function validateThread(space: string, thread: string): void {
  if (!thread.startsWith(`${space}/threads/`) || !/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/.test(thread)) {
    throw new MailmanError("--thread는 대상 스페이스의 spaces/.../threads/... 이름이어야 합니다.");
  }
}

export function loadConfig(configFile: string): MailmanConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch {
    throw new MailmanError(`설정 파일을 읽을 수 없습니다: ${configFile}. 설정 가이드(${SETUP_GUIDE_URL})의 config 예시를 참고해 작성하세요.`);
  }
  if (!isRecord(parsed) || typeof parsed.defaultSpace !== "string" || !isRecord(parsed.spaces)) {
    throw new MailmanError(`설정 파일에 defaultSpace와 spaces가 필요합니다. 설정 가이드(${SETUP_GUIDE_URL})의 config 예시를 확인하세요.`);
  }
  const spaces: Record<string, MailmanSpace> = Object.create(null);
  for (const [alias, value] of Object.entries(parsed.spaces)) {
    if (!alias || !isRecord(value) || typeof value.space !== "string" ||
        (value.webhookUrl !== undefined && typeof value.webhookUrl !== "string")) {
      throw new MailmanError("spaces 항목에 space 이름과 선택적인 webhookUrl 문자열을 지정하세요.");
    }
    validateSpace(value.space);
    if (typeof value.webhookUrl === "string") registerSecret(value.webhookUrl);
    spaces[alias] = { space: value.space, webhookUrl: value.webhookUrl as string | undefined };
  }
  if (!Object.hasOwn(spaces, parsed.defaultSpace)) {
    throw new MailmanError("defaultSpace가 spaces에 등록된 별칭과 일치하지 않습니다.");
  }
  return { defaultSpace: parsed.defaultSpace, spaces };
}

export function resolveSpace(config: MailmanConfig, requestedKey?: string) {
  const spaceKey = requestedKey ?? config.defaultSpace;
  if (!Object.hasOwn(config.spaces, spaceKey)) {
    throw new MailmanError("등록되지 않은 스페이스 별칭입니다. 설정 파일의 spaces를 확인하세요.");
  }
  return { spaceKey, space: config.spaces[spaceKey]! };
}

export function collectionOptions(env: Environment = process.env, deepFlag = false) {
  // --deep 플래그와 MAILMAN_DEEP=1은 같은 의미다.
  const deep = deepFlag || env.MAILMAN_DEEP === "1";
  const days = env.MAILMAN_BACKFILL_DAYS;
  const backfillDays = days === undefined ? (deep ? 30 : 7) : Number(days);
  if ((days !== undefined && !/^\d+$/.test(days)) || !Number.isSafeInteger(backfillDays) || backfillDays < 1 || backfillDays > 36500) {
    throw new MailmanError("MAILMAN_BACKFILL_DAYS는 1~36500 사이의 정수여야 합니다.");
  }
  return { deep, backfillDays };
}
