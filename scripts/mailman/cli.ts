import { existsSync, readFileSync } from "node:fs";
import { authenticate, getAccessToken } from "./auth";
import { ChatClient } from "./chat";
import { collectMessages, logCollection, logCollectionFailure } from "./collector";
import { errorMessage, MailmanError } from "./errors";
import { printInbox } from "./fetch";
import type { Fetch } from "./http";
import { collectionOptions, getRuntimePaths, loadConfig, resolveSpace, validateThread, type RuntimePaths } from "./runtime";
import { buildMessageBody, sendMessage } from "./send";
import { openDatabase } from "./store";
import { parseSince } from "./time";

export type Command = "run" | "fetch" | "send";
export type Arguments = { help: boolean; auth: boolean; spaceKey?: string; since?: string; thread?: string };

export const HELP = {
  run: "사용: run.sh [스페이스]\n      run.sh auth\n사용자 OAuth 인증 또는 Google Chat API 증분 수집. MAILMAN_DEEP=1이면 최근 30일 백필.",
  fetch: "사용: fetch.sh [스페이스] [--since <기간|날짜>]\n수집 후 mailman이 마지막으로 보여준 이후의 새 메시지를 최대 200건 조회 (첫 조회는 24시간).\n--since 24h / 3d / 2026-10-01: 지정 시점 이후 조회, seen 커서 유지. 수집 실패 시 기존 DB 출력.",
  send: "사용: send.sh [스페이스] [--thread spaces/.../threads/...] < 본문.txt\n사용자 명의로 [🤖 Claude] 태그를 붙여 텍스트 전송. 실패 시 재시도하지 않음.",
} as const;

export function parseArguments(command: Command, args: string[], now = new Date()): Arguments {
  const result: Arguments = { help: false, auth: false };
  if (args.includes("--help") || args.includes("-h")) return { ...result, help: true };
  if (command === "run" && args[0] === "auth") {
    if (args.length !== 1) throw new MailmanError("사용: run.sh auth (추가 인자 없음)");
    return { ...result, auth: true };
  }
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--since" && command === "fetch" && result.since === undefined) {
      const since = args[++index];
      if (!since || since.startsWith("-")) throw new MailmanError("--since 뒤에 24h, 3d 또는 YYYY-MM-DD를 지정하세요.");
      result.since = parseSince(since, now);
    } else if (arg === "--thread" && command === "send" && result.thread === undefined) {
      const thread = args[++index];
      if (!thread || thread.startsWith("-")) throw new MailmanError("--thread 뒤에 spaces/.../threads/... 이름을 지정하세요.");
      result.thread = thread;
    } else if (arg.startsWith("-")) throw new MailmanError(HELP[command]);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new MailmanError(HELP[command]);
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
    if (command !== "run" && command !== "fetch" && command !== "send") throw new MailmanError("cli.ts는 run/fetch/send 래퍼를 통해 실행하세요.");
    const now = dependencies.now ?? new Date();
    const options = parseArguments(command, args.slice(1), now);
    if (options.help) { await out(HELP[command]); return 0; }
    const paths = dependencies.paths ?? getRuntimePaths(import.meta.url);
    const fetcher = dependencies.fetcher ?? fetch;
    if (options.auth) {
      err("브라우저에서 Google 계정 로그인과 권한 동의를 진행하세요 (최대 5분).");
      const token = await authenticate(paths);
      await out(`✅ 인증 완료\n이메일: ${token.email}\n허용 스코프:\n${token.scopes.map(scope => `- ${scope}`).join("\n")}`);
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
      await out(`✅ 전송 완료\nmessage name: ${created.name}\nthread name: ${created.thread.name}`);
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
      await out(`[${spaceKey}] 수집된 데이터가 없습니다. 먼저 run.sh auth 및 run.sh를 실행하세요.`);
      return 0;
    }
    const db = openDatabase(paths.dbPath);
    try { await printInbox(db, { spaceKey, space: space.space, since: options.since, now }, out); }
    finally { db.close(); }
    return 0;
  } catch (error: unknown) {
    err(`[mailman] ${errorMessage(error)}`);
    return error instanceof MailmanError ? error.exitCode : 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
