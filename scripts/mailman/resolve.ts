// 대상 해석은 모든 명령에서 공유한다. 후보가 여러 개면 추측하지 않는다.
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { ChatClient, ChatSpace } from "./chat";
import { errorMessage, isRecord, MailmanError } from "./errors";
import { writePrivateFile } from "./private-file";
import { loadConfig, validateSpace, type MailmanConfig } from "./runtime";
import { cachedSpaces, cacheSpace, cacheSpaces, getMeta } from "./store";

export function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

export function requireName(value: string, label: string): void {
  if (!normalizeName(value)) throw new MailmanError(`${label}${label === "검색어" ? "는" : "은"} 비어 있지 않은 값을 지정하세요.`);
}

export const SPACE_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

export function formatSpace(space: ChatSpace): string {
  return `${space.displayName || "(표시 이름 없음)"} (${space.spaceType}, ${space.name})`;
}

export type ResolvedTarget = ChatSpace & { spaceKey: string; dmUser?: string; dmLabel?: string };
export function targetHeader(target: ChatSpace): string {
  return `[대상] ${formatSpace(target)}`;
}

// 대기 중 새로 수집한 sender 표시명도 마지막 출력에 반영한다.
export function describeTarget(db: Database | undefined, target: ResolvedTarget, self?: string, otherSelf?: string): ResolvedTarget {
  if (target.spaceType !== "DIRECT_MESSAGE") return target;
  let user = target.dmUser;
  if ((!user || user.includes("@")) && db && self) {
    const peers = db.query<{ name: string }, [string, string, string]>(
      "SELECT DISTINCT sender_name AS name FROM messages WHERE space=? AND sender_name NOT IN (?,?) AND sender_name LIKE 'users/%' AND (sender_type IS NULL OR sender_type='HUMAN')",
    ).all(target.name, self, otherSelf ?? self);
    if (peers.length === 1) user = peers[0]!.name;
  }
  const known = user && db ? db.query<{ displayName: string }, [string]>(
    "SELECT sender_display_name AS displayName FROM messages WHERE sender_name=? AND trim(coalesce(sender_display_name,''))<>'' AND (sender_type IS NULL OR sender_type='HUMAN') ORDER BY create_time DESC, fetched_at DESC LIMIT 1",
  ).get(user)?.displayName : undefined;
  const fallback = target.dmLabel ?? target.displayName.replace(/^DM: /, "");
  const label = known || fallback || user || target.spaceKey;
  return { ...target, dmUser: user, dmLabel: label, displayName: `DM: ${label}${user && label !== user ? ` → ${user}` : ""}` };
}

export function inboxLabel(target: ResolvedTarget): string {
  return target.spaceType === "DIRECT_MESSAGE" ? `DM: ${target.dmLabel ?? target.displayName.replace(/^DM: /, "")}`
    : target.displayName || target.spaceKey || target.name;
}

type ClientProvider = () => Promise<Pick<ChatClient, "listSpaces" | "findDirectMessage">>;

export async function listSpaces(db: Database, client: ClientProvider, refresh = false, now = new Date()): Promise<ChatSpace[]> {
  if (refresh || !getMeta(db, "spacesUpdatedAt")) {
    // 모든 페이지가 성공한 뒤에만 기존 캐시를 교체한다.
    cacheSpaces(db, await (await client()).listSpaces(), now.toISOString());
  }
  return cachedSpaces(db);
}

export function searchSpaces(spaces: ChatSpace[], search = ""): ChatSpace[] {
  const normalized = normalizeName(search);
  return spaces.filter(space => normalizeName(space.displayName).includes(normalized));
}

