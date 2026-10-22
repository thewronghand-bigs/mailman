import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { authenticate, getAccessToken } from "./auth";
import { ChatClient } from "./chat";
import { collectMessages, logCollection, logCollectionFailure } from "./collector";
import { errorMessage, MailmanError } from "./errors";
import { renderInbox } from "./fetch";
import type { Fetch } from "./http";
import { collectionOptions, getRuntimePaths, loadConfig, resolveSpace, validateThread, type RuntimePaths } from "./runtime";
import { buildMessageBody, sendMessage } from "./send";
import { openDatabase } from "./store";

export type Command = "run" | "fetch" | "send";
export type Arguments = { help: boolean; auth: boolean; spaceKey?: string; limit: number; all: boolean; thread?: string };

export const HELP = {
  run: "사용: run.sh [스페이스]\n      run.sh auth\n사용자 OAuth 인증 또는 Google Chat API 증분 수집. MAILMAN_DEEP=1이면 최근 30일 백필.",
  fetch: "사용: fetch.sh [스페이스] [개수=5] [--all]\n수집 후 최신 스레드 1~50개 조회. --all이면 조회 필터 해제. 수집 실패 시 기존 DB 출력.",
  send: "사용: send.sh [스페이스] [--thread spaces/.../threads/...] < 본문.txt\n사용자 명의로 [🤖 Claude] 태그를 붙여 텍스트 전송. 실패 시 재시도하지 않음.",
} as const;

export function parseArguments(command: Command, args: string[]): Arguments {
  const result: Arguments = { help: false, auth: false, limit: 5, all: false };
  if (args.includes("--help") || args.includes("-h")) return { ...result, help: true };
  if (command === "run" && args[0] === "auth") {
    if (args.length !== 1) throw new MailmanError("사용: run.sh auth (추가 인자 없음)");
    return { ...result, auth: true };
  }
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--all" && command === "fetch" && !result.all) result.all = true;
    else if (arg === "--thread" && command === "send" && result.thread === undefined) {
      const thread = args[++index];
      if (!thread || thread.startsWith("-")) throw new MailmanError("--thread 뒤에 spaces/.../threads/... 이름을 지정하세요.");
      result.thread = thread;
    } else if (arg.startsWith("-")) throw new MailmanError(HELP[command]);
    else positional.push(arg);
  }
  if (command === "fetch") {
    if (positional.length > 0 && !/^\d+$/.test(positional[0]!)) result.spaceKey = positional.shift();
    if (positional.length > 1 || (positional.length === 1 && !/^\d+$/.test(positional[0]!))) throw new MailmanError(HELP.fetch);
    if (positional.length === 1) result.limit = Number(positional[0]);
    if (!Number.isSafeInteger(result.limit) || result.limit < 1 || result.limit > 50) throw new MailmanError("조회 개수는 1~50 사이의 정수여야 합니다.");
  } else {
    if (positional.length > 1) throw new MailmanError(HELP[command]);
    result.spaceKey = positional[0];
  }
  return result;
}

type Dependencies = {
  paths?: RuntimePaths;
  fetcher?: Fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  stdin?: () => string;
};

export async function main(args: string[], dependencies: Dependencies = {}): Promise<number> {
  const out = dependencies.stdout ?? console.log;
  const err = dependencies.stderr ?? console.error;
  try {
    const command = args[0];
    if (command !== "run" && command !== "fetch" && command !== "send") throw new MailmanError("cli.ts는 run/fetch/send 래퍼를 통해 실행하세요.");
    const options = parseArguments(command, args.slice(1));
    if (options.help) { out(HELP[command]); return 0; }
    const paths = dependencies.paths ?? getRuntimePaths(import.meta.url);
    const fetcher = dependencies.fetcher ?? fetch;
    if (options.auth) {
      err("브라우저에서 Google 계정 로그인과 권한 동의를 진행하세요 (최대 5분).");
      const token = await authenticate(paths);
      out(`✅ 인증 완료\n이메일: ${token.email}\n허용 스코프:\n${token.scopes.map(scope => `- ${scope}`).join("\n")}`);
      return 0;
    }
    const { spaceKey, space } = resolveSpace(loadConfig(paths.scriptDir), options.spaceKey);
    if (command === "send") {
      if (options.thread) validateThread(space.space, options.thread);
      if (!dependencies.stdin && process.stdin.isTTY) throw new MailmanError("본문은 stdin으로 전달하세요. send.sh --help를 확인하세요.");
      const text = dependencies.stdin ? dependencies.stdin() : readFileSync(0, "utf8");
      buildMessageBody(text, options.thread);
      const client = new ChatClient(await getAccessToken(paths, fetcher), fetcher);
      const created = await sendMessage(client, space.space, text, options.thread);
      out(`✅ 전송 완료\nmessage name: ${created.name}\nthread name: ${created.thread.name}`);
      return 0;
    }
    const collect = async () => {
      try {
        const settings = collectionOptions();
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
    if (command === "run") { await collect(); return 0; }
    try { await collect(); }
    catch (error: unknown) { err(`[mailman] 수집 실패: ${errorMessage(error)} 기존 DB 내용을 표시합니다.`); }
    if (!existsSync(paths.dbPath)) {
      out(`[${spaceKey}] 수집된 데이터가 없습니다. 먼저 run.sh auth 및 run.sh를 실행하세요.`);
      return 0;
    }
    const db = new Database(paths.dbPath, { readonly: true });
    try { out(renderInbox(db, { spaceKey, space: space.space, limit: options.limit, all: options.all })); }
    finally { db.close(); }
    return 0;
  } catch (error: unknown) {
    err(`[mailman] ${errorMessage(error)}`);
    return error instanceof MailmanError ? error.exitCode : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
