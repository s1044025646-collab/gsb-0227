import { splitCards, unfold } from './lexer.js';
import { parseCard } from './parser.js';
import { ParsedVCard } from './types.js';
import { VCardError } from './errors.js';

export interface InvalidCard {
  cardIndex: number;
  code: string;
  message: string;
  line: number;
  detail?: string;
}

export interface ParseBatchResult {
  cards: ParsedVCard[];
  invalid: InvalidCard[];
}

/** 批量解析 UTF-8 vCard 文本；单张出错不影响其他卡片，错误收集返回 */
export function parseVCardText(text: string): ParseBatchResult {
  if (text.replace(/\s/g, '') === '') {
    throw new VCardError('EMPTY_INPUT', '输入为空或仅含空白字符', 0);
  }
  const logical = unfold(text);
  const rawCards = splitCards(logical);

  const cards: ParsedVCard[] = [];
  const invalid: InvalidCard[] = [];
  rawCards.forEach((lines, index) => {
    try {
      cards.push(parseCard(lines, index));
    } catch (e) {
      if (e instanceof VCardError) {
        invalid.push({
          cardIndex: index,
          code: e.code,
          message: e.message,
          line: e.line,
          detail: e.detail,
        });
      } else {
        invalid.push({
          cardIndex: index,
          code: 'UNKNOWN',
          message: e instanceof Error ? e.message : String(e),
          line: 0,
        });
      }
    }
  });
  return { cards, invalid };
}

export * from './types.js';
export * from './errors.js';
export { parseCard } from './parser.js';
export { serializeCard, serializeCards, foldLine } from './serializer.js';
export { unfold, splitCards } from './lexer.js';
