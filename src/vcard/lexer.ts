import { VCardError } from './errors.js';

export interface LogicalLine {
  text: string;
  /** 该逻辑行起始物理行号（从 1 起） */
  line: number;
}

/**
 * 展开折叠行（RFC 6350：CRLF 后紧跟一个空格或 HTAB 表示续行）。
 * 同时兼容 LF 行尾与 CR 行尾输入。
 * 返回逻辑行序列，行号取折叠块第一行的物理行号。
 */
export function unfold(input: string): LogicalLine[] {
  const normalized = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const physical = normalized.split('\n');
  const result: LogicalLine[] = [];

  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];
    if (raw.length > 0 && (raw[0] === ' ' || raw[0] === '\t')) {
      if (result.length === 0) {
        throw new VCardError('BAD_LINE', '文件以折叠续行符开头，没有可续接的行', i + 1);
      }
      result[result.length - 1].text += raw.slice(1);
    } else {
      result.push({ text: raw, line: i + 1 });
    }
  }
  // 去掉末尾因结尾换行产生的空行
  while (result.length > 0 && result[result.length - 1].text === '') {
    result.pop();
  }
  return result;
}

/** 将逻辑行序列切分为一张一张名片，校验 BEGIN/END 配对与坏结束标记 */
export function splitCards(lines: LogicalLine[]): LogicalLine[][] {
  const cards: LogicalLine[][] = [];
  let current: LogicalLine[] | null = null;

  for (const ll of lines) {
    const upper = ll.text.toUpperCase();
    if (upper === 'BEGIN:VCARD') {
      if (current !== null) {
        // 上一张卡片缺少 END，先作为残缺卡片交给解析器报错，再开始新卡片
        cards.push(current);
      }
      current = [ll];
    } else if (upper.startsWith('END:')) {
      if (current === null) {
        throw new VCardError('BAD_END', `出现未配对的结束标记 “${ll.text}”`, ll.line);
      }
      // 即便结束标记写错（如 END:FOO）也在此收尾，由 parseCard 逐卡判定 BAD_END
      current.push(ll);
      cards.push(current);
      current = null;
    } else if (current !== null) {
      current.push(ll);
    } else if (ll.text.trim() !== '') {
      throw new VCardError('NOT_VCARD', '名片外出现内容，缺少 BEGIN:VCARD', ll.line);
    }
  }

  if (current !== null) {
    const last = current[current.length - 1];
    throw new VCardError('BAD_END', '名片缺少 END:VCARD 结束标记', last.line);
  }
  return cards;
}
