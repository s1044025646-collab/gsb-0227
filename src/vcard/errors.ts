export type VCardErrorCode =
  | 'NOT_VCARD'
  | 'UNSUPPORTED_VERSION'
  | 'MISSING_FN'
  | 'MISSING_VERSION'
  | 'MISSING_UID'
  | 'BAD_END'
  | 'BAD_LINE'
  | 'BAD_PARAM'
  | 'BAD_ESCAPE'
  | 'N_COMPONENT_COUNT'
  | 'EMPTY_INPUT';

export class VCardError extends Error {
  code: VCardErrorCode;
  /** 逻辑行号（折行已展开后，从 1 开始） */
  line: number;
  /** 出错卡片在批量输入中的序号（从 0 开始） */
  cardIndex: number;
  detail?: string;

  constructor(
    code: VCardErrorCode,
    message: string,
    line: number,
    cardIndex = 0,
    detail?: string,
  ) {
    super(message);
    this.name = 'VCardError';
    this.code = code;
    this.line = line;
    this.cardIndex = cardIndex;
    this.detail = detail;
  }

  withCardIndex(index: number): VCardError {
    this.cardIndex = index;
    return this;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      line: this.line,
      cardIndex: this.cardIndex,
      detail: this.detail,
    };
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
