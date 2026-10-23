import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadToken, REQUIRED_SCOPES, saveToken } from "../auth";
import { main, parseArguments } from "../cli";
import { buildMessageBody } from "../send";
import { closeUploadFiles, MAX_UPLOAD_BYTES, multipartUpload, validateUploadFiles } from "../upload";
import { cleanupFixtures, fixture, json, message, mockFetch, SPACE, THREAD } from "./helpers";

afterEach(cleanupFixtures);
const NOW = Date.parse("2026-10-22T12:00:00Z");
const SELF = "users/fixture-self", PEER = "users/fixture-peer";
const REF = { resourceName: `${SPACE}/attachments/uploaded`, attachmentUploadToken: "fixture-upload-secret" };

function io() {
  const output: string[] = [], errors: string[] = [];
  return { output, errors, stdout: (text: string) => output.push(text), stderr: (text: string) => errors.push(text) };
}

describe("첨부 업로드 요청", () => {
  test("multipart/related JSON filename과 원본 바이트를 정확히 전송하고 받은 ref를 메시지에 넣는다", async () => {
    const paths = fixture();
    const directory = join(paths.home, "nested"); mkdirSync(directory);
    const path = join(directory, 'handover "한글".md');
    const content = Buffer.from([0, 1, 255, 13, 10, 65]);
    writeFileSync(path, content);
    let uploads = 0, messages = 0;
    const capture = io();
    const api = mockFetch(async (url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      if (url.pathname.startsWith("/upload/")) {
        uploads++;
        expect(url.pathname).toBe(`/upload/v1/${SPACE}/attachments:upload`);
        expect(url.searchParams.get("uploadType")).toBe("multipart");
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        const headers = new Headers(init.headers);
        expect(headers.get("Authorization")).toBe("Bearer fixture-access");
        const boundary = headers.get("Content-Type")?.match(/^multipart\/related; boundary=(.+)$/)?.[1];
        expect(boundary).toBeDefined();
        const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: 'handover "한글".md' })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
        expect(bytes).toEqual(Buffer.concat([head, content, tail]));
        expect(Number(headers.get("Content-Length"))).toBe(bytes.length);
        expect(bytes.toString()).not.toContain(directory);
        return json({ attachmentDataRef: REF });
      }
      messages++;
      expect(url.pathname).toBe(`/v1/${SPACE}/messages`);
      expect(new Headers(init.headers).get("Content-Type")).toBe("application/json; charset=UTF-8");
      expect(JSON.parse(String(init.body))).toEqual({ text: "[🤖 Codex] 전달합니다", attachment: [{ attachmentDataRef: REF }] });
      return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD } });
    });
    expect(await main(["send", "tn", "--attach", path, "--agent", "codex"], { paths, env: {}, fetcher: api.fetcher, stdin: () => "전달합니다", ...capture })).toBe(0);
    expect([uploads, messages]).toEqual([1, 1]);
    expect(capture.output.join("\n")).toContain(`첨부 파일: ${JSON.stringify('handover "한글".md')}`);
    expect(capture.output.join("\n") + capture.errors.join("\n")).not.toContain(REF.attachmentUploadToken);
  });

  test("본문 없이 첨부가 있으면 태그만 또는 텍스트 없이 전송한다", async () => {
    for (const mode of ["tag", "no-tag", "config-off"] as const) {
      const paths = fixture();
      const path = join(paths.home, "handover.md"); writeFileSync(path, "# handover");
      if (mode === "config-off") writeFileSync(paths.configFile, JSON.stringify({ defaultSpace: "tn", sendTag: false, spaces: { tn: { space: SPACE } } }));
      const api = mockFetch(async (url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
        if (url.pathname.startsWith("/upload/")) { await new Response(init.body).arrayBuffer(); return json({ attachmentDataRef: { attachmentUploadToken: "fixture-upload-token" } }); }
        const body: unknown = JSON.parse(String(init.body));
        expect(body).toEqual({ ...(mode === "tag" ? { text: "[🤖 AI] " } : {}), attachment: [{ attachmentDataRef: { attachmentUploadToken: "fixture-upload-token" } }] });
        return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD } });
      });
      expect(await main(["send", "--attach", path, ...(mode === "no-tag" ? ["--no-tag"] : [])], { paths, env: {}, fetcher: api.fetcher, stdin: () => " \n\t", ...io() })).toBe(0);
    }
    expect(() => buildMessageBody(" ", "[🤖 AI] ")).toThrow("빈 메시지");
  });

  test("반복 --attach, thread·agent·wait·from을 함께 쓰고 업로드와 생성 POST는 각각 한 번씩 한다", async () => {
    const paths = fixture();
    // 기존 필수 스코프만 있어도 업로드한다. 추가 권한은 요구하지 않는다.
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), scopes: [...REQUIRED_SCOPES], user_name: SELF });
    const files = ["first.md", "second.txt"].map(name => { const path = join(paths.home, name); writeFileSync(path, name); return path; });
    let uploads = 0, sent = 0, time = NOW;
    const capture = io();
    const api = mockFetch(async (url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      if (url.pathname.startsWith("/upload/")) {
        uploads++;
        await new Response(init.body).arrayBuffer();
        return json({ attachmentDataRef: { resourceName: `fixture-ref-${uploads}` } });
      }
      if (init.method === "POST") {
        sent++;
        expect(uploads).toBe(2);
        expect(url.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
        expect(JSON.parse(String(init.body))).toEqual({ text: "[🤖 Codex] 질문", thread: { name: THREAD }, attachment: [1, 2].map(index => ({ attachmentDataRef: { resourceName: `fixture-ref-${index}` } })) });
        return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD }, createTime: new Date(NOW).toISOString(), sender: { name: SELF } });
      }
      return json({ messages: time > NOW ? [message("reply", new Date(NOW + 1000).toISOString(), { sender: { name: PEER, type: "HUMAN" } })] : [] });
    });
    expect(await main(["send", "--attach", files[0]!, "--attach", files[1]!, "--agent", "codex", "--thread", THREAD, "--wait", "--from", PEER, "--quiet", "1s", "--interval", "1s", "--timeout", "5s"], {
      paths, env: {}, fetcher: api.fetcher, stdin: () => "질문", clock: { now: () => time, sleep: async milliseconds => { time += milliseconds; } }, ...capture,
    })).toBe(0);
    expect([uploads, sent]).toEqual([2, 1]);
    expect(capture.output[0]).toContain('첨부 파일: "first.md", "second.txt"');
    expect(capture.output.at(-1)).toContain("답장 1건");
  });
});

