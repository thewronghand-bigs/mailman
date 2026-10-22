import type { ChatClient, CreatedMessage } from "./chat";
import { SEND_PREFIX } from "./content";
import { MailmanError } from "./errors";

export function buildMessageBody(text: string, thread?: string): { text: string; thread?: { name: string } } {
  if (!text.trim()) throw new MailmanError("빈 메시지는 전송하지 않습니다.");
  return { text: SEND_PREFIX + text, ...(thread ? { thread: { name: thread } } : {}) };
}

export async function sendMessage(client: Pick<ChatClient, "createMessage">, space: string, text: string, thread?: string): Promise<CreatedMessage> {
  // 네트워크 실패/응답 유실에서도 자동 재시도하지 않는다.
  return client.createMessage(space, buildMessageBody(text, thread));
}
