import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { resolve, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, getContactById, listContacts, deleteContact, listReports, getReport } from "./db.js";
import { ApiError, importVCard, updateContactFields } from "./contacts.js";
import { serializeVCards } from "./vcard/serializer.js";
import type { DatabaseSync } from "node:sqlite";

export interface AppContext {
  db: DatabaseSync;
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(contentType.startsWith("application/json") ? JSON.stringify(body, null, 2) : (body as string));
}

async function readBody(req: IncomingMessage, limitBytes = 5 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limitBytes) throw new ApiError("PAYLOAD_TOO_LARGE", 413, `请求体超过 ${limitBytes} 字节上限`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: AppContext, req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, query: URLSearchParams) => Promise<void> | void;
}

const routes: Route[] = [
  { method: "GET", pattern: /^\/api\/health$/, handler: (_ctx, _req, res) => send(res, 200, { ok: true }) },
  {
    method: "GET",
    pattern: /^\/api\/contacts$/,
    handler: (ctx, _req, res, _m, q) => send(res, 200, { contacts: listContacts(ctx.db, q.get("q") ?? undefined) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/contacts\/import$/,
    handler: async (ctx, req, res) => {
      const body = await readBody(req);
      let text = body;
      let source = "http-body";
      let onDuplicate: "skip" | "update" | "error" | undefined;
      const ct = req.headers["content-type"] ?? "";
      if (ct.includes("application/json")) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          throw new ApiError("INVALID_JSON", 400, "请求体不是合法 JSON");
        }
        if (typeof parsed.text !== "string") throw new ApiError("INVALID_TEXT", 400, "JSON 需包含字符串字段 text");
        text = parsed.text;
        if (typeof parsed.source === "string") source = parsed.source;
        onDuplicate = parsed.onDuplicate as typeof onDuplicate;
      } else if (req.headers["x-source"]) {
        source = String(req.headers["x-source"]);
        onDuplicate = (req.headers["x-on-duplicate"] as typeof onDuplicate) ?? undefined;
      }
      const result = importVCard(ctx.db, { text, source, onDuplicate });
      send(res, 200, result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/contacts\/(\d+)$/,
    handler: (ctx, _req, res, m) => {
      const c = getContactById(ctx.db, Number(m[1]));
      if (!c) throw new ApiError("CONTACT_NOT_FOUND", 404, `联系人 id=${m[1]} 不存在`);
      send(res, 200, c);
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/contacts\/(\d+)$/,
    handler: async (ctx, req, res, m) => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      } catch {
        throw new ApiError("INVALID_JSON", 400, "请求体不是合法 JSON");
      }
      send(res, 200, updateContactFields(ctx.db, Number(m[1]), body));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/contacts\/(\d+)$/,
    handler: (ctx, _req, res, m) => {
      const ok = deleteContact(ctx.db, Number(m[1]));
      if (!ok) throw new ApiError("CONTACT_NOT_FOUND", 404, `联系人 id=${m[1]} 不存在`);
      send(res, 200, { deleted: true, id: Number(m[1]) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/contacts\/export$/,
    handler: (ctx, req, res, _m, q) => {
      const ids = (q.get("ids") ?? "").split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x));
      if (ids.length === 0) throw new ApiError("INVALID_IDS", 400, "导出需提供 ids=1,2,3");
      const cards = ids.map((id) => {
        const c = getContactById(ctx.db, id);
        if (!c) throw new ApiError("CONTACT_NOT_FOUND", 404, `联系人 id=${id} 不存在`);
        return c;
      });
      const text = serializeVCards(cards);
      res.setHeader("Content-Disposition", 'attachment; filename="contacts.vcf"');
      send(res, 200, text, "text/vcard; charset=utf-8");
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/contacts\/(\d+)\/export$/,
    handler: (ctx, _req, res, m) => {
      const c = getContactById(ctx.db, Number(m[1]));
      if (!c) throw new ApiError("CONTACT_NOT_FOUND", 404, `联系人 id=${m[1]} 不存在`);
      send(res, 200, serializeVCards([c]), "text/vcard; charset=utf-8");
    },
  },
  { method: "GET", pattern: /^\/api\/reports$/, handler: (ctx, _req, res) => send(res, 200, { reports: listReports(ctx.db) }) },
  {
    method: "GET",
    pattern: /^\/api\/reports\/(\d+)$/,
    handler: (ctx, _req, res, m) => {
      const report = getReport(ctx.db, Number(m[1]));
      if (!report) throw new ApiError("REPORT_NOT_FOUND", 404, `导入报告 id=${m[1]} 不存在`);
      send(res, 200, report);
    },
  },
];

export function createApp(dbPath: string): { server: Server; ctx: AppContext } {
  const db = openDatabase({ path: dbPath });
  const ctx: AppContext = { db };
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!match) {
          send(res, 404, { error: "NOT_FOUND", message: `无此路由：${req.method} ${url.pathname}` });
          return;
        }
        await match.handler(ctx, req, res, url.pathname.match(match.pattern)!, url.searchParams);
      } catch (err) {
        if (err instanceof ApiError) {
          send(res, err.status, { error: err.code, message: err.message, details: err.details });
        } else {
          send(res, 500, { error: "INTERNAL", message: (err as Error).message });
        }
      }
    })();
  });
  return { server, ctx };
}

/** 选择一个空闲端口：port=0 时由操作系统分配；否则校验是否可用。 */
export function pickPort(preferred?: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : Number(addr);
      probe.close(() => resolvePort(port));
    });
  });
}

async function main(): Promise<void> {
  const argPort = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const envPort = process.env.PORT;
  const preferred = argPort ?? envPort;
  const port = await pickPort(preferred ? Number(preferred) : undefined);
  const dbPath = process.env.DB_PATH ?? resolve("data/contacts.sqlite");
  const { server } = createApp(dbPath);
  server.listen(port, "127.0.0.1", () => {
    console.log(`[vcard] 数据文件: ${dbPath}`);
    console.log(`[vcard] 服务已启动: http://127.0.0.1:${port}`);
    console.log("[vcard] 健康检查: /api/health");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(normalize(process.argv[1])).href) {
  void main();
}
