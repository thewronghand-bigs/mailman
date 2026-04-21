// claude-mailman: on-demand 수집기
// - auth.ts로 저장된 persistent Chrome 프로필을 재사용해
//   chat.google.com 의 MONIFY / TN 그룹 DM에서 "API 스펙 Bot" 메시지를 긁어온다.
// - DB 스키마는 이전 Chat API 버전과 동일하게 유지 → fetch.ts는 손댈 필요 없음.
//
// 환경변수:
//   MAILMAN_SPACE_URL   (optional) 대상 space URL override. 기본 MONIFY/TN 고정.
//   MAILMAN_BOT_NAME    (optional) 봇 표시 이름. 기본 "API 스펙 Bot"
//   MAILMAN_HEADLESS    (optional) "1"이면 headless. 기본 headful(안정성 ↑)
//   MAILMAN_DEBUG       (optional) "1"이면 selector 디버깅 로그

import { chromium, type Page } from "playwright";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(readFileSync(`${SCRIPT_DIR}/config.json`, "utf8"));

const PROFILE_DIR = `${homedir()}/.claude/state/mailman-chrome`;
const DB_PATH = `${homedir()}/.claude/inbox/mailman.db`;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SPACE_URL = process.env.MAILMAN_SPACE_URL ?? config.spaceUrl;

// 봇 이름 결정: 환경변수 > CLI 인자(별칭) > defaultBot
const bots: Record<string, string> = config.bots ?? {};
const defaultBotAlias: string = config.defaultBot ?? Object.keys(bots)[0] ?? "";
const botArg = process.argv[2] ?? "";
const resolvedFromArg = botArg && bots[botArg] ? bots[botArg] : "";
const BOT_NAME = process.env.MAILMAN_BOT_NAME
  ?? (resolvedFromArg || bots[defaultBotAlias] || config.botName || "");
const HEADLESS = process.env.MAILMAN_HEADLESS === "1";
const DEBUG = process.env.MAILMAN_DEBUG === "1";

mkdirSync(dirname(DB_PATH), { recursive: true });

if (!existsSync(PROFILE_DIR)) {
  console.error(
    `[mailman] 프로필이 없습니다. 먼저 'bun run auth.ts' 로 로그인하세요. (path=${PROFILE_DIR})`,
  );
  process.exit(2);
}

// DB 준비 (기존 스키마 그대로)
const db = new Database(DB_PATH, { create: true });
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
    fetched_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_createTime ON messages(createTime DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_display_name ON messages(sender_display_name);
  CREATE INDEX IF NOT EXISTS idx_messages_sender_name ON messages(sender_name);

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO messages
  (id, createTime, sender_name, sender_display_name, sender_type, text, thread_name, fetched_at, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// 답장 확장: 각 봇 top-level 메시지에 "N reply/replies" 버튼이 있으면 모두 클릭해서 인라인 확장.
// 뷰 전환은 없고 같은 페이지에 답장 노드가 추가된다.
// jsaction="click:QQNHUe" 가 확장 버튼의 안정적 식별자.
async function expandAllThreads(page: Page): Promise<number> {
  return await page.evaluate(async (botName: string) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(
        "div[role='button'][jsaction*='QQNHUe']",
      ),
    );
    // 봇 메시지가 포함된 그룹 안의 버튼만 클릭
    const botButtons = buttons.filter((btn) => {
      // 버튼의 조상 role='group' 을 찾고, 그 안의 heading 이 봇인지 확인
      let g: HTMLElement | null = btn;
      while (g && g.getAttribute("role") !== "group") {
        g = g.parentElement;
      }
      if (!g) return false;
      const h = g.querySelector<HTMLElement>("[data-message-id][role='heading']");
      return !!h && (h.innerText ?? "").includes(botName);
    });

    for (const btn of botButtons) {
      btn.click();
      // 각 클릭 후 DOM 안정화를 위해 짧게 대기
      await new Promise((r) => setTimeout(r, 300));
    }
    return botButtons.length;
  }, botName);
}

// 추출 로직 (2026-04 chat.google.com 기준 실측):
//  - 메시지 컨테이너: div[role='group'].nF6pT (leaf — 내부에 또 다른 role='group' 이 없는 것)
//  - 안정 ID: 내부 [data-message-id][role='heading'] 의 data-message-id
//  - 스레드 그룹핑: 가장 가까운 조상 c-wiz[data-topic-id] 의 data-topic-id → thread_name 에 저장
//  - 시간: 내부 [data-absolute-timestamp] (Unix ms)
//  - 봇 필터: heading innerText 가 botName 포함
//  - 중복 제거: 같은 messageId 가 복수 occurrence 로 나타날 수 있음 (스레드 프리뷰 중복)
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
    // leaf group = 자손에 또 다른 role='group' 이 없는 것
    const leafGroups = allGroups.filter(
      (g) => g.querySelectorAll("div[role='group']").length === 0,
    );

    const seen = new Set<string>();

    for (const g of leafGroups) {
      const heading = g.querySelector<HTMLElement>(
        "[data-message-id][role='heading']",
      );
      if (!heading) continue;
      const headingText = heading.innerText ?? "";
      if (!headingText.includes(botName)) continue;

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

      // 본문 정리 (기존 로직 유지)
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

      const isNoiseLine = (raw: string): boolean => {
        const line = raw.trim();
        if (line === "") return true;
        if (line === ",") return true;
        if (line === "App") return true;
        if (line === botName) return true;
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
        senderDisplayName: botName,
        text,
      });
    }

    return results;
  }, botName);
}

async function ensureLoaded(page: Page): Promise<boolean> {
  // 로그인 페이지로 리다이렉트 되는지 체크
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const url = page.url();
  if (url.includes("accounts.google.com") || url.includes("signin")) {
    return false;
  }
  // 메시지 렌더링 대기: c-wiz[data-topic-id] 가 나타날 때까지
  try {
    await page.waitForSelector("c-wiz[data-topic-id]", { timeout: 15000 });
  } catch {
    if (DEBUG) console.error("[mailman] c-wiz[data-topic-id] 미검출. 진행은 함.");
  }
  // 초기 로드 후 스크롤/렌더 여유
  await page.waitForTimeout(1500);
  return true;
}

const botName = BOT_NAME;

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: HEADLESS,
  executablePath: CHROME_PATH,
  viewport: { width: 1280, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

let inserted = 0;
let scanned = 0;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SPACE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  const ok = await ensureLoaded(page);
  if (!ok) {
    console.error("[mailman] 로그인 세션이 만료되었습니다. 'bun run auth.ts' 를 다시 실행하세요.");
    process.exit(3);
  }

  // 1차 수집 전에 스레드 전부 펼치기
  const expanded = await expandAllThreads(page);
  if (DEBUG) console.error(`[mailman] expanded ${expanded} thread(s)`);
  // 확장된 답장 DOM 안정화 대기
  if (expanded > 0) {
    await page.waitForTimeout(800);
  }

  const msgs = await extractMessages(page);
  scanned = msgs.length;
  const now = new Date().toISOString();

  for (const m of msgs) {
    const r = insertStmt.run(
      m.id,
      m.createTime,
      null,
      m.senderDisplayName,
      "BOT",
      m.text,
      m.threadName,
      now,
      JSON.stringify({ source: "dom-scrape", ...m }),
    );
    if (r.changes > 0) inserted++;
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSync', ?)").run(now);
} finally {
  await context.close().catch(() => {});
}

console.error(`[mailman] scanned=${scanned} inserted=${inserted} bot="${botName}" space=${SPACE_URL}`);
