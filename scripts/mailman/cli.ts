// 컴파일된 실행 파일과 개발 실행기(mailman-dev)가 함께 쓰는 단일 진입점.
import { existsSync, readFileSync } from "node:fs";
import { authenticate, DIRECTORY_SCOPE, getAccessToken, getSelfUser, installClient, loadToken, requireReactionScope, requireSpaceCreateScope } from "./auth";
import { ChatClient, SentMessageError, type CreatedMessage } from "./chat";
import { collectMessages, logCollection, logCollectionFailure, logWaitWarning } from "./collector";
import { errorMessage, MailmanError, throwIfAborted } from "./errors";
import { printInbox, type SenderType } from "./fetch";
import { attachmentExpander, downloadAttachment, driveDescription, messageAttachments, renderDownloaded } from "./download";
import { runDoctor } from "./doctor";
import type { Fetch } from "./http";
import packageJson from "./package.json" with { type: "json" };
import type { SendAgent } from "./content";
import { collectionOptions, getRuntimePaths, loadConfig, MISSING_TARGET, parseAgent, parseMessageName, resolveSendPrefix, SEND_AGENT_HINT, SETUP_GUIDE_URL, validateThread,
  type Environment, type RuntimePaths } from "./runtime";
import { buildMessageText, sendMessage } from "./send";
import { closeUploadFiles, MAX_UPLOAD_FILES, uploadAttachments, uploadPreview, validateUploadFiles, type UploadFile } from "./upload";
import { cacheSpace, forgetPerson, openDatabase, registeredPeople } from "./store";
import { parseSince } from "./time";
import { describeTarget, formatPerson, formatSpace, inboxLabel, listSpaces, normalizeName, requireName, resolveWaitPerson, resolveTarget, saveAlias, searchSpaces, targetHeader } from "./resolve";
import { parseEmoji, reactMessage, type ReactionEmoji } from "./react";
import { parseDuration, waitForReplies, type WaitClock } from "./wait";
import type { Database } from "bun:sqlite";

// 빌드 시 `bun build --define`으로 주입한다. 개발 실행에서는 package.json 버전을 쓴다.
declare const MAILMAN_BUILD_VERSION: string | undefined;
export const VERSION = typeof MAILMAN_BUILD_VERSION === "string" ? MAILMAN_BUILD_VERSION : packageJson.version;

export type Command = "auth" | "doctor" | "spaces" | "people" | "collect" | "fetch" | "send" | "wait" | "download" | "react";
export type Arguments = {
  help: boolean;
  spaceKey?: string;
  since?: string;
  thread?: string;
  only?: SenderType;
  client?: string;
  agent?: SendAgent;
  dm?: string;
  forget?: string;
  save?: string;
  makeDefault?: boolean;
  from?: string;
  quietMs?: number;
  timeoutMs?: number;
  intervalMs?: number;
  refresh?: boolean;
  wait?: boolean;
  dryRun?: boolean;
  messageName?: string;
  emoji?: ReactionEmoji;
  out?: string;
  print?: boolean;
  withAttachments?: boolean;
  attach?: string[];
  deep: boolean;
  collect: boolean;
  tag: boolean;
};

const COMMANDS: readonly Command[] = ["auth", "doctor", "spaces", "people", "collect", "fetch", "send", "wait", "download", "react"];
const TARGET_COMMANDS: readonly Command[] = ["collect", "fetch", "send", "wait"];
const ALIAS_COMMANDS: readonly Command[] = ["spaces", ...TARGET_COMMANDS];