export function resolvePerson(db: Database, value: string): string {
  requireName(value, "사람");
  if (/^users\/[A-Za-z0-9_.@+-]+$/.test(value)) return value;
  if (/^[^@\s/]+@[^@\s/]+$/.test(value)) return `users/${value}`;
  const candidates = db.query<{ name: string; displayName: string }, []>(
    `SELECT DISTINCT sender_name AS name, sender_display_name AS displayName FROM messages
     WHERE sender_name LIKE 'users/%' AND sender_display_name IS NOT NULL AND (sender_type IS NULL OR sender_type='HUMAN')`,
  ).all().filter(sender => normalizeName(sender.displayName) === normalizeName(value));
  const users = [...new Map(candidates.map(sender => [sender.name, sender])).values()];
  if (users.length === 1) return users[0]!.name;
  if (users.length > 1) throw new MailmanError(`같은 이름의 사람이 여러 명입니다. 이메일로 지정하세요.\n${users.map(user => `- ${user.displayName} (${user.name})`).join("\n")}`);
  throw new MailmanError("수집된 발신자 기록에서 사람을 찾을 수 없습니다. 이메일로 지정하세요.");
}

// 이메일 별칭 자체에는 정식 ID가 없다. 기존 DM의 발신자로 전송 전에 확정한다.
// 멤버 조회 권한을 추가하지 않고, 대기 중 발신자별 API 조회도 없앤다.
export async function resolveWaitPerson(db: Database, client: Pick<ChatClient, "findDirectMessage" | "listMessages">,
  value: string, self: string, now = new Date(), backfillDays = 7, selfEmail?: string): Promise<string> {
  const person = resolvePerson(db, value);
  const checked = (id: string): string => {
    if (id === self || selfEmail && id.toLowerCase() === `users/${selfEmail.toLowerCase()}`) {
      throw new MailmanError("--from에 내 계정을 지정할 수 없습니다. 상대 사람을 지정하세요.");
    }
    return id;
  };
  checked(person);
  if (!person.includes("@")) return person;
  const alias = db.query<{ name: string }, [string]>(
    "SELECT DISTINCT sender_name AS name FROM messages WHERE lower(sender_name)=lower(?) AND (sender_type IS NULL OR sender_type='HUMAN')",
  ).all(person);
  if (alias.length === 1) return checked(alias[0]!.name);
  const dm = await client.findDirectMessage(person);
  const peers = new Set(db.query<{ name: string }, [string, string]>(
    "SELECT DISTINCT sender_name AS name FROM messages WHERE space=? AND sender_name<>? AND sender_name LIKE 'users/%' AND (sender_type IS NULL OR sender_type='HUMAN')",
  ).all(dm.name, self).map(row => row.name));
  if (!peers.size) {
    const after = new Date(now.getTime() - backfillDays * 86_400_000).toISOString();
    for (const message of await client.listMessages(dm.name, after)) {
      if (message.sender?.name?.startsWith("users/") && message.sender.name !== self && message.sender.type !== "BOT") peers.add(message.sender.name);
    }
  }
  if (peers.size === 1) return checked([...peers][0]!);
  throw new MailmanError("--from 이메일의 사용자 ID를 확정할 수 없습니다. 기존 DM의 수집 기록/최근 메시지가 필요합니다. 수집된 정확한 사람 이름이나 users/ID로 지정하세요.");
}

