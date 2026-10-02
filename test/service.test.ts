import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeService } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { ContactService } from '../src/service.js';
import { parseVCardText } from '../src/vcard/index.js';

const validCard = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:srv-1',
  'FN:联系人甲',
  'N:联系;人甲;;;',
  'TEL;TYPE=work,voice:111',
  'TEL;TYPE=home:222',
  'EMAIL;TYPE=work:a@x.test',
  'EMAIL;TYPE=home:b@x.test',
  'END:VCARD',
].join('\r\n');

test('重复 UID 默认不建档，create-only 不覆盖', () => {
  const ctx = makeService();
  try {
    const r1 = ctx.service.importCards(validCard, 'create-only');
    assert.equal(r1.created, 1);
    const r2 = ctx.service.importCards(validCard, 'create-only');
    assert.equal(r2.created, 0);
    assert.equal(r2.skipped, 1);
    assert.equal(ctx.service.listContacts().length, 1);
  } finally {
    ctx.close();
  }
});

test('内容相同跳过；内容变化时 skip 不覆盖、update 显式覆盖', () => {
  const ctx = makeService();
  try {
    ctx.service.importCards(validCard, 'create-only');
    const changed = validCard.replace('111', '999');

    const skip = ctx.service.importCards(changed, 'skip');
    assert.equal(skip.updated, 0);
    assert.equal(skip.skipped, 1);
    assert.equal(
      ctx.service.getContact('srv-1').phones.find((p) => p.types.includes('work'))!.value,
      '111',
      'skip 模式不得覆盖',
    );

    const upd = ctx.service.importCards(changed, 'update');
    assert.equal(upd.updated, 1);
    assert.equal(
      ctx.service.getContact('srv-1').phones.find((p) => p.types.includes('work'))!.value,
      '999',
    );

    const same = ctx.service.importCards(changed, 'update');
    assert.equal(same.skipped, 1, '内容完全相同应跳过而非更新');
  } finally {
    ctx.close();
  }
});

test('PATCH 修改一个电话不误删其它号码与邮箱', () => {
  const ctx = makeService();
  try {
    ctx.service.importCards(validCard, 'create-only');
    const before = ctx.service.getContact('srv-1');
    const phones = before.phones.map((p) =>
      p.types.includes('home') ? { ...p, value: '333' } : p,
    );
    const after = ctx.service.patchContact('srv-1', { phones });
    assert.deepEqual(
      after.phones.map((p) => p.value).sort(),
      ['111', '333'],
    );
    assert.equal(after.emails.length, 2, '邮箱不应被动到');

    const onlyFn = ctx.service.patchContact('srv-1', { fn: '新名字' });
    assert.equal(onlyFn.fn, '新名字');
    assert.equal(onlyFn.phones.length, 2, '只改 FN 不应影响电话');
  } finally {
    ctx.close();
  }
});

test('PATCH 参数校验：空 fn、错误 types 类型被拒', () => {
  const ctx = makeService();
  try {
    ctx.service.importCards(validCard, 'create-only');
    assert.throws(() => ctx.service.patchContact('srv-1', { fn: '' }), { code: 'VALIDATION_ERROR' });
    assert.throws(
      () => ctx.service.patchContact('srv-1', { phones: [{ value: 'x', types: [1] }] }),
      { code: 'VALIDATION_ERROR' },
    );
    assert.throws(() => ctx.service.patchContact('srv-1', {}), { code: 'EMPTY_PATCH' });
    assert.throws(() => ctx.service.getContact('not-exist'), { code: 'NOT_FOUND' });
  } finally {
    ctx.close();
  }
});

test('导入报告记录非法卡片位置与原因，且不建成空联系人', () => {
  const ctx = makeService();
  try {
    const bad = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:坏卡',
      'END:VCARD',
    ].join('\r\n');
    const r = ctx.service.importCards(validCard + '\r\n' + bad, 'create-only');
    assert.equal(r.created, 1);
    assert.equal(r.rejected, 1);
    assert.equal(ctx.service.listContacts().length, 1);
    const rejectedItem = r.items.find((i) => i.action === 'rejected')!;
    assert.match(rejectedItem.issues[0], /UNSUPPORTED_VERSION/);
    assert.match(rejectedItem.issues[0], /第 \d+ 行/);

    const persisted = ctx.service.getReport(r.reportId);
    assert.ok(persisted);
    assert.equal(persisted!.items.length, 2);
    assert.equal(ctx.service.listReports().length, 1);
  } finally {
    ctx.close();
  }
});

test('同批重复 UID 拒绝第二次', () => {
  const ctx = makeService();
  try {
    const r = ctx.service.importCards(validCard + '\r\n' + validCard, 'create-only');
    assert.equal(r.created, 1);
    assert.equal(r.rejected, 1);
  } finally {
    ctx.close();
  }
});

test('示例文件可导入、修改、导出往返', () => {
  const ctx = makeService();
  try {
    const input = readFileSync(resolve(process.cwd(), 'examples/demo.vcf'), 'utf8');
    const r = ctx.service.importCards(input, 'create-only');
    assert.equal(r.created, 2);
    const zh = ctx.service.getContact('demo-zh-0001');
    assert.match(zh.fn, /\n/);
    assert.equal(zh.phones.length, 2);
    assert.equal(zh.emails.length, 2);
    const exported = ctx.service.exportOne('demo-zh-0001');
    const re = parseVCardText(exported);
    assert.equal(re.cards.length, 1);
    assert.equal(re.cards[0].fn, zh.fn);
    assert.equal(re.cards[0].tels.length, 2);
  } finally {
    ctx.close();
  }
});

test('重启后字段与导出结果保留', () => {
  const ctx = makeService();
  try {
    ctx.service.importCards(validCard, 'create-only');
  } finally {
    ctx.close();
  }
  const db2 = openDatabase(ctx.dir);
  try {
    const svc2 = new ContactService(db2);
    const c = svc2.getContact('srv-1');
    assert.equal(c.fn, '联系人甲');
    assert.equal(c.phones.length, 2);
    assert.equal(c.emails.length, 2);
    const text = svc2.exportOne('srv-1');
    const reparsed = parseVCardText(text);
    assert.equal(reparsed.cards[0].tels.length, 2);
    assert.equal(svc2.listReports().length, 1);
  } finally {
    db2.close();
  }
});
