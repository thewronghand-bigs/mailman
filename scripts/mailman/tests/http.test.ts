import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatClient } from "../chat";
import { RequestError } from "../errors";
import { requestBytes, requestUploadJson, type TimeoutScheduler } from "../http";
import { closeUploadFiles, validateUploadFiles } from "../upload";
import { cleanupFixtures, fixture, json, mockFetch, SPACE } from "./helpers";

afterEach(cleanupFixtures);

const URL_MEDIA = new URL("https://chat.googleapis.com/v1/media/fixture-ref?alt=media");
const URL_UPLOAD = new URL(`https://chat.googleapis.com/upload/v1/${SPACE}/attachments:upload?uploadType=multipart`);
const INIT = { method: "GET", headers: { Authorization: "Bearer fixture-access" } };
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function timers() {
  let now = 0, nextId = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const schedule: TimeoutScheduler = (callback, milliseconds) => {
    const id = nextId++;
    pending.set(id, { at: now + milliseconds, callback });
    return () => { pending.delete(id); };
  };
  return {
    schedule, pending,
    advance(milliseconds: number) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        pending.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  return { response, controller, cancelled: () => cancelled };
}

describe("첨부 업로드 시간 제한", () => {
  test("실제 multipart 본문을 느리게 소비해도 전송 진척이 있으면 30초를 넘겨 성공한다", async () => {
    const paths = fixture(false), clock = timers();
    const path = join(paths.home, "slow.dat"); writeFileSync(path, Buffer.alloc(256 * 1024, 65));
    const files = validateUploadFiles([path]);
    let elapsed = 0, bytes = 0;
    const api = mockFetch(async (_url, init) => {
      expect(clock.pending.size).toBe(2);
      expect(init.redirect).toBe("error");
      if (!(init.body instanceof ReadableStream)) throw new Error("스트림 본문 필요");
      const reader = init.body.getReader();
      try {
        for (;;) {
          clock.advance(20_000); elapsed += 20_000;
          const chunk = await reader.read();
          expect(init.signal?.aborted).toBe(false);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
        }
      } finally { reader.releaseLock(); }
      return json({ attachmentDataRef: { resourceName: "fixture-upload-ref" } });
    });
    try {
      const client = new ChatClient("fixture-access", api.fetcher, undefined, undefined, clock.schedule);
      expect(await client.uploadAttachment(SPACE, files[0]!)).toEqual({ attachmentDataRef: { resourceName: "fixture-upload-ref" } });
      expect(elapsed).toBeGreaterThan(30_000);
      expect(bytes).toBe(Number(new Headers(api.calls[0]!.init.headers).get("Content-Length")));
      expect(api.calls).toHaveLength(1);
      expect(clock.pending.size).toBe(0);
    } finally { closeUploadFiles(files); }
  });

  test("응답 헤더 대기에도 60초 무진척이면 중단하고 본문·타이머를 정리한다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = requestUploadJson(api.fetcher, URL_UPLOAD, { method: "POST", body: stream.response.body! }, clock.schedule).catch((error: unknown) => error);
    clock.advance(59_999);
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("60초 동안 전송 진척이 없어");
    expect(stream.cancelled()).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(clock.pending.size).toBe(0);
  });

  test("마지막 전송부터 60초 뒤 중단하며 0바이트 chunk는 유휴 시간을 갱신하지 않는다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch(async (_url, init) => { await new Response(init.body).arrayBuffer(); return json({}); });
    const pending = requestUploadJson(api.fetcher, URL_UPLOAD, { method: "POST", body: stream.response.body! }, clock.schedule).catch((error: unknown) => error);
    await settle();
    clock.advance(40_000);
    stream.controller.enqueue(Buffer.from("a"));
    await settle();
    clock.advance(59_999);
    stream.controller.enqueue(new Uint8Array(0));
    await settle();
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("60초 동안 전송 진척이 없어");
    expect(stream.cancelled()).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(clock.pending.size).toBe(0);
  });

  test("전송 진척이 계속 있어도 전체 30분 상한에서 중단한다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch(async (_url, init) => { await new Response(init.body).arrayBuffer(); return json({}); });
    const pending = requestUploadJson(api.fetcher, URL_UPLOAD, { method: "POST", body: stream.response.body! }, clock.schedule).catch((error: unknown) => error);
    await settle();
    for (let index = 0; index < 44; index++) {
      clock.advance(40_000);
      stream.controller.enqueue(Buffer.from("a"));
      await settle();
    }
    clock.advance(39_999);
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("전체 상한(30분)");
    expect(stream.cancelled()).toBe(true);
    expect(api.calls).toHaveLength(1);
    expect(clock.pending.size).toBe(0);
  });

  test("호출자 중단과 연결 오류·비JSON 응답에서도 본문과 타이머를 정리한다", async () => {
    const clock = timers(), stream = streamResponse(), controller = new AbortController();
    const api = mockFetch(async (_url, init) => { await new Response(init.body).arrayBuffer(); return json({}); });
    const pending = requestUploadJson(api.fetcher, URL_UPLOAD, { method: "POST", body: stream.response.body!, signal: controller.signal }, clock.schedule).catch((error: unknown) => error);
    await settle();
    controller.abort("SIGTERM");
    expect(await pending).toMatchObject({ exitCode: 143 });
    expect(stream.cancelled()).toBe(true);
    expect(clock.pending.size).toBe(0);
    const before = api.calls.length, abortedStream = streamResponse();
    await expect(requestUploadJson(api.fetcher, URL_UPLOAD, { body: abortedStream.response.body!, signal: controller.signal }, clock.schedule)).rejects.toMatchObject({ exitCode: 143 });
    expect(api.calls).toHaveLength(before);
    expect(abortedStream.cancelled()).toBe(true);
    for (const invalidJson of [false, true]) {
      const source = streamResponse();
      const failed = mockFetch(() => { if (invalidJson) return new Response("비JSON"); throw new TypeError("비공개 연결 오류"); });
      await expect(requestUploadJson(failed.fetcher, URL_UPLOAD, { body: source.response.body! }, clock.schedule)).rejects.toBeInstanceOf(RequestError);
      expect(source.cancelled()).toBe(true);
      expect(clock.pending.size).toBe(0);
    }
  });
});

