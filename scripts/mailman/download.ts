// 업로드 첨부만 내려받는다. 외부 downloadUri/Drive URL에 인증 헤더를 보내지 않는다.
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseMessage, type ChatAttachment, type ChatClient } from "./chat";
import { errorMessage, isRecord, MailmanError } from "./errors";
import { attachmentSizeError } from "./http";
import { writePrivateFile } from "./private-file";
import { parseMessageName, type RuntimePaths } from "./runtime";
import type { MessageRow } from "./store";

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_INLINE_ATTACHMENTS = 3;
const MANIFEST = ".mailman-attachments.json";
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text", ".json", ".jsonl", ".ndjson", ".csv", ".tsv", ".yaml", ".yml", ".log", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".sql", ".sh", ".ini", ".toml", ".rst", ".diff", ".patch", ".conf"]);
type DownloadClient = Pick<ChatClient, "getMessage" | "downloadMedia">;
type ClientProvider = () => Promise<DownloadClient>;
type CacheEntry = { resourceName: string; contentName: string; fileName: string; size: number };
export type DownloadedAttachment = { path: string; fileName: string; size: number; reused: boolean; text?: string };

export function sanitizeFileName(value: string): string {
  let name = value.normalize("NFKC").replace(/[\\/:\p{Cc}\p{Cf}]/gu, "").replace(/\.{2,}/g, "").trim().replace(/^\.+/, "");
  // UTF-8 바이트 기준으로 여유를 남겨 충돌 접미사를 붙여도 파일시스템 상한을 넘지 않는다.
  if (Buffer.byteLength(name) > 200) {
    const extension = extname(name);
    const suffix = Buffer.byteLength(extension) <= 30 ? extension : "";
    let stem = "";
    for (const character of name.slice(0, suffix ? -suffix.length : undefined)) {
      if (Buffer.byteLength(stem + character + suffix) > 200) break;
      stem += character;
    }
    name = stem + suffix;
  }
  return name || "attachment";
}

export function isTextAttachment(attachment: ChatAttachment): boolean {
  const mime = (attachment.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^(image|audio|video|font)\//.test(mime) || /^application\/(pdf|zip|gzip|x-7z-compressed|x-rar-compressed|vnd\.(openxmlformats-officedocument|ms-|oasis\.opendocument))/.test(mime)) return false;
  return mime.startsWith("text/") || /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|yaml|x-yaml|javascript|sql|toml)$/.test(mime) ||
    TEXT_EXTENSIONS.has(extname(sanitizeFileName(attachment.contentName ?? "")).toLowerCase());
}

export function driveDescription(attachment: ChatAttachment): string | undefined {
  if (!attachment.driveDataRef) return undefined;
  const id = attachment.driveDataRef.driveFileId;
  return `Drive 첨부는 지원하지 않음${id ? ` — 파일 ID: ${sanitizeFileName(id)}, https://drive.google.com/file/d/${encodeURIComponent(id)}/view` : " (파일 ID 없음)"}`;
}

export function attachmentsFromRaw(raw: string, name: string): ChatAttachment[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new MailmanError("저장된 메시지 원본 JSON을 읽을 수 없습니다.", 3); }
  return parseMessage(value, parseMessageName(name).space).attachment ?? [];
}

export async function messageAttachments(db: Database | undefined, getClient: ClientProvider, name: string): Promise<ChatAttachment[]> {
  parseMessageName(name);
  const cached = db?.query<{ raw_json: string }, [string]>("SELECT raw_json FROM messages WHERE name=?").get(name);
  if (cached) return attachmentsFromRaw(cached.raw_json, name);
  return (await (await getClient()).getMessage(name)).attachment ?? [];
}

function privateDirectory(directory: string, owned = true): void {
  const created = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new MailmanError("첨부 저장 디렉터리는 심볼릭 링크가 아닌 디렉터리여야 합니다.");
  if (owned || created !== undefined) chmodSync(directory, 0o700);
}

function outputDirectory(paths: Pick<RuntimePaths, "attachmentsDir">, name: string, out?: string): string {
  const { spaceId, messageId } = parseMessageName(name);
  if (out !== undefined) {
    const directory = resolve(out);
    privateDirectory(directory, false);
    return directory;
  }
  let directory = paths.attachmentsDir;
  for (const part of ["", spaceId, messageId]) {
    if (part) directory = join(directory, part);
    privateDirectory(directory);
  }
  return directory;
}

function readManifest(directory: string): CacheEntry[] {
  const path = join(directory, MANIFEST);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 512 * 1024) return [];
    fchmodSync(fd, 0o600);
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is CacheEntry => isRecord(entry) && typeof entry.resourceName === "string" &&
      typeof entry.contentName === "string" && typeof entry.fileName === "string" && sanitizeFileName(entry.fileName) === entry.fileName &&
      typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_ATTACHMENT_BYTES);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function textContent(content: Buffer, attachment: ChatAttachment): string | undefined {
  if (!isTextAttachment(attachment) || content.byteLength > MAX_TEXT_BYTES) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text) ? undefined : text;
  } catch { return undefined; }
}

