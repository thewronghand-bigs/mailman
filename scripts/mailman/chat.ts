import { errorMessage, isRecord, MailmanError, RequestError, registerSecret } from "./errors";
import { chatError, requestBytes, requestJson, requestUploadJson, type Fetch, type TimeoutScheduler } from "./http";
import { parseMessageName, validateSpace, validateThread } from "./runtime";
import { parseEmoji, type ReactionEmoji } from "./react";
import { normalizeTime } from "./time";
import { multipartUpload, type UploadFile } from "./upload";

export type AttachmentDataRef = { resourceName?: string; attachmentUploadToken?: string };
export type UploadedAttachment = { attachmentDataRef: AttachmentDataRef };
export type MessageBody = { text?: string; thread?: { name: string }; attachment?: UploadedAttachment[] };
export type ChatAttachment = Record<string, unknown> & {
  contentName?: string; contentType?: string; name?: string;
  attachmentDataRef?: AttachmentDataRef;
  driveDataRef?: { driveFileId?: string };
};
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
export type DirectoryPerson = { userName: string; displayName: string; email: string | null };
export const MAX_PAGES = 1000;
export const MAX_SPACE_MEMBERS = 20;

// People API 오류 원문은 분류에만 쓰고 고정 안내만 출력한다.
export function directoryErrorMessage(error: unknown): string {
  if (error instanceof RequestError) {
    const hint = `${error.apiStatus ?? ""} ${error.apiReasons.join(" ")} ${error.message}`;
    if (error.status === 403) {
      if (/SERVICE_DISABLED|accessNotConfigured|has not been used|API.*disabled|People API 사용 설정/i.test(hint)) {
        return "HTTP 403: People API 사용 설정이 필요합니다. OAuth 클라이언트 프로젝트에서 People API를 사용 설정하세요.";
      }
      if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient.*scope|insufficientPermissions|스코프가 없습니다/i.test(hint)) {
        return "HTTP 403: 디렉터리 검색 스코프가 없습니다. directory.readonly 권한을 추가하고 mailman auth를 다시 실행하세요.";
      }
      return "HTTP 403: 디렉터리 검색 권한이 부족합니다. directory.readonly 권한과 관리자의 디렉터리 공유 정책을 확인하고 mailman auth를 다시 실행하세요.";
    }
    if (error.status === 401) return "HTTP 401: 디렉터리 검색 인증이 거부되었습니다. mailman auth를 다시 실행하세요.";
    if (error.status === undefined) return "People API 네트워크 연결 실패 — 인터넷·프록시·방화벽을 확인하세요.";
  }
  return "People API 점검에 실패했습니다. API 사용 설정과 디렉터리 공유 정책을 확인하세요.";
}

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

function parseDirectoryPerson(value: unknown): DirectoryPerson {
  if (!isRecord(value) || typeof value.resourceName !== "string" || !/^people\/\d+$/.test(value.resourceName) ||
      !Array.isArray(value.names) || !value.names.length || !value.names.every(name => isRecord(name) && typeof name.displayName === "string") ||
      (value.emailAddresses !== undefined && (!Array.isArray(value.emailAddresses) ||
        !value.emailAddresses.every(email => isRecord(email) && typeof email.value === "string")))) {
    throw new MailmanError("People API 사람 응답 형식이 올바르지 않습니다.", 3);
  }
  const primary = (items: Record<string, unknown>[]) => items.find(item => isRecord(item.metadata) && item.metadata.primary === true) ?? items[0]!;
  const name = primary(value.names as Record<string, unknown>[]);
  const emails = (value.emailAddresses ?? []) as Record<string, unknown>[];
  return { userName: value.resourceName.replace(/^people\//, "users/"), displayName: name.displayName as string,
    email: emails.length ? primary(emails).value as string : null };
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
        !value.attachment.every(item => isRecord(item) && optionalFields(item, ["contentName", "contentType", "name"]) &&
          optionalFields(item.attachmentDataRef, ["resourceName"]) && optionalFields(item.driveDataRef, ["driveFileId"]))))) {
    throw new MailmanError("Google Chat 메시지 응답 형식이 올바르지 않습니다.", 3);
  }
  normalizeTime(value.createTime);
  if (typeof value.lastUpdateTime === "string") normalizeTime(value.lastUpdateTime);
  return value as ChatMessage;
}

