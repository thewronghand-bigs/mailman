import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatMessage, ChatSpace } from "./chat";
import { MailmanError } from "./errors";
import { normalizeTime } from "./time";

export type Person = {
  userName: string;
  displayName: string;
  email: string | null;
  source: "sender" | "directory" | "manual";
  updatedAt: string;
};

export type MessageRow = {
  name: string;
  space: string;
  create_time: string;
  last_update_time: string;
  sender_name: string | null;
  sender_display_name: string | null;
  sender_type: string | null;
  text: string;
  thread_name: string | null;
  attachments_json: string;
  raw_json: string;
  fetched_at: string;
};

export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
    // SQLite가 열기 전에 0600으로 생성한다. 기존 파일의 내용과 권한은 유지한다.
    closeSync(openSync(path, "a", 0o600));
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      name TEXT PRIMARY KEY,
      space TEXT NOT NULL,
      create_time TEXT NOT NULL,
      last_update_time TEXT NOT NULL,
      sender_name TEXT,
      sender_display_name TEXT,
      sender_type TEXT,
      text TEXT NOT NULL,
      thread_name TEXT,
      attachments_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_space_time ON messages(space, create_time DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_space_thread ON messages(space, thread_name, create_time);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS spaces (
      name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      space_type TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS people (
      user_name TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT,
      source TEXT NOT NULL CHECK(source IN ('sender','directory','manual')),
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function registeredPeople(db: Database): Person[] {
  return db.query<Person, []>("SELECT user_name AS userName, display_name AS displayName, email, source, updated_at AS updatedAt FROM people ORDER BY display_name, user_name").all();
}

export function upsertPerson(db: Database, person: Person): void {
  if (!/^users\/\d+$/.test(person.userName)) throw new MailmanError("등록할 사람은 users/숫자ID 형식으로 지정하세요.");
  db.query(`INSERT INTO people(user_name,display_name,email,source,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_name) DO UPDATE SET display_name=excluded.display_name, email=coalesce(excluded.email,people.email),
      source=excluded.source, updated_at=excluded.updated_at`)
    .run(person.userName, person.displayName, person.email, person.source, person.updatedAt);
}

export function forgetPerson(db: Database, userName: string): boolean {
  if (!/^users\/\d+$/.test(userName)) throw new MailmanError("--forget은 users/숫자ID 형식으로 지정하세요.");
  return db.query("DELETE FROM people WHERE user_name=?").run(userName).changes > 0;
}

export function cachedSpaces(db: Database): ChatSpace[] {
  return db.query<ChatSpace, []>("SELECT name, display_name AS displayName, space_type AS spaceType FROM spaces ORDER BY display_name, name").all();
}

export function cacheSpaces(db: Database, spaces: ChatSpace[], updatedAt: string): void {
  db.transaction(() => {
    db.exec("DELETE FROM spaces");
    for (const space of spaces) cacheSpace(db, space, updatedAt);
    // 빈 목록도 아직 가져오지 않은 상태와 구별한다.
    setMeta(db, "spacesUpdatedAt", updatedAt);
  })();
}

export function cacheSpace(db: Database, space: ChatSpace, updatedAt: string): void {
  db.query(`INSERT INTO spaces(name,display_name,space_type,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(name) DO UPDATE SET display_name=excluded.display_name, space_type=excluded.space_type, updated_at=excluded.updated_at`)
    .run(space.name, space.displayName, space.spaceType, updatedAt);
}

export function getMeta(db: Database, key: string): string | undefined {
  return db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.query("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function toRow(message: ChatMessage, space: string, fetchedAt: string): MessageRow {
  return {
    name: message.name,
    space,
    create_time: normalizeTime(message.createTime),
    last_update_time: normalizeTime(message.lastUpdateTime ?? message.createTime),
    sender_name: message.sender?.name ?? null,
    sender_display_name: message.sender?.displayName ?? null,
    sender_type: message.sender?.type ?? null,
    text: message.text ?? "",
    thread_name: message.thread?.name || null,
    attachments_json: JSON.stringify(message.attachment ?? []),
    raw_json: JSON.stringify(message),
    fetched_at: fetchedAt,
  };
}

export function upsertRows(db: Database, rows: MessageRow[]): number {
  const statement = db.query(`
    INSERT INTO messages(name,space,create_time,last_update_time,sender_name,sender_display_name,sender_type,text,thread_name,attachments_json,raw_json,fetched_at)
    VALUES ($name,$space,$create_time,$last_update_time,$sender_name,$sender_display_name,$sender_type,$text,$thread_name,$attachments_json,$raw_json,$fetched_at)
    ON CONFLICT(name) DO UPDATE SET
      space=excluded.space, create_time=excluded.create_time, last_update_time=excluded.last_update_time,
      sender_name=excluded.sender_name, sender_display_name=excluded.sender_display_name, sender_type=excluded.sender_type,
      text=excluded.text, thread_name=excluded.thread_name, attachments_json=excluded.attachments_json,
      raw_json=excluded.raw_json, fetched_at=excluded.fetched_at
    WHERE excluded.last_update_time >= messages.last_update_time AND excluded.raw_json != messages.raw_json
  `);
  let saved = 0;
  for (const row of rows) {
    saved += statement.run({
      $name: row.name, $space: row.space, $create_time: row.create_time, $last_update_time: row.last_update_time,
      $sender_name: row.sender_name, $sender_display_name: row.sender_display_name, $sender_type: row.sender_type,
      $text: row.text, $thread_name: row.thread_name, $attachments_json: row.attachments_json,
      $raw_json: row.raw_json, $fetched_at: row.fetched_at,
    }).changes;
  }
  return saved;
}
