import type { ChatClient, CreatedMessage } from "./chat";
import { MailmanError } from "./errors";

// prefix는 runtime.ts의 resolveSendPrefix가 정한다. 태그를 끈 전송은 빈 문자열이다.
export function buildMessageBody(text: string, prefix: string, thread?: string): { text: string; thread?: { name: string } } {
  if (!text.trim()) throw new MailmanError("빈 메시지는 전송하지 않습니다.");
  return { text: prefix + text, ...(thread ? { thread: { name: thread } } : {}) };
}

export async function sendMessage(client: Pick<ChatClient, "createMessage">, space: string, text: string, prefix: string, thread?: string): Promise<CreatedMessage> {
  // 네트워크 실패/응답 유실에서도 자동 재시도하지 않는다.
  return client.createMessage(space, buildMessageBody(text, prefix, thread));
}
