import type { ChatClient, CreatedMessage, MessageBody, UploadedAttachment } from "./chat";
import { MailmanError } from "./errors";

// prefix는 runtime.ts의 resolveSendPrefix가 정한다. 태그를 끈 전송은 빈 문자열이다.
export function buildMessageText(text: string, prefix: string, hasAttachments = false): string | undefined {
  if (text.trim()) return prefix + text;
  if (!hasAttachments) throw new MailmanError("빈 메시지는 전송하지 않습니다.");
  return prefix || undefined;
}

export function buildMessageBody(text: string, prefix: string, thread?: string, attachments: UploadedAttachment[] = []): MessageBody {
  const content = buildMessageText(text, prefix, attachments.length > 0);
  return { ...(content !== undefined ? { text: content } : {}), ...(thread ? { thread: { name: thread } } : {}),
    ...(attachments.length ? { attachment: attachments } : {}) };
}

export async function sendMessage(client: Pick<ChatClient, "createMessage">, space: string, text: string, prefix: string, thread?: string, waitMetadata = false, attachments: UploadedAttachment[] = []): Promise<CreatedMessage> {
  // 네트워크 실패/응답 유실에서도 자동 재시도하지 않는다.
  return client.createMessage(space, buildMessageBody(text, prefix, thread, attachments), waitMetadata);
}
