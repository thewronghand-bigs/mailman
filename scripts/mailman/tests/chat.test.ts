import { describe, expect, test } from "bun:test";
import { ChatClient, parseMessage } from "../chat";
import { SEND_PREFIX } from "../content";
import { buildMessageBody, sendMessage } from "../send";
import { json, message, mockFetch, SPACE, THREAD } from "./helpers";

describe("Chat API 목록", () => {
  test("필터/정렬/페이지 크기를 유지하며 빈 중간 페이지도 끝까지 수집한다", async () => {
    const after = "2026-10-20T00:00:00.000000001Z";
    const { fetcher, calls } = mockFetch((url, init, index) => {
      expect(url.origin).toBe("https://chat.googleapis.com");
      expect(url.pathname).toBe(`/v1/${SPACE}/messages`);
      expect(url.searchParams.get("filter")).toBe(`createTime > "${after}"`);
      expect(url.searchParams.get("orderBy")).toBe("createTime asc");
      expect(url.searchParams.get("pageSize")).toBe("100");
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-access-secret");
      expect(url.toString()).not.toContain("fixture-access-secret");
      expect(url.searchParams.get("pageToken")).toBe([null, "next-1", "next-2"][index]!);
      return json([
        { messages: [message("one")], nextPageToken: "next-1" },
        { nextPageToken: "next-2" },
        { messages: [message("two")] },
      ][index]);
    });
    const result = await new ChatClient("fixture-access-secret", fetcher).listMessages(SPACE, after);
    expect(result.map(item => item.name)).toEqual([`${SPACE}/messages/one`, `${SPACE}/messages/two`]);
    expect(calls).toHaveLength(3);
  });

  test("메시지가 없는 스페이스의 빈 객체 응답을 허용한다", async () => {
    const { fetcher } = mockFetch(() => json({}));
    expect(await new ChatClient("fixture-access-secret", fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z")).toEqual([]);
  });

  test("첨부의 실제 API 필드 contentName/contentType/name을 검증한다", () => {
    const attachment = [{ name: `${SPACE}/messages/one/attachments/file`, contentName: "명세.pdf", contentType: "application/pdf" }];
    expect(parseMessage(message("one", undefined, { attachment }), SPACE).attachment).toEqual(attachment);
    for (const field of ["contentName", "contentType", "name"]) {
      expect(() => parseMessage({ ...message("bad"), attachment: [{ [field]: 123 }] }, SPACE)).toThrow("응답 형식");
    }
  });

  test("페이지 상한과 반복 토큰에서 실패한다", async () => {
    const limited = mockFetch((_url, _init, index) => json({ nextPageToken: `page-${index}` }));
    await expect(new ChatClient("fixture-access-secret", limited.fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z", 2)).rejects.toThrow("수집 상한");
    expect(limited.calls).toHaveLength(2);
    const repeated = mockFetch(() => json({ nextPageToken: "same" }));
    await expect(new ChatClient("fixture-access-secret", repeated.fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z")).rejects.toThrow("반복");
    expect(repeated.calls).toHaveLength(2);
  });

  test("HTTP 상태와 Google 에러 메시지를 보존하고 인증정보는 지운다", async () => {
    const { fetcher } = mockFetch(() => json({ error: { message: "Permission denied: fixture-access-secret\n문의" } }, 403));
    await expect(new ChatClient("fixture-access-secret", fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z"))
      .rejects.toThrow("HTTP 403: Permission denied: [비공개] 문의");
  });

  test("비JSON/연결 오류/잘못된 응답에 요청 원문을 노출하지 않는다", async () => {
    const html = mockFetch(() => new Response("fixture-access-secret", { status: 502 }));
    await expect(new ChatClient("fixture-access-secret", html.fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z")).rejects.toThrow("HTTP 502");
    const network = mockFetch(() => { throw new Error("fixture-access-secret"); });
    await expect(new ChatClient("fixture-access-secret", network.fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z")).rejects.toThrow("네트워크 요청");
    const malformed = mockFetch(() => json({ messages: [message("bad", "not-a-timestamp")] }));
    await expect(new ChatClient("fixture-access-secret", malformed.fetcher).listMessages(SPACE, "2026-10-20T00:00:00Z")).rejects.toThrow("RFC3339");
  });
});

describe("전송", () => {
  test("본문 앞에 공통 태그를 붙이고 줄바꿈을 유지한다", () => {
    expect(buildMessageBody("첫 줄\n둘째 줄")).toEqual({ text: `${SEND_PREFIX}첫 줄\n둘째 줄` });
    expect(() => buildMessageBody(" \n\t")).toThrow("빈 메시지");
  });

  test("새 메시지는 thread/query 없이 전송하고 생성 이름을 반환한다", async () => {
    const { fetcher, calls } = mockFetch((url, init) => {
      expect(url.search).toBe("");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ text: `${SEND_PREFIX}확인했습니다` });
      return json({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
    });
    expect(await sendMessage(new ChatClient("fixture-access-secret", fetcher), SPACE, "확인했습니다"))
      .toEqual({ name: `${SPACE}/messages/created`, thread: { name: THREAD } });
    expect(calls).toHaveLength(1);
  });

  test("답글은 thread.name과 fallback 옵션을 보낸다", async () => {
    const { fetcher } = mockFetch((url, init) => {
      expect(url.searchParams.get("messageReplyOption")).toBe("REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
      expect(JSON.parse(String(init.body))).toEqual({ text: `${SEND_PREFIX}답글`, thread: { name: THREAD } });
      return json({ name: `${SPACE}/messages/reply`, thread: { name: THREAD } });
    });
    await sendMessage(new ChatClient("fixture-access-secret", fetcher), SPACE, "답글", THREAD);
  });

  test("빈 본문/다른 스페이스 thread는 호출하지 않고 HTTP 실패는 재시도하지 않는다", async () => {
    const { fetcher, calls } = mockFetch(() => json({ error: { message: "일시 오류" } }, 503));
    const client = new ChatClient("fixture-access-secret", fetcher);
    await expect(sendMessage(client, SPACE, "")).rejects.toThrow("빈 메시지");
    await expect(sendMessage(client, SPACE, "답글", "spaces/other/threads/thread")).rejects.toThrow("대상 스페이스");
    expect(calls).toHaveLength(0);
    await expect(sendMessage(client, SPACE, "답글")).rejects.toThrow("HTTP 503: 일시 오류");
    expect(calls).toHaveLength(1);
  });
});
