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

const requestedSpaceKey = process.argv[2] ?? "";
const { spaceKey, space } = resolveSpace(config, requestedSpaceKey);

const SPACE_URL = space.url;
const BOT_NAME = resolveBotDisplayName(space);
const MENTION_FILTER = space.mentionFilter ?? "";

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
async function listThreadsWithReplies(page: Page, botName: string): Promise<string[]> {
  return await page.evaluate((bn: string) => {
    const ids: string[] = [];
    const cwizes = Array.from(document.querySelectorAll<HTMLElement>("c-wiz[data-topic-id]"));
    for (const cwiz of cwizes) {
      const tid = cwiz.getAttribute("data-topic-id");
      if (!tid) continue;
      const heading = cwiz.querySelector<HTMLElement>("[data-message-id][role='heading']");
      if (!heading) continue;
      if (bn && !(heading.innerText ?? "").includes(bn)) continue;
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
async function extractMessages(page: Page): Promise<
  Array<{
    id: string;
    threadName: string | null;
    createTime: string;
    senderDisplayName: string;
    text: string;
  }>
> {
  return await page.evaluate((botName: string) => {
    const results: Array<{
      id: string;
      threadName: string | null;
      createTime: string;
      senderDisplayName: string;
      text: string;
    }> = [];

    const allGroups = Array.from(
      document.querySelectorAll<HTMLElement>("div[role='group']"),
    );
    // leaf group = 자손에 실질적 content가 있는 role='group' 이 없는 것
    // (빈 장식용 div[role='group'] 은 무시)
    const leafGroups = allGroups.filter((g) => {
      const childGroups = g.querySelectorAll("div[role='group']");
      if (childGroups.length === 0) return true;
      // 모든 child group이 빈 텍스트면 leaf로 취급
      return Array.from(childGroups).every(
        (cg) => (cg as HTMLElement).innerText?.trim() === "",
      );
    });

    const seen = new Set<string>();

    for (const g of leafGroups) {
      const heading = g.querySelector<HTMLElement>(
        "[data-message-id][role='heading']",
      );
      if (!heading) continue;
      const headingText = heading.innerText ?? "";
      // 봇 이름이 있으면 필터, 없으면 모든 메시지 수집
      if (botName && !headingText.includes(botName)) continue;

      const messageId = heading.getAttribute("data-message-id");
      if (!messageId) continue;
      if (seen.has(messageId)) continue;
      seen.add(messageId);

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
      const headingLines = headingText.split("\n").map((s) => s.trim());
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

      const text = cleaned.join("\n").trim();
      if (!text) continue;

      results.push({
        id: messageId,
        threadName,
        createTime,
        senderDisplayName,
        text,
      });
    }

    return results;
  }, BOT_NAME);
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
  await page.waitForTimeout(1500);
  return true;
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
  const msgs = parseSnapshotJson(snapshot)
    .filter((message) => (BOT_NAME ? message.senderDisplayName.includes(BOT_NAME) : true))
    .filter((message) => (MENTION_FILTER ? message.text.includes(MENTION_FILTER) : true));
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

    // 1) 톱(메인) 메시지 먼저 수집 (봇 필터 적용)
    const topMsgs = await extractMessages(page);

    // 2) 답글이 달린 스레드를 하나씩 패널로 열어서 답글 누적 수집
    //    (사이드 패널은 동시에 1개만 열려서 일괄 클릭 시 마지막 것만 DOM에 남음)
    const threadsWithReplies = await listThreadsWithReplies(page, BOT_NAME);
    if (DEBUG) console.error(`[mailman] threads with replies: ${threadsWithReplies.length}`);

    const replyMsgs: typeof topMsgs = [];
    const seenIds = new Set(topMsgs.map((m) => m.id));
    for (const tid of threadsWithReplies) {
      const opened = await openThreadPanel(page, tid);
      if (!opened) continue;
      await page.waitForTimeout(1500);
      const all = await extractMessages(page);
      for (const m of all) {
        if (seenIds.has(m.id)) continue;
        if (m.threadName !== tid) continue;
        seenIds.add(m.id);
        replyMsgs.push(m);
      }
    }

    const allMsgs = [...topMsgs, ...replyMsgs];
    let msgs = allMsgs;
    if (MENTION_FILTER) {
      // 멘션은 스레드 톱 메시지에만 들어간다. 톱(=스레드 내 최초 메시지)이 멘션을 포함하면 그 스레드 전체 통과.
      const topByThread = new Map<string, string>();
      for (const m of allMsgs) {
        const key = m.threadName ?? m.id;
        const cur = topByThread.get(key);
        if (!cur || m.createTime < cur) topByThread.set(key, m.createTime);
      }
      const passThreads = new Set<string>();
      for (const m of allMsgs) {
        const key = m.threadName ?? m.id;
        if (m.createTime === topByThread.get(key) && m.text.includes(MENTION_FILTER)) {
          passThreads.add(key);
        }
      }
      msgs = allMsgs.filter((m) => passThreads.has(m.threadName ?? m.id));
    }
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