export async function downloadAttachment(getClient: ClientProvider, paths: Pick<RuntimePaths, "attachmentsDir">, name: string,
  attachment: ChatAttachment, options: { out?: string; maxBytes?: number } = {}): Promise<DownloadedAttachment> {
  if (attachment.driveDataRef) throw new MailmanError(driveDescription(attachment)!);
  const resourceName = attachment.attachmentDataRef?.resourceName;
  if (!resourceName) throw new MailmanError("업로드 첨부의 attachmentDataRef.resourceName이 없습니다.", 3);
  const fileName = sanitizeFileName(attachment.contentName ?? "attachment");
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const directory = outputDirectory(paths, name, options.out);
  // 명시한 --out에는 앱 메타데이터를 읽거나 남기지 않고 항상 새 파일로 받는다.
  const manifest = options.out === undefined ? readManifest(directory) : [];
  const previous = manifest.find(entry => entry.resourceName === resourceName && entry.contentName === fileName);
  if (previous) {
    let fd: number | undefined;
    try {
      fd = openSync(join(directory, previous.fileName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (info.isFile() && info.size === previous.size) {
        if (info.size > maxBytes) throw attachmentSizeError(maxBytes);
        fchmodSync(fd, 0o600);
        const text = info.size <= MAX_TEXT_BYTES && isTextAttachment(attachment) ? textContent(readFileSync(fd), attachment) : undefined;
        return { path: join(directory, previous.fileName), fileName: previous.fileName, size: info.size, reused: true, text };
      }
    } catch (error: unknown) { if (error instanceof MailmanError) throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const content = await (await getClient()).downloadMedia(resourceName, maxBytes);
  // 주입 구현도 상한을 우회할 수 없게 저장 직전에 한 번 더 확인한다.
  if (content.byteLength > maxBytes) throw attachmentSizeError(maxBytes);
  const temporary = join(directory, `.mailman-download-${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content);
    closeSync(fd);
    fd = undefined;
    const extension = extname(fileName);
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    for (let suffix = 0; suffix < 10000; suffix++) {
      const candidate = suffix ? `${stem}-${suffix}${extension}` : fileName;
      const path = join(directory, candidate);
      try {
        // link는 기존 파일/심볼릭 링크를 덮어쓰지 않는다. 실패한 수신은 최종 파일로 남지 않는다.
        linkSync(temporary, path);
      } catch (error: unknown) {
        if (isRecord(error) && error.code === "EEXIST") continue;
        const code = isRecord(error) && typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? ` (${error.code})` : "";
        throw new MailmanError(`첨부 저장 위치에 하드 링크를 만들 수 없습니다${code}. 하드 링크를 지원하고 쓰기 권한이 있는 디렉터리를 --out으로 지정하세요.`);
      }
      if (options.out === undefined) {
        const entries = manifest.filter(entry => entry !== previous);
        entries.push({ resourceName, contentName: fileName, fileName: candidate, size: content.byteLength });
        writePrivateFile(join(directory, MANIFEST), JSON.stringify(entries) + "\n", ".mailman-cache-", "첨부 재사용 기록을 저장할 수 없습니다.");
      }
      return { path, fileName: candidate, size: content.byteLength, reused: false, text: textContent(content, attachment) };
    }
    throw new MailmanError("첨부 파일명 충돌이 너무 많습니다. 다른 --out 디렉터리를 지정하세요.");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* 이 호출이 만든 임시 파일만 정리한다. */ }
  }
}

export function renderDownloaded(file: DownloadedAttachment, print = false): string {
  if (!print || file.text === undefined) return file.path;
  let fence = "```";
  for (const ticks of file.text.match(/`+/g) ?? []) if (ticks.length >= fence.length) fence = "`".repeat(ticks.length + 1);
  return `첨부 파일: ${file.fileName}\n${file.path}\n${fence}\n${file.text}${file.text.endsWith("\n") ? "" : "\n"}${fence}`;
}

// 메시지당 최대 3개 텍스트 첨부만 시도한다. 개별 실패는 본문 조회와 seen 처리를 막지 않는다.
export function attachmentExpander(getClient: ClientProvider, paths: Pick<RuntimePaths, "attachmentsDir">) {
  const expanded = new Map<string, Promise<string[]>>();
  return (row: MessageRow): Promise<string[]> => {
    let result = expanded.get(row.name);
    if (!result) {
      result = (async () => {
        const textFiles = attachmentsFromRaw(row.raw_json, row.name).filter(item => !item.driveDataRef && isTextAttachment(item));
        const lines: string[] = [];
        for (const attachment of textFiles.slice(0, MAX_INLINE_ATTACHMENTS)) {
          try {
            const file = await downloadAttachment(getClient, paths, row.name, attachment, { maxBytes: MAX_TEXT_BYTES });
            lines.push(file.text === undefined ? `첨부 ${file.fileName}: 텍스트로 펼칠 수 없음 — ${file.path}` : renderDownloaded(file, true));
          } catch (error: unknown) {
            lines.push(`첨부 ${sanitizeFileName(attachment.contentName ?? "attachment")} 펼치기 실패: ${errorMessage(error)}`);
          }
        }
        if (textFiles.length > MAX_INLINE_ATTACHMENTS) lines.push(`텍스트 첨부는 메시지당 최대 3개만 펼칩니다 (${textFiles.length - MAX_INLINE_ATTACHMENTS}개 생략).`);
        return lines;
      })();
      expanded.set(row.name, result);
    }
    return result;
  };
}
