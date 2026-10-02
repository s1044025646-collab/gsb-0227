import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVCard, unfold, unescapeText } from "../src/vcard/parser.ts";
import { foldLine, serializeVCards, escapeText } from "../src/vcard/serializer.ts";

const SAMPLE = `BEGIN:VCARD
VERSION:4.0
UID:urn:uuid:abc
FN:\u6b27\u9633\\;\u5fa1\u98ce\\n\u7b2c\u4e8c\u884c
N:\u6b27\u9633;\u5fa1\u98ce;\u6587\u6e0a;Dr.;\u535a\u58eb
TEL;TYPE=work,voice:+86 10 8888 6666
TEL;TYPE=home:+86 21 5555 2222
EMAIL;TYPE=work:a@example.test
EMAIL;TYPE=home:b@example.test
X-TEST:\u539f\u6837\\,\u4fdd\u7559
END:VCARD`;

test("解析多值电话/邮箱与 TYPE，不丢失任何一项", () => {
  const { cards, issues } = parseVCard(SAMPLE);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.tels.length, 2);
  assert.deepEqual(c.tels[0].types, ["work", "voice"]);
  assert.deepEqual(c.tels[1].types, ["home"]);
  assert.equal(c.emails.length, 2);
  assert.equal(c.unknown.length, 1);
  assert.equal(c.unknown[0].name, "X-TEST");
  assert.ok(issues.some((i) => i.code === "UNKNOWN_PROPERTY_PRESERVED"));
});

test("FN 与 N 不混淆，转义分号与字段内换行正确还原", () => {
  const c = parseVCard(SAMPLE).cards[0];
  assert.equal(c.fn, "\u6b27\u9633;\u5fa1\u98ce\n\u7b2c\u4e8c\u884c");
  assert.deepEqual(c.n?.familyNames, ["\u6b27\u9633"]);
  assert.deepEqual(c.n?.givenNames, ["\u5fa1\u98ce"]);
  assert.deepEqual(c.n?.additionalNames, ["\u6587\u6e0a"]);
  assert.deepEqual(c.n?.honorificPrefixes, ["Dr."]);
  assert.deepEqual(c.n?.honorificSuffixes, ["\u535a\u58eb"]);
});

test("折叠行还原：CRLF+空格续行，且只删续行首字符", () => {
  const folded = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:abc\r\n  def\r\nEND:VCARD";
  const { lines } = unfold(folded);
  assert.ok(lines.includes("FN:abc def"));
});

test("UTF-8 字节折叠：不拆坏汉字，首行不超 75 字节", () => {
  const longLine = "NOTE:" + "\u6c49\u5b57".repeat(60) + "A";
  const folded = foldLine(longLine);
  const physicalLines = folded.split("\r\n");
  for (const l of physicalLines) assert.ok(Buffer.byteLength(l, "utf8") <= 75, `${l.length} bytes?`);
  assert.ok(physicalLines.length > 1);
  // 续行以空格开头；还原后应与原文完全一致
  const restored = physicalLines.map((l, i) => (i > 0 && l.startsWith(" ") ? l.slice(1) : l)).join("");
  assert.equal(restored, longLine);
});

test("往返：导出再解析保持多值/换行/未知属性/转义", () => {
  const c = parseVCard(SAMPLE).cards[0];
  const out = serializeVCards([c]);
  const again = parseVCard(out);
  assert.equal(again.cards.length, 1);
  const d = again.cards[0];
  assert.equal(d.fn, c.fn);
  assert.deepEqual(d.n, c.n);
  assert.equal(d.tels.length, 2);
  assert.deepEqual(d.tels.map((t) => t.value), c.tels.map((t) => t.value));
  assert.deepEqual(d.tels.map((t) => t.types), c.tels.map((t) => t.types));
  assert.equal(d.emails.length, 2);
  assert.equal(d.unknown.length, 1);
  assert.equal(d.unknown[0].value, "\u539f\u6837,\u4fdd\u7559");
});

test("escapeText 覆盖反斜杠/分号/逗号/换行", () => {
  assert.equal(escapeText("a;b,c\\d\ne"), "a\\;b\\,c\\\\d\\ne");
  assert.equal(unescapeText("a\\;b\\,c\\\\d\\ne"), "a;b,c\\d\ne");
});

test("错误卡片：缺 FN、版本不对、坏结束标记、未闭合", () => {
  const input = [
    "BEGIN:VCARD", "VERSION:4.0", "FN:OK", "END:VCARD", // 正常
    "BEGIN:VCARD", "VERSION:4.0", "TEL:123", "END:VCARD", // 缺 FN
    "BEGIN:VCARD", "VERSION:3.0", "FN:Old", "END:VCARD", // 版本
    "BEGIN:VCARD", "VERSION:4.0", "FN:Bad", "END:VCARDD", // 坏结束
    "BEGIN:VCARD", "VERSION:4.0", "FN:Open", // 未闭合
  ].join("\n");
  const { cards, issues } = parseVCard(input);
  assert.equal(cards.length, 1);
  const codes = issues.filter((i) => i.severity === "error").map((i) => i.code);
  assert.ok(codes.includes("MISSING_FN"));
  assert.ok(codes.includes("UNSUPPORTED_VERSION"));
  assert.ok(codes.includes("BAD_END_MARKER"));
  assert.ok(codes.includes("VCARD_NOT_CLOSED"));
  // 错误给出逻辑行号
  assert.ok(issues.every((i) => i.line >= 1));
});
