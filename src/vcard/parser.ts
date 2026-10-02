import { VCardError } from './errors.js';
import { LogicalLine } from './lexer.js';
import {
  emptyStructuredName,
  ParsedVCard,
  RawProperty,
  StructuredName,
  SUPPORTED_PROPERTIES,
  TypedValue,
} from './types.js';
import {
  parseTextList,
  splitRespectingEscapes,
  unescapeText,
  unescapeTextValue,
} from './escaping.js';

interface ContentLine {
  group: string;
  name: string;
  params: Record<string, string>;
  value: string;
  line: number;
}

/** 在尊重引号的前提下找到第一个未被引用的字符位置（用于参数部分切分） */
function findUnquoted(s: string, target: string, from = 0): number {
  let inQuotes = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === target) return i;
  }
  return -1;
}

/** 解析属性参数段，参数值引号内的 ; : , 视为普通字符 */
function parseParams(paramText: string, line: number): Record<string, string> {
  const params: Record<string, string> = {};
  if (paramText === '') return params;
  const segments: string[] = [];
  let rest = paramText;
  for (;;) {
    const idx = findUnquoted(rest, ';');
    if (idx === -1) {
      segments.push(rest);
      break;
    }
    segments.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  for (const seg of segments) {
    const eq = seg.indexOf('=');
    if (eq === -1) {
      throw new VCardError('BAD_PARAM', `参数 “${seg}” 缺少 “=”`, line, 0, paramText);
    }
    const key = seg.slice(0, eq).trim().toUpperCase();
    let value = seg.slice(eq + 1);
    if (key === '') {
      throw new VCardError('BAD_PARAM', '参数名为空', line, 0, paramText);
    }
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (value === '') {
      throw new VCardError('BAD_PARAM', `参数 ${key} 的值为空`, line, 0, paramText);
    }
    params[key] = value;
  }
  return params;
}

/** 解析一条内容行为 name / params / value */
function parseContentLine(ll: LogicalLine): ContentLine {
  const colon = findUnquoted(ll.text, ':');
  if (colon === -1) {
    throw new VCardError('BAD_LINE', '内容行缺少冒号 “:”', ll.line, 0, ll.text);
  }
  const head = ll.text.slice(0, colon);
  const value = ll.text.slice(colon + 1);
  if (head === '') {
    throw new VCardError('BAD_LINE', '内容行属性名为空', ll.line);
  }

  let group = '';
  let namePart = head;
  const dot = head.indexOf('.');
  if (dot !== -1) {
    group = head.slice(0, dot);
    namePart = head.slice(dot + 1);
  }
  const semi = namePart.indexOf(';');
  let name: string;
  let paramText: string;
  if (semi === -1) {
    name = namePart;
    paramText = '';
  } else {
    name = namePart.slice(0, semi);
    paramText = namePart.slice(semi + 1);
  }
  name = name.toUpperCase();
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    throw new VCardError('BAD_LINE', `非法属性名 “${name}”`, ll.line);
  }
  const params = parseParams(paramText, ll.line);
  return { group, name, params, value, line: ll.line };
}

/** TYPE 参数本身可能是逗号分隔的多值（引号内外均支持） */
function extractTypes(params: Record<string, string>): {
  types: string[];
  rest: Record<string, string>;
} {
  const types: string[] = [];
  const rest: Record<string, string> = {};
  for (const [key, val] of Object.entries(params)) {
    if (key === 'TYPE') {
      for (const t of val.split(',')) {
        const trimmed = t.trim();
        if (trimmed !== '') types.push(trimmed.toLowerCase());
      }
    } else {
      rest[key] = val;
    }
  }
  return { types, rest };
}

function parseN(raw: string, line: number): StructuredName {
  const components = splitRespectingEscapes(raw, ';');
  if (components.length !== 5) {
    throw new VCardError(
      'N_COMPONENT_COUNT',
      `N 必须包含 5 个分号分隔组件，实际为 ${components.length} 个`,
      line,
      0,
      raw,
    );
  }
  const [family, given, additional, prefix, suffix] = components;
  return {
    familyNames: parseTextList(family, line),
    givenNames: parseTextList(given, line),
    additionalNames: parseTextList(additional, line),
    honorificPrefixes: parseTextList(prefix, line),
    honorificSuffixes: parseTextList(suffix, line),
  };
}

