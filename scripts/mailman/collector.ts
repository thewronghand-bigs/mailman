// claude-mailman: on-demand 수집기 (멀티 스페이스 지원)
// - auth.ts로 저장된 persistent Chrome 프로필을 재사용해
//   chat.google.com 의 지정된 스페이스에서 봇 메시지를 긁어온다.
//
// 사용: bun run collector.ts [스페이스별칭]
//   별칭 생략 시 config.json 의 defaultSpace 사용
//
// 환경변수:
//   MAILMAN_HEADLESS    (optional) "1"이면 headless. 기본 headful(안정성 ↑)
//   MAILMAN_DEBUG       (optional) "1"이면 selector 디버깅 로그

import { chromium, type Page } from "playwright";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import {
  ensureDataDirs,
  getRuntimePaths,
  loadConfig,
  resolveBotDisplayName,
  resolveChromePath,
  resolveSpace,
} from "./runtime";
import { parseSnapshotJson } from "./snapshot";

const paths = getRuntimePaths(import.meta.url);
const config = loadConfig(paths.scriptDir);
const chromePath = resolveChromePath();
const HEADLESS = process.env.MAILMAN_HEADLESS === "1";
const DEBUG = process.env.MAILMAN_DEBUG === "1";
const DRIVER = process.env.MAILMAN_DRIVER || "playwright";
const SNAPSHOT_FILE = process.env.MAILMAN_SNAPSHOT_FILE || "";
// MAILMAN_DEEP=1 이면 과거 스레드 lazy-load + reply 달린 모든 스레드 펼침 (무거움).
// 기본(미설정)은 가벼운 스캔: viewport에 보이는 스레드만 + 최신 reply 스레드 1개만 펼침.
const DEEP = process.env.MAILMAN_DEEP === "1";

const requestedSpaceKey = process.argv[2] ?? "";
const { spaceKey, space } = resolveSpace(config, requestedSpaceKey);

const SPACE_URL = space.url;
const BOT_NAME = resolveBotDisplayName(space);
// mailman 자신이 webhook 으로 발사한 카드 메시지를 다시 수집하지 않도록 발신자 이름을 명시.
const SELF_BOT_NAMES = space.selfBotNames ?? [];

ensureDataDirs(paths);

