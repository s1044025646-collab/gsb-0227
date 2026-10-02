import { VCardError } from './errors.js';

/**
 * 反转义文本类型值（RFC 6350）。
 * \\n / \\N -> 换行，\\, -> 逗号，\\; -> 分号，\\\\ -> 反斜杠。
 * 其它反斜杠序列视为非法（BAD_ESCAPE），避免静默吞字符。
 */
export function unescapeText(raw: string, line: number): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) {
      throw new VCardError('BAD_ESCAPE', '值以孤立的反斜杠结尾', line, 0, raw);
    }
    switch (next) {
      case 'n':
      case 'N':
        out += '\n';
        break;
      case ',':
        out += ',';
        break;
      case ';':
        out += ';';
        break;
      case '\\':
        out += '\\';
        break;
      default:
        throw new VCardError(
          'BAD_ESCAPE',
          `非法转义序列 “\\${next}”，只允许 \\n \\, \\; \\\\`,
          line,
          0,
          raw,
        );
    }
    i++;
  }
  return out;
}

/**
 * 在尊重转义的前提下按单个分隔符切分（; 或 ,）。
 * 分隔符前若有反斜杠则视为普通字符。
 */
export function splitRespectingEscapes(raw: string, sep: ';' | ','): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      current += ch + raw[i + 1];
      i++;
    } else if (ch === sep) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/** 文本列表（逗号分隔，如 N 的每个组件） */
export function parseTextList(raw: string, line: number): string[] {
  const parts = splitRespectingEscapes(raw, ',');
  const values = parts.map((p) => unescapeText(p, line));
  if (values.length === 1 && values[0] === '') return [];
  return values;
}

/** 结构化姓名 N：必须恰好 5 个分号组件（空组件允许） */
export function unescapeTextValue(raw: string, line: number): string {
  // TEL/EMAIL 等 URI 或文本值也允许转义，按文本安全反转义
  return unescapeText(raw, line);
}

/** 转义文本值用于导出 */
export function escapeText(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case ';':
        out += '\\;';
        break;
      case ',':
        out += '\\,';
        break;
      case '\n':
        out += '\\n';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

export function escapeTextList(values: string[]): string {
  if (values.length === 0) return '';
  return values.map(escapeText).join(',');
}
