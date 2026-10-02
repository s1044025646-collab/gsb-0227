import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let dbInstance: DatabaseSync | null = null;

export function getDbPath(dataDir: string): string {
  return resolve(dataDir, 'vcard.db');
}

export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = getDbPath(dataDir);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

export function getSharedDb(dataDir: string): DatabaseSync {
  if (!dbInstance) dbInstance = openDatabase(dataDir);
  return dbInstance;
}

/** 仅用于测试隔离：关闭并清空共享句柄 */
export function closeSharedDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function migrate(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,
  fn            TEXT NOT NULL,
  n_family      TEXT NOT NULL DEFAULT '[]',
  n_given       TEXT NOT NULL DEFAULT '[]',
  n_additional  TEXT NOT NULL DEFAULT '[]',
  n_prefix      TEXT NOT NULL DEFAULT '[]',
  n_suffix      TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_phones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  value       TEXT NOT NULL,
  types       TEXT NOT NULL DEFAULT '[]',
  params      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS contact_emails (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  value       TEXT NOT NULL,
  types       TEXT NOT NULL DEFAULT '[]',
  params      TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS contact_unknown_props (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  grp         TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '{}',
  raw_value   TEXT NOT NULL,
  source_line INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  source_name  TEXT NOT NULL DEFAULT '',
  mode         TEXT NOT NULL,
  total        INTEGER NOT NULL,
  created_cnt  INTEGER NOT NULL DEFAULT 0,
  updated_cnt  INTEGER NOT NULL DEFAULT 0,
  skipped_cnt  INTEGER NOT NULL DEFAULT 0,
  rejected_cnt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_report_items (
  report_id   INTEGER NOT NULL REFERENCES import_reports(id) ON DELETE CASCADE,
  card_index  INTEGER NOT NULL,
  contact_id  INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  uid         TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  issues      TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_phones_contact ON contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS idx_emails_contact ON contact_emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_unknown_contact ON contact_unknown_props(contact_id);
CREATE INDEX IF NOT EXISTS idx_report_items ON import_report_items(report_id);
`);
}