// DB 준비 (space 컬럼 추가)
const db = new Database(paths.dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    createTime TEXT NOT NULL,
    sender_name TEXT,
    sender_display_name TEXT,
    sender_type TEXT,
    text TEXT NOT NULL,
    thread_name TEXT,
    space TEXT,
    fetched_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_createTime ON messages(createTime DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_display_name ON messages(sender_display_name);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_name ON messages(sender_name);
  CREATE INDEX IF NOT EXISTS idx_messages_space ON messages(space);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// 기존 테이블에 space 컬럼이 없으면 추가 (마이그레이션)
try {
  db.exec("ALTER TABLE messages ADD COLUMN space TEXT;");
} catch {
  // 이미 존재하면 무시
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
  (id, createTime, sender_name, sender_display_name, sender_type, text, thread_name, space, fetched_at, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// 답장이 달린 봇 톱 메시지 topic-id 목록 수집 (페이지 메인 영역 기준).
// 2026-05 chat.google.com DOM 변경:
//  - 더이상 [data-message-id][role='heading'] 셀렉터가 존재하지 않음
//  - 발신자 식별은 [data-message-id][data-member-id] (data-member-id="user/bot/..." 이면 봇)
async function listThreadsWithReplies(page: Page, botName: string): Promise<string[]> {
  return await page.evaluate((bn: string) => {
    const ids: string[] = [];
    const cwizes = Array.from(document.querySelectorAll<HTMLElement>("c-wiz[data-topic-id]"));
    for (const cwiz of cwizes) {
      const tid = cwiz.getAttribute("data-topic-id");
      if (!tid) continue;
      const senderEl = cwiz.querySelector<HTMLElement>(
        "[data-message-id][data-member-id]"
      );
      if (!senderEl) continue;
      const memberId = senderEl.getAttribute("data-member-id") ?? "";
      const senderText = (senderEl.textContent ?? "").trim();
      const isBot = memberId.startsWith("user/bot/");

      // 봇은 모두 통과. 사람은 cwiz 내 어디든 @mailman 마커가 있어야 통과.
      // (listThreads 단계에선 본문 정리 전이라 정확한 첫 줄 판별이 어려워서
      //  느슨하게 contains 검사. 정밀 필터링은 extractMessages 가 다시 한다.)
      if (!isBot && !/@mailman\b/i.test(cwiz.innerText ?? "")) continue;

      const replyBtn = Array.from(cwiz.querySelectorAll<HTMLElement>("[role='button']"))
        .find((b) => /repl(y|ies)/i.test(b.innerText ?? ""));
      if (replyBtn) ids.push(tid);
    }
    return ids;
  }, botName);
}

// 특정 topic-id의 reply 버튼 클릭 → 사이드 패널이 열리며 답글이 DOM에 추가됨.
async function openThreadPanel(page: Page, topicId: string): Promise<boolean> {
  return await page.evaluate(async (tid: string) => {
    const cwiz = document.querySelector<HTMLElement>(`c-wiz[data-topic-id='${tid}']`);
    if (!cwiz) return false;
    const btn = Array.from(cwiz.querySelectorAll<HTMLElement>("[role='button']"))
      .find((b) => /repl(y|ies)/i.test(b.innerText ?? ""));
    if (!btn) return false;
    btn.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 200));
    btn.click();
    return true;
  }, topicId);
}

// 추출 로직 (2026-04 chat.google.com 기준 실측)
async function extractMessages(
  page: Page,
  selfBotNames: string[] = [],
): Promise<
  Array<{
    id: string;
    threadName: string | null;
    createTime: string;
    senderDisplayName: string;
    text: string;
  }>
> {
  const evalResult: {
    results: Array<{
      id: string;
      threadName: string | null;
      createTime: string;
      senderDisplayName: string;
      text: string;
    }>;
    debug: {
      leafGroups: number;
      withSenderEl: number;
      botCount: number;
      humanCount: number;
      noMessageId: number;
      seenDup: number;
      emptyText: number;
      humanNoMarker: number;
      pushed: number;
    };
  } = await page.evaluate(({ botName, selfBotNames: selfNames }: { botName: string; selfBotNames: string[] }) => {
    const results: Array<{
      id: string;
      threadName: string | null;
      createTime: string;
      senderDisplayName: string;
      text: string;
    }> = [];
    const debug = {
      leafGroups: 0,
      withSenderEl: 0,
      botCount: 0,
      humanCount: 0,
      noMessageId: 0,
      seenDup: 0,
      emptyText: 0,
      humanNoMarker: 0,
      pushed: 0,
    };

    const allGroups = Array.from(
      document.querySelectorAll<HTMLElement>("[role='group']"),
    );
    // leaf group = 자손에 실질적 content가 있는 role='group' 이 없는 것
    // (빈 장식용 [role='group'] 은 무시)
    const leafGroups = allGroups.filter((g) => {
      const childGroups = g.querySelectorAll("[role='group']");
      if (childGroups.length === 0) return true;
      // 모든 child group이 빈 텍스트면 leaf로 취급
      return Array.from(childGroups).every(
        (cg) => (cg as HTMLElement).innerText?.trim() === "",
      );
    });

    const seen = new Set<string>();

    debug.leafGroups = leafGroups.length;
    for (const g of leafGroups) {
      // 2026-05 chat.google.com DOM 변경: heading 대신 [data-message-id][data-member-id] 사용.
      const senderEl = g.querySelector<HTMLElement>(
        "[data-message-id][data-member-id]",
      );
      if (!senderEl) continue;
      debug.withSenderEl++;
      const memberId = senderEl.getAttribute("data-member-id") ?? "";
      const senderText = (senderEl.textContent ?? "").trim();
      const isBot = memberId.startsWith("user/bot/");
      if (isBot) debug.botCount++; else debug.humanCount++;

      // mailman 자신이 발사한 카드 메시지는 self-loop 방지를 위해 스킵
      if (isBot && selfNames.some((n) => senderText.startsWith(n))) continue;

      // 봇은 모두 통과. 사람은 본문 첫 줄 `@mailman` 마커 체크 (cleaned 본문 기준)
      // - 마커 매칭은 대소문자 무시, 마커 뒤 공백/콜론 등 어떤 문자가 와도 OK
      // - 실제 마커 검증은 noise 라인 제거 후의 본문 첫 줄로 한다 (g.innerText 첫 줄은
      //   보통 발신자 이름이라 마커가 거기 있을 일이 없음)

      const messageId = senderEl.getAttribute("data-message-id");
      if (!messageId) { debug.noMessageId++; continue; }
      if (seen.has(messageId)) { debug.seenDup++; continue; }
      seen.add(messageId);

      // 호환 유지를 위한 변수 (아래 noise 필터에서 사용)
      const headingText = senderText;
      const headingLines = senderText.split("\n").map((s) => s.trim());

      // thread_name: 조상 c-wiz[data-topic-id]
      let threadName: string | null = null;
      {
        let p: HTMLElement | null = g.parentElement;
        while (p) {
          if (p.tagName === "C-WIZ" && p.getAttribute("data-topic-id")) {
            threadName = p.getAttribute("data-topic-id");
            break;
          }
          p = p.parentElement;
        }
      }

      // 시간: data-absolute-timestamp (Unix ms)
      let createTime = "";
      const tsEl = g.querySelector<HTMLElement>("[data-absolute-timestamp]");
      if (tsEl) {
        const raw = tsEl.getAttribute("data-absolute-timestamp");
        const n = raw ? Number(raw) : NaN;
        if (Number.isFinite(n) && n > 0) {
          createTime = new Date(n).toISOString();
        }
      }
      if (!createTime) createTime = new Date().toISOString();

      // 본문 정리
      const full = (g.innerText ?? "").trim();
      const headingLinesSet = new Set(headingLines.filter(Boolean));

      const timeTexts = new Set<string>();
      for (const t of g.querySelectorAll<HTMLElement>(
        "[data-absolute-timestamp]",
      )) {
        const tt = (t.innerText ?? "").trim();
        if (tt) timeTexts.add(tt);
      }

      // senderDisplayName: heading 첫 줄에서 실제 발신자 이름 추출
      const senderDisplayName = headingLines[0] || botName || "(unknown)";

      const isNoiseLine = (raw: string): boolean => {
        const line = raw.trim();
        if (line === "") return true;
        if (line === ",") return true;
        if (line === "App") return true;
        if (botName && line === botName) return true;
        if (headingLinesSet.has(line)) return true;
        if (timeTexts.has(line)) return true;
        // 사람 메시지 마커 단독 라인만 noise 처리 (마커 + 본문이 같은 라인이면 아래 후처리에서 마커만 떼어냄)
        if (/^@mailman[:\s]*$/i.test(line)) return true;
        if (/^,?\s*\d+\s+repl(y|ies)/i.test(line)) return true;
        if (/^,?\s*Last Reply/i.test(line)) return true;
        if (
          /^(Yesterday|Today|\d{1,2}\/\d{1,2}\/\d{2,4})\b.*\d{1,2}:\d{2}\s*(AM|PM)?/i.test(
            line,
          )
        )
          return true;
        if (/^(오전|오후)\s*\d{1,2}:\d{2}/.test(line)) return true;
        return false;
      };

      const lines = full.split("\n");
      const cleaned: string[] = [];
      let i = 0;
      while (i < lines.length && isNoiseLine(lines[i]!)) i++;
      for (; i < lines.length; i++) cleaned.push(lines[i]!);
      while (cleaned.length > 0 && isNoiseLine(cleaned[cleaned.length - 1]!)) {
        cleaned.pop();
      }

      let text = cleaned.join("\n").trim();
      if (!text) { debug.emptyText++; continue; }

      // 사람 메시지는 cleaned 본문 첫 줄에 `@mailman` 마커가 있어야 통과.
      // 봇은 마커 무관하게 모두 통과.
      if (!isBot) {
        if (!/^@mailman\b/i.test(text)) { debug.humanNoMarker++; continue; }
        text = text.replace(/^@mailman[:\s]*/i, "").trim();
        if (!text) { debug.emptyText++; continue; }
      }

      debug.pushed++;
      results.push({
        id: messageId,
        threadName,
        createTime,
        senderDisplayName,
        text,
      });
    }

    return { results, debug };
  }, { botName: BOT_NAME, selfBotNames });

  if (DEBUG) {
    console.error(
      `[mailman/extractMessages] debug=${JSON.stringify(evalResult.debug)}`,
    );
  }
  return evalResult.results;
}

async function ensureLoaded(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const url = page.url();
  if (url.includes("accounts.google.com") || url.includes("signin")) {
    return false;
  }
  try {
    await page.waitForSelector("c-wiz[data-topic-id]", { timeout: 15000 });
  } catch {
    if (DEBUG) console.error("[mailman] c-wiz[data-topic-id] 미검출. 진행은 함.");
  }
  // c-wiz 가 떠도 내부 메시지 컨텐츠(leaf group / data-message-id 등)는 추가 렌더링이 필요하다.
  // 1.5초로는 빠른 머신에서도 누락이 자주 나서 5초로 보수적으로 잡는다.
  await page.waitForTimeout(5000);
  return true;
}

// 메시지 리스트 컨테이너를 위로 반복 스크롤해 과거 스레드를 lazy-load.
// 더 이상 새 스레드가 추가되지 않으면 종료.
async function scrollUpToLoadHistory(page: Page, maxIterations = 20): Promise<void> {
  let prevCount = 0;
  let stableCount = 0;
  for (let i = 0; i < maxIterations; i++) {
    const count = await page.evaluate(() => {
      const anyTopic = document.querySelector<HTMLElement>("c-wiz[data-topic-id]");
      if (!anyTopic) return 0;
      let node: HTMLElement | null = anyTopic;
      while (node) {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        const scrollable =
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight;
        if (scrollable) {
          node.scrollTop = 0;
          break;
        }
        node = node.parentElement;
      }
      return document.querySelectorAll("c-wiz[data-topic-id]").length;
    });
    await page.waitForTimeout(1200);
    if (count === prevCount) {
      stableCount++;
      if (stableCount >= 2) break;
    } else {
      stableCount = 0;
    }
    prevCount = count;
  }
  if (DEBUG) console.error(`[mailman] scrollUpToLoadHistory: final topic count=${prevCount}`);
}

let inserted = 0;
let scanned = 0;
const now = new Date().toISOString();

if (DRIVER === "snapshot") {
  if (!SNAPSHOT_FILE) {
    console.error("[mailman] MAILMAN_DRIVER=snapshot 인 경우 MAILMAN_SNAPSHOT_FILE 이 필요합니다.");
    process.exit(1);
  }
  if (!existsSync(SNAPSHOT_FILE)) {
    console.error(`[mailman] snapshot 파일을 찾을 수 없습니다: ${SNAPSHOT_FILE}`);
    process.exit(1);
  }

  const snapshot = readFileSync(SNAPSHOT_FILE, "utf8");
  const msgs = parseSnapshotJson(snapshot).filter((message) =>
    BOT_NAME ? message.senderDisplayName.includes(BOT_NAME) : true,
  );
  scanned = msgs.length;

  for (const m of msgs) {
    const r = insertStmt.run(
      m.id,
      m.createTime,
      null,
      m.senderDisplayName,
      "BOT",
      m.text,
      m.threadName,
      spaceKey,
      now,
      JSON.stringify({ source: "snapshot-import", snapshotFile: SNAPSHOT_FILE, space: spaceKey, ...m }),
    );
    if (r.changes > 0) inserted++;
  }
} else {
  if (!existsSync(paths.profileDir)) {
    console.error(
      `[mailman] 프로필이 없습니다. 먼저 'bun run auth.ts' 로 로그인하세요. (path=${paths.profileDir})`,
    );
    process.exit(2);
  }

  const context = await chromium.launchPersistentContext(paths.profileDir, {
    headless: HEADLESS,
    executablePath: chromePath,
    viewport: { width: 1280, height: 900 },
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(SPACE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    const ok = await ensureLoaded(page);
    if (!ok) {
      console.error("[mailman] 로그인 세션이 만료되었습니다. 'bun run auth.ts' 를 다시 실행하세요.");
      process.exit(3);
    }

    // DEEP 모드에서만 가상 스크롤 영역을 위로 올려 과거 스레드 lazy-load.
    // 기본 모드는 채팅방 상단으로 끌어올리지 않고 viewport에 보이는 것만 본다.
    if (DEEP) {
      await scrollUpToLoadHistory(page);
    }

    // 1) 톱(메인) 메시지 먼저 수집 (봇 필터 적용)
    const topMsgs = await extractMessages(page, SELF_BOT_NAMES);

    // 2) 답글이 달린 스레드를 패널로 열어서 답글 누적 수집
    //    (사이드 패널은 동시에 1개만 열려서 일괄 클릭 시 마지막 것만 DOM에 남음)
    //    DEEP 모드: reply 달린 모든 스레드 순회.
    //    기본 모드: 가장 최신 스레드 1개만 펼친다.
    const allThreadsWithReplies = await listThreadsWithReplies(page, BOT_NAME);
    const threadsWithReplies = DEEP ? allThreadsWithReplies : allThreadsWithReplies.slice(0, 1);
    if (DEBUG) console.error(`[mailman] threads with replies: ${threadsWithReplies.length}/${allThreadsWithReplies.length} (deep=${DEEP})`);

    const replyMsgs: typeof topMsgs = [];
    const seenIds = new Set(topMsgs.map((m) => m.id));
    for (const tid of threadsWithReplies) {
      const opened = await openThreadPanel(page, tid);
      if (!opened) continue;
      await page.waitForTimeout(1500);
      const all = await extractMessages(page, SELF_BOT_NAMES);
      for (const m of all) {
        if (seenIds.has(m.id)) continue;
        if (m.threadName !== tid) continue;
        seenIds.add(m.id);
        replyMsgs.push(m);
      }
    }

    // 봇은 모두 통과, 사람은 @mailman 마커로 1차 필터, selfBotNames 는 collector 안에서 스킵.
    // 별도 mentionFilter 는 더 이상 적용하지 않는다.
    const msgs = [...topMsgs, ...replyMsgs];
    scanned = msgs.length;

    for (const m of msgs) {
      const r = insertStmt.run(
        m.id,
        m.createTime,
        null,
        m.senderDisplayName,
        "BOT",
        m.text,
        m.threadName,
        spaceKey,
        now,
        JSON.stringify({ source: "dom-scrape", space: spaceKey, ...m }),
      );
      if (r.changes > 0) inserted++;
    }
  } finally {
    await context.close().catch(() => {});
  }
}

db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSync', ?)").run(now);
db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`lastSync:${spaceKey}`, now);

console.error(
  `[mailman] driver="${DRIVER}" space="${spaceKey}" scanned=${scanned} inserted=${inserted} bot="${BOT_NAME}" url=${SPACE_URL}`,
);
