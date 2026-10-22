import { MailmanError } from "./errors";

// Google 타임스탬프의 나노초를 보존한다. 고정 길이 UTC 문자열이라 SQLite에서도 시간순 정렬된다.
export function normalizeTime(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const millis = match ? Date.parse(`${match[1]}${match[3]}`) : NaN;
  if (!match || !Number.isFinite(millis)) {
    throw new MailmanError("메시지 또는 수집 기준 시각이 RFC3339 형식이 아닙니다.", 3);
  }
  return `${new Date(millis).toISOString().slice(0, 19)}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}
