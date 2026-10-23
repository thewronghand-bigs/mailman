import { isRecord, MailmanError, RequestError, registerSecret } from "./errors";
import { chatError, requestJson, type Fetch } from "./http";
import { validateSpace, validateThread } from "./runtime";
import { normalizeTime } from "./time";

export type ChatAttachment = Record<string, unknown> & { contentName?: string; contentType?: string; name?: string };
export type ChatMessage = Record<string, unknown> & {
  name: string;
  createTime: string;
  lastUpdateTime?: string;
  sender?: { name?: string; displayName?: string; type?: string };
  text?: string;
  thread?: { name?: string };
  attachment?: ChatAttachment[];
};
export type CreatedMessage = { name: string; thread: { name: string }; createTime?: string; sender?: ChatMessage["sender"] };
export type ChatSpace = { name: string; displayName: string; spaceType: string };
export const MAX_PAGES = 1000;

// 생성 이름을 받은 뒤의 부가 정보 오류는 전송 실패와 구분한다.
export class SentMessageError extends MailmanError {
  constructor(message: string, readonly created: CreatedMessage) { super(message, 3); }
}

export function parseSpace(value: unknown): ChatSpace {
  if (!isRecord(value) || typeof value.name !== "string" || !/^spaces\/[A-Za-z0-9_-]+$/.test(value.name) ||
      !optionalString(value, "displayName") || !optionalString(value, "spaceType")) {
    throw new MailmanError("Google Chat 스페이스 응답 형식이 올바르지 않습니다.", 3);
  }
  return { name: value.name, displayName: typeof value.displayName === "string" ? value.displayName : "",
    spaceType: typeof value.spaceType === "string" ? value.spaceType : "SPACE_TYPE_UNSPECIFIED" };
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function optionalFields(value: unknown, fields: string[]): boolean {
  return value === undefined || (isRecord(value) && fields.every(key => optionalString(value, key)));
}

export function parseMessage(value: unknown, space: string): ChatMessage {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.startsWith(`${space}/messages/`) ||
      typeof value.createTime !== "string" || !optionalString(value, "text") || !optionalString(value, "lastUpdateTime") ||
      !optionalFields(value.sender, ["name", "displayName", "type"]) ||
      !optionalFields(value.thread, ["name"]) ||
      (value.attachment !== undefined && (!Array.isArray(value.attachment) ||
        !value.attachment.every(item => isRecord(item) && optionalFields(item, ["contentName", "contentType", "name"]))))) {
    throw new MailmanError("Google Chat 메시지 응답 형식이 올바르지 않습니다.", 3);
  }
  normalizeTime(value.createTime);
  if (typeof value.lastUpdateTime === "string") normalizeTime(value.lastUpdateTime);
  return value as ChatMessage;
}

export class ChatClient {
  constructor(private accessToken: string, private readonly fetcher: Fetch = fetch, private readonly signal?: AbortSignal,
    private readonly refreshAccessToken?: (signal?: AbortSignal) => Promise<string>) {
    registerSecret(accessToken);
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const signal = this.signal && init.signal ? AbortSignal.any([this.signal, init.signal]) : this.signal ?? init.signal ?? undefined;
    for (let refreshed = false;;) {
      try {
        const { response, body } = await requestJson(this.fetcher, url, {
          ...init, signal,
          headers: { "Content-Type": "application/json; charset=UTF-8", Authorization: `Bearer ${this.accessToken}` },
        });
        if (!response.ok) throw chatError(response.status, body);
        return body;
      } catch (error: unknown) {
        // 읽기만 재시도한다. 전송 요청은 응답 유실 가능성 때문에 재시도하지 않는다.
        if (init.method !== "GET" || refreshed || !this.refreshAccessToken || !(error instanceof RequestError) || error.status !== 401) throw error;
        refreshed = true;
        this.accessToken = await this.refreshAccessToken(signal);
        registerSecret(this.accessToken);
      }
    }
  }

