// 외부 응답이나 예외에 섞인 인증정보가 터미널/로그로 나가지 않도록 한다.
const secrets = new Set<string>();

export class MailmanError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
    this.name = "MailmanError";
  }
}

export function registerSecret(value: string): void {
  if (value) secrets.add(value);
}

export function redact(text: string): string {
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    for (const variant of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
      result = result.split(variant).join("[비공개]");
    }
  }
  return result
    .replace(/https:\/\/chat\.googleapis\.com\/[^\s"'<>]*[?][^\s"'<>]*/gi, "[웹훅 비공개]")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [비공개]");
}

export function errorMessage(error: unknown): string {
  // 원본 예외는 요청 헤더/본문이나 JSON 파일 내용을 포함할 수 있다.
  return error instanceof MailmanError
    ? redact(error.message)
    : "처리 중 오류가 발생했습니다. 설정 파일 형식과 데이터 경로 권한을 확인하세요.";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
