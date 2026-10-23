// 단일 진입점: mailman <auth|collect|fetch|send>. 컴파일된 실행 파일과 개발 실행기(mailman-dev)가 함께 쓴다.
import { existsSync, readFileSync } from "node:fs";
import { authenticate, getAccessToken, installClient } from "./auth";
import { ChatClient } from "./chat";
import { collectMessages, logCollection, logCollectionFailure } from "./collector";
import { errorMessage, MailmanError } from "./errors";
import { printInbox, type SenderType } from "./fetch";
import type { Fetch } from "./http";
import packageJson from "./package.json" with { type: "json" };
import { collectionOptions, getRuntimePaths, loadConfig, resolveSpace, SETUP_GUIDE_URL, validateThread, type RuntimePaths } from "./runtime";
import { buildMessageBody, sendMessage } from "./send";
import { openDatabase } from "./store";
import { parseSince } from "./time";

// 빌드 시 `bun build --define`으로 주입한다. 개발 실행에서는 package.json 버전을 쓴다.
declare const MAILMAN_BUILD_VERSION: string | undefined;
export const VERSION = typeof MAILMAN_BUILD_VERSION === "string" ? MAILMAN_BUILD_VERSION : packageJson.version;

export type Command = "auth" | "collect" | "fetch" | "send";
export type Arguments = {
  help: boolean;
  spaceKey?: string;
  since?: string;
  thread?: string;
  only?: SenderType;
  client?: string;
  deep: boolean;
  collect: boolean;
};

const COMMANDS: readonly Command[] = ["auth", "collect", "fetch", "send"];

export const USAGE = `mailman — Google Chat 스페이스 메시지를 로컬에 모아 조회·전송하는 CLI

사용: mailman <명령> [옵션]

명령:
  auth [--client <client_secret.json>]    Google 로그인. --client로 OAuth 클라이언트 JSON을 등록
  collect [스페이스] [--deep]              Chat API 증분 수집 (--deep: 최근 30일 백필)
  fetch [스페이스] [옵션]                  수집 후 새 메시지 조회
  send [스페이스] [--thread <스레드>]      stdin 본문을 사용자 명의로 전송

mailman <명령> --help    명령별 도움말
mailman --version        버전

설정 파일: $MAILMAN_CONFIG (기본 ~/.claude/mailman/config.json)
설정 가이드: ${SETUP_GUIDE_URL}`;

export const HELP: Record<Command, string> = {
  auth: `사용: mailman auth [--client <client_secret.json>]
브라우저에서 Google 로그인·권한 동의 후 refresh token을 저장한다 (최대 5분).
--client: Google에서 받은 데스크톱 앱 OAuth 클라이언트 JSON을 검증해 클라이언트 파일 경로로 0600 복사한 뒤 로그인.
클라이언트 파일이 없으면 설정 가이드를 확인하세요: ${SETUP_GUIDE_URL}`,
  collect: `사용: mailman collect [스페이스] [--deep]
Google Chat API 증분 수집. --deep(또는 MAILMAN_DEEP=1)이면 수집 커서와 무관하게 최근 30일 백필.`,
  fetch: `사용: mailman fetch [스페이스] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep]
수집 후 mailman이 마지막으로 보여준 이후의 새 메시지를 최대 200건 조회 (첫 조회는 24시간). 수집 실패 시 기존 DB 출력.
--since 24h / 3d / 2026-10-01: 지정 시점 이후 조회, seen 커서 유지.
--only bot|human: 해당 발신자 유형의 새 메시지만 조회, seen 커서 유지.
--no-collect: 수집 없이 DB만 조회. --deep: 조회 전 최근 30일 백필 수집.`,
  send: `사용: mailman send [스페이스] [--thread spaces/.../threads/...] < 본문.txt
사용자 명의로 [🤖 Claude] 태그를 붙여 텍스트 전송. 실패 시 재시도하지 않음.`,
};

function isCommand(value: string | undefined): value is Command {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function parseOnly(value: string): SenderType {
  const upper = value.toUpperCase();
  if (upper === "BOT" || upper === "HUMAN") return upper;
  throw new MailmanError("--only 뒤에 bot 또는 human을 지정하세요.");
}

export function parseArguments(command: Command, args: string[], now = new Date()): Arguments {
  const result: Arguments = { help: false, deep: false, collect: true };
  if (args.includes("--help") || args.includes("-h")) return { ...result, help: true };
  const value = (index: number, message: string): string => {
    const next = args[index];
    if (!next || next.startsWith("-")) throw new MailmanError(message);
    return next;
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--since" && command === "fetch" && result.since === undefined) {
      result.since = parseSince(value(++index, "--since 뒤에 24h, 3d 또는 YYYY-MM-DD를 지정하세요."), now);
    } else if (arg === "--only" && command === "fetch" && result.only === undefined) {
      result.only = parseOnly(value(++index, "--only 뒤에 bot 또는 human을 지정하세요."));
    } else if (arg === "--no-collect" && command === "fetch" && result.collect) {
      result.collect = false;
    } else if (arg === "--deep" && (command === "fetch" || command === "collect") && !result.deep) {
      result.deep = true;
    } else if (arg === "--thread" && command === "send" && result.thread === undefined) {
      result.thread = value(++index, "--thread 뒤에 spaces/.../threads/... 이름을 지정하세요.");
    } else if (arg === "--client" && command === "auth" && result.client === undefined) {
      result.client = value(++index, "--client 뒤에 Google에서 받은 client_secret JSON 경로를 지정하세요.");
    } else if (arg.startsWith("-")) throw new MailmanError(HELP[command]);
    else positional.push(arg);
  }
  if (positional.length > (command === "auth" ? 0 : 1)) throw new MailmanError(HELP[command]);
  if (result.deep && !result.collect) throw new MailmanError("--deep과 --no-collect는 함께 쓸 수 없습니다.");
  result.spaceKey = positional[0];
  return result;
}