const SAVE_HELP = `--save <별칭>: 해석된 대상을 설정에 0600으로 원자 저장. 처음 저장한 별칭이 기본 방.
--save <별칭> --default: 기본 방 변경. 기존 별칭은 같은 방일 때 기본 방만 변경하며 space 값은 덮어쓰지 않음.
대상을 생략한 --save <기존 별칭> --default는 그 별칭을 선택. send --dry-run은 별칭·기본 방 모두 변경하지 않음.`;
const TARGET_HELP = `대상: config 별칭 → spaces/ID → --dm <users/ID|이메일|사람 이름> → 스페이스 표시 이름.
명시 대상은 설정 파일 없이 동작. 생략할 때만 defaultSpace 필요.
사람 이름: 등록된 사람 → 수집 발신자 → 회사 디렉터리(선택 권한 필요). 확정한 사람은 로컬에 등록 (--dry-run 제외).
위치 인자와 --dm은 함께 쓸 수 없음. 이름 후보가 여러 개면 선택하지 않고 목록을 표시.
${SAVE_HELP}
빈 문자열/공백 대상은 인자 오류. 표시 이름 캐시는 24시간 초과 시 갱신 (오프라인이면 경고 후 기존 캐시).`;
const WAIT_HELP = `--thread <spaces/.../threads/...>: 이 스레드만. --from <사람>: 이 발신자만 (둘 다 seen 유지).
--quiet 60s: 마지막 답장 이후 조용한 시간. --timeout 30m: 전체 대기 (최대 2h). --interval 15s: 폴링 간격.
기간은 양의 정수 s/m/h. 첫 답장부터 최대 10분 또는 전체 timeout까지 한 묶음으로 대기.
--from은 대기/전송 전에 users/ID로 확정. 이메일은 기존 DM의 수집 기록/최근 메시지가 필요하며 실패하면 전송하지 않음.
네트워크/5xx/429는 최대 60초 백오프로 재시도, 연속 실패 5분이면 받은 답장 출력 후 종료. 401은 토큰 갱신 후 1회 재시도.
답장이 없으면 exit 4. 단독 wait의 SIGINT/SIGTERM은 exit 130/143, seen 유지.
send --wait 전송 완료 후 대기 오류/중단은 exit 5: 전송은 완료됨 — 재전송하지 말 것. 전송 요청 중 중단은 전송 여부 불확실, Chat에서 확인.`;
const ATTACHMENTS_HELP = "--with-attachments: 표시할 텍스트 첨부를 메시지당 최대 3개·각 256KB까지 내려받아 코드블록으로 표시. 실패해도 조회 계속.";

export const USAGE = `mailman — Google Chat 스페이스 메시지를 로컬에 모아 조회·전송하는 CLI

사용: mailman <명령> [옵션]

명령:
  auth [--client <client_secret.json>]    Google 로그인. --client로 OAuth 클라이언트 JSON을 등록
  doctor                                 설정·인증·Chat API 접근 점검과 해결 단계 안내
  spaces [검색어] [--refresh] [--save <별칭>] [--default]  스페이스 목록·검색·별칭 저장
  people [검색어] [--forget <users/ID>]     등록된 사람 목록·검색·삭제
  collect [스페이스] [--deep]              Chat API 증분 수집 (--deep: 최근 30일 백필)
  fetch [스페이스] [옵션]                  수집 후 새 메시지 조회
  send [스페이스] [옵션]                   stdin 본문을 사용자 명의로 태그를 붙여 전송
  wait [스페이스] [옵션]                   새 답장을 조용해진 뒤 한 묶음으로 출력
  download <메시지 name> [--out <디렉터리>] [--print]  업로드 첨부 내려받기
  react <메시지 name> <👀|✅>              사용자 명의 리액션 (✅는 승인 후)

mailman <명령> --help    명령별 도움말
mailman --version        버전

설정 파일: $MAILMAN_CONFIG (기본 ~/.claude/mailman/config.json)
설정 가이드: ${SETUP_GUIDE_URL}`;

