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

export function parseSince(value: string, now = new Date()): string {
  const invalid = () => new MailmanError("--since는 24h, 3d 같은 양의 정수 기간 또는 YYYY-MM-DD 날짜로 지정하세요.");
  const relative = /^([1-9]\d*)(h|d)$/.exec(value);
  let date: Date;
  if (relative) {
    const duration = Number(relative[1]) * (relative[2] === "h" ? 3_600_000 : 86_400_000);
    if (!Number.isSafeInteger(duration)) throw invalid();
    date = new Date(now.getTime() - duration);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // 시간대 접미사가 없는 날짜/시각은 실행 환경의 로컬 자정으로 해석한다.
    date = new Date(`${value}T00:00:00`);
    const [year, month, day] = value.split("-").map(Number);
    if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) throw invalid();
  } else throw invalid();
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) throw invalid();
  return normalizeTime(date.toISOString());
}