  async listSpaces(maxPages = MAX_PAGES): Promise<ChatSpace[]> {
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new MailmanError(`페이지 상한은 1~${MAX_PAGES} 사이의 정수여야 합니다.`);
    const spaces = new Map<string, ChatSpace>();
    const tokens = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      const url = new URL("https://chat.googleapis.com/v1/spaces");
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.request(url, { method: "GET" });
      if (!isRecord(body) || (body.spaces !== undefined && !Array.isArray(body.spaces)) || !optionalString(body, "nextPageToken")) {
        throw new MailmanError("Google Chat 스페이스 목록 응답 형식이 올바르지 않습니다.", 3);
      }
      for (const item of (body.spaces ?? []) as unknown[]) {
        const space = parseSpace(item);
        spaces.set(space.name, space);
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!pageToken) return [...spaces.values()];
      if (tokens.has(pageToken)) throw new MailmanError("Google Chat 스페이스 페이지 토큰이 반복되었습니다. 캐시는 갱신하지 않습니다.", 3);
      tokens.add(pageToken);
    }
    throw new MailmanError(`스페이스 목록 상한(${maxPages}페이지)에 도달했습니다. 캐시는 갱신하지 않습니다.`, 3);
  }

  async findDirectMessage(user: string, signal?: AbortSignal): Promise<ChatSpace> {
    const url = new URL("https://chat.googleapis.com/v1/spaces:findDirectMessage");
    url.searchParams.set("name", user);
    try {
      const space = parseSpace(await this.request(url, { method: "GET", signal }));
      return { ...space, spaceType: "DIRECT_MESSAGE" };
    } catch (error: unknown) {
      if (error instanceof MailmanError && error.message.startsWith("HTTP 404:")) {
        throw new MailmanError("아직 DM이 없습니다. Google Chat에서 먼저 대화를 시작하세요.");
      }
      throw error;
    }
  }

  async listMessages(space: string, after: string, maxPages = MAX_PAGES, signal?: AbortSignal): Promise<ChatMessage[]> {
    validateSpace(space);
    normalizeTime(after);
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) {
      throw new MailmanError(`페이지 상한은 1~${MAX_PAGES} 사이의 정수여야 합니다.`);
    }
    const messages: ChatMessage[] = [];
    const seenTokens = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
      url.searchParams.set("orderBy", "createTime asc");
      url.searchParams.set("filter", `createTime > "${after}"`);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await this.request(url, { method: "GET", signal });
      if (!isRecord(body) || (body.messages !== undefined && !Array.isArray(body.messages)) ||
          !optionalString(body, "nextPageToken")) {
        throw new MailmanError("Google Chat 목록 응답 형식이 올바르지 않습니다.", 3);
      }
      const items: unknown[] = Array.isArray(body.messages) ? body.messages : [];
      messages.push(...items.map(item => parseMessage(item, space)));
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : "";
      if (!pageToken) return messages;
      if (seenTokens.has(pageToken)) {
        throw new MailmanError("Google Chat 페이지 토큰이 반복되었습니다. 수집 기준은 갱신하지 않습니다.", 3);
      }
      seenTokens.add(pageToken);
    }
    throw new MailmanError(`수집 상한(${maxPages}페이지)에 도달했습니다. MAILMAN_BACKFILL_DAYS를 줄여 다시 시도하세요.`, 3);
  }

  async createMessage(space: string, body: { text: string; thread?: { name: string } }): Promise<CreatedMessage> {
    validateSpace(space);
    if (body.thread) validateThread(space, body.thread.name);
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    if (body.thread) url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    const result = await this.request(url, { method: "POST", body: JSON.stringify(body) });
    if (!isRecord(result) || typeof result.name !== "string" || !result.name.startsWith(`${space}/messages/`) ||
        !isRecord(result.thread) || typeof result.thread.name !== "string" || !result.thread.name.startsWith(`${space}/threads/`)) {
      throw new MailmanError("전송 응답에서 message/thread 이름을 확인할 수 없습니다. 중복 전송을 피하려면 Chat에서 먼저 확인하세요.", 3);
    }
    if ((result.createTime !== undefined && typeof result.createTime !== "string") || !optionalFields(result.sender, ["name", "displayName", "type"])) {
      throw new SentMessageError("전송 응답의 시각/발신자 형식이 올바르지 않아 대기를 준비할 수 없습니다.", { name: result.name, thread: { name: result.thread.name } });
    }
    if (typeof result.createTime === "string") {
      try { normalizeTime(result.createTime); }
      catch { throw new SentMessageError("전송 응답의 createTime이 RFC3339 형식이 아니어서 대기를 준비할 수 없습니다.", { name: result.name, thread: { name: result.thread.name } }); }
    }
    return { name: result.name, thread: { name: result.thread.name },
      ...(typeof result.createTime === "string" ? { createTime: result.createTime } : {}),
      ...(isRecord(result.sender) ? { sender: result.sender as ChatMessage["sender"] } : {}) };
  }
}
