import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatClient, type ChatAttachment } from "../chat";
import { main, parseArguments } from "../cli";
import { attachmentExpander, downloadAttachment, isTextAttachment, MAX_ATTACHMENT_BYTES, MAX_TEXT_BYTES, renderDownloaded, sanitizeFileName } from "../download";
import { printInbox, queryInbox, renderInboxAsync } from "../fetch";
import { errorMessage } from "../errors";
import { getMeta, openDatabase, toRow, upsertRows } from "../store";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);
const NAME = `${SPACE}/messages/attachment-message`;
const NOW = new Date("2026-10-22T12:00:00Z");
const uploaded = (file = "handover.md", id = "ref-one", contentType = "text/markdown"): ChatAttachment => ({
  contentName: file, contentType, attachmentDataRef: { resourceName: `${SPACE}/attachments/${id}` },
});
const bytesClient = (fetcher: ChatClient["downloadMedia"]) => async () => ({ downloadMedia: fetcher, getMessage: async () => { throw new Error("메시지 조회 금지"); } });

function io() {
  const output: string[] = [], errors: string[] = [];
  return { output, errors, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
}

describe("첨부 파일 저장과 재사용", () => {
  test("기본 경로·0700 디렉터리·0600 파일과 파일명 정리, 이름 충돌, 같은 소스 재사용", async () => {
    const paths = fixture(false);
    let calls = 0;
    const getClient = bytesClient(async () => { calls++; return Buffer.from("# spec\n"); });
    const attachment = uploaded("../folder\\..\\handover\u0000\n.md");
    expect(sanitizeFileName(attachment.contentName!)).toBe("folderhandover.md");
    for (const bad of ["..", "/../\\\u0000", "\n\u202e"]) expect(sanitizeFileName(bad)).toBe("attachment");
    const long = sanitizeFileName("가".repeat(200) + ".md");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
    expect(long).toEndWith(".md");
    const first = await downloadAttachment(getClient, paths, NAME, attachment);
    const directory = join(paths.attachmentsDir, "test-space", "attachment-message");
    expect(first.path).toBe(join(directory, "folderhandover.md"));
    expect(first.text).toBe("# spec\n");
    expect(first.reused).toBe(false);
    for (const dir of [paths.attachmentsDir, join(paths.attachmentsDir, "test-space"), directory]) expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(directory)) expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
    const second = await downloadAttachment(getClient, paths, NAME, { ...attachment, attachmentDataRef: { resourceName: "other-ref" } });
    expect(second.path).toBe(join(directory, "folderhandover-1.md"));
    chmodSync(first.path, 0o644);
    const cached = await downloadAttachment(getClient, paths, NAME, attachment);
    expect(cached.path).toBe(first.path);
    expect(cached.reused).toBe(true);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(calls).toBe(2);
    // 크기가 다른 로컬 파일은 재사용하거나 덮어쓰지 않는다.
    writeFileSync(first.path, "changed-size");
    const replaced = await downloadAttachment(getClient, paths, NAME, attachment);
    expect(replaced.path).toBe(join(directory, "folderhandover-2.md"));
    expect(replaced.reused).toBe(false);
    expect(readFileSync(first.path, "utf8")).toBe("changed-size");
    const renamed = await downloadAttachment(getClient, paths, NAME, { ...attachment, contentName: "renamed.md" });
    expect(renamed.reused).toBe(false);
    expect(renamed.fileName).toBe("renamed.md");
    expect(calls).toBe(4);
  });

  test("--out 디렉터리와 동명 심볼릭 링크는 덮어쓰지 않는다", async () => {
    const paths = fixture(false);
    const out = join(paths.home, "chosen");
    const getClient = bytesClient(async () => Buffer.from("hello"));
    const first = await downloadAttachment(getClient, paths, NAME, uploaded("first.md"), { out });
    expect(readdirSync(out)).toEqual(["first.md"]);
    symlinkSync(first.path, join(out, "handover.md"));
    const next = await downloadAttachment(getClient, paths, NAME, uploaded(), { out });
    expect(next.path).toBe(join(out, "handover-1.md"));
    expect(statSync(out).mode & 0o777).toBe(0o700);
    const linkedDirectory = join(paths.home, "linked-directory");
    symlinkSync(out, linkedDirectory);
    await expect(downloadAttachment(getClient, paths, NAME, uploaded(), { out: linkedDirectory })).rejects.toThrow("심볼릭 링크");
  });

  test("기존 --out 권한과 메타 파일을 건드리지 않고 매번 충돌 없는 새 파일만 저장한다", async () => {
    const paths = fixture(false);
    const out = join(paths.home, "shared"); mkdirSync(out); chmodSync(out, 0o775);
    let calls = 0;
    const getClient = bytesClient(async () => { calls++; return Buffer.from("hello"); });
    const first = await downloadAttachment(getClient, paths, NAME, uploaded(), { out });
    expect(readdirSync(out)).toEqual(["handover.md"]);
    const metadata = join(out, ".mailman-attachments.json");
    writeFileSync(metadata, "사용자가 만든 기존 파일", { mode: 0o644 });
    const second = await downloadAttachment(getClient, paths, NAME, uploaded(), { out });
    expect(second.path).toBe(join(out, "handover-1.md"));
    expect(first.reused || second.reused).toBe(false);
    expect(calls).toBe(2);
    expect(statSync(out).mode & 0o777).toBe(0o775);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(statSync(second.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(metadata, "utf8")).toBe("사용자가 만든 기존 파일");
    expect(statSync(metadata).mode & 0o777).toBe(0o644);
    expect(existsSync(paths.attachmentsDir)).toBe(false);
  });

  test("--out의 하드 링크 미지원·권한 오류는 원인과 대안을 알리고 임시 파일을 정리한다", async () => {
    const paths = fixture(false);
    const out = join(paths.home, "no-hardlinks"); mkdirSync(out); chmodSync(out, 0o775);
    for (const code of ["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]) {
      const link = spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("비공개 파일시스템 오류"), { code }); });
      try {
        const error = await downloadAttachment(bytesClient(async () => Buffer.from("hello")), paths, NAME, uploaded(), { out }).catch((error: unknown) => error);
        expect(errorMessage(error)).toContain(`하드 링크를 만들 수 없습니다 (${code})`);
        expect(errorMessage(error)).toContain("하드 링크를 지원하고 쓰기 권한이 있는 디렉터리를 --out으로 지정하세요");
        expect(errorMessage(error)).not.toContain("비공개 파일시스템 오류");
        expect(readdirSync(out)).toEqual([]);
        expect(statSync(out).mode & 0o777).toBe(0o775);
      } finally { link.mockRestore(); }
    }
  });

  test("Content-Length와 실제 스트림 바이트 양쪽 상한에서 중단하고 부분 파일을 남기지 않는다", async () => {
    const paths = fixture(false);
    let cancelled = false;
    const oversized = mockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "Content-Length": String(MAX_ATTACHMENT_BYTES + 1) } }));
    const client = new ChatClient("fixture-access", oversized.fetcher);
    await expect(downloadAttachment(async () => client, paths, NAME, uploaded())).rejects.toThrow("50MB");
    expect(cancelled).toBe(true);
    const stream = mockFetch(() => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(4)); }, cancel() { cancelled = true; },
    }), { headers: { "Content-Length": "1" } }));
    cancelled = false;
    await expect(new ChatClient("fixture-access", stream.fetcher).downloadMedia("ref", 5)).rejects.toThrow("상한(5 bytes)");
    expect(cancelled).toBe(true);
    expect(readdirSync(join(paths.attachmentsDir, "test-space", "attachment-message"))).toEqual([]);
    await expect(downloadAttachment(bytesClient(async () => Buffer.alloc(6)), paths, NAME, uploaded(), { maxBytes: 5 })).rejects.toThrow("상한(5 bytes)");
    await downloadAttachment(bytesClient(async () => Buffer.alloc(6)), paths, NAME, uploaded());
    await expect(downloadAttachment(bytesClient(async () => { throw new Error("재사용 전에 호출 금지"); }), paths, NAME, uploaded(), { maxBytes: 5 })).rejects.toThrow("상한(5 bytes)");
  });
});

