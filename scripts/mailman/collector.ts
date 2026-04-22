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
import { homedir } from "node:os";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(readFileSync(`${SCRIPT_DIR}/config.json`, "utf8"));

const PROFILE_DIR = `${homedir()}/.claude/state/mailman-chrome`;
const DB_PATH = `${homedir()}/.claude/inbox/mailman.db`;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HEADLESS = process.env.MAILMAN_HEADLESS === "1";
const DEBUG = process.env.MAILMAN_DEBUG === "1";

// 스페이스 결정: CLI 인자 > defaultSpace
const spaces: Record<string, { url: string; bots: Record<string, string>; defaultBot: string; webhookUrl: string }> = config.spaces ?? {};
const spaceArg = process.argv[2] ?? "";
const spaceKey = spaces[spaceArg] ? spaceArg : config.defaultSpace ?? Object.keys(spaces)[0] ?? "";
const space = spaces[spaceKey];

if (!space) {
  console.error(`[mailman] 스페이스를 찾을 수 없습니다: "${spaceArg || "(기본)"}". config.json의 spaces를 확인하세요.`);
  process.exit(1);
}

const SPACE_URL = space.url;
const bots = space.bots ?? {};
const defaultBotAlias = space.defaultBot ?? Object.keys(bots)[0] ?? "";
const BOT_NAME = bots[defaultBotAlias] || "";

mkdirSync(dirname(DB_PATH), { recursive: true });

if (!existsSync(PROFILE_DIR)) {
  console.error(
    `[mailman] 프로필이 없습니다. 먼저 'bun run auth.ts' 로 로그인하세요. (path=${PROFILE_DIR})`,
  );
  process.exit(2);
}

// DB 준비 (space 컬럼 추가)
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

// 답장 확장: 각 봇 top-level 메시지에 "N reply/replies" 버튼이 있으면 모두 클릭해서 인라인 확장.
async function expandAllThreads(page: Page): Promise<number> {
  return await page.evaluate(async (botName: string) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>(
        "div[role='button'][jsaction*='QQNHUe']",
      ),
    );
    const botButtons = botName
      ? buttons.filter((btn) => {
          let g: HTMLElement | null = btn;
          while (g && g.getAttribute("role") !== "group") {
            g = g.parentElement;
          }
          if (!g) return false;
          const h = g.querySelector<HTMLElement>("[data-message-id][role='heading']");
          return !!h && (h.innerText ?? "").includes(botName);
        })
      : buttons; // 봇 이름이 없으면 모든 스레드 확장

    for (const btn of botButtons) {
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    return botButtons.length;
  }, BOT_NAME);
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

  const expanded = await expandAllThreads(page);
  if (DEBUG) console.error(`[mailman] expanded ${expanded} thread(s)`);
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
      spaceKey,
      now,
      JSON.stringify({ source: "dom-scrape", space: spaceKey, ...m }),
    );
    if (r.changes > 0) inserted++;
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('lastSync', ?)").run(now);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`lastSync:${spaceKey}`, now);
} finally {
  await context.close().catch(() => {});
}

console.error(`[mailman] space="${spaceKey}" scanned=${scanned} inserted=${inserted} bot="${BOT_NAME}" url=${SPACE_URL}`);
