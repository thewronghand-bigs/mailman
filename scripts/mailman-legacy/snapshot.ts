export type SnapshotMessage = {
  id: string;
  threadName: string | null;
  createTime: string;
  senderDisplayName: string;
  text: string;
};

function isSnapshotMessage(value: unknown): value is SnapshotMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    (typeof candidate.threadName === "string" || candidate.threadName === null) &&
    typeof candidate.createTime === "string" &&
    typeof candidate.senderDisplayName === "string" &&
    typeof candidate.text === "string"
  );
}

export function parseSnapshotJson(raw: string): SnapshotMessage[] {
  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown[] }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : null;

  if (!items) {
    throw new Error("[mailman] snapshot JSON 형식이 올바르지 않습니다. 배열 또는 { messages: [] } 형식이어야 합니다.");
  }

  const messages = items.filter(isSnapshotMessage);
  if (messages.length !== items.length) {
    throw new Error("[mailman] snapshot JSON 안에 필수 필드(id, threadName, createTime, senderDisplayName, text)가 없는 항목이 있습니다.");
  }

  return messages;
}
