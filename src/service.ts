import { DatabaseSync } from 'node:sqlite';
import { ContactRepository, ContactRecord, recordToCard } from './repository.js';
import { parseVCardText, ParsedVCard, serializeCard, serializeCards } from './vcard/index.js';
import { StructuredName, TypedValue } from './vcard/types.js';
import { ApiError } from './vcard/errors.js';

export type ImportMode = 'create-only' | 'update' | 'skip';

export type ItemAction = 'created' | 'updated' | 'skipped' | 'rejected';

export interface ImportItemResult {
  cardIndex: number;
  contactId: number | null;
  uid: string;
  action: ItemAction;
  issues: string[];
}

export interface ImportReport {
  reportId: number;
  createdAt: string;
  sourceName: string;
  mode: ImportMode;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
  items: ImportItemResult[];
}

export interface ReportSummary {
  reportId: number;
  createdAt: string;
  sourceName: string;
  mode: ImportMode;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  rejected: number;
}

function normalizeCard(card: ParsedVCard): string {
  return JSON.stringify({
    fn: card.fn,
    n: card.n,
    uid: card.uid,
    tels: card.tels.map((t) => ({
      value: t.value,
      types: [...t.types].sort(),
      params: t.params,
    })),
    emails: card.emails.map((e) => ({
      value: e.value,
      types: [...e.types].sort(),
      params: e.params,
    })),
    unknown: card.unknown.map((u) => ({
      group: u.group,
      name: u.name,
      params: u.params,
      rawValue: u.rawValue,
    })),
  });
}

function semanticEqual(a: ParsedVCard, b: ParsedVCard): boolean {
  return normalizeCard(a) === normalizeCard(b);
}

export class ContactService {
  private repo: ContactRepository;

  constructor(private db: DatabaseSync) {
    this.repo = new ContactRepository(db);
  }

  importCards(text: string, mode: ImportMode, sourceName = ''): ImportReport {
    if (!['create-only', 'update', 'skip'].includes(mode)) {
      throw new ApiError(400, 'INVALID_MODE', `未知导入模式 “${mode}”`, {
        allowedModes: ['create-only', 'update', 'skip'],
      });
    }

    const { cards, invalid } = parseVCardText(text);
    const items: ImportItemResult[] = [];
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const seenUid = new Set<string>();

    const handleConflict = (
      card: ParsedVCard,
      existing: ContactRecord,
      issues: string[],
    ): void => {
      if (semanticEqual(recordToCard(existing), card)) {
        skipped++;
        items.push({
          cardIndex: card.cardIndex,
          contactId: existing.id,
          uid: card.uid,
          action: 'skipped',
          issues: [...issues, '内容与现有联系人完全相同，跳过'],
        });
        return;
      }
      if (mode === 'update') {
        this.repo.fullUpdate(existing, card);
        updated++;
        items.push({
          cardIndex: card.cardIndex,
          contactId: existing.id,
          uid: card.uid,
          action: 'updated',
          issues: [...issues, '已按显式 update 模式覆盖现有联系人内容'],
        });
      } else {
        skipped++;
        const label = mode === 'create-only' ? 'create-only 模式拒绝覆盖' : 'skip 模式不覆盖';
        items.push({
          cardIndex: card.cardIndex,
          contactId: existing.id,
          uid: card.uid,
          action: 'skipped',
          issues: [...issues, `UID 已存在且内容不同；${label}，已跳过`],
        });
      }
    };

    this.db.exec('BEGIN');
    let reportId = -1;
    try {
      for (const card of cards) {
        const issues = [...card.notes];
        if (seenUid.has(card.uid)) {
          items.push({
            cardIndex: card.cardIndex,
            contactId: null,
            uid: card.uid,
            action: 'rejected',
            issues: [...issues, `同一批输入中 UID “${card.uid}” 重复，仅处理首次出现的卡片`],
          });
          continue;
        }
        seenUid.add(card.uid);

        const existing = this.repo.findByUid(card.uid);
        if (!existing) {
          const id = this.repo.insert(card);
          created++;
          items.push({
            cardIndex: card.cardIndex,
            contactId: id,
            uid: card.uid,
            action: 'created',
            issues,
          });
        } else {
          handleConflict(card, existing, issues);
        }
      }

      for (const bad of invalid) {
        items.push({
          cardIndex: bad.cardIndex,
          contactId: null,
          uid: '',
          action: 'rejected',
          issues: [`[${bad.code}] 第 ${bad.line} 行: ${bad.message}`],
        });
      }

      items.sort((a, b) => a.cardIndex - b.cardIndex);
      const rejected = items.filter((i) => i.action === 'rejected').length;

      const info = this.db
        .prepare(
          `INSERT INTO import_reports
             (source_name, mode, total, created_cnt, updated_cnt, skipped_cnt, rejected_cnt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceName,
          mode,
          cards.length + invalid.length,
          created,
          updated,
          skipped,
          rejected,
        );
      reportId = Number(info.lastInsertRowid);
      const itemStmt = this.db.prepare(
        `INSERT INTO import_report_items
           (report_id, card_index, contact_id, uid, action, issues)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const it of items) {
        itemStmt.run(
          reportId,
          it.cardIndex,
          it.contactId,
          it.uid,
          it.action,
          JSON.stringify(it.issues),
        );
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    const full = this.getReport(reportId);
    if (!full) throw new Error('导入报告写入失败');
    return full;
  }

  listContacts(query?: string): ContactRecord[] {
    return this.repo.list(query);
  }

  getContact(idOrUid: string): ContactRecord {
    const rec = /^\d+$/.test(idOrUid)
      ? this.repo.getById(Number(idOrUid))
      : this.repo.findByUid(idOrUid);
    if (!rec) {
      throw new ApiError(404, 'NOT_FOUND', `联系人不存在: ${idOrUid}`);
    }
    return rec;
  }

  patchContact(
    idOrUid: string,
    body: { fn?: unknown; n?: unknown; phones?: unknown; emails?: unknown },
  ): ContactRecord {
    const existing = this.getContact(idOrUid);
    const patch: {
      fn?: string;
      n?: StructuredName;
      phones?: TypedValue[];
      emails?: TypedValue[];
    } = {};

    if (body.fn !== undefined) {
      if (typeof body.fn !== 'string' || body.fn === '') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'fn 必须是非空字符串');
      }
      patch.fn = body.fn;
    }
    if (body.n !== undefined) patch.n = this.validateStructuredName(body.n);
    if (body.phones !== undefined) patch.phones = this.validateMultiValue(body.phones, 'phones');
    if (body.emails !== undefined) patch.emails = this.validateMultiValue(body.emails, 'emails');
    if (Object.keys(patch).length === 0) {
      throw new ApiError(
        400,
        'EMPTY_PATCH',
        '没有可更新的字段，允许: fn, n, phones, emails',
      );
    }
    return this.repo.patch(existing, patch);
  }

