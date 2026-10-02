import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { openDatabase, getContactById } from "../src/db.ts";
import { importVCard, ApiError, updateContactFields } from "../src/contacts.ts";
import { serializeVCards } from "../src/vcard/serializer.ts";

const CARD = (uid: string, tel = "+86 10 8888 6666") =>
  ["BEGIN:VCARD", "VERSION:4.0", `UID:${uid}`, "FN:\u5f20\u4e09", "N:\u5f20;\u4e09;;;", `TEL;TYPE=work:${tel}`, "TEL;TYPE=home:+86 21 5555 2222", "EMAIL:a@example.test", "END:VCARD"].join("\n");

test("重复 UID 且内容一致：unchanged，不重复建档", () => {
  const db = openDatabase({ path: ":memory:" });
  const a = importVCard(db, { text: CARD("u1"), source: "t" });
  const b = importVCard(db, { text: CARD("u1"), source: "t" });
  assert.equal(a.created, 1);
  assert.equal(b.created, 0);
  assert.equal(b.unchanged, 1);
  db.close();
});

test("内容变化默认 skip：不覆盖并给 CONFLICT 警告；update 才更新", () => {
  const db = openDatabase({ path: ":memory:" });
  importVCard(db, { text: CARD("u1", "111"), source: "t" });
  const skip = importVCard(db, { text: CARD("u1", "222"), source: "t" });
  assert.equal(skip.skipped, 1);
  assert.ok(skip.issues.some((i) => i.code === "CONFLICT_UID_SKIPPED"));
  assert.equal(getContactById(db, 1)!.tels.find((t) => t.types.includes("work"))?.value, "111");

  const upd = importVCard(db, { text: CARD("u1", "222"), source: "t", onDuplicate: "update" });
  assert.equal(upd.updated, 1);
  assert.equal(getContactById(db, 1)!.version, 2);
  assert.equal(getContactById(db, 1)!.tels.find((t) => t.types.includes("work"))?.value, "222");
  db.close();
});

test("onDuplicate=error 时冲突抛出 409", () => {
  const db = openDatabase({ path: ":memory:" });
  importVCard(db, { text: CARD("u1", "1"), source: "t" });
  assert.throws(
    () => importVCard(db, { text: CARD("u1", "2"), source: "t", onDuplicate: "error" }),
    (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "UID_CONFLICT",
  );
  db.close();
});

test("修改一个电话不误删其他号码；改 fn 不动多值集合", () => {
  const db = openDatabase({ path: ":memory:" });
  importVCard(db, { text: CARD("u1"), source: "t" });
  const c1 = getContactById(db, 1)!;
  const newTels = c1.tels.map((t) => (t.types.includes("work") ? { ...t, value: "999" } : t));
  const updated = updateContactFields(db, 1, { tels: newTels });
  assert.equal(updated.tels.length, 2);
  assert.ok(updated.tels.some((t) => t.value === "999"));
  assert.ok(updated.tels.some((t) => t.value === "+86 21 5555 2222"));
  const fnOnly = updateContactFields(db, 1, { fn: "\u674e\u56db" });
  assert.equal(fnOnly.fn, "\u674e\u56db");
  assert.equal(fnOnly.tels.length, 2);
  db.close();
});

test("非法卡片不会建档为空联系人", () => {
  const db = openDatabase({ path: ":memory:" });
  const bad = ["BEGIN:VCARD", "VERSION:4.0", "END:VCARD"].join("\n");
  const r = importVCard(db, { text: bad, source: "t" });
  assert.equal(r.created, 0);
  assert.equal(r.totalCards, 0);
  assert.ok(r.issues.some((i) => i.code === "MISSING_FN"));
  db.close();
});

test("重启进程等价场景：关闭后重开同一文件，字段与导出均保留", () => {
  const file = "data/test-restart.sqlite";
  rmSync(file, { force: true });
  {
    const db = openDatabase({ path: file });
    importVCard(db, { text: CARD("persist-uid"), source: "t" });
    db.close();
  }
  {
    const db = openDatabase({ path: file });
    const c = getContactById(db, 1)!;
    assert.equal(c.uid, "persist-uid");
    assert.equal(c.tels.length, 2);
    assert.equal(c.emails.length, 1);
    const out = serializeVCards([c]);
    assert.ok(out.includes("BEGIN:VCARD") && out.includes("END:VCARD"));
    assert.ok(out.includes("+86 21 5555 2222"));
    db.close();
  }
});
