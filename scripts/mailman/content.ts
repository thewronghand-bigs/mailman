// 전송 태그. 보내는 에이전트를 밝히고, 밝히지 않으면 중립 라벨을 쓴다.
export type SendAgent = "claude" | "codex";
export const SEND_AGENT_LABELS: Record<SendAgent, string> = { claude: "Claude", codex: "Codex" };
export const NEUTRAL_SEND_LABEL = "AI";

export function isSendAgent(value: string): value is SendAgent {
  return Object.hasOwn(SEND_AGENT_LABELS, value);
}

export function sendPrefix(label: string): string {
  return `[🤖 ${label}] `;
}
