/** 结构化姓名 N：5 个文本列表组件，均允许为空 */
export interface StructuredName {
  familyNames: string[];
  givenNames: string[];
  additionalNames: string[];
  honorificPrefixes: string[];
  honorificSuffixes: string[];
}

export interface TypedValue {
  /** 电话/邮箱的实际值 */
  value: string;
  /** TYPE 参数，保持原始大小写语义，导出时统一大写；如 ["work","voice"] */
  types: string[];
  /** 其它非 TYPE 参数，键统一大写，值原样保留（如 PREF=1） */
  params: Record<string, string>;
}

/** 解析后保留的未知/不保证语义的属性 */
export interface RawProperty {
  group: string;
  name: string;
  params: Record<string, string>;
  /** 原始 VALUE 文本（未反转义），按属性序列原样导出 */
  rawValue: string;
  /** 该属性所在逻辑行号 */
  line: number;
}

export interface ParsedVCard {
  /** 该卡片在批量输入中的序号（从 0 开始） */
  cardIndex: number;
  fn: string;
  n: StructuredName | null;
  uid: string;
  tels: TypedValue[];
  emails: TypedValue[];
  /** 按出现顺序保留的未知/非核心属性 */
  unknown: RawProperty[];
  /** 支持范围标注信息（非错误） */
  notes: string[];
}

export const SUPPORTED_PROPERTIES = new Set([
  'BEGIN',
  'END',
  'VERSION',
  'FN',
  'N',
  'UID',
  'TEL',
  'EMAIL',
]);

export function emptyStructuredName(): StructuredName {
  return {
    familyNames: [],
    givenNames: [],
    additionalNames: [],
    honorificPrefixes: [],
    honorificSuffixes: [],
  };
}