export class ChatClient {
  constructor(private accessToken: string, private readonly fetcher: Fetch = fetch, private readonly signal?: AbortSignal,
    private readonly refreshAccessToken?: (signal?: AbortSignal) => Promise<string>, private readonly timeoutScheduler?: TimeoutScheduler) {
    registerSecret(accessToken);
  }

  private async authorized<T>(init: RequestInit, request: (init: RequestInit) => Promise<T>): Promise<T> {
    const signal = this.signal && init.signal ? AbortSignal.any([this.signal, init.signal]) : this.signal ?? init.signal ?? undefined;
    for (let refreshed = false;;) {
      try {
        const headers = new Headers(init.headers);
        if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json; charset=UTF-8");
        headers.set("Authorization", `Bearer ${this.accessToken}`);
        return await request({
          ...init, signal,
          headers,
        });
      } catch (error: unknown) {
        // 읽기만 재시도한다. 전송 요청은 응답 유실 가능성 때문에 재시도하지 않는다.
        if (init.method !== "GET" || refreshed || !this.refreshAccessToken || !(error instanceof RequestError) || error.status !== 401) throw error;
        refreshed = true;
        this.accessToken = await this.refreshAccessToken(signal);
        registerSecret(this.accessToken);
      }
    }
  }

  private async request(url: URL, init: RequestInit): Promise<unknown> {
    return this.authorized(init, async authorized => {
      const { response, body } = await requestJson(this.fetcher, url, authorized);
      if (!response.ok) throw chatError(response.status, body);
      return body;
    });
  }

  async getMessage(name: string): Promise<ChatMessage> {
    const { space } = parseMessageName(name);
    const message = parseMessage(await this.request(new URL(`https://chat.googleapis.com/v1/${name}`), { method: "GET" }), space);
    if (message.name !== name) throw new MailmanError("Google Chat 메시지 응답의 name이 요청과 다릅니다.", 3);
    return message;
  }