describe("첨부 다운로드 시간 제한", () => {
  test("30초를 넘겨도 바이트가 계속 도착하면 성공하고 타이머를 정리한다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch(() => stream.response);
    const pending = requestBytes(api.fetcher, URL_MEDIA, INIT, 10, clock.schedule);
    await settle();
    for (let index = 0; index < 4; index++) {
      clock.advance(20_000);
      stream.controller.enqueue(Buffer.from("a"));
      await settle();
      expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    }
    stream.controller.close();
    expect(await pending).toEqual(Buffer.from("aaaa"));
    expect(clock.pending.size).toBe(0);
  });

  test("응답 헤더를 기다리는 동안에도 30초 무응답이면 요청을 중단한다", async () => {
    const clock = timers();
    const api = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const pending = requestBytes(api.fetcher, URL_MEDIA, INIT, 10, clock.schedule).catch((error: unknown) => error);
    clock.advance(29_999);
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("30초 동안");
    expect(api.calls[0]!.init.signal?.aborted).toBe(true);
    expect(clock.pending.size).toBe(0);
  });

  test("마지막 바이트부터 30초 뒤 중단하며 0바이트 chunk는 유휴 시간을 갱신하지 않는다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch(() => stream.response);
    const pending = requestBytes(api.fetcher, URL_MEDIA, INIT, 10, clock.schedule).catch((error: unknown) => error);
    await settle();
    clock.advance(20_000);
    stream.controller.enqueue(Buffer.from("a"));
    await settle();
    clock.advance(29_999);
    stream.controller.enqueue(new Uint8Array(0));
    await settle();
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("30초 동안");
    expect(stream.cancelled()).toBe(true);
    expect(clock.pending.size).toBe(0);
  });

  test("바이트가 계속 도착해도 전체 10분 상한에서 중단한다", async () => {
    const clock = timers(), stream = streamResponse();
    const api = mockFetch(() => stream.response);
    const pending = requestBytes(api.fetcher, URL_MEDIA, INIT, 100, clock.schedule).catch((error: unknown) => error);
    await settle();
    for (let index = 0; index < 29; index++) {
      clock.advance(20_000);
      stream.controller.enqueue(Buffer.from("a"));
      await settle();
    }
    clock.advance(19_999);
    expect(api.calls[0]!.init.signal?.aborted).toBe(false);
    clock.advance(1);
    expect(String(await pending)).toContain("전체 상한(10분)");
    expect(stream.cancelled()).toBe(true);
    expect(clock.pending.size).toBe(0);
  });

  test("호출자 중단을 보존하고 크기 초과·네트워크 실패에서도 타이머를 정리한다", async () => {
    const clock = timers(), stream = streamResponse(), controller = new AbortController();
    const api = mockFetch(() => stream.response);
    const pending = requestBytes(api.fetcher, URL_MEDIA, { ...INIT, signal: controller.signal }, 10, clock.schedule).catch((error: unknown) => error);
    await settle();
    controller.abort("SIGTERM");
    expect(await pending).toMatchObject({ exitCode: 143 });
    expect(stream.cancelled()).toBe(true);
    expect(clock.pending.size).toBe(0);
    const before = api.calls.length;
    await expect(requestBytes(api.fetcher, URL_MEDIA, { signal: controller.signal }, 10, clock.schedule)).rejects.toMatchObject({ exitCode: 143 });
    expect(api.calls).toHaveLength(before);
    const large = mockFetch(() => new Response("large", { headers: { "Content-Length": "5" } }));
    await expect(requestBytes(large.fetcher, URL_MEDIA, INIT, 4, clock.schedule)).rejects.toThrow("4 bytes");
    expect(clock.pending.size).toBe(0);
    const failed = mockFetch(() => { throw new Error("연결 실패"); });
    await expect(requestBytes(failed.fetcher, URL_MEDIA, INIT, 4, clock.schedule)).rejects.toBeInstanceOf(RequestError);
    expect(clock.pending.size).toBe(0);
  });
});