type Dependencies = {
  paths?: RuntimePaths;
  fetcher?: Fetch;
  stdout?: (text: string) => unknown;
  stderr?: (text: string) => void;
  stdin?: () => string;
  now?: Date;
  // 테스트에서 브라우저·Google 호출 없이 auth 흐름을 확인하기 위해 주입한다.
  authenticate?: (paths: RuntimePaths) => Promise<{ email: string; scopes: string[] }>;
};

async function writeStdout(text: string): Promise<void> {
  // Bun의 process.stdout.write 콜백은 EPIPE에서도 성공할 수 있으므로 Bun.write로 완료를 확인한다.
  const output = `${text}\n`;
  if (await Bun.write(Bun.stdout, output) !== Buffer.byteLength(output)) {
    throw new MailmanError("표준 출력을 완료하지 못했습니다.");
  }
}

export async function main(args: string[], dependencies: Dependencies = {}): Promise<number> {
  const out = dependencies.stdout ?? writeStdout;
  const err = dependencies.stderr ?? console.error;
  try {
    const command = args[0];
    if (command === "--help" || command === "-h" || command === "help") { await out(USAGE); return 0; }
    if (command === "--version" || command === "-v" || command === "version") { await out(`mailman ${VERSION}`); return 0; }
    if (command === undefined) { err(USAGE); return 1; }
    if (!isCommand(command)) throw new MailmanError(`알 수 없는 명령입니다: ${command}\n\n${USAGE}`);
    const now = dependencies.now ?? new Date();
    const options = parseArguments(command, args.slice(1), now);
    if (options.help) { await out(HELP[command]); return 0; }
    const paths = dependencies.paths ?? getRuntimePaths();
    const fetcher = dependencies.fetcher ?? fetch;
    if (command === "auth") {
      if (options.client !== undefined) {
        if (!existsSync(options.client)) throw new MailmanError(`--client 파일을 찾을 수 없습니다: ${options.client}`);
        installClient(options.client, paths.clientFile);
        err(`[mailman] OAuth 클라이언트를 저장했습니다: ${paths.clientFile}`);
      } else if (!existsSync(paths.clientFile)) {
        throw new MailmanError(`OAuth 클라이언트 파일이 없습니다: ${paths.clientFile}\n` +
          `설정 가이드(${SETUP_GUIDE_URL})를 따라 데스크톱 앱 OAuth 클라이언트를 만든 뒤 mailman auth --client <다운로드한 JSON>을 실행하세요.`, 2);
      }
      err("브라우저에서 Google 계정 로그인과 권한 동의를 진행하세요 (최대 5분).");
      const token = await (dependencies.authenticate ?? authenticate)(paths);
      await out(`✅ 인증 완료\n이메일: ${token.email}\n허용 스코프:\n${token.scopes.map(scope => `- ${scope}`).join("\n")}`);
      return 0;
    }
    const { spaceKey, space } = resolveSpace(loadConfig(paths.configFile), options.spaceKey);
    if (command === "send") {
      if (options.thread) validateThread(space.space, options.thread);
      if (!dependencies.stdin && process.stdin.isTTY) throw new MailmanError("본문은 stdin으로 전달하세요. mailman send --help를 확인하세요.");
      const text = dependencies.stdin ? dependencies.stdin() : readFileSync(0, "utf8");
      buildMessageBody(text, options.thread);
      const client = new ChatClient(await getAccessToken(paths, fetcher), fetcher);
      const created = await sendMessage(client, space.space, text, options.thread);
      await out(`✅ 전송 완료\nmessage name: ${created.name}\nthread name: ${created.thread.name}`);
      return 0;
    }
    const collect = async () => {
      try {
        const settings = collectionOptions(process.env, options.deep);
        const client = new ChatClient(await getAccessToken(paths, fetcher), fetcher);
        const db = openDatabase(paths.dbPath);
        try {
          const result = await collectMessages(db, client, space.space, settings);
          try { logCollection(paths.logFile, result); }
          catch { err("[mailman] 수집은 완료됐지만 요약 로그를 기록할 수 없습니다."); }
          err(`[mailman] space=${space.space} received=${result.received} saved=${result.saved}`);
        } finally { db.close(); }
      } catch (error: unknown) {
        try { logCollectionFailure(paths.logFile, space.space, error); }
        catch { err("[mailman] 수집 실패 로그를 기록할 수 없습니다."); }
        throw error;
      }
    };
    if (command === "collect") { await collect(); return 0; }
    if (options.collect) {
      try { await collect(); }
      catch (error: unknown) { err(`[mailman] 수집 실패: ${errorMessage(error)} 기존 DB 내용을 표시합니다.`); }
    }
    if (!existsSync(paths.dbPath)) {
      await out(`[${spaceKey}] 수집된 데이터가 없습니다. 먼저 mailman auth 및 mailman collect를 실행하세요.`);
      return 0;
    }
    const db = openDatabase(paths.dbPath);
    try { await printInbox(db, { spaceKey, space: space.space, since: options.since, only: options.only, now }, out); }
    finally { db.close(); }
    return 0;
  } catch (error: unknown) {
    err(`[mailman] ${errorMessage(error)}`);
    return error instanceof MailmanError ? error.exitCode : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