  async downloadMedia(resourceName: string, maxBytes: number): Promise<Buffer> {
    const parts = resourceName.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || /[\p{Cc}\p{Cf}]/u.test(part))) {
      throw new MailmanError("첨부 다운로드 참조 형식이 올바르지 않습니다.", 3);
    }
    const url = new URL(`https://chat.googleapis.com/v1/media/${parts.map(encodeURIComponent).join("/")}`);
    url.searchParams.set("alt", "media");
    return this.authorized({ method: "GET" }, init => requestBytes(this.fetcher, url, init, maxBytes, this.timeoutScheduler));
  }

  async uploadAttachment(space: string, file: UploadFile): Promise<UploadedAttachment> {
    validateSpace(space);
    const upload = multipartUpload(file);
    const url = new URL(`https://chat.googleapis.com/upload/v1/${space}/attachments:upload`);
    url.searchParams.set("uploadType", "multipart");
    try {
      const result = await this.authorized({ method: "POST", ...upload }, async init => {
        const { response, body } = await requestUploadJson(this.fetcher, url, { ...init, body: upload.body }, this.timeoutScheduler);
        if (!response.ok) throw chatError(response.status, body);
        return body;
      });
      if (!isRecord(result) || !isRecord(result.attachmentDataRef) ||
          !optionalFields(result.attachmentDataRef, ["resourceName", "attachmentUploadToken"]) ||
          !(result.attachmentDataRef.resourceName || result.attachmentDataRef.attachmentUploadToken)) {
        throw new MailmanError("첨부 업로드 응답의 attachmentDataRef를 확인할 수 없습니다.", 3);
      }
      const ref = result.attachmentDataRef;
      if (typeof ref.attachmentUploadToken === "string") registerSecret(ref.attachmentUploadToken);
      return { attachmentDataRef: {
        ...(typeof ref.resourceName === "string" ? { resourceName: ref.resourceName } : {}),
        ...(typeof ref.attachmentUploadToken === "string" ? { attachmentUploadToken: ref.attachmentUploadToken } : {}),
      } };
    } catch (error: unknown) {
      if (error instanceof RequestError && error.status === 403) {
        throw new RequestError("HTTP 403: 첨부 업로드 권한 부족 — 기존 chat.messages.create 권한을 확인하고 mailman auth를 다시 실행하세요. 추가 스코프는 요청하지 않습니다.", 403);
      }
      throw error;
    } finally { await upload.body.cancel().catch(() => {}); }
  }

  // 409/ALREADY_EXISTS는 같은 사용자의 같은 리액션이 이미 있으므로 성공이다.
  async createReaction(name: string, emoji: ReactionEmoji): Promise<boolean> {
    parseMessageName(name);
    parseEmoji(emoji);
    try {
      await this.request(new URL(`https://chat.googleapis.com/v1/${name}/reactions`), { method: "POST", body: JSON.stringify({ emoji: { unicode: emoji } }) });
      return false;
    } catch (error: unknown) {
      if (error instanceof RequestError && (error.status === 409 || error.apiStatus === "ALREADY_EXISTS")) return true;
      throw error;
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

  // 설정 점검은 한 건만 요청한다. 페이지를 순회하거나 목록 캐시를 갱신하지 않는다.
  async checkSpacesAccess(): Promise<boolean> {
    const url = new URL("https://chat.googleapis.com/v1/spaces");
    url.searchParams.set("pageSize", "1");
    const body = await this.request(url, { method: "GET" });
    if (!isRecord(body) || (body.spaces !== undefined && !Array.isArray(body.spaces))) {
      throw new MailmanError("Google Chat 스페이스 목록 응답 형식이 올바르지 않습니다.", 3);
    }
    const spaces: unknown[] = Array.isArray(body.spaces) ? body.spaces : [];
    for (const space of spaces) parseSpace(space);
    return spaces.length > 0;
  }

  async findDirectMessage(user: string, signal?: AbortSignal): Promise<ChatSpace> {
    const url = new URL("https://chat.googleapis.com/v1/spaces:findDirectMessage");
    url.searchParams.set("name", user);
    try {
      const space = parseSpace(await this.request(url, { method: "GET", signal }));
      return { ...space, spaceType: "DIRECT_MESSAGE" };
    } catch (error: unknown) {
      if (error instanceof RequestError && error.status === 404) {
        throw new RequestError("아직 대화가 없는 DM입니다. mailman send --dm <사람>으로 첫 메시지를 보내세요.", 404, error.apiStatus, error.apiReasons);
      }
      throw error;
    }
  }

  async setupDirectMessage(user: string): Promise<ChatSpace> {
    if (!/^users\/[A-Za-z0-9_.@+-]+$/.test(user)) throw new MailmanError("DM 상대는 users/ID 또는 이메일 별칭이어야 합니다.");
    return this.setupSpaceWithMembers({ spaceType: "DIRECT_MESSAGE" }, [user]);
  }

  async setupSpace(displayName: string, members: string[]): Promise<ChatSpace> {
    if (!displayName.normalize("NFKC").trim()) throw new MailmanError("표시 이름은 비어 있지 않은 값을 지정하세요.");
    if (!members.length || members.length > MAX_SPACE_MEMBERS) throw new MailmanError(`멤버는 1~${MAX_SPACE_MEMBERS}명 지정하세요.`);
    if (members.some(user => !/^users\/[A-Za-z0-9_.@+-]+$/.test(user))) throw new MailmanError("멤버는 users/ID 또는 이메일 별칭이어야 합니다.");
    return this.setupSpaceWithMembers({ spaceType: "SPACE", displayName }, members);
  }

  private async setupSpaceWithMembers(requested: { spaceType: "SPACE" | "DIRECT_MESSAGE"; displayName?: string }, members: string[]): Promise<ChatSpace> {
    try {
      const space = parseSpace(await this.request(new URL("https://chat.googleapis.com/v1/spaces:setup"), {
        method: "POST", body: JSON.stringify({ space: requested, memberships: members.map(name => ({ member: { name, type: "HUMAN" } })) }),
      }));
      return { ...space, displayName: space.displayName || requested.displayName || "", spaceType: requested.spaceType };
    } catch (error: unknown) {
      if (error instanceof RequestError && error.status === 403) {
        throw new RequestError(`HTTP 403: ${requested.spaceType === "DIRECT_MESSAGE" ? "DM" : "스페이스"} 생성 권한이 부족합니다. chat.spaces.create 권한과 관리자 정책을 확인하고 mailman auth를 다시 실행하세요.`, 403, error.apiStatus, error.apiReasons);
      }
      // 응답이 유실돼도 생성됐을 수 있으므로 POST는 재시도하지 않는다.
      const message = `${errorMessage(error)}\nChat에서 생성 여부를 확인한 뒤 재실행하세요.`;
      if (error instanceof RequestError) throw new RequestError(message, error.status, error.apiStatus, error.apiReasons);
      throw new MailmanError(message, error instanceof MailmanError ? error.exitCode : 3);
    }
  }

  private async directoryPage(query: string, pageSize: number, pageToken = ""): Promise<{ people: DirectoryPerson[]; nextPageToken: string }> {
    const url = new URL("https://people.googleapis.com/v1/people:searchDirectoryPeople");
    url.search = new URLSearchParams({ query, readMask: "names,emailAddresses", sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE", pageSize: String(pageSize),
      ...(pageToken ? { pageToken } : {}) }).toString();
    let body: unknown;
    try { body = await this.request(url, { method: "GET" }); }
    catch (error: unknown) {
      if (error instanceof RequestError && error.status === 403) {
        throw new RequestError(directoryErrorMessage(error), 403, error.apiStatus, error.apiReasons);
      }
      throw error;
    }
    if (!isRecord(body) || (body.people !== undefined && !Array.isArray(body.people)) || !optionalString(body, "nextPageToken")) {
      throw new MailmanError("People API 디렉터리 응답 형식이 올바르지 않습니다.", 3);
    }
    return { people: ((body.people ?? []) as unknown[]).map(parseDirectoryPerson), nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : "" };
  }

  async searchDirectoryPeople(query: string): Promise<DirectoryPerson[]> {
    const people = new Map<string, DirectoryPerson>();
    const tokens = new Set<string>();
    let pageToken = "";
    // 다음 페이지에도 동명이인이 있을 수 있으므로 모두 확인한다.
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await this.directoryPage(query, 10, pageToken);
      for (const person of result.people) people.set(person.userName, person);
      if (!result.nextPageToken) return [...people.values()];
      if (tokens.has(result.nextPageToken)) throw new MailmanError("People API 페이지 토큰이 반복되었습니다. 사람을 확정하지 않습니다.", 3);
      tokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }
    throw new MailmanError("디렉터리 검색 페이지 상한에 도달했습니다. 이메일로 지정하세요.", 3);
  }

  async checkDirectoryAccess(query: string): Promise<void> {
    await this.directoryPage(query, 1);
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

  async createMessage(space: string, body: MessageBody, waitMetadata = false): Promise<CreatedMessage> {
    validateSpace(space);
    if (body.thread) validateThread(space, body.thread.name);
    const url = new URL(`https://chat.googleapis.com/v1/${space}/messages`);
    if (body.thread) url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    const result = await this.request(url, { method: "POST", body: JSON.stringify(body) });
    if (!isRecord(result) || typeof result.name !== "string" || !result.name.startsWith(`${space}/messages/`) ||
        !isRecord(result.thread) || typeof result.thread.name !== "string" || !result.thread.name.startsWith(`${space}/threads/`)) {
      throw new MailmanError("전송 응답에서 message/thread 이름을 확인할 수 없습니다. 중복 전송을 피하려면 Chat에서 먼저 확인하세요.", 3);
    }
    if (!waitMetadata) return { name: result.name, thread: { name: result.thread.name } };
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