describe("첨부 다운로드 수동 리다이렉트", () => {
  test("Google 세 도메인의 5회 리다이렉트를 따르고 호스트 변경 뒤 인증 헤더를 다시 붙이지 않는다", async () => {
    const locations = ["https://media.googleapis.com/file", "/relative", "https://download.googleusercontent.com/file",
      "https://content.google.com/file", "https://chat.googleapis.com/v1/media/final"];
    const statuses = [301, 302, 303, 307, 308];
    let cancelled = 0;
    const api = mockFetch((_url, init, index) => {
      expect(init.redirect).toBe("manual");
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).get("Authorization")).toBe(index === 0 ? "Bearer fixture-access" : null);
      return index < locations.length ? new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: statuses[index], headers: { Location: locations[index]! },
      }) : new Response("# handover");
    });
    expect(await new ChatClient("fixture-access", api.fetcher).downloadMedia("fixture-ref", 100)).toEqual(Buffer.from("# handover"));
    expect(api.calls).toHaveLength(6);
    expect(api.calls[2]!.url.href).toBe("https://media.googleapis.com/relative");
    expect(new Headers(api.calls[0]!.init.headers).get("Authorization")).toBe("Bearer fixture-access");
    expect(cancelled).toBe(5);
  });

  test("같은 호스트의 상대 주소 이동은 인증 헤더를 유지한다", async () => {
    const api = mockFetch((_url, init, index) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access");
      return index === 0 ? new Response(null, { status: 302, headers: { Location: "/v1/media/final" } }) : new Response("ok");
    });
    expect(await requestBytes(api.fetcher, URL_MEDIA, INIT, 10)).toEqual(Buffer.from("ok"));
    expect(api.calls).toHaveLength(2);
  });

  test("리다이렉트 응답은 유휴 시간을 갱신하지 않으며 다음 요청도 같은 제한으로 중단한다", async () => {
    const clock = timers();
    const api = mockFetch((_url, init, index) => {
      if (index === 0) {
        clock.advance(20_000);
        return new Response(null, { status: 302, headers: { Location: "https://download.googleusercontent.com/file" } });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = requestBytes(api.fetcher, URL_MEDIA, INIT, 10, clock.schedule).catch((error: unknown) => error);
    await settle();
    expect(api.calls).toHaveLength(2);
    expect(new Headers(api.calls[1]!.init.headers).has("Authorization")).toBe(false);
    clock.advance(10_000);
    expect(String(await pending)).toContain("30초 동안");
    expect(clock.pending.size).toBe(0);
  });

  test("허용되지 않은 호스트·유사 도메인·HTTP·URL 자격증명에는 요청과 인증 헤더를 보내지 않는다", async () => {
    for (const location of ["https://outside.example.test/file", "https://googleapis.com.evil.test/file", "https://evilgoogleapis.com/file",
      "https://googleusercontent.com.evil.test/file", "https://google.com.evil.test/file", "http://media.google.com/file",
      "https://user:password@media.google.com/file", "file:///tmp/fixture"]) {
      let cancelled = false;
      const api = mockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 302, headers: { Location: location } }));
      await expect(requestBytes(api.fetcher, URL_MEDIA, INIT, 10)).rejects.toThrow("Google HTTPS 호스트");
      expect(api.calls).toHaveLength(1);
      expect(cancelled).toBe(true);
    }
  });

  test("최대 5회 뒤 반복 리다이렉트와 누락·잘못된 Location을 거절한다", async () => {
    const loop = mockFetch((_url, _init, index) => new Response(null, { status: 302, headers: { Location: `/loop-${index}` } }));
    await expect(requestBytes(loop.fetcher, URL_MEDIA, INIT, 10)).rejects.toThrow("최대 5회");
    expect(loop.calls).toHaveLength(6);
    for (const location of [undefined, "", "https://["]) {
      const api = mockFetch(() => new Response(null, { status: 302, headers: location === undefined ? {} : { Location: location } }));
      await expect(requestBytes(api.fetcher, URL_MEDIA, INIT, 10)).rejects.toThrow("주소가 올바르지");
      expect(api.calls).toHaveLength(1);
    }
  });

  test("리다이렉트 뒤 HTTP 오류 상태를 보존하고 JSON·비JSON 오류를 처리한다", async () => {
    for (const status of [401, 404, 429, 503]) {
      for (const content of [JSON.stringify({ error: { message: "고정 API 오류" } }), "비JSON 오류"]) {
        const api = mockFetch((_url, _init, index) => index === 0
          ? new Response(null, { status: 302, headers: { Location: "https://media.googleapis.com/file" } })
          : new Response(content, { status }));
        const error = await requestBytes(api.fetcher, URL_MEDIA, INIT, 10).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(RequestError);
        expect(error).toMatchObject({ status, exitCode: 3 });
        expect(api.calls).toHaveLength(2);
      }
    }
  });
});
