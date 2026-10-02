import { DatabaseSync } from 'node:sqlite';
import {
  emptyStructuredName,
  ParsedVCard,
  StructuredName,
  TypedValue,
} from './vcard/types.js';

export interface ContactRecord {
  id: number;
  uid: string;
  fn: string;
  n: StructuredName;
  phones: TypedValue[];
  emails: TypedValue[];
  unknown: ParsedVCard['unknown'];
  createdAt: string;
  updatedAt: string;
}

interface ContactRow {
  id: number;
  uid: string;
  fn: string;
  n_family: string;
  n_given: string;
  n_additional: string;
  n_prefix: string;
  n_suffix: string;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(s: string): string[] {
  const v = JSON.parse(s);
  return Array.isArray(v) ? v : [];
}

export class ContactRepository {
  constructor(private db: DatabaseSync) {}

  findByUid(uid: string): ContactRecord | null {
    const row = this.db
      .prepare('SELECT * FROM contacts WHERE uid = ?')
      .get(uid) as unknown as ContactRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  getById(id: number): ContactRecord | null {
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as
      | ContactRow
      | undefined;
    return row ? this.hydrate(row) : null;
  }

  list(query?: string): ContactRecord[] {
    let rows: ContactRow[];
    if (query && query.trim() !== '') {
      const like = `%${query.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      rows = this.db
        .prepare(
          `SELECT * FROM contacts
           WHERE fn LIKE ? ESCAPE '\\' OR uid LIKE ? ESCAPE '\\'
           ORDER BY id`,
        )
        .all(like, like) as unknown as ContactRow[];
    } else {
      rows = this.db.prepare('SELECT * FROM contacts ORDER BY id').all() as unknown as ContactRow[];
    }
    return rows.map((r) => this.hydrate(r));
  }

  insert(card: ParsedVCard): number {
    const info = this.db
      .prepare(
        `INSERT INTO contacts (uid, fn, n_family, n_given, n_additional, n_prefix, n_suffix)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        card.uid,
        card.fn,
        JSON.stringify(card.n?.familyNames ?? []),
        JSON.stringify(card.n?.givenNames ?? []),
        JSON.stringify(card.n?.additionalNames ?? []),
        JSON.stringify(card.n?.honorificPrefixes ?? []),
        JSON.stringify(card.n?.honorificSuffixes ?? []),
      );
    const id = Number(info.lastInsertRowid);
    this.replaceMultiValues(id, card);
    return id;
  }

  fullUpdate(contact: ContactRecord, card: ParsedVCard): void {
    this.db
      .prepare(
        `UPDATE contacts SET uid=?, fn=?, n_family=?, n_given=?, n_additional=?,
           n_prefix=?, n_suffix=?, updated_at=datetime('now') WHERE id=?`,
      )
      .run(
        card.uid,
        card.fn,
        JSON.stringify(card.n?.familyNames ?? []),
        JSON.stringify(card.n?.givenNames ?? []),
        JSON.stringify(card.n?.additionalNames ?? []),
        JSON.stringify(card.n?.honorificPrefixes ?? []),
        JSON.stringify(card.n?.honorificSuffixes ?? []),
        contact.id,
      );
    this.replaceMultiValues(contact.id, card);
  }

  patch(
    contact: ContactRecord,
    patch: {
      fn?: string;
      n?: StructuredName;
      phones?: TypedValue[];
      emails?: TypedValue[];
    },
  ): ContactRecord {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.fn !== undefined) {
      sets.push('fn=?');
      params.push(patch.fn);
    }
    if (patch.n !== undefined) {
      sets.push('n_family=?', 'n_given=?', 'n_additional=?', 'n_prefix=?', 'n_suffix=?');
      params.push(
        JSON.stringify(patch.n.familyNames),
        JSON.stringify(patch.n.givenNames),
        JSON.stringify(patch.n.additionalNames),
        JSON.stringify(patch.n.honorificPrefixes),
        JSON.stringify(patch.n.honorificSuffixes),
      );
    }
    if (sets.length > 0) {
      sets.push("updated_at=datetime('now')");
      params.push(contact.id);
      this.db
        .prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id=?`)
        .run(...(params as Array<string | number>));
    }
    if (patch.phones !== undefined) this.replacePhoneTable(contact.id, patch.phones);
    if (patch.emails !== undefined) this.replaceEmailTable(contact.id, patch.emails);
    return this.getById(contact.id)!;
  }

  private replacePhoneTable(contactId: number, phones: TypedValue[]): void {
    this.db.prepare('DELETE FROM contact_phones WHERE contact_id=?').run(contactId);
    const stmt = this.db.prepare(
      'INSERT INTO contact_phones (contact_id, ordinal, value, types, params) VALUES (?, ?, ?, ?, ?)',
    );
    phones.forEach((p, i) =>
      stmt.run(contactId, i, p.value, JSON.stringify(p.types), JSON.stringify(p.params ?? {})),
    );
  }

  private replaceEmailTable(contactId: number, emails: TypedValue[]): void {
    this.db.prepare('DELETE FROM contact_emails WHERE contact_id=?').run(contactId);
    const stmt = this.db.prepare(
      'INSERT INTO contact_emails (contact_id, ordinal, value, types, params) VALUES (?, ?, ?, ?, ?)',
    );
    emails.forEach((e, i) =>
      stmt.run(contactId, i, e.value, JSON.stringify(e.types), JSON.stringify(e.params ?? {})),
    );
  }

  private replaceMultiValues(contactId: number, card: ParsedVCard): void {
    this.replacePhoneTable(contactId, card.tels);
    this.replaceEmailTable(contactId, card.emails);

    this.db.prepare('DELETE FROM contact_unknown_props WHERE contact_id=?').run(contactId);
    const stmt = this.db.prepare(
      `INSERT INTO contact_unknown_props (contact_id, ordinal, grp, name, params, raw_value, source_line)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    card.unknown.forEach((u, i) =>
      stmt.run(
        contactId,
        i,
        u.group,
        u.name,
        JSON.stringify(u.params),
        u.rawValue,
        u.line,
      ),
    );
  }

  private hydrate(row: ContactRow): ContactRecord {
    const phones = this.db
      .prepare('SELECT value, types, params FROM contact_phones WHERE contact_id=? ORDER BY ordinal')
      .all(row.id) as Array<{ value: string; types: string; params: string }>;
    const emails = this.db
      .prepare('SELECT value, types, params FROM contact_emails WHERE contact_id=? ORDER BY ordinal')
      .all(row.id) as Array<{ value: string; types: string; params: string }>;
    const unknown = this.db
      .prepare(
        `SELECT grp, name, params, raw_value, source_line FROM contact_unknown_props
         WHERE contact_id=? ORDER BY ordinal`,
      )
      .all(row.id) as Array<{
      grp: string;
      name: string;
      params: string;
      raw_value: string;
      source_line: number;
    }>;

    const n: StructuredName = {
      familyNames: parseJsonArray(row.n_family),
      givenNames: parseJsonArray(row.n_given),
      additionalNames: parseJsonArray(row.n_additional),
      honorificPrefixes: parseJsonArray(row.n_prefix),
      honorificSuffixes: parseJsonArray(row.n_suffix),
    };

    return {
      id: row.id,
      uid: row.uid,
      fn: row.fn,
      n: this.isEmptyN(n) ? emptyStructuredName() : n,
      phones: phones.map((p) => ({
        value: p.value,
        types: parseJsonArray(p.types),
        params: JSON.parse(p.params),
      })),
      emails: emails.map((e) => ({
        value: e.value,
        types: parseJsonArray(e.types),
        params: JSON.parse(e.params),
      })),
      unknown: unknown.map((u) => ({
        group: u.grp,
        name: u.name,
        params: JSON.parse(u.params),
        rawValue: u.raw_value,
        line: u.source_line,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private isEmptyN(n: StructuredName): boolean {
    return (
      n.familyNames.length === 0 &&
      n.givenNames.length === 0 &&
      n.additionalNames.length === 0 &&
      n.honorificPrefixes.length === 0 &&
      n.honorificSuffixes.length === 0
    );
  }
}

export function recordToCard(rec: ContactRecord): ParsedVCard {
  return {
    cardIndex: 0,
    fn: rec.fn,
    n: rec.n,
    uid: rec.uid,
    tels: rec.phones,
    emails: rec.emails,
    unknown: rec.unknown,
    notes: [],
  };
}
