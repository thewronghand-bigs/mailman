import { isRecord, MailmanError, RequestError, redact, throwIfAborted } from "./errors";

export type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function requestResponse(fetcher: Fetch, url: URL | string, init: RequestInit): Promise<Response> {
  try {
    throwIfAborted(init.signal ?? undefined);
    const timeout = AbortSignal.timeout(30_000);
    return await fetcher(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  } catch {
    throwIfAborted(init.signal ?? undefined);
    throw new RequestError("네트워크 요청에 실패했습니다 (연결 오류 또는 30초 시간 초과).");
  }
}

export async function requestJson(fetcher: Fetch, url: URL | string, init: RequestInit): Promise<{ response: Response; body: unknown }> {
  const response = await requestResponse(fetcher, url, init);
  return readJson(response, init.signal ?? undefined);
}

async function readJson(response: Response, signal?: AbortSignal): Promise<{ response: Response; body: unknown }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throwIfAborted(signal);
    throw new RequestError(`HTTP ${response.status}: JSON 응답을 읽을 수 없습니다.`, response.status);
  }
  return { response, body };
}

export function attachmentSizeError(maxBytes: number): MailmanError {
  const limit = maxBytes >= 1024 * 1024 && maxBytes % (1024 * 1024) === 0 ? `${maxBytes / (1024 * 1024)}MB`
    : maxBytes >= 1024 && maxBytes % 1024 === 0 ? `${maxBytes / 1024}KB` : `${maxBytes} bytes`;
  return new MailmanError(`첨부 크기 상한(${limit})을 초과했습니다.`);
}

function validateMediaUrl(url: URL): void {
  if (url.protocol !== "https:" || url.username || url.password ||
      ![".googleapis.com", ".googleusercontent.com", ".google.com"].some(suffix => url.hostname.endsWith(suffix))) {
    throw new RequestError("첨부 다운로드는 허용된 Google HTTPS 호스트만 사용할 수 있습니다.");
  }
}

