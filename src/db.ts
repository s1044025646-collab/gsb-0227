import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ContactRecord, RawProperty, StructuredName, TypedValue } from "./types.js";

export interface DbOptions {
  /** SQLite 文件路径；":memory:" 为内存库。 */
  path: string;
}

export function openDatabase({ path }: DbOptions): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    fn TEXT NOT NULL,
    n_json TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS contact_tels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    types_json TEXT NOT NULL DEFAULT '[]',
    ordinal INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contact_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    types_json TEXT NOT NULL DEFAULT '[]',
    ordinal INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS contact_unknown (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    ordinal INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    on_duplicate TEXT NOT NULL,
    total_cards INTEGER NOT NULL,
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS import_report_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES import_reports(id) ON DELETE CASCADE,
    severity TEXT NOT NULL,
    line INTEGER NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    card_index INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS import_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES import_reports(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    action TEXT NOT NULL
  );
  `);
}

// ---------- 读取 ----------

interface ContactRow {
  id: number;
  uid: string;
  fn: string;
  n_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function readMulti(db: DatabaseSync, table: "contact_tels" | "contact_emails", contactId: number): TypedValue[] {
  const stmt = db.prepare(
    `SELECT value, types_json, ordinal FROM ${table} WHERE contact_id = ? ORDER BY ordinal, id`,
  );
  return (stmt.all(contactId) as { value: string; types_json: string; ordinal: number }[]).map((r) => ({
    value: r.value,
    types: JSON.parse(r.types_json) as string[],
    ordinal: r.ordinal,
  }));
}

function readUnknown(db: DatabaseSync, contactId: number): RawProperty[] {
  const stmt = db.prepare(
    "SELECT name, params, value, ordinal FROM contact_unknown WHERE contact_id = ? ORDER BY ordinal, id",
  );
  return (stmt.all(contactId) as { name: string; params: string; value: string; ordinal: number }[]).map((r) => ({
    name: r.name,
    params: r.params,
    value: r.value,
    supported: false,
    ordinal: r.ordinal,
  })) as RawProperty[];
}

export function toContactRecord(db: DatabaseSync, row: ContactRow): ContactRecord {
  return {
    id: row.id,
    uid: row.uid,
    fn: row.fn,
    n: row.n_json ? (JSON.parse(row.n_json) as StructuredName) : null,
    tels: readMulti(db, "contact_tels", row.id),
    emails: readMulti(db, "contact_emails", row.id),
    unknown: readUnknown(db, row.id),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getContactByUid(db: DatabaseSync, uid: string): ContactRecord | null {
  const row = db.prepare("SELECT * FROM contacts WHERE uid = ?").get(uid) as ContactRow | undefined;
  return row ? toContactRecord(db, row) : null;
}

export function getContactById(db: DatabaseSync, id: number): ContactRecord | null {
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
  return row ? toContactRecord(db, row) : null;
}

export interface ContactSummary {
  id: number;
  uid: string;
  fn: string;
  telCount: number;
  emailCount: number;
  updatedAt: string;
}

export function listContacts(db: DatabaseSync, q?: string): ContactSummary[] {
  const sql = `
    SELECT c.id, c.uid, c.fn, c.updated_at,
      (SELECT COUNT(*) FROM contact_tels t WHERE t.contact_id = c.id) AS tel_count,
      (SELECT COUNT(*) FROM contact_emails e WHERE e.contact_id = c.id) AS email_count
    FROM contacts c
    ${q ? "WHERE c.fn LIKE @q OR c.uid LIKE @q OR EXISTS (SELECT 1 FROM contact_tels t WHERE t.contact_id=c.id AND t.value LIKE @q) OR EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id=c.id AND e.value LIKE @q)" : ""}
    ORDER BY c.id`;
  const rows = (q ? db.prepare(sql).all({ q: `%${q}%` }) : db.prepare(sql).all()) as {
    id: number;
    uid: string;
    fn: string;
    updated_at: string;
    tel_count: number;
    email_count: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    uid: r.uid,
    fn: r.fn,
    telCount: r.tel_count,
    emailCount: r.email_count,
    updatedAt: r.updated_at,
  }));
}

export function listReports(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT * FROM import_reports ORDER BY id DESC").all();
}

export function getReport(db: DatabaseSync, id: number): unknown | null {
  const report = db.prepare("SELECT * FROM import_reports WHERE id = ?").get(id);
  if (!report) return null;
  const issues = db.prepare("SELECT severity, line, code, message, card_index FROM import_report_issues WHERE report_id = ? ORDER BY id").all(id);
  const items = db.prepare("SELECT uid, action FROM import_items WHERE report_id = ? ORDER BY id").all(id);
  return { ...(report as object), issues, items };
}

// ---------- 写入 ----------

function replaceMulti(
  db: DatabaseSync,
  table: "contact_tels" | "contact_emails",
  contactId: number,
  values: TypedValue[],
): void {
  db.prepare(`DELETE FROM ${table} WHERE contact_id = ?`).run(contactId);
  const ins = db.prepare(
    `INSERT INTO ${table} (contact_id, value, types_json, ordinal) VALUES (?, ?, ?, ?)`,
  );
  values.forEach((v, i) => ins.run(contactId, v.value, JSON.stringify(v.types ?? []), v.ordinal ?? i));
}

function replaceUnknown(db: DatabaseSync, contactId: number, values: RawProperty[]): void {
  db.prepare("DELETE FROM contact_unknown WHERE contact_id = ?").run(contactId);
  const ins = db.prepare(
    "INSERT INTO contact_unknown (contact_id, name, params, value, ordinal) VALUES (?, ?, ?, ?, ?)",
  );
  values.forEach((u, i) => ins.run(contactId, u.name, u.params ?? "", u.value, i));
}

export function insertContact(
  db: DatabaseSync,
  c: { uid: string; fn: string; n: StructuredName | null; tels: TypedValue[]; emails: TypedValue[]; unknown: RawProperty[] },
): number {
  const info = db
    .prepare("INSERT INTO contacts (uid, fn, n_json) VALUES (?, ?, ?)")
    .run(c.uid, c.fn, c.n ? JSON.stringify(c.n) : null);
  const id = Number(info.lastInsertRowid);
  replaceMulti(db, "contact_tels", id, c.tels);
  replaceMulti(db, "contact_emails", id, c.emails);
  replaceUnknown(db, id, c.unknown);
  return id;
}

/**
 * 显式全量替换某个联系人（仅由导入 update 策略或显式 update 命令调用）。
 * version 加 1，多值表整体替换为新快照。
 */
export function replaceContact(
  db: DatabaseSync,
  id: number,
  c: { fn: string; n: StructuredName | null; tels: TypedValue[]; emails: TypedValue[]; unknown: RawProperty[] },
): void {
  db.prepare("UPDATE contacts SET fn=?, n_json=?, version=version+1, updated_at=datetime('now') WHERE id=?").run(
    c.fn,
    c.n ? JSON.stringify(c.n) : null,
    id,
  );
  replaceMulti(db, "contact_tels", id, c.tels);
  replaceMulti(db, "contact_emails", id, c.emails);
  replaceUnknown(db, id, c.unknown);
}

export function deleteContact(db: DatabaseSync, id: number): boolean {
  return db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
}

/**
 * 局部更新受支持字段。只替换请求中显式给出的字段；
 * 未给出的电话/邮箱集合原样保留，避免“改一个号码删光其他号码”。
 */
export function patchContact(
  db: DatabaseSync,
  id: number,
  patch: {
    fn?: string;
    n?: StructuredName | null;
    tels?: TypedValue[];
    emails?: TypedValue[];
  },
): ContactRecord | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.fn !== undefined) {
    sets.push("fn = ?");
    params.push(patch.fn);
  }
  if (patch.n !== undefined) {
    sets.push("n_json = ?");
    params.push(patch.n ? JSON.stringify(patch.n) : null);
  }
  if (sets.length) {
    sets.push("version = version + 1", "updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  if (patch.tels !== undefined) replaceMulti(db, "contact_tels", id, patch.tels);
  if (patch.emails !== undefined) replaceMulti(db, "contact_emails", id, patch.emails);
  return getContactById(db, id);
}

export interface IssueRow {
  severity: string;
  line: number;
  code: string;
  message: string;
  card_index: number;
}

export function saveReport(
  db: DatabaseSync,
  r: {
    source: string;
    onDuplicate: string;
    totalCards: number;
    created: number;
    updated: number;
    unchanged: number;
    skipped: number;
    issues: IssueRow[];
    items: { uid: string; action: string }[];
  },
): number {
  const info = db
    .prepare(
      "INSERT INTO import_reports (source, on_duplicate, total_cards, created_count, updated_count, unchanged_count, skipped_count) VALUES (?,?,?,?,?,?,?)",
    )
    .run(r.source, r.onDuplicate, r.totalCards, r.created, r.updated, r.unchanged, r.skipped);
  const id = Number(info.lastInsertRowid);
  const iss = db.prepare(
    "INSERT INTO import_report_issues (report_id, severity, line, code, message, card_index) VALUES (?,?,?,?,?,?)",
  );
  for (const i of r.issues) iss.run(id, i.severity, i.line, i.code, i.message, i.card_index);
  const it = db.prepare("INSERT INTO import_items (report_id, uid, action) VALUES (?,?,?)");
  for (const x of r.items) it.run(id, x.uid, x.action);
  return id;
}