/** 解析单张名片（已切分好的逻辑行，含 BEGIN/END） */
export function parseCard(lines: LogicalLine[], cardIndex = 0): ParsedVCard {
  const wrap = (e: unknown): never => {
    if (e instanceof VCardError) throw e.withCardIndex(cardIndex);
    throw e;
  };

  let versionSeen = false;
  let fn: string | null = null;
  let uid: string | null = null;
  let n: StructuredName | null = null;
  const tels: TypedValue[] = [];
  const emails: TypedValue[] = [];
  const unknown: RawProperty[] = [];
  const notes: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const ll = lines[i];
    const upper = ll.text.toUpperCase();
    if (i === 0 && upper !== 'BEGIN:VCARD') {
      return wrap(new VCardError('NOT_VCARD', '名片必须以 BEGIN:VCARD 开始', ll.line));
    }
    if (i === lines.length - 1 && upper !== 'END:VCARD') {
      return wrap(new VCardError('BAD_END', '名片必须以 END:VCARD 结束', ll.line));
    }
    if (upper === 'BEGIN:VCARD' || upper === 'END:VCARD') continue;

    const cl = parseContentLine(ll);
    try {
      switch (cl.name) {
        case 'VERSION': {
          if (cl.value.trim() !== '4.0') {
            throw new VCardError(
              'UNSUPPORTED_VERSION',
              `仅支持 vCard 4.0（VERSION:4.0），实际版本为 “${cl.value}”`,
              cl.line,
            );
          }
          versionSeen = true;
          break;
        }
        case 'FN':
          if (fn !== null) notes.push(`第 ${cl.line} 行的重复 FN 已忽略，以首个 FN 为准`);
          else fn = unescapeText(cl.value, cl.line);
          break;
        case 'UID':
          if (uid !== null) notes.push(`第 ${cl.line} 行的重复 UID 已忽略，以首个 UID 为准`);
          else uid = unescapeTextValue(cl.value, cl.line);
          break;
        case 'N':
          if (n !== null) notes.push(`第 ${cl.line} 行的重复 N 已忽略，以首个 N 为准`);
          else n = parseN(cl.value, cl.line);
          break;
        case 'TEL': {
          const { types, rest } = extractTypes(cl.params);
          const value = unescapeTextValue(cl.value, cl.line);
          if (value.trim() === '') {
            throw new VCardError('BAD_LINE', 'TEL 值不能为空', cl.line);
          }
          tels.push({ value, types, params: rest });
          break;
        }
        case 'EMAIL': {
          const { types, rest } = extractTypes(cl.params);
          const value = unescapeTextValue(cl.value, cl.line);
          if (value.trim() === '') {
            throw new VCardError('BAD_LINE', 'EMAIL 值不能为空', cl.line);
          }
          emails.push({ value, types, params: rest });
          break;
        }
        default: {
          if (!SUPPORTED_PROPERTIES.has(cl.name)) {
            unknown.push({
              group: cl.group,
              name: cl.name,
              params: cl.params,
              rawValue: cl.value,
              line: cl.line,
            });
            notes.push(
              `第 ${cl.line} 行的属性 ${cl.name} 不在受支持子集内，已原样保留但不解析语义`,
            );
          }
        }
      }
    } catch (e) {
      wrap(e);
    }
  }

  if (!versionSeen) {
    throw new VCardError('MISSING_VERSION', '缺少必需的 VERSION:4.0', lines[1]?.line ?? 1, cardIndex);
  }
  if (fn === null) {
    throw new VCardError('MISSING_FN', '缺少必需字段 FN（格式化姓名）', lines[0].line, cardIndex);
  }
  if (uid === null) {
    throw new VCardError('MISSING_UID', '缺少必需字段 UID（唯一标识）', lines[0].line, cardIndex);
  }

  return {
    cardIndex,
    fn,
    n: n ?? emptyStructuredName(),
    uid,
    tels,
    emails,
    unknown,
    notes,
  };
}
