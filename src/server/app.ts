import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { ContactService } from '../service.js';
import { ApiError } from '../vcard/errors.js';

interface RouteCtx {
  service: ContactService;
  body: unknown;
  params: Record<string, string>;
  searchParams: URLSearchParams;
}

type Handler = (ctx: RouteCtx) => { status: number; body: unknown; contentType?: string };

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const regexSrc = path.replace(/:([^/]+)/g, (_m, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${regexSrc}$`), paramNames, handler };
}

const routes: Route[] = [
  route('GET', '/health', () => ({
    status: 200,
    body: { status: 'ok', service: 'vcard-local' },
  })),
  route('POST', '/contacts/import', ({ service, body, searchParams }) => {
    if (typeof body !== 'string') {
      throw new ApiError(400, 'VALIDATION_ERROR', '请求体必须是 UTF-8 vCard 文本（text/plain）');
    }
    const mode = (searchParams.get('mode') as 'create-only' | 'update' | 'skip') ?? 'create-only';
    const sourceName = searchParams.get('source') ?? '';
    return { status: 200, body: service.importCards(body, mode, sourceName) };
  }),
  route('GET', '/contacts', ({ service, searchParams }) => ({
    status: 200,
    body: { contacts: service.listContacts(searchParams.get('q') ?? undefined) },
  })),
  route('GET', '/contacts/:idOrUid', ({ service, params }) => ({
    status: 200,
    body: service.getContact(params.idOrUid),
  })),
  route('PATCH', '/contacts/:idOrUid', ({ service, body, params }) => ({
    status: 200,
    body: service.patchContact(params.idOrUid, (body ?? {}) as Record<string, unknown>),
  })),
  route('GET', '/contacts/:idOrUid/vcard', ({ service, params }) => ({
    status: 200,
    body: service.exportOne(params.idOrUid),
    contentType: 'text/vcard; charset=utf-8',
  })),
  route('POST', '/contacts/export', ({ service, body }) => {
    const ids = (body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
      throw new ApiError(400, 'VALIDATION_ERROR', '请求体必须为 { "ids": string[] }');
    }
    return {
      status: 200,
      body: service.exportContacts(ids as string[]),
      contentType: 'text/vcard; charset=utf-8',
    };
  }),
  route('GET', '/reports', ({ service }) => ({
    status: 200,
    body: { reports: service.listReports() },
  })),
  route('GET', '/reports/:id', ({ service, params }) => {
    const report = service.getReport(Number(params.id));
    if (!report) throw new ApiError(404, 'NOT_FOUND', `导入报告不存在: ${params.id}`);
    return { status: 200, body: report };
  }),
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 8MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp(service: ContactService): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, payload: unknown, contentType?: string) => {
      res.statusCode = status;
      if (contentType) {
        res.setHeader('Content-Type', contentType);
        res.end(payload as string);
      } else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload, null, 2));
      }
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const matched = routes.find(
        (r) => r.method === method && r.pattern.test(url.pathname),
      );
      if (!matched) {
        send(404, { error: { code: 'NO_ROUTE', message: `无此路由: ${method} ${url.pathname}` } });
        return;
      }
      const match = url.pathname.match(matched.pattern)!;
      const params: Record<string, string> = {};
      matched.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      let rawBody = '';
      if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
        rawBody = await readBody(req);
      }
      const isPlainVcard =
        (req.headers['content-type'] ?? '').includes('text/') ||
        (req.headers['content-type'] ?? '').includes('vcard');
      let parsedBody: unknown = {};
      if (rawBody !== '') {
        if (isPlainVcard) {
          parsedBody = rawBody;
        } else {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            throw new ApiError(400, 'INVALID_JSON', '请求体不是合法 JSON（导入 vCard 请用 text/plain）');
          }
        }
      }

      const result = matched.handler({
        service,
        body: parsedBody,
        params,
        searchParams: url.searchParams,
      });
      send(result.status, result.body, result.contentType);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message, details: e.details } });
      } else if (e instanceof SyntaxError) {
        send(400, { error: { code: 'BAD_REQUEST', message: e.message } });
      } else {
        send(500, {
          error: {
            code: 'INTERNAL',
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }
  });
}