export const HELP: Record<Command, string> = {
  doctor: `사용: mailman doctor
버전·파일 경로/0600 권한, 설정 JSON, 데스크톱 클라이언트, 필수/선택 스코프, 토큰 갱신, Chat API 접근을 순서대로 점검.
파일·DB·설정을 변경하지 않으며 로그인 창을 열지 않음. 토큰 갱신·스페이스 1건·선택 디렉터리 1건 조회에 네트워크를 사용.
실패는 exit 1, 경고만 있으면 exit 0. 앞 단계 실패에 의존하는 점검은 건너뜀.
해결 단계: ${SETUP_GUIDE_URL}`,
  auth: `사용: mailman auth [--client <client_secret.json>]
브라우저에서 Google 로그인·권한 동의 후 refresh token을 저장한다 (최대 5분).
--client: Google에서 받은 데스크톱 앱 OAuth 클라이언트 JSON을 검증해 클라이언트 파일 경로로 0600 복사한 뒤 로그인.
클라이언트 파일이 없으면 설정 가이드를 확인하세요: ${SETUP_GUIDE_URL}`,
  collect: `사용: mailman collect [스페이스] [--deep]
Google Chat API 증분 수집. --deep(또는 MAILMAN_DEEP=1)이면 수집 커서와 무관하게 최근 30일 백필.
${TARGET_HELP}`,
  spaces: `사용: mailman spaces [검색어] [--refresh] [--save <별칭>] [--default]
내가 속한 스페이스의 표시 이름·종류·ID를 출력. 검색어는 대소문자·공백을 무시한 표시 이름 부분 일치.
캐시가 없거나 --refresh면 Google Chat API 목록을 최대 1,000페이지 받아 DB 캐시를 교체.
--save는 config 별칭·spaces/ID·표시 이름을 해석. 표시 이름은 정확 일치 우선, 없으면 부분 일치하며 후보가 유일해야 저장.
${SAVE_HELP}`,
  people: `사용: mailman people [검색어]
등록된 사람의 이름·users/ID·이메일·출처(sender|directory|manual)를 출력. 검색은 공백·대소문자를 무시한 부분 일치.
mailman people --forget <users/숫자ID>: 한 명의 등록만 삭제. 수집된 메시지는 유지.
디렉터리 검색 결과 중 확정된 한 명만 저장하며 --dry-run은 등록하지 않음.`,
  fetch: `사용: mailman fetch [스페이스] [--since <기간|날짜>] [--only bot|human] [--no-collect] [--deep]
수집 후 mailman이 마지막으로 보여준 이후의 새 메시지를 최대 200건 조회 (첫 조회는 24시간). 수집 실패 시 기존 DB 출력.
--since 24h / 3d / 2026-10-01: 지정 시점 이후 조회, seen 커서 유지.
--only bot|human: 해당 발신자 유형의 새 메시지만 조회, seen 커서 유지.
--no-collect: 메시지 수집 없이 DB만 조회 (이름/DM 해석은 API를 호출할 수 있음). --deep: 조회 전 최근 30일 백필 수집.
${ATTACHMENTS_HELP}
${TARGET_HELP}`,
  send: `사용: mailman send [스페이스] [--attach <파일> ...] [--thread spaces/.../threads/...] [--agent claude|codex] [--no-tag] < 본문.txt
사용자 명의로 본문 앞에 [🤖 <라벨>] 태그를 붙여 텍스트·지정 파일을 전송. 실패 시 재시도하지 않음.
--attach <파일>: 최대 10개, 각 200MB 이하 일반 파일. 심볼릭 링크는 거절하며 실제 경로를 출력. 모두 검증한 뒤 업로드하고 전부 성공한 경우만 메시지 생성. 업로드는 60초 무진척 또는 전체 30분을 넘으면 중단.
본문이 비고 첨부가 있으면 태그만, 태그도 끄면 첨부만 보냄. --dry-run은 파일 경로·이름·크기만 미리 보고 업로드하지 않음.
--agent claude|codex: 라벨을 Claude/Codex로 표시 (대소문자 무시). 없으면 환경변수 MAILMAN_AGENT, 둘 다 없으면 [🤖 AI].
--no-tag: 이번 전송만 태그 없이 보냄. --agent와 함께 쓸 수 없음.
설정 파일 최상위 "sendTag": false면 항상 태그 없이 보냄 (기본 true).
--dry-run: 해석된 대상과 전송 본문 미리보기. --save도 저장할 예정 안내만 하며 설정을 바꾸지 않음.
--dm: 처음 보내는 상대도 이름으로 검색. 기존 DM이 없으면 chat.spaces.create 권한으로 새 DM을 만들고 전송.
--dry-run은 새 DM을 만들지 않고 생성 예정만 표시. fetch/collect/wait는 기존 DM만 사용.
--wait: 전송한 createTime부터 답장 대기. --dry-run과 함께 쓸 수 없음.
${ATTACHMENTS_HELP} send에서는 --wait와 함께 사용.
${TARGET_HELP}
${WAIT_HELP}`,
  wait: `사용: mailman wait [스페이스] [--dm <사람>] [대기 옵션]
실행 시각 이후의 내 메시지를 제외한 새 답장을 기다린다. 대기 전부터 있던 안 읽은 메시지도 먼저 출력.
${ATTACHMENTS_HELP}
${TARGET_HELP}
${WAIT_HELP}`,
  download: `사용: mailman download <spaces/SPACE_ID/messages/MESSAGE_ID> [--out <디렉터리>] [--print]
DB 원본 JSON을 우선 사용하고 없으면 messages.get으로 조회. 업로드 첨부만 최대 50MB까지 내려받음.
기본: $MAILMAN_HOME/mailman/attachments/<space id>/<message id>/<파일명> (디렉터리 0700, 파일 0600).
기본 경로에서는 같은 참조·이름·저장 크기의 파일을 재사용. 이름 충돌은 접미사로 구분.
--out: 저장 디렉터리 지정. 새 디렉터리만 0700으로 만들고 기존 권한은 유지. 재사용 기록 없이 매번 다운로드.
다운로드는 30초 동안 수신 바이트가 없거나 전체 10분을 넘기면 중단.
--print: 텍스트 계열·256KB 이하의 UTF-8 내용만 출력. 바이너리/큰 파일은 경로만 출력.
Drive 첨부는 링크/파일 ID와 미지원 안내만 출력.`,
  react: `사용: mailman react <spaces/SPACE_ID/messages/MESSAGE_ID> <👀|✅>
작업 관련 스펙·요청·핸드오버를 읽고 보고했으면 👀 자동, 실제 반영 완료 후 ✅는 사용자 승인 필수.
리액션은 해당 내용을 보낸 메시지(스펙·요청·핸드오버 그 자체)의 name에 단다. 사용자 본인 메시지에는 달지 않는다.
잡담에는 달지 않으며 같은 메시지·이모지는 중복 생성하지 않음 (409/ALREADY_EXISTS는 성공).
리액션 스코프가 없는 기존 토큰은 exit 2: mailman auth를 다시 실행하세요.`,
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
    if (arg === "--attach" && command === "send") {
      const path = value(++index, "--attach 뒤에 파일 경로를 지정하세요.");
      requireName(path, "--attach");
      (result.attach ??= []).push(path);
      if (result.attach.length > MAX_UPLOAD_FILES) throw new MailmanError("첨부는 최대 10개까지 지정할 수 있습니다.");
    } else if (arg === "--out" && command === "download" && result.out === undefined) {
      result.out = value(++index, "--out 뒤에 저장 디렉터리를 지정하세요.");
      requireName(result.out, "--out");
    } else if (arg === "--print" && command === "download" && !result.print) {
      result.print = true;
    } else if (arg === "--with-attachments" && ["fetch", "wait", "send"].includes(command) && !result.withAttachments) {
      result.withAttachments = true;
    } else if (arg === "--since" && command === "fetch" && result.since === undefined) {
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
    } else if (arg === "--dm" && TARGET_COMMANDS.includes(command) && result.dm === undefined) {
      result.dm = value(++index, "--dm 뒤에 사람 이름, 이메일 또는 users/ID를 지정하세요.");
    } else if (arg === "--forget" && command === "people" && result.forget === undefined) {
      result.forget = value(++index, "--forget 뒤에 users/숫자ID를 지정하세요.");
      if (!/^users\/\d+$/.test(result.forget)) throw new MailmanError("--forget은 users/숫자ID 형식으로 지정하세요.");
    } else if (arg === "--save" && ALIAS_COMMANDS.includes(command) && result.save === undefined) {
      result.save = value(++index, "--save 뒤에 별칭을 지정하세요.");
    } else if (arg === "--default" && ALIAS_COMMANDS.includes(command) && !result.makeDefault) {
      result.makeDefault = true;
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
  if (command === "download" || command === "react") {
    if (positional.length !== (command === "react" ? 2 : 1)) throw new MailmanError(HELP[command]);
    result.messageName = positional[0]!;
    parseMessageName(result.messageName);
    if (command === "react") result.emoji = parseEmoji(positional[1]!);
    return result;
  }
  if (positional.length > (command === "auth" || command === "doctor" ? 0 : 1)) throw new MailmanError(HELP[command]);
  if (result.deep && !result.collect) throw new MailmanError("--deep과 --no-collect는 함께 쓸 수 없습니다.");
  // 태그를 끄면서 라벨을 지정하는 것은 의도가 충돌하므로 한쪽을 무시하지 않고 거절한다.
  if (result.agent !== undefined && !result.tag) throw new MailmanError("--agent와 --no-tag는 함께 쓸 수 없습니다.");
  result.spaceKey = positional[0];
  if (result.forget !== undefined && result.spaceKey !== undefined) throw new MailmanError("people 검색어와 --forget은 함께 쓸 수 없습니다.");
  for (const [label, entry] of [[command === "spaces" ? "검색어" : "대상", result.spaceKey], ["--dm", result.dm], ["--from", result.from], ["--save", result.save]]) {
    if (entry !== undefined) requireName(entry, label!);
  }
  if (result.makeDefault && result.save === undefined) throw new MailmanError("--default는 --save <별칭>과 함께 쓰세요.");
  if (result.spaceKey !== undefined && result.dm !== undefined) throw new MailmanError("위치 인자와 --dm은 함께 쓸 수 없습니다.");
  if (result.dryRun && result.wait) throw new MailmanError("--dry-run과 --wait는 함께 쓸 수 없습니다.");
  if (command === "send" && !result.wait && [result.from, result.quietMs, result.timeoutMs, result.intervalMs].some(option => option !== undefined)) {
    throw new MailmanError("전송 대기 옵션은 --wait와 함께 쓰세요.");
  }
  if (command === "send" && result.withAttachments && !result.wait) throw new MailmanError("send --with-attachments는 --wait와 함께 쓰세요.");
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
  let uploadFiles: UploadFile[] = [];
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
    if (command === "doctor") return await runDoctor(paths, VERSION, dependencies.fetcher ?? fetch, out);
    if (command === "send") uploadFiles = validateUploadFiles(options.attach ?? []);
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
      return new ChatClient(await accessToken, fetcher, signal, async refreshSignal => {
        err("[mailman] HTTP 401: access token을 갱신하고 읽기 요청을 1회 재시도합니다.");
        accessToken = getAccessToken(paths, (input, init = {}) => fetcher(input, { ...init, signal: refreshSignal }));
        return accessToken;
      });
    })();
    if (command === "people") {
      if (!existsSync(paths.dbPath)) {
        await out(options.forget ? `등록된 사람이 없습니다: ${options.forget}` : "등록된 사람이 없습니다.");
        return 0;
      }
      db = openDatabase(paths.dbPath);
      if (options.forget) {
        await out(forgetPerson(db, options.forget) ? `사람 등록을 삭제했습니다: ${options.forget}` : `등록된 사람이 없습니다: ${options.forget}`);
      } else {
        const query = normalizeName(options.spaceKey ?? "");
        const people = registeredPeople(db).filter(person => [person.displayName, person.userName, person.email ?? ""].some(field => normalizeName(field).includes(query)));
        await out(people.length ? people.map(person => `${formatPerson(person)} [${person.source}]`).join("\n") : "일치하는 등록된 사람이 없습니다.");
      }
      return 0;
    }
    if (command === "react") {
      requireReactionScope(paths.tokenFile);
      await out(await reactMessage(await getClient(), options.messageName!, options.emoji!));
      return 0;
    }
    if (command === "download") {
      if (existsSync(paths.dbPath)) db = openDatabase(paths.dbPath);
      const attachments = await messageAttachments(db, getClient, options.messageName!);
      if (!attachments.length) await out("첨부가 없습니다.");
      for (const attachment of attachments) {
        const drive = driveDescription(attachment);
        if (drive) { await out(drive); continue; }
        const file = await downloadAttachment(getClient, paths, options.messageName!, attachment, { out: options.out });
        await out(renderDownloaded(file, options.print));
      }
      return 0;
    }
    if (command === "spaces" && options.save === undefined) {
      db = openDatabase(paths.dbPath);
      const spaces = searchSpaces(await listSpaces(db, getClient, options.refresh, now), options.spaceKey);
      await out(spaces.length ? spaces.map(space => `- ${formatSpace(space)}`).join("\n") : "일치하는 스페이스가 없습니다. mailman spaces --refresh로 확인하세요.");
      return 0;
    }
    const config = loadConfig(paths.configFile);
    // 기존 별칭의 기본 방 변경은 대상을 다시 입력하지 않아도 그 별칭을 사용한다.
    const targetOptions = { ...options, spaceKey: options.spaceKey ?? (options.makeDefault && options.save !== undefined &&
      options.dm === undefined && Object.hasOwn(config.spaces, options.save) ? options.save : undefined) };
    const waitSettings = waiting ? collectionOptions(env) : undefined;
    const requested = targetOptions.spaceKey ?? config.defaultSpace;
    if (targetOptions.spaceKey === undefined && options.dm === undefined && !requested) throw new MailmanError(MISSING_TARGET);
    const needsResolution = options.dm !== undefined || (!Object.hasOwn(config.spaces, requested) && !requested.startsWith("spaces/"));
    if (needsResolution || existsSync(paths.dbPath) || waiting || options.refresh) db = openDatabase(paths.dbPath);
    if (command === "spaces" && options.refresh) await listSpaces(db!, getClient, true, now);
    let target = await resolveTarget(config, db, getClient, { ...targetOptions, allowNewDm: command === "send",
      directoryEnabled: () => loadToken(paths.tokenFile).scopes.includes(DIRECTORY_SCOPE) }, now, err);
    const spaceKey = target.spaceKey;
    const space = { space: target.name };
    if (options.thread) {
      if (target.newDm) throw new MailmanError("새 DM에는 기존 --thread를 지정할 수 없습니다.");
      validateThread(space.space, options.thread);
    }
    let self: string | undefined;
    let otherSelf: string | undefined;
    let from: string | undefined;
    const currentTarget = () => describeTarget(db, target, self, otherSelf);
    const header = () => targetHeader(currentTarget());
    const renderOptions = { isDm: target.spaceType === "DIRECT_MESSAGE", spaceLabel: () => inboxLabel(currentTarget()),
      expandAttachments: options.withAttachments ? attachmentExpander(getClient, paths) : undefined };
    if (waiting) {
      const api = await getClient();
      self = await getSelfUser(paths, await accessToken!, fetcher);
      if (options.from !== undefined) from = await resolveWaitPerson(db!, api, options.from, self, now, waitSettings!.backfillDays, loadToken(paths.tokenFile).email);
    }
    if (options.save !== undefined) {
      if (target.newDm) {
        if (Object.hasOwn(config.spaces, options.save)) throw new MailmanError(`이미 등록된 별칭입니다: ${options.save}. --save는 덮어쓰지 않습니다.`);
      } else saveAlias(paths.configFile, options.save, space.space, { dryRun: options.dryRun, makeDefault: options.makeDefault });
    }
    if (command === "spaces") {
      await out(`${header()}\n[별칭] ${options.save}: ${options.makeDefault ? "기본 방으로 지정했습니다." : "저장했습니다."}`);
      return 0;
    }
    const wait = async (startTime: string, self: string, otherSelf?: string, thread = options.thread): Promise<number> => {
      const api = await getClient();
      db ??= openDatabase(paths.dbPath);
      err(`[mailman] 답장을 기다립니다. ${space.space}`);
      return waitForReplies(db, api, { space: space.space, spaceKey, startTime, self, otherSelf, from, ...renderOptions,
        thread, quietMs: options.quietMs, timeoutMs: options.timeoutMs, intervalMs: options.intervalMs,
        backfillDays: waitSettings!.backfillDays, signal, warn: text => {
          err(text);
          try { logWaitWarning(paths.logFile, space.space, text); }
          catch { err("[mailman] 대기 재시도 로그를 기록할 수 없습니다."); }
        } }, text => out(`${header()}\n${text}`), dependencies.clock);
    };
    if (command === "wait") {
      return await wait(now.toISOString(), self!);
    }
    if (command === "send") {
      if (!dependencies.stdin && process.stdin.isTTY && !uploadFiles.length) throw new MailmanError("본문은 stdin으로 전달하세요. mailman send --help를 확인하세요.");
      const text = dependencies.stdin ? dependencies.stdin() : process.stdin.isTTY ? "" : readFileSync(0, "utf8");
      const { prefix, untaggedReason } = resolveSendPrefix(options, config, env);
      const bodyText = buildMessageText(text, prefix, uploadFiles.length > 0);
      if (options.dryRun) {
        await out(`${header()}\n[전송 미리보기]${options.thread ? `\nthread name: ${options.thread}` : ""}\n${bodyText ?? "(텍스트 없이 첨부만 전송)"}${uploadPreview(uploadFiles)}${options.save !== undefined ? `\n[별칭] ${options.save}: ${options.makeDefault ? "기본 방으로 지정할 예정" : "저장할 예정"} (미리보기이므로 설정 변경 없음)` : ""}`);
        return 0;
      }
      const api = await getClient();
      if (target.newDm) {
        requireSpaceCreateScope(paths.tokenFile);
        const createdSpace = await api.setupDirectMessage(target.dmUser!);
        cacheSpace(db!, createdSpace, now.toISOString());
        target = { ...target, ...createdSpace, newDm: false };
        space.space = createdSpace.name;
        if (options.save !== undefined) saveAlias(paths.configFile, options.save, space.space, { makeDefault: options.makeDefault });
      }
      const attachments = await uploadAttachments(api, space.space, uploadFiles, err, signal);
      closeUploadFiles(uploadFiles);
      throwIfAborted(signal);
      if (options.wait) sendState = "sending";
      let created: CreatedMessage;
      let metadataError: SentMessageError | undefined;
      try { created = await sendMessage(api, space.space, text, prefix, options.thread, options.wait, attachments); }
      catch (error: unknown) {
        if (!(error instanceof SentMessageError)) throw error;
        created = error.created;
        metadataError = error;
      }
      if (options.wait) sendState = "sent";
      const untagged = untaggedReason ? `\n태그 없이 전송했습니다 (${untaggedReason}).` : "";
      sentSummary = `${header()}\n✅ 전송 완료${untagged}\nmessage name: ${created.name}\nthread name: ${created.thread.name}${uploadFiles.length ? `\n첨부 파일: ${uploadFiles.map(file => JSON.stringify(file.name)).join(", ")}\n첨부 경로: ${uploadFiles.map(file => JSON.stringify(file.path)).join(", ")}` : ""}`;
      await out(sentSummary);
      if (options.wait) {
        if (metadataError) throw metadataError;
        if (!created.createTime) throw new MailmanError("응답에 createTime이 없어 대기를 시작할 수 없습니다. mailman wait를 실행하세요.", 3);
        if (created.sender?.name && created.sender.name !== self) err("[mailman] 경고: 보낸 메시지의 sender.name이 Google 계정 ID와 다릅니다. 두 ID 모두 내 메시지에서 제외합니다.");
        if (!created.sender?.name) err("[mailman] 경고: 전송 응답에 sender.name이 없어 Google 계정 ID와 대조할 수 없습니다.");
        otherSelf = created.sender?.name;
        return await wait(created.createTime, self!, otherSelf, options.thread ? created.thread.name : undefined);
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
    if (command === "collect") { await out(header()); await collect(); return 0; }
    if (options.collect) {
      try { await collect(); }
      catch (error: unknown) { err(`[mailman] 수집 실패: ${errorMessage(error)} 기존 DB 내용을 표시합니다.`); }
    }
    if (!existsSync(paths.dbPath)) {
      await out(`${header()}\n[${inboxLabel(currentTarget())}] 수집된 데이터가 없습니다. 먼저 mailman auth 및 mailman collect를 실행하세요.`);
      return 0;
    }
    db ??= openDatabase(paths.dbPath);
    await printInbox(db, { spaceKey, space: space.space, since: options.since, only: options.only, now, ...renderOptions }, text => out(`${header()}\n${text}`));
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
    closeUploadFiles(uploadFiles);
    db?.close();
    cleanupSignals();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
