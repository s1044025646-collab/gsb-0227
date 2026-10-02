/**
 * 领域类型定义：只描述本服务支持的 vCard 4.0 子集。
 */

/** vCard 4.0 结构化姓名 N，按规范固定为 5 个组成部分，各部分可为多值（逗号分隔）。 */
export interface StructuredName {
  familyNames: string[];
  givenNames: string[];
  additionalNames: string[];
  honorificPrefixes: string[];
  honorificSuffixes: string[];
}

export interface TypedValue {
  /** 已解析的值（转义还原后）。 */
  value: string;
  /** TYPE 参数值，统一小写去重，如 ["work","voice"]。 */
  types: string[];
  /** 在源卡片中出现的序号（0 起），用于稳定排序。 */
  ordinal: number;
}

/** 未知 / 不支持但需要原样往返保留的属性。 */
export interface RawProperty {
  /** 属性名大写，如 "X-MANAGER"、"ADR"、"TITLE"。 */
  name: string;
  /** 原始参数字符串（GROUP.NAME;PARAMS=VALUE 中分号之后、冒号之前的部分），原样保留。 */
  params: string;
  /** 已做转义还原的值；导出时重新转义。 */
  value: string;
  /** 是否为按本版本策略不支持（如 VERSION:3.0 在别处处理，VERSION 本身不算未知）。 */
  supported: false;
}

/** 解析后的一张名片（内存模型）。 */
export interface ParsedCard {
  uid: string | null;
  fn: string | null;
  n: StructuredName | null;
  tels: TypedValue[];
  emails: TypedValue[];
  unknown: RawProperty[];
  /** 内容行起止（折叠还原后的逻辑行序号，0 起，含 BEGIN/END）。 */
  beginLine: number;
  endLine: number;
}

export type IssueSeverity = "error" | "warning";

/** 导入问题：给出逻辑行位置与原因。 */
export interface CardIssue {
  severity: IssueSeverity;
  /** 折叠还原后的逻辑行号（1 起，便于人读）。 */
  line: number;
  /** 错误码，机器可读。 */
  code: string;
  message: string;
  /** 出错卡片在输入中的序号（0 起）；未能构成卡片时为 -1。 */
  cardIndex: number;
}

export interface ParseResult {
  /** 成功解析的卡片（错误卡片不在其中，不会伪装成空联系人）。 */
  cards: ParsedCard[];
  issues: CardIssue[];
}

/** 数据库中的联系人视图。 */
export interface ContactRecord {
  id: number;
  uid: string;
  fn: string;
  n: StructuredName | null;
  tels: TypedValue[];
  emails: TypedValue[];
  unknown: RawProperty[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportReportSummary {
  id: number;
  source: string;
  totalCards: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  issues: CardIssue[];
  createdAt: string;
}