describe("첨부 출력과 CLI", () => {
  test("확장자/Content-Type/실제 UTF-8으로 텍스트를 판정하고 256KB 넘는 파일·바이너리는 경로만 출력", async () => {
    const paths = fixture(false);
    expect(isTextAttachment(uploaded("unknown", "ref", "application/json; charset=utf-8"))).toBe(true);
    expect(isTextAttachment(uploaded("unknown", "ref", "application/vnd.api+json"))).toBe(true);
    expect(isTextAttachment(uploaded("unknown", "ref", "text/plain"))).toBe(true);
    for (const ext of ["md", "txt", "json", "csv", "yaml", "yml", "log"]) expect(isTextAttachment(uploaded(`file.${ext}`, "ref", "application/octet-stream"))).toBe(true);
    expect(isTextAttachment(uploaded("fake.txt", "ref", "application/pdf"))).toBe(false);
    const exact = await downloadAttachment(bytesClient(async () => Buffer.alloc(MAX_TEXT_BYTES, 65)), paths, NAME, uploaded("exact.txt", "exact"));
    expect(exact.text?.length).toBe(MAX_TEXT_BYTES);
    const big = await downloadAttachment(bytesClient(async () => Buffer.alloc(MAX_TEXT_BYTES + 1, 65)), paths, NAME, uploaded("big.md", "big"));
    expect(renderDownloaded(big, true)).toBe(big.path);
    await expect(downloadAttachment(bytesClient(async () => { throw new Error("캐시 상한 확인 전에 호출하면 안 됨"); }), paths, NAME, uploaded("big.md", "big"), { maxBytes: MAX_TEXT_BYTES })).rejects.toThrow("256KB");
    for (const [index, content] of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe]), Buffer.from("\x1b[31m")].entries()) {
      const binary = await downloadAttachment(bytesClient(async () => content), paths, NAME, uploaded(`binary-${index}.txt`, `binary-${index}`));
      expect(renderDownloaded(binary, true)).toBe(binary.path);
    }
    const text = await downloadAttachment(bytesClient(async () => Buffer.from("```\n# code\n```")), paths, NAME, uploaded());
    expect(renderDownloaded(text, true)).toContain("````\n```\n# code\n```\n````");
  });

  test("DB raw_json을 우선하고 --print 텍스트 내용을 stdout에 출력, 재사용 때 네트워크 불필요", async () => {
    const paths = fixture();
    writeFileSync(paths.configFile, "설정 파일 불필요");
    const db = openDatabase(paths.dbPath);
    const row = toRow(message("attachment-message", undefined, { attachment: [uploaded()] }), SPACE, NOW.toISOString());
    row.attachments_json = "[]";
    upsertRows(db, [row]); db.close();
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      expect(url.pathname).toBe(`/v1/media/${SPACE}/attachments/ref-one`);
      expect(url.searchParams.get("alt")).toBe("media");
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access");
      return new Response("# handover\n");
    });
    const capture = io();
    expect(await main(["download", NAME, "--print"], { paths, fetcher: api.fetcher, ...capture })).toBe(0);
    expect(capture.output.join("\n")).toContain("```\n# handover\n```");
    expect(api.calls).toHaveLength(2);
    expect(await main(["download", NAME, "--print"], { paths, fetcher: api.fetcher, ...capture })).toBe(0);
    expect(api.calls).toHaveLength(2);
  });

  test("DB에 메시지가 없으면 message get, Drive 첨부는 링크·ID·미지원만 표시", async () => {
    const paths = fixture();
    const capture = io();
    const api = mockFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      expect(url.pathname).toBe(`/v1/${NAME}`);
      expect(init.method).toBe("GET");
      return json(message("attachment-message", undefined, { attachment: [{ contentName: "drive.md", driveDataRef: { driveFileId: "fixture-drive" } }] }));
    });
    expect(await main(["download", NAME], { paths, fetcher: api.fetcher, ...capture })).toBe(0);
    expect(capture.output.join("\n")).toContain("Drive 첨부는 지원하지 않음");
    expect(capture.output.join("\n")).toContain("파일 ID: fixture-drive");
    expect(capture.output.join("\n")).toContain("https://drive.google.com/file/d/fixture-drive/view");
    expect(existsSync(paths.attachmentsDir)).toBe(false);
    expect(api.calls).toHaveLength(2);
    // DB 파일은 있지만 해당 메시지가 없는 경로도 동일하다.
    openDatabase(paths.dbPath).close();
    expect(await main(["download", NAME], { paths, fetcher: api.fetcher, ...capture })).toBe(0);
    expect(api.calls).toHaveLength(4);
  });

  test("media 403은 권한/필요 스코프 확인과 auth 재실행만 안내하고 비밀값을 숨긴다", async () => {
    const api = mockFetch(() => json({ error: { message: "fixture-secret" } }, 403));
    const error = await new ChatClient("fixture-secret", api.fetcher).downloadMedia("ref", MAX_ATTACHMENT_BYTES).catch((error: unknown) => error);
    expect(errorMessage(error)).toContain("권한 부족 — 필요한 스코프");
    expect(errorMessage(error)).toContain("mailman auth를 다시 실행");
    expect(errorMessage(error)).not.toContain("fixture-secret");
  });

  test("잘못된 메시지 name/옵션은 설정·인증·API 전에 거절한다", async () => {
    const paths = fixture(false);
    const api = mockFetch(() => { throw new Error("호출 금지"); });
    for (const args of [[], ["spaces/x/messages/.."], ["spaces/x/messages/a?alt=media"], [NAME, "extra"], [NAME, "--dm", "peer"], [NAME, "--out", " "], [NAME, "--print", "--print"]]) {
      expect(await main(["download", ...args], { paths, fetcher: api.fetcher, ...io() })).toBe(1);
    }
    expect(api.calls).toHaveLength(0);
    expect(parseArguments("download", [NAME, "--out", "chosen", "--print"])).toMatchObject({ messageName: NAME, out: "chosen", print: true });
    for (const command of ["fetch", "wait", "send"] as const) expect(parseArguments(command, [...(command === "send" ? ["--wait"] : []), "--with-attachments"]).withAttachments).toBe(true);
    expect(() => parseArguments("send", ["--with-attachments"])).toThrow("--wait");
  });
});

