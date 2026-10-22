export const SEND_TAG = "🤖 Claude";
export const SEND_PREFIX = `[${SEND_TAG}] `;

export function isMailmanMessage(text: string): boolean {
  return text.startsWith(`[${SEND_TAG}]`);
}

export function matchesDefaultFilter(senderType: string | null, text: string): boolean {
  if (isMailmanMessage(text)) return false;
  return senderType === "BOT" || (senderType === "HUMAN" && /^@mailman\b/i.test(text));
}

export function displayText(senderType: string | null, text: string): string {
  return (senderType === "HUMAN" ? text.replace(/^@mailman\b[:\s]*/i, "") : text).trim();
}
