// 모든 파일을 먼저 검증하고 열린 파일을 유지한다. 경로가 바뀌어도 다른 파일을 올리지 않는다.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ChatClient, UploadedAttachment } from "./chat";
import { MailmanError, throwIfAborted } from "./errors";

export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export type UploadFile = { path: string; name: string; size: number; modified: number; fd?: number };

export function closeUploadFiles(files: UploadFile[]): void {
  for (const file of files) {
    if (file.fd === undefined) continue;
    closeSync(file.fd);
    file.fd = undefined;
  }
}

export function validateUploadFiles(paths: string[]): UploadFile[] {
  if (paths.length > MAX_UPLOAD_FILES) throw new MailmanError("첨부는 최대 10개까지 지정할 수 있습니다.");
  const files: UploadFile[] = [];
  try {
    for (const entry of paths) {
      if (!entry.trim()) throw new MailmanError("--attach 뒤에 비어 있지 않은 파일 경로를 지정하세요.");
      const requestedPath = resolve(entry);
      let fd: number | undefined;
      try {
        // 소켓/파이프를 열기 전에 거절하며, 바뀐 파이프도 블로킹으로 열지 않는다.
        const selected = lstatSync(requestedPath);
        if (selected.isSymbolicLink()) throw new MailmanError(`첨부 파일의 심볼릭 링크는 허용하지 않습니다: ${JSON.stringify(requestedPath)}`);
        if (!selected.isFile()) throw new MailmanError(`첨부는 일반 파일이어야 합니다: ${JSON.stringify(requestedPath)}`);
        fd = openSync(requestedPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        const path = realpathSync(requestedPath);
        const resolved = lstatSync(path);
        if (info.dev !== selected.dev || info.ino !== selected.ino || resolved.dev !== info.dev || resolved.ino !== info.ino) {
          throw new MailmanError(`검증 도중 첨부 파일 경로가 변경되었습니다. 다시 확인하세요: ${JSON.stringify(requestedPath)}`);
        }
        if (!info.isFile()) throw new MailmanError(`첨부는 일반 파일이어야 합니다: ${JSON.stringify(path)}`);
        if (info.size > MAX_UPLOAD_BYTES) throw new MailmanError(`첨부 크기는 파일당 200MB 이하여야 합니다: ${JSON.stringify(path)}`);
        files.push({ path, name: basename(path), size: info.size, modified: info.mtimeMs, fd });
        fd = undefined;
      } catch (error: unknown) {
        if (error instanceof MailmanError) throw error;
        throw new MailmanError(`첨부 파일을 열 수 없습니다. 존재 여부와 읽기 권한을 확인하세요: ${JSON.stringify(requestedPath)}`);
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    return files;
  } catch (error: unknown) {
    closeUploadFiles(files);
    throw error;
  }
}

function fileChanged(file: UploadFile, uploading: boolean): MailmanError {
  return new MailmanError(`첨부 파일이 ${uploading ? "업로드 중" : "검증 후"} 바뀌었습니다 — 내용을 확인하고 다시 승인받으세요. 이 오류는 재시도 대상이 아닙니다: ${JSON.stringify(file.path)}`);
}

function assertUnchanged(file: UploadFile, uploading = false): number {
  if (file.fd === undefined) throw new MailmanError("첨부 파일이 닫혀 있습니다.");
  const info = fstatSync(file.fd);
  if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.modified || info.size > MAX_UPLOAD_BYTES) {
    throw fileChanged(file, uploading);
  }
  return file.fd;
}

// multipart/related의 첫 파트는 JSON 메타데이터, 둘째 파트는 원본 파일 바이트다.
// 200MB 파일도 전부 메모리에 올리지 않도록 64KB씩 전송한다.
export function multipartUpload(file: UploadFile) {
  const fd = assertUnchanged(file);
  const boundary = `mailman-${randomBytes(18).toString("hex")}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: file.name })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  let sentHead = false;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHead) { sentHead = true; controller.enqueue(head); return; }
      if (offset < file.size) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, file.size - offset));
        const received = readSync(fd, chunk, 0, chunk.length, offset);
        if (!received) throw fileChanged(file, true);
        offset += received;
        controller.enqueue(chunk.subarray(0, received));
        return;
      }
      assertUnchanged(file, true);
      controller.enqueue(tail);
      controller.close();
    },
  });
  return { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(head.length + file.size + tail.length) } };
}

export function uploadPreview(files: UploadFile[]): string {
  if (!files.length) return "";
  return `\n[첨부 ${files.length}개]\n${files.map(file => `- 경로: ${JSON.stringify(file.path)}, 이름: ${JSON.stringify(file.name)}, 크기: ${file.size} bytes`).join("\n")}`;
}

export async function uploadAttachments(client: Pick<ChatClient, "uploadAttachment">, space: string, files: UploadFile[],
  warn: (text: string) => void, signal?: AbortSignal): Promise<UploadedAttachment[]> {
  const attachments: UploadedAttachment[] = [];
  try {
    for (const file of files) {
      throwIfAborted(signal);
      attachments.push(await client.uploadAttachment(space, file));
    }
    throwIfAborted(signal);
    return attachments;
  } catch (error: unknown) {
    warn(`[mailman] 첨부 업로드 실패/중단: 메시지를 보내지 않았습니다. 이미 올라간 업로드는 무시해도 됩니다 (성공 응답 ${attachments.length}개).`);
    throw error;
  }
}
