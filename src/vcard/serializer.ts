import { ParsedVCard, StructuredName, TypedValue } from './types.js';
import { escapeText, escapeTextList } from './escaping.js';

/** RFC 6350：逻辑行 UTF-8 字节数不超过 75，续行以 CRLF + 空格折叠 */
const MAX_LINE_BYTES = 75;

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * 按 UTF-8 字节边界折叠：绝不在一个字符中间断开。
 * 首行最多 MAX_LINE_BYTES 字节，后续续行内容（含前导空格）同样受限。
 */
export function foldLine(content: string): string {
  if (byteLength(content) <= MAX_LINE_BYTES) return content;

  const lines: string[] = [];
  let remaining = content;
  let first = true;

  while (byteLength(remaining) > (first ? MAX_LINE_BYTES : MAX_LINE_BYTES - 1)) {
    const budget = first ? MAX_LINE_BYTES : MAX_LINE_BYTES - 1;
    let take = 0;
    let usedBytes = 0;
    // 逐字符累加，保证不切断多字节字符
    for (const ch of remaining) {
      const cb = byteLength(ch);
      if (usedBytes + cb > budget) break;
      usedBytes += cb;
      take += ch.length;
    }
    lines.push(first ? remaining.slice(0, take) : ' ' + remaining.slice(0, take));
    remaining = remaining.slice(take);
    first = false;
  }
  if (remaining.length > 0) {
    lines.push(first ? remaining : ' ' + remaining);
  }
  return lines.join('\r\n');
}

function formatParams(tv: TypedValue): string {
  const parts: string[] = [];
  if (tv.types.length > 0) parts.push(`TYPE=${tv.types.join(',').toUpperCase()}`);
  for (const [key, val] of Object.entries(tv.params)) parts.push(`${key}=${quoteParam(val)}`);
  return parts.length > 0 ? ';' + parts.join(';') : '';
}

/** 参数值含 ; : , 时按 RFC 6350 加双引号 */
function quoteParam(value: string): string {
  return /[;:,]/.test(value) ? `"${value}"` : value;
}

function serializeN(n: StructuredName | null): string {
  const s = n ?? {
    familyNames: [],
    givenNames: [],
    additionalNames: [],
    honorificPrefixes: [],
    honorificSuffixes: [],
  };
  return [
    escapeTextList(s.familyNames),
    escapeTextList(s.givenNames),
    escapeTextList(s.additionalNames),
    escapeTextList(s.honorificPrefixes),
    escapeTextList(s.honorificSuffixes),
  ].join(';');
}

/** 将一张名片序列化为 vCard 4.0 文本（CRLF 行尾，无末尾多余空行） */
export function serializeCard(card: ParsedVCard): string {
  const out: string[] = [];
  out.push(foldLine('BEGIN:VCARD'));
  out.push(foldLine('VERSION:4.0'));
  out.push(foldLine(`FN:${escapeText(card.fn)}`));
  out.push(foldLine(`N:${serializeN(card.n)}`));
  out.push(foldLine(`UID:${escapeText(card.uid)}`));

  for (const tel of card.tels) {
    out.push(foldLine(`TEL${formatParams(tel)}:${escapeText(tel.value)}`));
  }
  for (const email of card.emails) {
    out.push(foldLine(`EMAIL${formatParams(email)}:${escapeText(email.value)}`));
  }

  for (const prop of card.unknown) {
    const paramParts = Object.entries(prop.params).map(([k, v]) => `${k}=${quoteParam(v)}`);
    const paramStr = paramParts.length > 0 ? ';' + paramParts.join(';') : '';
    const prefix = prop.group ? `${prop.group}.` : '';
    out.push(foldLine(`${prefix}${prop.name}${paramStr}:${prop.rawValue}`));
  }

  out.push(foldLine('END:VCARD'));
  return out.join('\r\n');
}

export function serializeCards(cards: ParsedVCard[]): string {
  return cards.map(serializeCard).join('\r\n');
}
