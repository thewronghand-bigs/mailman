// 컴파일된 실행 파일과 개발 실행기(mailman-dev)가 함께 쓰는 단일 진입점.
import { existsSync, readFileSync } from "node:fs";
import { authenticate, getAccessToken, getSelfUser, installClient } from "./auth";
import { ChatClient, SentMessageError, type CreatedMessage } from "./chat";
import { collectMessages, logCollection, logCollectionFailure, logWaitWarning } from "./collector";
import { errorMessage, MailmanError, throwIfAborted } from "./errors";
import { printInbox, type SenderType } from "./fetch";
import type { Fetch } from "./http";
import packageJson from "./package.json" with { type: "json" };
import type { SendAgent } from "./content";
import { collectionOptions, getRuntimePaths, loadConfig, parseAgent, resolveSendPrefix, SEND_AGENT_HINT, SETUP_GUIDE_URL, validateThread,
  type Environment, type RuntimePaths } from "./runtime";
import { buildMessageBody, sendMessage } from "./send";
import { openDatabase } from "./store";
import { parseSince } from "./time";
import { formatSpace, listSpaces, requireName, resolveWaitPerson, resolveTarget, saveAlias, searchSpaces, targetHeader } from "./resolve";
import { parseDuration, waitForReplies, type WaitClock } from "./wait";
import type { Database } from "bun:sqlite";

// 빌드 시 `bun build --define`으로 주입한다. 개발 실행에서는 package.json 버전을 쓴다.
declare const MAILMAN_BUILD_VERSION: string | undefined;
export const VERSION = typeof MAILMAN_BUILD_VERSION === "string" ? MAILMAN_BUILD_VERSION : packageJson.version;

export type Command = "auth" | "spaces" | "collect" | "fetch" | "send" | "wait";
export type Arguments = {
  help: boolean;
  spaceKey?: string;
  since?: string;
  thread?: string;
  only?: SenderType;
  client?: string;
  agent?: SendAgent;
  dm?: string;
  save?: string;
  from?: string;
  quietMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
  refresh?: boolean;
  wait?: boolean;
  dryRun?: boolean;
  deep: boolean;
  collect: boolean;
  tag: boolean;
};

const COMMANDS: readonly Command[] = ["auth", "spaces", "collect", "fetch", "send", "wait"];

const TARGET_HELP = `대상: config 별칭 → spaces/ID → --dm <users/ID|이메일|수집된 사람 이름> → 스페이스 표시 이름.
위치 인자와 --dm은 함께 쓸 수 없음. 이름 후보가 여러 개면 선택하지 않고 목록을 표시.
--save <별칭>: 해석된 대상을 설정에 0600으로 원자 저장 (기존 별칭 덮어쓰기 금지).
빈 문자열/공백 대상은 인자 오류. 표시 이름 캐시는 24시간 초과 시 갱신 (오프라인이면 경고 후 기존 캐시).`;
const WAIT_HELP = `--thread <spaces/.../threads/...>: 이 스레드만. --from <사람>: 이 발신자만 (둘 다 seen 유지).
--quiet 60s: 마지막 답장 이후 조용한 시간. --timeout 30m: 전체 대기 (최대 2h). --interval 15s: 폴링 간격.
기간은 양의 정수 s/m/h. 첫 답장부터 최대 10분 또는 전체 timeout까지 한 묶음으로 대기.
--from은 대기/전송 전에 users/ID로 확정. 이메일은 기존 DM의 수집 기록/최근 메시지가 필요하며 실패하면 전송하지 않음.
네트워크/5xx/429는 최대 60초 백오프로 재시도, 연속 실패 5분이면 받은 답장 출력 후 종료. 401은 토큰 갱신 후 1회 재시도.
답장이 없으면 exit 4. 단독 wait의 SIGINT/SIGTERM은 exit 130/143, seen 유지.
send --wait 전송 완료 후 대기 오류/중단은 exit 5: 전송은 완료됨 — 재전송하지 말 것. 전송 요청 중 중단은 전송 여부 불확실, Chat에서 확인.`;