export async function resolveTarget(config: MailmanConfig, db: Database | undefined, client: ClientProvider,
  options: { spaceKey?: string; dm?: string }, now = new Date(), warn: (text: string) => void = console.error): Promise<ResolvedTarget> {
  if (options.dm !== undefined && options.spaceKey !== undefined) throw new MailmanError("위치 인자와 --dm은 함께 쓸 수 없습니다.");
  const key = options.spaceKey ?? config.defaultSpace;
  requireName(options.dm ?? key, options.dm === undefined ? "대상" : "--dm");
  const metadata = (name: string): ChatSpace => cachedSpacesIfPresent(db).find(space => space.name === name)
    ?? { name, displayName: key, spaceType: "SPACE_TYPE_UNSPECIFIED" };
  if (options.dm === undefined && Object.hasOwn(config.spaces, key)) return { ...metadata(config.spaces[key]!.space), spaceKey: key };
  if (options.dm === undefined && key.startsWith("spaces/")) {
    validateSpace(key);
    return { ...metadata(key), spaceKey: key };
  }
  if (!db) throw new MailmanError("대상 이름 해석에 필요한 DB를 열 수 없습니다.");
  if (options.dm !== undefined) {
    const user = resolvePerson(db, options.dm);
    const space = await (await client()).findDirectMessage(user);
    cacheSpace(db, space, now.toISOString());
    return describeTarget(db, { ...space, displayName: space.displayName || options.dm, spaceKey: options.dm, dmUser: user });
  }
  const updated = getMeta(db, "spacesUpdatedAt");
  const expired = updated !== undefined && (!Number.isFinite(Date.parse(updated)) || now.getTime() - Date.parse(updated) > SPACE_CACHE_MAX_AGE_MS);
  let refreshed = !updated || expired;
  let spaces: ChatSpace[];
  try { spaces = await listSpaces(db, client, expired, now); }
  catch (error: unknown) {
    if (!expired) throw error;
    warn(`[mailman] 스페이스 캐시 자동 갱신 실패: ${errorMessage(error)} 기존 캐시를 사용합니다.`);
    spaces = cachedSpaces(db);
  }
  for (;;) {
    const namedSpaces = spaces.filter(space => normalizeName(space.displayName));
    const exact = namedSpaces.filter(space => normalizeName(space.displayName) === normalizeName(key));
    const candidates = exact.length ? exact : searchSpaces(namedSpaces, key);
    if (candidates.length === 1) return { ...candidates[0]!, spaceKey: key };
    if (candidates.length > 1) throw new MailmanError(`스페이스 후보가 여러 개입니다. 이름 또는 ID로 하나를 선택하세요.\n${candidates.map(space => `- ${formatSpace(space)}`).join("\n")}`);
    if (refreshed) throw new MailmanError("스페이스를 찾을 수 없습니다. mailman spaces로 목록을 확인하세요.");
    spaces = await listSpaces(db, client, true, now);
    refreshed = true;
  }
}

function cachedSpacesIfPresent(db?: Database): ChatSpace[] { return db ? cachedSpaces(db) : []; }

export function saveAlias(configFile: string, alias: string, space: string, options: { dryRun?: boolean; makeDefault?: boolean } = {}): void {
  requireName(alias, "--save");
  validateSpace(space);
  // 최신 파일을 다시 읽어 다른 필드와 이미 저장된 별칭을 보존한다.
  const exists = existsSync(configFile);
  const config = exists ? loadConfig(configFile) : undefined;
  // 설정이 없을 때만 첫 별칭을 기본 방으로 만든다. 기존 파일의 기본 방과 다른 필드는 보존한다.
  const raw: unknown = exists ? JSON.parse(readFileSync(configFile, "utf8")) : { defaultSpace: alias, spaces: {} };
  if (!isRecord(raw) || !isRecord(raw.spaces)) throw new MailmanError("설정 파일의 spaces를 확인하세요.");
  const registered = Object.hasOwn(raw.spaces, alias);
  if (registered && (!options.makeDefault || config?.spaces[alias]?.space !== space)) {
    throw new MailmanError(`이미 등록된 별칭입니다: ${alias}. --save는 덮어쓰지 않습니다. --default는 같은 방의 별칭만 기본 방으로 지정할 수 있습니다.`);
  }
  if (options.dryRun) return;
  if (!registered) Object.defineProperty(raw.spaces, alias, { value: { space }, enumerable: true, configurable: true, writable: true });
  if (options.makeDefault) raw.defaultSpace = alias;
  writePrivateFile(configFile, JSON.stringify(raw, null, 2) + "\n", ".mailman-config-", "설정 파일에 별칭을 저장할 수 없습니다.");
}
