import type {
  CardIssue,
  ParseResult,
  ParsedCard,
  RawProperty,
  StructuredName,
  TypedValue,
} from "../types.js";

/**
 * vCard 4.0 文本解析器（自实现，不依赖任何完整通讯录库）。
 * 支持范围：FN / N / UID / TEL / EMAIL 及 TYPE 参数；
 * 其余属性原样保留为 unknown；仅接受 VERSION:4.0。
 */

/**
 * 折叠行还原（RFC 6350 3.2）：
 * 逻辑行以 CRLF 或 LF 分隔；续行以单个空格或水平制表符开头，
 * 还原时删除且仅删除续行首字符。按字节折叠与字符无关，逐字符处理即可。
 * 返回逻辑行数组（保留原始内容，不做 trim，便于定位）。
 */
export function unfold(raw: string): { lines: string[]; logicalOfPhysical: number[] } {
  const norm = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const physical = norm.split("\n");
  const lines: string[] = [];
  const logicalOfPhysical: number[] = [];
  for (const phy of physical) {
    if (lines.length > 0 && (phy.startsWith(" ") || phy.startsWith("\t"))) {
      lines[lines.length - 1] += phy.slice(1);
    } else {
      lines.push(phy);
    }
    logicalOfPhysical.push(lines.length - 1);
  }
  return { lines, logicalOfPhysical };
}

/** 在尊重双引号与反斜杠转义的前提下，按分隔符切分字符串。 */
function splitRespecting(text: string, sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (!inQuote && ch === "\\") {
      cur += ch + (text[i + 1] ?? "");
      i += 1;
    } else if (!inQuote && ch === sep) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** 还原 TEXT 类型值中的反斜杠转义：\\\、\\; 、\\, 、\\n（字段内换行）。 */
export function unescapeText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = s[++i];
    if (next === undefined) {
      out += "\\";
    } else if (next === "n" || next === "N") {
      out += "\n";
    } else {
      out += next; // \\; \, \\ 等一律还原为其后字符
    }
  }
  return out;
}

/** 从参数字符串中提取 TYPE 参数（可能出现多次，值可能是 "a,b" 引号列表）。 */
function extractTypes(paramText: string): string[] {
  const types = new Set<string>();
  if (!paramText) return [];
  for (const piece of paramText.split(";")) {
    const eq = piece.indexOf("=");
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim().toUpperCase();
    if (key !== "TYPE") continue;
    let val = piece.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) {
      val = val.slice(1, -1);
    }
    for (const t of val.split(",")) {
      const tt = t.trim().toLowerCase();
      if (tt) types.add(tt);
    }
  }
  return [...types];
}

/**
 * 将 "name;params:value" 拆为 组/属性名、参数、值。
 * 冒号可能出现在引号参数中，需跳过；属性名前可带 "group." 前缀。
 */
function splitContentLine(line: string): { group: string; name: string; params: string; value: string } | null {
  let inQuote = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === ":") {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const firstSemi = head.indexOf(";");
  const namePart = firstSemi < 0 ? head : head.slice(0, firstSemi);
  const params = firstSemi < 0 ? "" : head.slice(firstSemi + 1);
  const dot = namePart.indexOf(".");
  const group = dot < 0 ? "" : namePart.slice(0, dot);
  const name = (dot < 0 ? namePart : namePart.slice(dot + 1)).toUpperCase();
  return { group, name, params, value };
}

function emptyN(): StructuredName {
  return { familyNames: [], givenNames: [], additionalNames: [], honorificPrefixes: [], honorificSuffixes: [] };
}

function parseN(rawValue: string): StructuredName {
  // N 固定 5 个分号分隔的组成部分，每部分内部可用逗号列多值。
  const comps = splitRespecting(rawValue, ";");
  const n = emptyN();
  const keys: (keyof StructuredName)[] = [
    "familyNames",
    "givenNames",
    "additionalNames",
    "honorificPrefixes",
    "honorificSuffixes",
  ];
  keys.forEach((key, idx) => {
    const part = comps[idx] ?? "";
    n[key] = splitRespecting(part, ",")
      .map((x) => unescapeText(x))
      .filter((x) => x !== "");
  });
  return n;
}

interface RawCardBlock {
  beginLine: number; // 逻辑行号（0 起）
  endLine: number; // END 行；-1 表示缺失
  body: { line: number; text: string }[];
  terminatedBy: "end" | "eof" | "begin";
}