export const USAGE = `mailman — Google Chat 스페이스 메시지를 로컬에 모아 조회·전송하는 CLI

사용: mailman <명령> [옵션]

명령:
  auth [--client <client_secret.json>]    Google 로그인. --client로 OAuth 클라이언트 JSON을 등록
  spaces [검색어] [--refresh]              내가 속한 스페이스 목록·검색 (DB 캐시)
  collect [스페이스] [--deep]              Chat API 증분 수집 (--deep: 최근 30일 백필)
  fetch [스페이스] [옵션]                  수집 후 새 메시지 조회
  send [스페이스] [옵션]                   stdin 본문을 사용자 명의로 태그를 붙여 전송
  wait [스페이스] [옵션]                   새 답장을 조용해진 뒤 한 묶음으로 출력

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
Google Chat API 증분 수집. --deep(또는 MAILMAN_DEEP=1)이면 수집 커서와 무관하게 최근 30일 백필.
${TARGET_HELP}`,
  spaces: `사용: mailman spaces [검색어] [--refresh]
내가 속한 스페이스의 표시 이름·종류·ID를 출력. 검색어는 대소문자·공백을 무시한 표시 이름 부분 일치.
캐시가 없거나 --refresh면 Google Chat API 목록을 최대 1,000페이지 받아 DB 캐시를 교체.`,
  fetch: `사용: mailman fetch [스페이스] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep]
수집 후 mailman이 마지막으로 보여준 이후의 새 메시지를 최대 200건 조회 (첫 조회는 24시간). 수집 실패 시 기존 DB 출력.
--since 24h / 3d / 2026-10-01: 지정 시점 이후 조회, seen 커서 유지.
--only bot|human: 해당 발신자 유형의 새 메시지만 조회, seen 커서 유지.
--no-collect: 메시지 수집 없이 DB만 조회 (이름/DM 해석은 API를 호출할 수 있음). --deep: 조회 전 최근 30일 백필 수집.
${TARGET_HELP}`,
  send: `사용: mailman send [스페이스] [--thread spaces/.../threads/...] [--agent claude|codex] [--no-tag] < 본문.txt
사용자 명의로 본문 앞에 [🤖 <라벨>] 태그를 붙여 텍스트 전송. 실패 시 재시도하지 않음.
--agent claude|codex: 라벨을 Claude/Codex로 표시 (대소문자 무시). 없으면 환경변수 MAILMAN_AGENT, 둘 다 없으면 [🤖 AI].
--no-tag: 이번 전송만 태그 없이 보냄. --agent와 함께 쓸 수 없음.
설정 파일 최상위 "sendTag": false면 항상 태그 없이 보냄 (기본 true).
--dry-run: 해석된 대상과 전송 본문 미리보기. --save도 저장할 예정 안내만 하며 설정을 바꾸지 않음.
--wait: 전송한 createTime부터 답장 대기. --dry-run과 함께 쓸 수 없음.
${TARGET_HELP}
${WAIT_HELP}`,
  wait: `사용: mailman wait [스페이스] [--dm <사람>] [대기 옵션]
실행 시각 이후의 내 메시지를 제외한 새 답장을 기다린다. 대기 전부터 있던 안 읽은 메시지도 먼저 출력.
${TARGET_HELP}
${WAIT_HELP}`,
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
  const result: Arguments = { help: false, deep: false, collect: true, tag: true };
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
    } else if (arg === "--thread" && (command === "send" || command === "wait") && result.thread === undefined) {
      result.thread = value(++index, "--thread 뒤에 spaces/.../threads/... 이름을 지정하세요.");
    } else if (arg === "--agent" && command === "send" && result.agent === undefined) {
      result.agent = parseAgent(value(++index, `--agent 뒤에 ${SEND_AGENT_HINT}를 지정하세요.`), "--agent");
    } else if (arg === "--no-tag" && command === "send" && result.tag) {
      result.tag = false;
    } else if (arg === "--client" && command === "auth" && result.client === undefined) {
      result.client = value(++index, "--client 뒤에 Google에서 받은 client_secret JSON 경로를 지정하세요.");
    } else if (arg === "--dm" && command !== "auth" && command !== "spaces" && result.dm === undefined) {
      result.dm = value(++index, "--dm 뒤에 사람 이름, 이메일 또는 users/ID를 지정하세요.");
    } else if (arg === "--save" && command !== "auth" && command !== "spaces" && result.save === undefined) {
      result.save = value(++index, "--save 뒤에 별칭을 지정하세요.");
    } else if (arg === "--refresh" && command === "spaces" && !result.refresh) {
      result.refresh = true;
    } else if (arg === "--wait" && command === "send" && !result.wait) {
      result.wait = true;
    } else if (arg === "--dry-run" && command === "send" && !result.dryRun) {
      result.dryRun = true;
    } else if ((command === "send" || command === "wait") && ["--from", "--quiet", "--timeout", "--interval"].includes(arg)) {
      const next = value(++index, `${arg} 뒤에 값을 지정하세요.`);
      if (arg === "--from" && result.from === undefined) result.from = next;
      else if (arg === "--quiet" && result.quietMs === undefined) result.quietMs = parseDuration(next, arg);
      else if (arg === "--timeout" && result.timeoutMs === undefined) result.timeoutMs = parseDuration(next, arg);
      else if (arg === "--interval" && result.intervalMs === undefined) result.intervalMs = parseDuration(next, arg);
      else throw new MailmanError(HELP[command]);
    } else if (arg.startsWith("-")) throw new MailmanError(HELP[command]);
    else positional.push(arg);
  }
  if (positional.length > (command === "auth" ? 0 : 1)) throw new MailmanError(HELP[command]);
  if (result.deep && !result.collect) throw new MailmanError("--deep과 --no-collect는 함께 쓸 수 없습니다.");
  // 태그를 끄면서 라벨을 지정하는 것은 의도가 충돌하므로 한쪽을 무시하지 않고 거절한다.
  if (result.agent !== undefined && !result.tag) throw new MailmanError("--agent와 --no-tag는 함께 쓸 수 없습니다.");
  result.spaceKey = positional[0];
  for (const [label, entry] of [["대상", result.spaceKey], ["--dm", result.dm], ["--from", result.from], ["--save", result.save]]) {
    if (entry !== undefined) requireName(entry, label!);
  }
  if (result.spaceKey !== undefined && result.dm !== undefined) throw new MailmanError("위치 인자와 --dm은 함께 쓸 수 없습니다.");
  if (result.dryRun && result.wait) throw new MailmanError("--dry-run과 --wait는 함께 쓸 수 없습니다.");
  if (command === "send" && !result.wait && [result.from, result.quietMs, result.timeoutMs, result.intervalMs].some(option => option !== undefined)) {
    throw new MailmanError("전송 대기 옵션은 --wait와 함께 쓰세요.");
  }
  return result;
}

