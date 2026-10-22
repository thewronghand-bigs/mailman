import { isRecord, MailmanError, registerSecret } from "./errors";
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
export type CreatedMessage = { name: string; thread: { name: string } };
export const MAX_PAGES = 1000;

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
  constructor(private readonly accessToken: string, private readonly fetcher: Fetch = fetch) {
    registerSecret(accessToken);
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    const { response, body } = await requestJson(this.fetcher, url, {
      ...init,
      headers: { "Content-Type": "application/json; charset=UTF-8", Authorization: `Bearer ${this.accessToken}` },
    });
    if (!response.ok) throw chatError(response.status, body);
    return body;
  }

  async listMessages(space: string, after: string, maxPages = MAX_PAGES): Promise<ChatMessage[]> {
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
      const body = await this.request(url, { method: "GET" });
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
    return { name: result.name, thread: { name: result.thread.name } };
  }
}