/** 以 BEGIN/END 切分卡片块，记录结束方式。 */
function sliceBlocks(lines: string[]): RawCardBlock[] {
  const blocks: RawCardBlock[] = [];
  let cur: RawCardBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const upper = text.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      if (cur) {
        cur.terminatedBy = "begin";
        cur.endLine = -1;
        blocks.push(cur);
      }
      cur = { beginLine: i, endLine: -1, body: [], terminatedBy: "end" };
      continue;
    }
    if (upper.startsWith("END:")) {
      if (cur) {
        cur.endLine = i;
        cur.terminatedBy = "end";
        blocks.push(cur);
        cur = null;
      } else {
        blocks.push({ beginLine: i, endLine: i, body: [], terminatedBy: "end" });
      }
      continue;
    }
    if (cur && text.trim() !== "") cur.body.push({ line: i, text });
  }
  if (cur) {
    cur.terminatedBy = "eof";
    blocks.push(cur);
  }
  return blocks;
}

/** 解析整段文本，错误卡片被跳过并在 issues 中给出逻辑行位置与原因。 */
export function parseVCard(raw: string): ParseResult {
  const { lines } = unfold(raw);
  const issues: CardIssue[] = [];
  const cards: ParsedCard[] = [];
  const blocks = sliceBlocks(lines);

  blocks.forEach((block, cardIndex) => {
    const card: ParsedCard = {
      uid: null,
      fn: null,
      n: null,
      tels: [],
      emails: [],
      unknown: [],
      beginLine: block.beginLine,
      endLine: block.endLine,
    };
    const fatal: CardIssue[] = [];
    let versionSeen = false;
    let fnCount = 0;
    let telOrd = 0;
    let emailOrd = 0;

    const err = (line: number, code: string, message: string): void => {
      fatal.push({ severity: "error", line: line + 1, code, message, cardIndex });
    };
    const warn = (line: number, code: string, message: string): void => {
      issues.push({ severity: "warning", line: line + 1, code, message, cardIndex });
    };

    if (block.terminatedBy !== "end" || block.endLine < 0) {
      err(
        block.body.length ? block.body[block.body.length - 1].line : block.beginLine,
        "VCARD_NOT_CLOSED",
        "缺少 END:VCARD，卡片未正常结束",
      );
    } else if (lines[block.endLine].toUpperCase() !== "END:VCARD") {
      err(block.endLine, "BAD_END_MARKER", `结束标记非法：应为 END:VCARD，实际为 “${lines[block.endLine]}”`);
    }

    for (const { line, text } of block.body) {
      const parsed = splitContentLine(text);
      if (!parsed) {
        err(line, "MALFORMED_LINE", `属性行缺少冒号，无法解析：“${text}”`);
        continue;
      }
      const { name, params, value } = parsed;
      switch (name) {
        case "VERSION": {
          if (value.trim() !== "4.0") {
            err(line, "UNSUPPORTED_VERSION", `仅支持 vCard 4.0，发现 VERSION:${value.trim()}`);
          } else {
            versionSeen = true;
          }
          break;
        }
        case "FN": {
          fnCount += 1;
          const v = unescapeText(value);
          if (fnCount === 1) card.fn = v;
          else warn(line, "DUPLICATE_FN", "存在多个 FN，仅保留第一个用于显示姓名");
          break;
        }
        case "N": {
          if (card.n) warn(line, "DUPLICATE_N", "存在多个 N，仅保留第一个结构化姓名");
          else card.n = parseN(value);
          break;
        }
        case "UID": {
          if (card.uid) warn(line, "DUPLICATE_UID_IN_CARD", "卡片内存在多个 UID，仅保留第一个");
          else card.uid = unescapeText(value).trim() || null;
          break;
        }
        case "TEL": {
          const item: TypedValue = { value: unescapeText(value), types: extractTypes(params), ordinal: telOrd++ };
          card.tels.push(item);
          break;
        }
        case "EMAIL": {
          const item: TypedValue = { value: unescapeText(value), types: extractTypes(params), ordinal: emailOrd++ };
          card.emails.push(item);
          break;
        }
        default: {
          // 未知 / 不支持属性：原样保留（参数原样、值转义还原后由导出端重新转义）。
          const rawProp: RawProperty = { name, params, value: unescapeText(value), supported: false };
          card.unknown.push(rawProp);
          warn(line, "UNKNOWN_PROPERTY_PRESERVED", `属性 ${name} 不在受支持子集内，将原样保留`);
        }
      }
    }

    if (!versionSeen && !fatal.some((f) => f.code === "UNSUPPORTED_VERSION")) {
      err(block.beginLine, "MISSING_VERSION", "缺少 VERSION:4.0");
    }
    if (fnCount === 0) {
      err(block.beginLine, "MISSING_FN", "缺少必需属性 FN（显示姓名）");
    }

    if (fatal.length > 0) {
      issues.push(...fatal);
    } else {
      cards.push(card);
    }
  });

  return { cards, issues };
}
