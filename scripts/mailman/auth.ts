// claude-mailman: 최초 로그인 세션 셋업
// Chat API 경로가 막혀서, 개인 Chrome 프로필을 재사용하는 방식으로 전환됐다.
// 이 스크립트는 headful Playwright로 chat.google.com을 띄워서
// 사용자가 직접 회사 Google 계정으로 로그인하게 한다.
// 로그인 세션(쿠키)은 PROFILE_DIR에 저장되고, 이후 collector가 같은 프로필을 재사용한다.

import { chromium } from "playwright";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const config = JSON.parse(readFileSync(`${SCRIPT_DIR}/config.json`, "utf8"));

const PROFILE_DIR = `${homedir()}/.claude/state/mailman-chrome`;
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SPACE_URL: string = config.spaceUrl;
const SPACE_NAME: string = config.spaceName;

mkdirSync(PROFILE_DIR, { recursive: true });

console.error(`프로필 경로: ${PROFILE_DIR}`);
console.error(`Chrome을 띄웁니다. 회사 Google 계정으로 로그인 후, '${SPACE_NAME}' 대화가 보이는 상태까지 진행해주세요.`);
console.error("로그인이 끝났으면 이 터미널로 돌아와 Enter를 누르세요.");

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  executablePath: CHROME_PATH,
  viewport: { width: 1280, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(SPACE_URL, { waitUntil: "domcontentloaded" });

// Enter 대기
process.stdin.setRawMode?.(false);
process.stdin.resume();
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
});

await context.close();
console.error("✅ 세션 저장 완료. 이제 /mailman 슬래시 커맨드를 쓰세요.");
