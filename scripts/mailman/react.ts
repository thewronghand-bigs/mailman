import type { ChatClient } from "./chat";
import { MailmanError } from "./errors";

export type ReactionEmoji = "👀" | "✅";

export function parseEmoji(value: string): ReactionEmoji {
  if (value === "👀" || value === "✅") return value;
  throw new MailmanError("리액션은 👀 또는 ✅만 허용합니다.");
}

export async function reactMessage(client: Pick<ChatClient, "createReaction">, name: string, emoji: ReactionEmoji): Promise<string> {
  const alreadyExists = await client.createReaction(name, emoji);
  return `${emoji} ${alreadyExists ? "이미 있음" : "리액션 완료"}\nmessage name: ${name}`;
}
