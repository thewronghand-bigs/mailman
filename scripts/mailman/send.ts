import { readFileSync } from "node:fs";
import { getScriptDir, loadConfig, resolveSpace } from "./runtime";

const scriptDir = getScriptDir(import.meta.url);
const config = loadConfig(scriptDir);

const requestedSpaceKey = process.argv[2] ?? "";
const { spaceKey, space } = resolveSpace(config, requestedSpaceKey);
const webhookUrl = process.env.MAILMAN_WEBHOOK_URL || space.webhookUrl || "";

if (!webhookUrl) {
  console.error(
    `[mailman-send] webhookUrl 이 설정되지 않았습니다. config.json 의 spaces.${spaceKey}.webhookUrl 확인.`,
  );
  process.exit(2);
}

const message = readFileSync(0, "utf8");
if (!message.trim()) {
  console.error("[mailman-send] 빈 메시지는 전송하지 않습니다.");
  process.exit(1);
}

const response = await fetch(webhookUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=UTF-8",
  },
  body: JSON.stringify({ text: message }),
});

if (response.ok) {
  console.log(`[mailman-send] ✅ 전송 완료 (space=${spaceKey})`);
  process.exit(0);
}

const body = await response.text();
console.error(`[mailman-send] ❌ 전송 실패 (HTTP ${response.status})`);
if (body) {
  console.error(body);
}
process.exit(3);
