// 비밀값을 포함할 수 있는 파일은 같은 디렉터리의 0600 임시 파일로 원자 교체한다.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MailmanError } from "./errors";

export function writePrivateFile(path: string, content: string | Buffer, prefix: string, failure: string): void {
  const temporary = join(dirname(path), `${prefix}${randomBytes(12).toString("hex")}`);
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, content);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    throw new MailmanError(failure);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* 이동 완료 또는 임시 파일 없음 */ }
  }
}