  private validateStructuredName(input: unknown): StructuredName {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'n 必须是对象');
    }
    const keys: Array<keyof StructuredName> = [
      'familyNames',
      'givenNames',
      'additionalNames',
      'honorificPrefixes',
      'honorificSuffixes',
    ];
    const obj = input as Record<string, unknown>;
    const result = {} as StructuredName;
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) {
        result[key] = [];
        continue;
      }
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new ApiError(400, 'VALIDATION_ERROR', `n.${key} 必须是字符串数组`);
      }
      result[key] = v;
    }
    return result;
  }

  private validateMultiValue(input: unknown, field: string): TypedValue[] {
    if (!Array.isArray(input)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${field} 必须是数组`);
    }
    return input.map((item, i) => {
      if (typeof item !== 'object' || item === null) {
        throw new ApiError(400, 'VALIDATION_ERROR', `${field}[${i}] 必须是对象`);
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.value !== 'string' || obj.value === '') {
        throw new ApiError(400, 'VALIDATION_ERROR', `${field}[${i}].value 必须是非空字符串`);
      }
      const types = obj.types ?? [];
      if (!Array.isArray(types) || types.some((t) => typeof t !== 'string')) {
        throw new ApiError(400, 'VALIDATION_ERROR', `${field}[${i}].types 必须是字符串数组`);
      }
      let params: Record<string, string> = {};
      if (obj.params !== undefined) {
        if (typeof obj.params !== 'object' || obj.params === null || Array.isArray(obj.params)) {
          throw new ApiError(400, 'VALIDATION_ERROR', `${field}[${i}].params 必须是对象`);
        }
        for (const [k, v] of Object.entries(obj.params as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            throw new ApiError(
              400,
              'VALIDATION_ERROR',
              `${field}[${i}].params.${k} 必须是字符串`,
            );
          }
        }
        params = obj.params as Record<string, string>;
      }
      return { value: obj.value, types: types.map((t) => t.toLowerCase()), params };
    });
  }

  exportContacts(idsOrUids: string[]): string {
    if (idsOrUids.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', '至少需要一个联系人 id 或 UID');
    }
    const records = idsOrUids.map((x) => this.getContact(x));
    return serializeCards(records.map(recordToCard));
  }

  exportOne(idOrUid: string): string {
    return serializeCard(recordToCard(this.getContact(idOrUid)));
  }

  listReports(): ReportSummary[] {
    return this.db
      .prepare(
        `SELECT id AS reportId, created_at AS createdAt, source_name AS sourceName, mode,
                total, created_cnt AS created, updated_cnt AS updated,
                skipped_cnt AS skipped, rejected_cnt AS rejected
         FROM import_reports ORDER BY id DESC`,
      )
      .all() as unknown as ReportSummary[];
  }

  getReport(reportId: number): ImportReport | null {
    const head = this.db
      .prepare(
        `SELECT id AS reportId, created_at AS createdAt, source_name AS sourceName, mode,
                total, created_cnt AS created, updated_cnt AS updated,
                skipped_cnt AS skipped, rejected_cnt AS rejected
         FROM import_reports WHERE id=?`,
      )
      .get(reportId) as ReportSummary | undefined;
    if (!head) return null;
    const rows = this.db
      .prepare(
        `SELECT card_index AS cardIndex, contact_id AS contactId, uid, action, issues
         FROM import_report_items WHERE report_id=? ORDER BY card_index`,
      )
      .all(reportId) as Array<{
      cardIndex: number;
      contactId: number | null;
      uid: string;
      action: ItemAction;
      issues: string;
    }>;
    return {
      ...head,
      items: rows.map((r) => ({
        cardIndex: r.cardIndex,
        contactId: r.contactId,
        uid: r.uid,
        action: r.action,
        issues: JSON.parse(r.issues) as string[],
      })),
    };
  }
}
