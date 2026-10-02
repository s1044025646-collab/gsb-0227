import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  getContactByUid,
  insertContact,
  patchContact,
  replaceContact,
  saveReport,
  type IssueRow,
} from "./db.js";
import { parseVCard } from "./vcard/parser.js";
import type { CardIssue, ContactRecord, StructuredName, TypedValue } from "./types.js";

/** 重复 UID 的显式策略：skip 拒绝覆盖（默认），update 显式替换，error 整体报错。 */
export type OnDuplicate = "skip" | "update" | "error";

export interface ImportInput {
  text: string;
  source: string;
  onDuplicate?: OnDuplicate;
}

export interface ImportResult {
  reportId: number;
  totalCards: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  issues: CardIssue[];
  actions: { uid: string; action: "created" | "updated" | "unchanged" | "skipped" }[];
}

/**
 * 规范指纹：仅对参与往返的字段内容求哈希，用于区分“内容一致”与“内容变化”。
 * 不依赖 updated_at / id，保证重启后可稳定比对。
 */
export function fingerprint(c: {
  fn: string | null;
  n: StructuredName | null;
  tels: TypedValue[];
  emails: TypedValue[];
  unknown: { name: string; params: string; value: string }[];
}): string {
  const canon = JSON.stringify({
    fn: c.fn ?? "",
    n: c.n ?? null,
    tels: c.tels.map((t) => [t.value, [...t.types].sort()]),
    emails: c.emails.map((e) => [e.value, [...e.types].sort()]),
    unknown: c.unknown.map((u) => [u.name, u.params, u.value]),
  });
  return createHash("sha256").update(canon, "utf8").digest("hex");
}

/** 无 UID 时由内容派生稳定 UID（urn:uuid 形式的确定性 sha256 摘要）。 */
export function deriveUid(card: Parameters<typeof fingerprint>[0]): string {
  return `urn:uuid:${createHash("sha256").update(fingerprint(card), "utf8").digest("hex").slice(0, 32)}`;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function importVCard(db: DatabaseSync, input: ImportInput): ImportResult {
  const onDuplicate: OnDuplicate = input.onDuplicate ?? "skip";
  if (!["skip", "update", "error"].includes(onDuplicate)) {
    throw new ApiError("INVALID_ON_DUPLICATE", 400, `onDuplicate 必须是 skip|update|error，收到 ${input.onDuplicate}`);
  }
  if (typeof input.text !== "string" || input.text.length === 0) {
    throw new ApiError("EMPTY_INPUT", 400, "导入文本为空");
  }

  const { cards, issues } = parseVCard(input.text);
  const actions: ImportResult["actions"] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  const seenUidInBatch = new Set<string>();

  for (const card of cards) {
    const uid = card.uid && card.uid.trim() ? card.uid.trim() : deriveUid(card);
    const candidate = {
      fn: card.fn ?? "",
      n: card.n,
      tels: card.tels,
      emails: card.emails,
      unknown: card.unknown,
    };

    if (seenUidInBatch.has(uid)) {
      issues.push({
        severity: "error",
        line: card.beginLine + 1,
        code: "DUP_UID_WITHIN_BATCH",
        message: `同一批次中 UID ${uid} 重复，后一张被跳过`,
        cardIndex: actions.length,
      });
      skipped += 1;
      actions.push({ uid, action: "skipped" });
      continue;
    }
    seenUidInBatch.add(uid);

    const existing = getContactByUid(db, uid);
    if (!existing) {
      insertContact(db, { uid, ...candidate });
      created += 1;
      actions.push({ uid, action: "created" });
      continue;
    }

    const same = fingerprint(existing) === fingerprint(candidate);
    if (same) {
      unchanged += 1;
      actions.push({ uid, action: "unchanged" });
      continue;
    }

    if (onDuplicate === "skip") {
      skipped += 1;
      issues.push({
        severity: "warning",
        line: card.beginLine + 1,
        code: "CONFLICT_UID_SKIPPED",
        message: `UID ${uid} 已存在且内容不同，按默认策略 skip 跳过，未做覆盖`,
        cardIndex: actions.length,
      });
      actions.push({ uid, action: "skipped" });
    } else if (onDuplicate === "error") {
      throw new ApiError("UID_CONFLICT", 409, `UID ${uid} 已存在且内容变化；显式指定 onDuplicate=update 才会更新`, {
        uid,
        existingVersion: existing.version,
      });
    } else {
      replaceContact(db, existing.id, candidate);
      updated += 1;
      actions.push({ uid, action: "updated" });
    }
  }

  const reportId = saveReport(db, {
    source: input.source,
    onDuplicate,
    totalCards: cards.length,
    created,
    updated,
    unchanged,
    skipped,
    issues: issues.map(
      (i): IssueRow => ({
        severity: i.severity,
        line: i.line,
        code: i.code,
        message: i.message,
        card_index: i.cardIndex,
      }),
    ),
    items: actions.map((a) => ({ uid: a.uid, action: a.action })),
  });

  return { reportId, totalCards: cards.length, created, updated, unchanged, skipped, issues, actions };
}

// ---------- 字段级修改（只动被请求的部分） ----------

export function validateTypes(types: unknown): string[] {
  if (!Array.isArray(types) || types.some((t) => typeof t !== "string")) {
    throw new ApiError("INVALID_TYPES", 400, "types 必须是字符串数组");
  }
  return [...new Set(types.map((t) => t.toLowerCase().trim()).filter(Boolean))];
}

export function normalizeN(n: unknown): StructuredName | null {
  if (n === null) return null;
  if (typeof n !== "object") throw new ApiError("INVALID_N", 400, "n 必须是对象或 null");
  const keys: (keyof StructuredName)[] = [
    "familyNames",
    "givenNames",
    "additionalNames",
    "honorificPrefixes",
    "honorificSuffixes",
  ];
  const out: StructuredName = { familyNames: [], givenNames: [], additionalNames: [], honorificPrefixes: [], honorificSuffixes: [] };
  for (const key of keys) {
    const arr = (n as Record<string, unknown>)[key] ?? [];
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string")) {
      throw new ApiError("INVALID_N", 400, `n.${key} 必须是字符串数组`);
    }
    out[key] = arr;
  }
  return out;
}

