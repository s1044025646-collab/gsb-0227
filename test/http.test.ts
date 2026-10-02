import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createApp, pickPort } from "../src/server.ts";
import type { Server } from "node:http";

const DB = "data/test-http.sqlite";

async function call(port: number, path: string, init?: { method?: string; body?: string; contentType?: string }): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init?.method ?? "GET",
    headers: init?.contentType ? { "Content-Type": init.contentType } : undefined,
    body: init?.body,
  });
  return { status: res.status, text: await res.text() };
}

test("HTTP 全链路：导入/查询/修改/导出/报告", async () => {
  rmSync(DB, { force: true });
  const { server, ctx } = createApp(DB);
  const port = await pickPort(0);
  await new Promise<void>((done) => (server as Server).listen(port, "127.0.0.1", done));
  try {
    const vcard = ["BEGIN:VCARD", "VERSION:4.0", "UID:http-1", "FN:\u738b\u4e94", "TEL;TYPE=work:123", "END:VCARD"].join("\n");
    const imp = await call(port, "/api/contacts/import", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ text: vcard }),
    });
    assert.equal(imp.status, 200);
    assert.match(imp.text, /"created": 1/);

    const got = await call(port, "/api/contacts/1");
    assert.equal(got.status, 200);
    assert.match(got.text, /\u738b\u4e94/);

    const patched = await call(port, "/api/contacts/1", {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ tels: [{ value: "456", types: ["home"] }] }),
    });
    assert.equal(patched.status, 200);
    assert.match(patched.text, /"value": "456"/);

    const exported = await call(port, "/api/contacts/1/export");
    assert.equal(exported.status, 200);
    assert.match(exported.text, /TEL;TYPE=home:456/);

    const reports = await call(port, "/api/reports");
    assert.equal(reports.status, 200);

    const badVersion = ["BEGIN:VCARD", "VERSION:2.1", "FN:Old", "END:VCARD"].join("\n");
    const bad = await call(port, "/api/contacts/import", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ text: badVersion }),
    });
    assert.equal(bad.status, 200);
    assert.match(bad.text, /UNSUPPORTED_VERSION/);

    const nf = await call(port, "/api/contacts/999");
    assert.equal(nf.status, 404);
    assert.match(nf.text, /CONTACT_NOT_FOUND/);
  } finally {
    ctx.db.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
