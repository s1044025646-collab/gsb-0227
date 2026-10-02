import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { createApp } from '../src/server/app.js';
import { makeService } from './helpers.js';

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const ctx = makeService();
  const server: Server = createApp(ctx.service);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
    ctx.close();
  }
}

const card = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'UID:api-1',
  'FN:接口测试',
  'TEL;TYPE=work:123',
  'END:VCARD',
].join('\r\n');

test('HTTP: 健康检查、导入、查询、PATCH、导出 vCard 全链路', async () => {
  await withServer(async (base) => {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const imp = await fetch(`${base}/contacts/import?mode=create-only`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: card,
    });
    assert.equal(imp.status, 200);
    const report = (await imp.json()) as { created: number };
    assert.equal(report.created, 1);

    const list = (await fetch(`${base}/contacts`).then((r) => r.json())) as {
      contacts: unknown[];
    };
    assert.equal(list.contacts.length, 1);

    const patched = await fetch(`${base}/contacts/api-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: '改名后' }),
    });
    assert.equal(patched.status, 200);
    const body = (await patched.json()) as { fn: string };
    assert.equal(body.fn, '改名后');

    const vcard = await fetch(`${base}/contacts/api-1/vcard`);
    assert.ok(vcard.headers.get('content-type')!.includes('text/vcard'));
    const text = await vcard.text();
    assert.match(text, /FN:改名后/);

    const multi = await fetch(`${base}/contacts/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['api-1'] }),
    });
    assert.equal(multi.status, 200);
    assert.match(await multi.text(), /BEGIN:VCARD/);
  });
});

test('HTTP: 非法卡片返回 200 报告（逐条拒绝），404/400 错误码正确', async () => {
  await withServer(async (base) => {
    const bad = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:x', 'END:VCARD'].join('\r\n');
    const imp = await fetch(`${base}/contacts/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: bad,
    });
    const report = (await imp.json()) as { rejected: number };
    assert.equal(report.rejected, 1);

    const nfRes = await fetch(`${base}/contacts/nope`);
    assert.equal(nfRes.status, 404);
    const nf = (await nfRes.json()) as { error: { code: string } };

    const badJsonRes = await fetch(`${base}/contacts/api-x`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(badJsonRes.status, 400);
    const badJsonBody = (await badJsonRes.json()) as { error: { code: string } };
    assert.equal(badJsonBody.error.code, 'INVALID_JSON');

    const noRouteRes = await fetch(`${base}/whatever`);
    assert.equal(noRouteRes.status, 404);
    const noRouteBody = (await noRouteRes.json()) as { error: { code: string } };
    assert.equal(noRouteBody.error.code, 'NO_ROUTE');
  });
});