describe("첨부 검증과 실패 처리", () => {
  test("첨부 심볼릭 링크는 일반 전송과 dry-run 모두 인증·업로드 전에 거절한다", async () => {
    const paths = fixture(false);
    const path = join(paths.home, "actual.md"); writeFileSync(path, "지정하지 않은 파일 내용");
    const link = join(paths.home, "handover.md"); symlinkSync(path, link);
    const dangling = join(paths.home, "missing.md"); symlinkSync(join(paths.home, "absent"), dangling);
    const api = mockFetch(() => { throw new Error("API 호출 금지"); });
    for (const file of [link, dangling]) {
      expect(() => validateUploadFiles([file])).toThrow("심볼릭 링크");
      for (const flags of [[], ["--dry-run"]]) {
        const capture = io();
        expect(await main(["send", "--attach", file, ...flags], { paths, fetcher: api.fetcher, stdin: () => "본문", ...capture })).toBe(1);
        expect(capture.errors.join("\n")).toContain("심볼릭 링크");
        expect(capture.output).toHaveLength(0);
      }
    }
    expect(api.calls).toHaveLength(0);
  });

  test("중간 디렉터리 링크는 허용하되 미리보기·성공 출력에 실제 파일 경로를 표시한다", async () => {
    const paths = fixture();
    const directory = join(paths.home, "actual"); mkdirSync(directory);
    const path = join(directory, "handover.md"); writeFileSync(path, "# handover");
    const linked = join(paths.home, "shortcut"); symlinkSync(directory, linked);
    const requested = join(linked, "handover.md");
    const capture = io();
    const api = mockFetch(async (url, init) => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      if (url.pathname.startsWith("/upload/")) {
        expect(await new Response(init.body).text()).toContain("# handover");
        return json({ attachmentDataRef: REF });
      }
      return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD } });
    });
    expect(await main(["send", "--attach", requested, "--dry-run"], { paths, fetcher: api.fetcher, stdin: () => "", ...capture })).toBe(0);
    expect(capture.output[0]).toContain(`경로: ${JSON.stringify(realpathSync(path))}`);
    expect(api.calls).toHaveLength(0);
    expect(await main(["send", "--attach", requested], { paths, fetcher: api.fetcher, stdin: () => "", ...capture })).toBe(0);
    expect(capture.output[1]).toContain(`첨부 경로: ${JSON.stringify(realpathSync(path))}`);
    expect(capture.output.join("\n")).not.toContain(requested);
  });

  test("없는 파일·디렉터리·200MB 초과·10개 초과는 업로드/인증 전에 거절한다", async () => {
    const paths = fixture();
    const valid = join(paths.home, "valid.md"); writeFileSync(valid, "ok");
    const large = join(paths.home, "large.dat");
    const fd = openSync(large, "w"); ftruncateSync(fd, MAX_UPLOAD_BYTES + 1); closeSync(fd);
    const api = mockFetch(() => { throw new Error("API 호출 금지"); });
    for (const bad of [join(paths.home, "absent"), paths.home, large]) {
      const capture = io();
      expect(await main(["send", "--attach", valid, "--attach", bad], { paths, fetcher: api.fetcher, stdin: () => "본문", ...capture })).toBe(1);
      expect(capture.errors.join("\n")).toContain("첨부");
    }
    expect(await main(["send", ...Array.from({ length: 11 }, () => ["--attach", valid]).flat()], { paths, fetcher: api.fetcher, ...io() })).toBe(1);
    expect(api.calls).toHaveLength(0);
    expect(validateUploadFiles([])).toEqual([]);
    expect(() => parseArguments("fetch", ["--attach", valid])).toThrow();
    expect(() => parseArguments("send", ["--attach"])).toThrow("파일 경로");
    expect(() => parseArguments("send", ["--attach", " "])).toThrow("비어 있지 않은");
  });

  test("정확히 200MB·최대 10개는 검증하며 dry-run은 내용 대신 경로·이름·크기를 출력하고 업로드하지 않는다", async () => {
    const paths = fixture(false);
    const path = join(paths.home, "handover.md");
    const fd = openSync(path, "w"); ftruncateSync(fd, MAX_UPLOAD_BYTES); closeSync(fd);
    const ten = validateUploadFiles(Array.from({ length: 10 }, () => path));
    expect(ten).toHaveLength(10); closeUploadFiles(ten);
    const original = readFileSync(paths.configFile, "utf8");
    const capture = io();
    const api = mockFetch(() => { throw new Error("API 호출 금지"); });
    expect(await main(["send", "--attach", path, "--thread", THREAD, "--no-tag", "--dry-run", "--save", "preview"], { paths, fetcher: api.fetcher, stdin: () => "", env: {}, ...capture })).toBe(0);
    const preview = capture.output.join("\n");
    expect(preview).toContain(`경로: ${JSON.stringify(path)}`);
    expect(preview).toContain('이름: "handover.md"');
    expect(preview).toContain(`크기: ${MAX_UPLOAD_BYTES} bytes`);
    expect(preview).toContain("텍스트 없이 첨부만 전송");
    expect(preview).toContain(THREAD);
    expect(api.calls).toHaveLength(0);
    expect(readFileSync(paths.configFile, "utf8")).toBe(original);
  });

  test("업로드가 중간 실패/401/403이면 메시지를 보내지 않고 성공한 업로드 무시 안내, 재시도도 하지 않는다", async () => {
    for (const status of [401, 403, 503]) {
      const paths = fixture();
      saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
      const path = join(paths.home, "handover.md"); writeFileSync(path, "# spec");
      let uploads = 0;
      const capture = io();
      const api = mockFetch(async (url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
        expect(url.pathname).toStartWith("/upload/");
        uploads++;
        await new Response(init.body).arrayBuffer();
        return uploads === 1 ? json({ attachmentDataRef: REF }) : json({ error: { message: "fixture-upload-secret" } }, status);
      });
      expect(await main(["send", "--wait", "--attach", path, "--attach", path], { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", ...capture })).toBe(3);
      expect(uploads).toBe(2);
      expect(api.calls.filter(call => call.url.hostname === "oauth2.googleapis.com")).toHaveLength(1);
      expect(capture.output).toHaveLength(0);
      const errors = capture.errors.join("\n");
      expect(errors).toContain("메시지를 보내지 않았습니다");
      expect(errors).toContain("이미 올라간 업로드는 무시해도 됩니다 (성공 응답 1개)");
      expect(errors).not.toContain("전송은 완료됨");
      expect(errors).not.toContain("fixture-upload-secret");
      if (status === 403) expect(errors).toContain("권한 부족 — 기존 chat.messages.create 권한");
    }
  });

  test("업로드 응답 ref가 잘못되거나 검증 후 파일이 바뀌면 메시지를 생성하지 않는다", async () => {
    const paths = fixture();
    const path = join(paths.home, "handover.md"); writeFileSync(path, "# spec");
    for (const ref of [undefined, {}, { resourceName: 42 }, { attachmentUploadToken: 42 }]) {
      const api = mockFetch(async (url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
        expect(url.pathname).toStartWith("/upload/");
        await new Response(init.body).arrayBuffer();
        return json({ attachmentDataRef: ref });
      });
      expect(await main(["send", "--attach", path], { paths, fetcher: api.fetcher, env: {}, stdin: () => "본문", ...io() })).toBe(3);
      expect(api.calls).toHaveLength(2);
    }
    const files = validateUploadFiles([path]);
    try {
      writeFileSync(path, "changed-size");
      expect(() => multipartUpload(files[0]!)).toThrow("첨부 파일이 검증 후 바뀌었습니다 — 내용을 확인하고 다시 승인받으세요");
    } finally { closeUploadFiles(files); }
  });

  test("업로드 중 시그널은 메시지 미전송을 안내하며 전송 여부 불확실/exit 5를 표시하지 않는다", async () => {
    const paths = fixture();
    saveToken(paths.tokenFile, { ...loadToken(paths.tokenFile), user_name: SELF });
    const path = join(paths.home, "handover.md"); writeFileSync(path, "# spec");
    const capture = io();
    const api = mockFetch(url => {
      if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
      expect(url.pathname).toStartWith("/upload/");
      process.emit("SIGINT");
      throw new Error("중단");
    });
    expect(await main(["send", "--wait", "--attach", path], { paths, env: {}, fetcher: api.fetcher, stdin: () => "본문", ...capture })).toBe(130);
    expect(capture.errors.join("\n")).toContain("메시지를 보내지 않았습니다");
    expect(capture.errors.join("\n")).not.toContain("전송 여부 불확실");
    expect(capture.output).toHaveLength(0);
  });

  test("업로드 중 덮어쓰기·축소 오류는 fetch가 감싸도 원래 사유와 재승인 안내를 표시하고 재시도하지 않는다", async () => {
    for (const change of ["overwrite", "truncate"] as const) {
      const paths = fixture();
      const path = join(paths.home, "changing.md");
      const size = 128 * 1024 + 1;
      writeFileSync(path, Buffer.alloc(size, 65));
      let messages = 0;
      const streamErrors: unknown[] = [];
      const capture = io();
      const api = mockFetch(async (url, init) => {
        if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "fixture-access" });
        if (url.pathname.startsWith("/upload/")) {
          if (!(init.body instanceof ReadableStream)) throw new Error("스트림 본문 필요");
          const reader = init.body.getReader();
          try {
            await reader.read(); // multipart 헤더
            const first = await reader.read();
            expect(first.value?.byteLength).toBe(64 * 1024);
            writeFileSync(path, change === "overwrite" ? Buffer.alloc(size, 66) : "");
            // 파일시스템 시각 해상도와 무관하게 mtime 변경을 고정한다.
            utimesSync(path, new Date("2030-01-01T00:00:00Z"), new Date("2030-01-01T00:00:00Z"));
            while (!(await reader.read()).done) { /* 마지막 검사까지 소비한다. */ }
          } catch (error: unknown) { streamErrors.push(error); throw new TypeError("fetch가 숨긴 스트림 오류"); }
          finally { reader.releaseLock(); }
          return json({ attachmentDataRef: REF });
        }
        messages++;
        return json({ name: `${SPACE}/messages/sent`, thread: { name: THREAD } });
      });
      expect(await main(["send", "--attach", path], { paths, fetcher: api.fetcher, stdin: () => "본문", ...capture })).toBe(1);
      expect(streamErrors).toHaveLength(1);
      expect(String(streamErrors[0])).toContain("첨부 파일이 업로드 중 바뀌었습니다");
      expect(messages).toBe(0);
      const errors = capture.errors.join("\n");
      expect(errors).toContain("메시지를 보내지 않았습니다");
      expect(errors).toContain("첨부 파일이 업로드 중 바뀌었습니다 — 내용을 확인하고 다시 승인받으세요");
      expect(errors).toContain("이 오류는 재시도 대상이 아닙니다");
      expect(errors).not.toContain("네트워크");
      expect(errors).not.toContain("fetch가 숨긴 스트림 오류");
      expect(api.calls.filter(call => call.url.pathname.startsWith("/upload/"))).toHaveLength(1);
      expect(capture.output).toHaveLength(0);
    }
  });
});