type Dependencies = {
  paths?: RuntimePaths;
  fetcher?: Fetch;
  stdout?: (text: string) => unknown;
  stderr?: (text: string) => void;
  stdin?: () => string;
  env?: Environment;
  now?: Date;
  clock?: WaitClock;
  signal?: AbortSignal;
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
  let db: Database | undefined;
  let cleanupSignals = () => {};
  let activeSignal: AbortSignal | undefined;
  let sendState: "idle" | "sending" | "sent" = "idle";
  let sentSummary = "";
  try {
    const command = args[0];
    if (command === "--help" || command === "-h" || command === "help") { await out(USAGE); return 0; }
    if (command === "--version" || command === "-v" || command === "version") { await out(`mailman ${VERSION}`); return 0; }
    if (command === undefined) { err(USAGE); return 1; }
    if (!isCommand(command)) throw new MailmanError(`알 수 없는 명령입니다: ${command}\n\n${USAGE}`);
    const now = dependencies.now ?? new Date(dependencies.clock?.now() ?? Date.now());
    const options = parseArguments(command, args.slice(1), now);
    if (options.help) { await out(HELP[command]); return 0; }
    const env = dependencies.env ?? process.env;
    const paths = dependencies.paths ?? getRuntimePaths(env);
    const waiting = command === "wait" || options.wait;
    const controller = new AbortController();
    if (waiting) {
      const interrupt = () => controller.abort(new MailmanError("SIGINT로 대기를 종료했습니다.", 130));
      const terminate = () => controller.abort(new MailmanError("SIGTERM으로 대기를 종료했습니다.", 143));
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      cleanupSignals = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    }
    const signal = waiting ? (dependencies.signal ? AbortSignal.any([dependencies.signal, controller.signal]) : controller.signal) : undefined;
    activeSignal = signal;
    const injectedFetch = dependencies.fetcher ?? fetch;
    const fetcher: Fetch = signal ? (input, init = {}) => injectedFetch(input,
      { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal }) : injectedFetch;
    throwIfAborted(signal);
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
    let accessToken: Promise<string> | undefined;
    let client: Promise<ChatClient> | undefined;
    const getClient = () => client ??= (async () => {
      accessToken ??= getAccessToken(paths, fetcher);
      return new ChatClient(await accessToken, fetcher, signal, waiting ? async refreshSignal => {
        err("[mailman] HTTP 401: access token을 갱신하고 읽기 요청을 1회 재시도합니다.");
        accessToken = getAccessToken(paths, (input, init = {}) => fetcher(input, { ...init, signal: refreshSignal }));
        return accessToken;
      } : undefined);
    })();
    if (command === "spaces") {
      db = openDatabase(paths.dbPath);
      const spaces = searchSpaces(await listSpaces(db, getClient, options.refresh, now), options.spaceKey);
      await out(spaces.length ? spaces.map(space => `- ${formatSpace(space)}`).join("\n") : "일치하는 스페이스가 없습니다. mailman spaces --refresh로 확인하세요.");
      return 0;
    }
    const config = loadConfig(paths.configFile);
    const waitSettings = waiting ? collectionOptions(env) : undefined;
    const requested = options.spaceKey ?? config.defaultSpace;
    const needsResolution = options.dm !== undefined || (!Object.hasOwn(config.spaces, requested) && !requested.startsWith("spaces/"));
    if (needsResolution || existsSync(paths.dbPath) || waiting) db = openDatabase(paths.dbPath);
    const target = await resolveTarget(config, db, getClient, options, now, err);
    const spaceKey = target.spaceKey;
    const space = { space: target.name };
    const header = targetHeader(target);
    if (options.thread) validateThread(space.space, options.thread);
    let self: string | undefined;
    let from: string | undefined;
    if (waiting) {
      const api = await getClient();
      self = await getSelfUser(paths, await accessToken!, fetcher);
      if (options.from !== undefined) from = await resolveWaitPerson(db!, api, options.from, self, now, waitSettings!.backfillDays);
    }
    if (options.save !== undefined) saveAlias(paths.configFile, options.save, space.space, options.dryRun);
    const wait = async (startTime: string, self: string, otherSelf?: string, thread = options.thread): Promise<number> => {
      const api = await getClient();
      db ??= openDatabase(paths.dbPath);
      err(`[mailman] 답장을 기다립니다. ${space.space}`);
      return waitForReplies(db, api, { space: space.space, spaceKey, startTime, self, otherSelf, from,
        thread, quietMs: options.quietMs, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs,
        backfillDays: waitSettings!.backfillDays, signal, warn: text => {
          err(text);
          try { logWaitWarning(paths.logFile, space.space, text); }
          catch { err("[mailman] 대기 재시도 로그를 기록할 수 없습니다."); }
        } }, text => out(`${header}\n${text}`), dependencies.clock);
    };
    if (command === "wait") {
      return await wait(now.toISOString(), self!);
    }
    if (command === "send") {
      if (!dependencies.stdin && process.stdin.isTTY) throw new MailmanError("본문은 stdin으로 전달하세요. mailman send --help를 확인하세요.");
      const text = dependencies.stdin ? dependencies.stdin() : readFileSync(0, "utf8");
      const { prefix, untaggedReason } = resolveSendPrefix(options, config, env);
      const body = buildMessageBody(text, prefix, options.thread);
      if (options.dryRun) {
        await out(`${header}\n[전송 미리보기]${options.thread ? `\nthread name: ${options.thread}` : ""}\n${body.text}${options.save !== undefined ? `\n[별칭] ${options.save}: 저장할 예정 (미리보기이므로 설정 변경 없음)` : ""}`);
        return 0;
      }
      const api = await getClient();
      throwIfAborted(signal);
      if (options.wait) sendState = "sending";
      let created: CreatedMessage;
      let metadataError: SentMessageError | undefined;
      try { created = await sendMessage(api, space.space, text, prefix, options.thread); }
      catch (error: unknown) {
        if (!(error instanceof SentMessageError)) throw error;
        created = error.created;
        metadataError = error;
      }
      if (options.wait) sendState = "sent";
      const untagged = untaggedReason ? `\n태그 없이 전송했습니다 (${untaggedReason}).` : "";
      sentSummary = `${header}\n✅ 전송 완료${untagged}\nmessage name: ${created.name}\nthread name: ${created.thread.name}`;
      await out(sentSummary);
      if (metadataError) throw metadataError;
      if (options.wait) {
        if (!created.createTime) throw new MailmanError("응답에 createTime이 없어 대기를 시작할 수 없습니다. mailman wait를 실행하세요.", 3);
        if (created.sender?.name && created.sender.name !== self) err("[mailman] 경고: 보낸 메시지의 sender.name이 Google 계정 ID와 다릅니다. 두 ID 모두 내 메시지에서 제외합니다.");
        if (!created.sender?.name) err("[mailman] 경고: 전송 응답에 sender.name이 없어 Google 계정 ID와 대조할 수 없습니다.");
        return await wait(created.createTime, self!, created.sender?.name, options.thread ? created.thread.name : undefined);
      }
      return 0;
    }
    const collect = async () => {
      try {
        const settings = collectionOptions(env, options.deep);
        const api = await getClient();
        db ??= openDatabase(paths.dbPath);
        const result = await collectMessages(db, api, space.space, { ...settings, now });
        try { logCollection(paths.logFile, result); }
        catch { err("[mailman] 수집은 완료됐지만 요약 로그를 기록할 수 없습니다."); }
        err(`[mailman] space=${space.space} received=${result.received} saved=${result.saved}`);
      } catch (error: unknown) {
        try { logCollectionFailure(paths.logFile, space.space, error); }
        catch { err("[mailman] 수집 실패 로그를 기록할 수 없습니다."); }
        throw error;
      }
    };
    if (command === "collect") { await out(header); await collect(); return 0; }
    if (options.collect) {
      try { await collect(); }
      catch (error: unknown) { err(`[mailman] 수집 실패: ${errorMessage(error)} 기존 DB 내용을 표시합니다.`); }
    }
    if (!existsSync(paths.dbPath)) {
      await out(`${header}\n[${spaceKey}] 수집된 데이터가 없습니다. 먼저 mailman auth 및 mailman collect를 실행하세요.`);
      return 0;
    }
    db ??= openDatabase(paths.dbPath);
    await printInbox(db, { spaceKey, space: space.space, since: options.since, only: options.only, now }, text => out(`${header}\n${text}`));
    return 0;
  } catch (error: unknown) {
    let reported = error;
    try { throwIfAborted(activeSignal); } catch (interrupted: unknown) { reported = interrupted; }
    if (sendState === "sent") {
      err(`${sentSummary}\n[mailman] 전송은 완료됨 — 재전송하지 말 것. 대기 실패/중단: ${errorMessage(reported)}`);
      return 5;
    }
    if (sendState === "sending" && activeSignal?.aborted) {
      err("[mailman] 전송 여부 불확실 — Chat에서 확인 후 재전송 판단.");
      return reported instanceof MailmanError ? reported.exitCode : 1;
    }
    err(`[mailman] ${errorMessage(reported)}`);
    return reported instanceof MailmanError ? reported.exitCode : 1;
  } finally {
    db?.close();
    cleanupSignals();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
