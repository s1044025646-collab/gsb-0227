// 端到端演示：导入 -> 查看 -> 修改一个电话（其他号码保留）-> 导出 -> 重新读取核对。
// 使用编译产物 dist/；请先执行 npm run build。
import { rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, getContactById } from "../dist/db.js";
import { importVCard, updateContactFields } from "../dist/contacts.js";
import { serializeVCards } from "../dist/vcard/serializer.js";
import { parseVCard } from "../dist/vcard/parser.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(root, "data/demo.sqlite");
rmSync(dbPath, { force: true });

const db = openDatabase({ path: dbPath });
const text = await (await import("node:fs/promises")).readFile(resolve(root, "demo/sample.vcf"), "utf8");

console.log("== 1) 导入 ==");
const r1 = importVCard(db, { text, source: "demo/sample.vcf" });
console.log(JSON.stringify({ created: r1.created, unchanged: r1.unchanged, warnings: r1.issues.filter((i) => i.severity === "warning").length }, null, 2));

console.log("== 2) 再次导入（应 unchanged，不重复建档）==");
const r2 = importVCard(db, { text, source: "demo/sample.vcf" });
console.log(JSON.stringify({ created: r2.created, unchanged: r2.unchanged }, null, 2));

console.log("== 3) 查看联系人 1 的字段 ==");
const c1 = getContactById(db, 1);
console.log(JSON.stringify({ fn: c1.fn, n: c1.n, tels: c1.tels, emails: c1.emails, unknown: c1.unknown.map((u) => u.name) }, null, 2));

console.log("== 4) 只修改工作电话（家庭电话必须保留）==");
const patched = updateContactFields(db, 1, {
  tels: [
    { value: "+86 10 9999 0000", types: ["work", "voice"] },
    { value: "+86 21 5555 2222", types: ["home", "voice"] },
  ],
});
console.log(JSON.stringify(patched.tels, null, 2));

console.log("== 5) 导出全部并重新解析，验证往返 ==");
const exported = serializeVCards([getContactById(db, 1), getContactById(db, 2)]);
console.log(exported);
const reparsed = parseVCard(exported);
const back = reparsed.cards[0];
console.log("重新读取：", JSON.stringify({ fn: back.fn, family: back.n?.familyNames, telCount: back.tels.length, emailCount: back.emails.length, hasNewline: back.fn?.includes("\n"), unknownNames: back.unknown.map((u) => u.name) }, null, 2));
if (back.tels.length !== 2) throw new Error("往返后电话数量不对");
if (!back.fn.includes("\n")) throw new Error("字段内换行丢失");
console.log("演示完成，数据库位于", dbPath, existsSync(dbPath) ? "(已持久化)" : "");
