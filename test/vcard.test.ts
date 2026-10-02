import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVCardText, serializeCard, foldLine, unfold } from '../src/vcard/index.js';

function first(text: string) {
  const r = parseVCardText(text);
  assert.equal(r.invalid.length, 0, `不应有非法卡片: ${JSON.stringify(r.invalid)}`);
  return r.cards[0];
}

test('折叠行被正确展开（含空格与 HTAB 续行）', () => {
  const input = 'BEGIN:VCARD\r\nVERSION:4.0\r\nFN:abc\r\n \tdef\r\nUID:u1\r\nEND:VCARD\r\n';
  const card = first(input);
  assert.equal(card.fn, 'abc\tdef');
});

test('反斜杠转义、字段内换行、转义分号与逗号', () => {
  const input = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:u2',
    'FN:张\\;三,先生\\n第二行',
    'N:张\\;家;三;;先生;',
    'END:VCARD',
  ].join('\r\n');
  const card = first(input);
  assert.equal(card.fn, '张;三,先生\n第二行');
  assert.deepEqual(card.n!.familyNames, ['张;家']);
  assert.deepEqual(card.n!.givenNames, ['三']);
  assert.deepEqual(card.n!.honorificPrefixes, ['先生']);
});

test('多个 TEL/EMAIL 及多值 TYPE 全部保留', () => {
  const input = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:u3',
    'FN:多值测试',
    'TEL;TYPE=work,voice:111',
    'TEL;TYPE=home,voice:222',
    'TEL;TYPE=cell:333',
    'EMAIL;TYPE=work:a@x.test',
    'EMAIL;TYPE=home:b@x.test',
    'END:VCARD',
  ].join('\r\n');
  const card = first(input);
  assert.deepEqual(card.tels.map((t) => t.value), ['111', '222', '333']);
  assert.deepEqual(card.tels[0].types, ['work', 'voice']);
  assert.deepEqual(card.emails.map((e) => e.value), ['a@x.test', 'b@x.test']);
});

test('导出按 UTF-8 字节折叠，不拆坏多字节字符', () => {
  const longName = '中'.repeat(40); // 120 字节
  const folded = foldLine(`FN:${longName}`);
  const physicalLines = folded.split('\r\n');
  assert.ok(physicalLines.length > 1, '应该发生折叠');
  for (const line of physicalLines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `行超 75 字节: ${Buffer.byteLength(line, 'utf8')}`);
    assert.ok(!line.includes('\uFFFD'), '不应出现替换字符');
  }
  // 折叠后再展开应与原文一致
  const unfolded = unfold(folded).map((l) => l.text).join('');
  assert.equal(unfolded, `FN:${longName}`);
});

test('往返：解析 -> 序列化 -> 再解析，字段含义保持', () => {
  const input = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:rt1',
    'FN:欧阳\\n娜;子,',
    'N:欧阳;娜;子;;',
    'TEL;TYPE=work,voice;PREF=1:+86-10-1',
    'TEL;TYPE=home:+86-138-2',
    'EMAIL;TYPE=work:x@y.test',
    'X-WEIRD;Q="a;b":原样内容\\;保留',
    'END:VCARD',
  ].join('\r\n');
  const card = first(input);
  const text = serializeCard(card);
  const again = first(text);
  assert.equal(again.fn, '欧阳\n娜;子,');
  assert.deepEqual(again.n!.familyNames, ['欧阳']);
  assert.equal(again.tels.length, 2);
  assert.deepEqual(again.tels[0].types, ['work', 'voice']);
  assert.equal(again.tels[0].params.PREF, '1');
  assert.equal(again.emails.length, 1);
  const weird = again.unknown.find((u) => u.name === 'X-WEIRD');
  assert.ok(weird, '未知属性应保留');
  assert.equal(weird!.rawValue, '原样内容\\;保留');
  assert.equal(weird!.params.Q, 'a;b');
});

test('非法转义序列报错', () => {
  const input = ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'FN:bad\\x', 'END:VCARD'].join('\r\n');
  const r = parseVCardText(input);
  assert.equal(r.cards.length, 0);
  assert.equal(r.invalid[0].code, 'BAD_ESCAPE');
  assert.ok(r.invalid[0].line > 0);
});

const errorCases: Array<[string, string, string]> = [
  [
    '缺少 FN',
    ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'END:VCARD'].join('\r\n'),
    'MISSING_FN',
  ],
  [
    '不支持的版本',
    ['BEGIN:VCARD', 'VERSION:3.0', 'UID:u', 'FN:x', 'END:VCARD'].join('\r\n'),
    'UNSUPPORTED_VERSION',
  ],
  [
    '坏结束标记',
    ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'FN:x', 'END:FOO'].join('\r\n'),
    'BAD_END',
  ],
  [
    '缺少 VERSION',
    ['BEGIN:VCARD', 'UID:u', 'FN:x', 'END:VCARD'].join('\r\n'),
    'MISSING_VERSION',
  ],
  [
    'N 组件数量错误',
    ['BEGIN:VCARD', 'VERSION:4.0', 'UID:u', 'FN:x', 'N:a;b', 'END:VCARD'].join('\r\n'),
    'N_COMPONENT_COUNT',
  ],
];

for (const [name, input, code] of errorCases) {
  test(`错误处理: ${name}`, () => {
    const r = parseVCardText(input);
    assert.equal(r.cards.length, 0);
    assert.equal(r.invalid[0].code, code);
  });
}

test('未知属性被保留并在 notes 标注支持范围', () => {
  const input = [
    'BEGIN:VCARD',
    'VERSION:4.0',
    'UID:u9',
    'FN:x',
    'X-FOO:bar',
    'END:VCARD',
  ].join('\r\n');
  const card = first(input);
  assert.equal(card.unknown[0].name, 'X-FOO');
  assert.ok(card.notes.some((n) => n.includes('不在受支持子集内')));
});

test('空输入抛 EMPTY_INPUT', () => {
  assert.throws(() => parseVCardText('   \n '), { code: 'EMPTY_INPUT' });
});