function normalizeMulti(list: unknown): TypedValue[] {
  if (!Array.isArray(list)) throw new ApiError("INVALID_MULTIVALUE", 400, "多值字段必须是数组");
  return list.map((item, i) => {
    if (typeof item === "string") return { value: item, types: [], ordinal: i };
    if (item && typeof item === "object" && typeof (item as { value?: unknown }).value === "string") {
      const o = item as { value: string; types?: unknown; ordinal?: number };
      return { value: o.value, types: validateTypes(o.types ?? []), ordinal: typeof o.ordinal === "number" ? o.ordinal : i };
    }
    throw new ApiError("INVALID_MULTIVALUE", 400, "每个条目需为字符串或 {value,types} 对象");
  });
}

/**
 * 局部修改：PATCH 体中出现哪个键就改哪个。
 * - fn / n：整体替换该字段。
 * - tels / emails：给出的数组整体替换该集合；不给出则保留原值，
 *   因此修改一个号码时，其他号码不受影响。
 */
export function updateContactFields(
  db: DatabaseSync,
  id: number,
  body: Record<string, unknown>,
): ContactRecord {
  const existing = db.prepare("SELECT id FROM contacts WHERE id = ?").get(id) as { id: number } | undefined;
  if (!existing) throw new ApiError("CONTACT_NOT_FOUND", 404, `联系人 id=${id} 不存在`);

  const patch: {
    fn?: string;
    n?: StructuredName | null;
    tels?: TypedValue[];
    emails?: TypedValue[];
  } = {};
  const allowed = new Set(["fn", "n", "tels", "emails"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError("UNSUPPORTED_FIELD", 400, `字段 ${key} 不支持通过 PATCH 修改`);
  }
  if (body.fn !== undefined) {
    if (typeof body.fn !== "string" || body.fn.trim() === "") {
      throw new ApiError("INVALID_FN", 400, "fn 必须是非空字符串");
    }
    patch.fn = body.fn;
  }
  if (body.n !== undefined) patch.n = normalizeN(body.n);
  if (body.tels !== undefined) patch.tels = normalizeMulti(body.tels);
  if (body.emails !== undefined) patch.emails = normalizeMulti(body.emails);

  if (Object.keys(patch).length === 0) throw new ApiError("EMPTY_PATCH", 400, "没有可修改的字段");
  const after = patchContact(db, id, patch);
  return after!;
}
