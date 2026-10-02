import type { ContactRecord, ParsedCard, RawProperty, StructuredName, TypedValue } from "../types.js";

/**
 * vCard 4.0 序列化：TEXT 转义 + UTF-8 字节安全折叠（RFC 6350 3.2，
 * 逻辑行不含换行时不超过 75 个八位组，超长处插入 CRLF + 空格）。
 */

const MAX_OCTETS = 75;

/** TEXT 值转义：反斜杠、逗号、分号与换行。 */
export function escapeText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === ";") out += "\\;";
    else if (ch === ",") out += "\\,";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "";
    else out += ch;
  }
  return out;
}

/** 非 TEXT 值（TEL）仅转义反斜杠与换行；不引入对逗号/分号的改写。 */
function escapeUriLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n");
}

function encodeN(n: StructuredName): string {
  const keys: (keyof StructuredName)[] = [
    "familyNames",
    "givenNames",
    "additionalNames",
    "honorificPrefixes",
    "honorificSuffixes",
  ];
  return keys
    .map((key) => n[key].map((x) => escapeText(x)).join(","))
    .join(";");
}

function typeParam(v: TypedValue): string {
  return v.types.length ? `;TYPE=${v.types.join(",")}` : "";
}

function unknownLine(p: RawProperty): string {
  const head = p.params ? `${p.name};${p.params}` : p.name;
  return `${head}:${escapeText(p.value)}`;
}

/** 生成折叠前的逻辑行。 */
function logicalLines(card: ParsedCard | ContactRecord): string[] {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:4.0"];
  if (card.uid) lines.push(`UID:${escapeText(card.uid)}`);
  lines.push(`FN:${escapeText(card.fn ?? "")}`);
  if (card.n) lines.push(`N:${encodeN(card.n)}`);
  const tels = [...card.tels].sort((a, b) => a.ordinal - b.ordinal);
  const emails = [...card.emails].sort((a, b) => a.ordinal - b.ordinal);
  for (const t of tels) lines.push(`TEL${typeParam(t)}:${escapeUriLike(t.value)}`);
  for (const e of emails) lines.push(`EMAIL${typeParam(e)}:${escapeText(e.value)}`);
  for (const u of card.unknown) lines.push(unknownLine(u));
  lines.push("END:VCARD");
  return lines;
}

/**
 * 按 UTF-8 字节折叠单行：首段最多 75 字节，续行最多 74 字节
 * （续行带一个前导空格，连同内容不超过 75 字节）。绝不在字符中间断开。
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= MAX_OCTETS) return line;

  const segments: string[] = [];
  let first = true;
  let budget = MAX_OCTETS;
  let cur = "";
  let curBytes = 0;

  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (curBytes + chBytes > budget) {
      segments.push(cur);
      first = false;
      budget = MAX_OCTETS - 1; // 续行前导空格占 1 字节
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  if (cur) segments.push(cur);
  void first;
  return segments.map((seg, idx) => (idx === 0 ? seg : ` ${seg}`)).join("\r\n");
}

/** 导出一张或多张名片为 UTF-8 vCard 4.0 文本（CRLF，卡片间空行不加）。 */
export function serializeVCards(cards: (ParsedCard | ContactRecord)[]): string {
  return cards
    .map((card) => logicalLines(card).map(foldLine).join("\r\n"))
    .join("\r\n") + "\r\n";
}