async function mediaResponse(fetcher: Fetch, url: URL, init: RequestInit): Promise<Response> {
  let current = url;
  let headers = new Headers(init.headers);
  for (let redirects = 0;; redirects++) {
    validateMediaUrl(current);
    throwIfAborted(init.signal ?? undefined);
    const response = await fetcher(current, { ...init, headers, redirect: "manual", credentials: "omit" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    void response.body?.cancel().catch(() => {});
    if (redirects >= 5) throw new RequestError("첨부 다운로드 리다이렉트가 최대 5회를 초과했습니다.");
    const location = response.headers.get("Location");
    let next: URL;
    try {
      if (!location) throw new Error();
      next = new URL(location, current);
    } catch { throw new RequestError("첨부 다운로드 리다이렉트 주소가 올바르지 않습니다."); }
    // 허용 범위 밖에는 요청 자체를 하지 않는다. Google 간 이동도 인증 헤더를 전달하지 않는다.
    validateMediaUrl(next);
    headers = new Headers(headers);
    if (next.origin !== current.origin) headers.delete("Authorization");
    current = next;
  }
}

// 타이머를 주입해 실제 대기 없이 유휴 시간과 전체 상한을 검증한다.
export type TimeoutScheduler = (callback: () => void, milliseconds: number) => () => void;
const scheduleTimeout: TimeoutScheduler = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

// fetch가 본문을 요구할 때만 진행으로 센다. 선행 버퍼링이나 빈 chunk는 유휴 시간을 늘리지 않는다.
// 본문 전송부터 응답 JSON 읽기까지 같은 제한을 유지하고 POST는 재시도하지 않는다.
export async function requestUploadJson(fetcher: Fetch, url: URL, init: RequestInit & { body: ReadableStream<Uint8Array> },
  schedule: TimeoutScheduler = scheduleTimeout): Promise<{ response: Response; body: unknown }> {
  const reader = init.body.getReader();
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const cancelTotal = schedule(() => controller.abort(new RequestError("첨부 업로드 전체 상한(30분)을 초과했습니다.")), 30 * 60_000);
  let cancelIdle = () => {};
  const resetIdle = () => {
    cancelIdle();
    cancelIdle = schedule(() => controller.abort(new RequestError("첨부 업로드가 60초 동안 전송 진척이 없어 중단했습니다.")), 60_000);
  };
  resetIdle();
  let streamError: unknown;
  const body = new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
        if (done) { target.close(); return; }
        if (value.byteLength > 0) resetIdle();
        target.enqueue(value);
      } catch (error: unknown) {
        // fetch가 스트림 예외를 일반 연결 오류로 감싸더라도 로컬 파일 오류를 보존한다.
        streamError = error;
        throw error;
      }
    },
    cancel(reason: unknown) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const response = await fetcher(url, { ...init, body, redirect: "error", signal });
    throwIfAborted(signal);
    if (streamError instanceof MailmanError) throw streamError;
    const result = await readJson(response, signal);
    throwIfAborted(signal);
    return result;
  } catch (error: unknown) {
    throwIfAborted(init.signal ?? undefined);
    if (streamError instanceof MailmanError) throw streamError;
    throwIfAborted(signal);
    if (error instanceof MailmanError) throw error;
    throw new RequestError("첨부 업로드 요청에 실패했습니다 (연결 오류).");
  } finally {
    cancelIdle();
    cancelTotal();
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// 바이트가 도착할 때만 유휴 타이머를 갱신한다. 리다이렉트·응답 헤더 대기도 전체 상한에 포함한다.
export async function requestBytes(fetcher: Fetch, url: URL, init: RequestInit, maxBytes: number,
  schedule: TimeoutScheduler = scheduleTimeout): Promise<Buffer> {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  const cancelTotal = schedule(() => controller.abort(new RequestError("첨부 수신 전체 상한(10분)을 초과했습니다.")), 10 * 60_000);
  let cancelIdle = () => {};
  const resetIdle = () => {
    cancelIdle();
    cancelIdle = schedule(() => controller.abort(new RequestError("첨부 수신이 30초 동안 없어 중단했습니다.")), 30_000);
  };
  resetIdle();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const onAbort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfAborted(signal);
    const response = await mediaResponse(fetcher, url, { ...init, signal });
    reader = response.body?.getReader();
    throwIfAborted(signal);
    if (response.status === 403) {
      throw new RequestError("HTTP 403: 권한 부족 — 필요한 스코프를 확인한 뒤 mailman auth를 다시 실행하세요. 추가 스코프는 자동 요청하지 않습니다.", 403);
    }
    const length = response.headers.get("Content-Length");
    if (response.ok && length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) throw attachmentSizeError(maxBytes);
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      if (!reader) break;
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value.byteLength > 0) resetIdle();
      size += value.byteLength;
      if (response.ok ? size > maxBytes : size > 64 * 1024) {
        throw response.ok ? attachmentSizeError(maxBytes) : chatError(response.status, undefined);
      }
      chunks.push(Buffer.from(value));
    }
    const content = Buffer.concat(chunks, size);
    if (!response.ok) {
      let body: unknown;
      try { body = JSON.parse(content.toString("utf8")); } catch { /* 비JSON 오류 본문은 출력하지 않는다. */ }
      throw chatError(response.status, body);
    }
    return content;
  } catch (error: unknown) {
    throwIfAborted(init.signal ?? undefined);
    throwIfAborted(signal);
    if (error instanceof MailmanError) throw error;
    throw new RequestError("첨부 내용을 수신할 수 없습니다 (연결 오류 또는 시간 초과).");
  } finally {
    cancelIdle();
    cancelTotal();
    signal.removeEventListener("abort", onAbort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

export function chatError(status: number, body: unknown): MailmanError {
  const message = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
    ? body.error.message : "Google Chat 요청에 실패했습니다.";
  // 한 줄만 출력한다. 응답 전체나 요청 헤더/본문은 출력하지 않는다.
  const apiStatus = isRecord(body) && isRecord(body.error) && typeof body.error.status === "string" ? body.error.status : undefined;
  // SERVICE_DISABLED 같은 구조화된 원인은 진단에만 사용하고 응답 상세는 출력하지 않는다.
  const details: unknown[] = isRecord(body) && isRecord(body.error) && Array.isArray(body.error.details) ? body.error.details : [];
  const reasons = details.filter(isRecord).map(detail => detail.reason).filter((reason): reason is string => typeof reason === "string");
  return new RequestError(`HTTP ${status}: ${redact(message).replace(/[\r\n\x00-\x1f\x7f]+/g, " ")}`, status, apiStatus, reasons);
}
