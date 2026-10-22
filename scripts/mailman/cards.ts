import { isRecord } from "./errors";

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00a0" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (entity: string, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? entity;
    const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code) : entity;
  });
}

function inlineHtml(text: string): string {
  return decodeEntities(text
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_match: string, double: string | undefined, single: string | undefined, bare: string | undefined, label: string) =>
        `[${label}](${double ?? single ?? bare ?? ""})`)
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<\/?b\b[^>]*>/gi, "**")
    .replace(/<\/?i\b[^>]*>/gi, "_")
    .replace(/<\/?[a-z][^>]*>/gi, ""));
}

export function renderCardHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  const parts: string[] = [];
  let start = 0;
  // 코드를 먼저 분리해 들여쓰기와 코드 안의 HTML/마크다운을 그대로 보존한다.
  for (const match of value.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>|<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi)) {
    parts.push(inlineHtml(value.slice(start, match.index)));
    const pre = match[1];
    const wrapped = pre?.match(/^\s*<code\b[^>]*>([\s\S]*?)<\/code\s*>\s*$/i);
    const code = decodeEntities(wrapped?.[1] ?? pre ?? match[2] ?? "");
    let fence = "```";
    for (const ticks of code.match(/`+/g) ?? []) {
      if (ticks.length >= fence.length) fence = "`".repeat(ticks.length + 1);
    }
    parts.push(`\n\n${fence}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}\n\n`);
    start = match.index + match[0].length;
  }
  parts.push(inlineHtml(value.slice(start)));
  return parts.join("").trim();
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function fields(record: Record<string, unknown>, names: string[]): string[] {
  return names.map(name => renderCardHtml(record[name])).filter(Boolean);
}

function renderWidgets(value: unknown, depth = 0): string {
  // 비정상적으로 깊은 중첩도 조회 전체를 실패시키지 않게 한다.
  if (depth > 20) return "";
  return records(value).map(widget => {
    if (isRecord(widget.textParagraph)) return renderCardHtml(widget.textParagraph.text);
    if (isRecord(widget.decoratedText)) return fields(widget.decoratedText, ["topLabel", "text", "bottomLabel"]).join("\n");
    if (isRecord(widget.buttonList)) {
      return records(widget.buttonList.buttons).map(button => {
        const label = renderCardHtml(button.text);
        const link = isRecord(button.onClick) && isRecord(button.onClick.openLink) ? button.onClick.openLink : undefined;
        const url = typeof link?.url === "string" ? decodeEntities(link.url).trim() : "";
        return url ? `[${label || url}](${url})` : label;
      }).filter(Boolean).join("\n");
    }
    if (isRecord(widget.columns)) {
      return records(widget.columns.columnItems).map(column => renderWidgets(column.widgets, depth + 1)).filter(Boolean).join("\n\n");
    }
    if (isRecord(widget.grid)) return records(widget.grid.items).map(item => fields(item, ["title", "subtitle"]).join("\n")).filter(Boolean).join("\n\n");
    if (isRecord(widget.image)) return renderCardHtml(widget.image.altText);
    if (isRecord(widget.divider)) return "---";
    return "";
  }).filter(Boolean).join("\n\n");
}

function renderCard(card: Record<string, unknown>): string {
  const parts: string[] = [];
  const header = isRecord(card.header) ? fields(card.header, ["title", "subtitle"]).join(" - ") : "";
  if (header) parts.push(`**${header}**`);
  for (const section of records(card.sections)) {
    const heading = renderCardHtml(section.header);
    if (heading) parts.push(`### ${heading}`);
    const widgets = renderWidgets(section.widgets);
    if (widgets) parts.push(widgets);
  }
  return parts.join("\n\n") || "(카드)";
}

export function renderCards(json: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!isRecord(parsed)) return [];
  return [
    ...records(parsed.cardsV2).map(item => item.card),
    ...records(parsed.cards),
  ].filter(isRecord).map(renderCard);
}
