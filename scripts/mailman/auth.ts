// claude-mailman: 최초 로그인 세션 셋업
// Chat API 경로가 막혀서, 개인 Chrome 프로필을 재사용하는 방식으로 전환됐다.
// 이 스크립트는 headful Playwright로 chat.google.com을 띄워서
// 사용자가 직접 회사 Google 계정으로 로그인하게 한다.
// 로그인 세션(쿠키)은 PROFILE_DIR에 저장되고, 이후 collector가 같은 프로필을 재사용한다.

import { chromium } from "playwright";
import {
  ensureRuntimeDirs,
  getRuntimePaths,
  loadConfig,
  resolveChromePath,
  resolveSpace,
} from "./runtime";

const paths = getRuntimePaths(import.meta.url);
const config = loadConfig(paths.scriptDir);
const { spaceKey, space } = resolveSpace(config, process.argv[2]);
const chromePath = resolveChromePath();

ensureRuntimeDirs(paths);

console.error(`프로필 경로: ${paths.profileDir}`);
console.error(`Chrome을 띄웁니다. 회사 Google 계정으로 로그인 후, '${spaceKey}' 대화가 보이는 상태까지 진행해주세요.`);
console.error("로그인이 끝났으면 이 터미널로 돌아와 Enter를 누르세요.");

const context = await chromium.launchPersistentContext(paths.profileDir, {
  headless: false,
  executablePath: chromePath,
  viewport: { width: 1280, height: 900 },
  args: ["--no-first-run", "--no-default-browser-check"],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(space.url, { waitUntil: "domcontentloaded" });

// Enter 대기
process.stdin.setRawMode?.(false);
process.stdin.resume();
await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
});

await context.close();
console.error("✅ 세션 저장 완료.");