describe("조회 첨부 펼치기", () => {
  test("텍스트 3개 제한·256KB 상한·실패 시 다음 첨부/메시지를 계속 출력하고 표시분만 수신한다", async () => {
    const paths = fixture(false);
    const db = openDatabase(paths.dbPath);
    const requests: Array<[string, number]> = [];
    const client = bytesClient(async (resourceName, maxBytes) => {
      requests.push([resourceName, maxBytes]);
      if (resourceName.endsWith("too-big")) return Buffer.alloc(MAX_TEXT_BYTES + 1);
      if (resourceName.endsWith("failed")) throw new Error("비공개 원본 오류");
      return Buffer.from("펼친 명세");
    });
    const options = { space: SPACE, spaceKey: "tn", now: NOW, expandAttachments: attachmentExpander(client, paths) };
    try {
      upsertRows(db, [
        toRow(message("outside-period", "2026-10-01T00:00:00Z", { thread: undefined, attachment: [uploaded("old.md", "outside-period")] }), SPACE, NOW.toISOString()),
        toRow(message("first", "2026-10-22T10:00:00Z", { thread: undefined, attachment: [
          uploaded("big.md", "too-big"), uploaded("fail.md", "failed"), uploaded("good.md", "good"), uploaded("fourth.md", "skip"),
          uploaded("image.png", "image", "image/png"), { driveDataRef: { driveFileId: "fixture-drive" } },
        ] }), SPACE, NOW.toISOString()),
        toRow(message("second", "2026-10-22T11:00:00Z", { thread: undefined, attachment: [uploaded("next.txt", "next")] }), SPACE, NOW.toISOString()),
      ]);
      let output = "";
      await printInbox(db, options, text => { output = text; });
      expect(output).toContain(`mailman download ${SPACE}/messages/first`);
      expect(output).toContain("256KB");
      expect(output).toContain("fail.md 펼치기 실패");
      expect(output).not.toContain("비공개 원본 오류");
      expect(output.match(/펼친 명세/g)).toHaveLength(2);
      expect(output).toContain("최대 3개");
      expect(output).toContain("Drive 첨부는 지원하지 않음");
      expect(requests.map(([name]) => name.split("/").at(-1))).toEqual(["too-big", "failed", "good", "next"]);
      expect(requests.every(([, max]) => max === MAX_TEXT_BYTES)).toBe(true);
      expect(getMeta(db, `seenMessageName:${SPACE}`)).toBe(`${SPACE}/messages/second`);
      expect(await renderInboxAsync(db, options, queryInbox(db, options))).not.toContain("펼친 명세");
    } finally { db.close(); }
  });

  test("CLI fetch --with-attachments도 DB 메시지의 첨부만 펼치고 기본 fetch는 다운로드하지 않는다", async () => {
    const paths = fixture();
    const db = openDatabase(paths.dbPath);
    upsertRows(db, [toRow(message("cached", "2026-10-22T11:00:00Z", { attachment: [uploaded()] }), SPACE, NOW.toISOString())]); db.close();
    const api = mockFetch(url => url.hostname === "oauth2.googleapis.com" ? json({ access_token: "fixture-access" }) : new Response("# CLI spec"));
    const capture = io();
    const dependencies = { paths, now: NOW, fetcher: api.fetcher, ...capture };
    expect(await main(["fetch", "--no-collect", "--since", "1d"], dependencies)).toBe(0);
    expect(api.calls).toHaveLength(0);
    expect(capture.output.at(-1)).toContain(`mailman download ${SPACE}/messages/cached`);
    expect(await main(["fetch", "--no-collect", "--since", "1d", "--with-attachments"], dependencies)).toBe(0);
    expect(capture.output.at(-1)).toContain("# CLI spec");
    expect(api.calls).toHaveLength(2);
  });
});
