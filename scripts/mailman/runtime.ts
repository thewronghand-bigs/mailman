import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isSendAgent, NEUTRAL_SEND_LABEL, SEND_AGENT_LABELS, sendPrefix, type SendAgent } from "./content";
import { isRecord, MailmanError, registerSecret } from "./errors";

export type MailmanSpace = { space: string; webhookUrl?: string };
// sendTag: false면 mailman send가 전송 태그를 붙이지 않는다. 생략 시 true.
export type MailmanConfig = { defaultSpace: string; spaces: Record<string, MailmanSpace>; sendTag: boolean };
export type Environment = Record<string, string | undefined>;
export type RuntimePaths = ReturnType<typeof getRuntimePaths>;

// 사용자별 OAuth 클라이언트 설정 가이드. 클라이언트 파일이 없을 때 안내한다.
export const SETUP_GUIDE_URL = "https://thewronghand.github.io/mailman/setup";

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
    attachmentsDir: join(home, "mailman", "attachments"),
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

export function parseMessageName(name: string): { space: string; spaceId: string; messageId: string } {
  const match = /^spaces\/([A-Za-z0-9_-]+)\/messages\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/.exec(name);
  if (!match) throw new MailmanError("메시지 name은 spaces/SPACE_ID/messages/MESSAGE_ID 형식이어야 합니다.");
  return { space: `spaces/${match[1]}`, spaceId: match[1]!, messageId: match[2]! };
}

export function loadConfig(configFile: string): MailmanConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return { defaultSpace: "", spaces: {}, sendTag: true };
    throw new MailmanError(`설정 파일을 읽을 수 없습니다: ${configFile}. 설정 가이드(${SETUP_GUIDE_URL}#step-10)의 방 등록 안내를 확인하세요.`);
  }
  if (!isRecord(parsed) || (parsed.defaultSpace !== undefined && typeof parsed.defaultSpace !== "string") || !isRecord(parsed.spaces)) {
    throw new MailmanError(`설정 파일에 spaces와 선택적인 defaultSpace 문자열이 필요합니다. 설정 가이드(${SETUP_GUIDE_URL}#step-10)의 방 등록 안내를 확인하세요.`);
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
  const defaultSpace = typeof parsed.defaultSpace === "string" ? parsed.defaultSpace : "";
  if (defaultSpace && !Object.hasOwn(spaces, defaultSpace)) {
    throw new MailmanError("defaultSpace가 spaces에 등록된 별칭과 일치하지 않습니다.");
  }
  const sendTag: unknown = parsed.sendTag === undefined ? true : parsed.sendTag;
  if (typeof sendTag !== "boolean") throw new MailmanError("설정 파일의 sendTag는 true 또는 false여야 합니다.");
  return { defaultSpace, spaces, sendTag };
}

export const MISSING_TARGET = "대상을 지정하거나 mailman spaces '검색어' --save <별칭>으로 기본 방을 등록하세요.";

export function resolveSpace(config: MailmanConfig, requestedKey?: string) {
  const spaceKey = requestedKey ?? config.defaultSpace;
  if (requestedKey === undefined && !spaceKey) throw new MailmanError(MISSING_TARGET);
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

export const SEND_AGENT_HINT = "claude 또는 codex";

// --agent와 MAILMAN_AGENT가 함께 쓰는 값 검증. 대소문자는 무시한다.
export function parseAgent(value: string, source: string): SendAgent {
  const lower = value.toLowerCase();
  if (isSendAgent(lower)) return lower;
  throw new MailmanError(`${source}는 ${SEND_AGENT_HINT}여야 합니다.`);
}

export type SendPrefix = { prefix: string; untaggedReason?: string };

// 태그 결정 순서: --no-tag > 설정 sendTag: false > 라벨(--agent > MAILMAN_AGENT > 중립 AI).
// MAILMAN_AGENT는 태그를 붙이고 --agent가 없을 때만 읽는다. 빈 문자열은 미지정으로 본다.
export function resolveSendPrefix(options: { agent?: SendAgent; tag: boolean }, config: Pick<MailmanConfig, "sendTag">,
  env: Environment = process.env): SendPrefix {
  if (!options.tag) return { prefix: "", untaggedReason: "--no-tag" };
  if (!config.sendTag) return { prefix: "", untaggedReason: "설정 sendTag: false" };
  const agent = options.agent ?? (env.MAILMAN_AGENT ? parseAgent(env.MAILMAN_AGENT, "MAILMAN_AGENT") : undefined);
  return { prefix: sendPrefix(agent ? SEND_AGENT_LABELS[agent] : NEUTRAL_SEND_LABEL) };
}
