import { isRecord, MailmanError, redact } from "./errors";

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function requestJson(fetcher: Fetch, url: URL | string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new MailmanError("네트워크 요청에 실패했습니다 (연결 오류 또는 30초 시간 초과).", 3);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MailmanError(`HTTP ${response.status}: JSON 응답을 읽을 수 없습니다.`, 3);
  }
  return { response, body };
}

export function chatError(status: number, body: unknown): MailmanError {
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
    ? body.error.message : "Google Chat 요청에 실패했습니다.";
  // 한 줄만 출력한다. 응답 전체나 요청 헤더/본문은 출력하지 않는다.
  return new MailmanError(`HTTP ${status}: ${redact(message).replace(/[\r\n\x00-\x1f\x7f]+/g, " ")}`, 3);
}
