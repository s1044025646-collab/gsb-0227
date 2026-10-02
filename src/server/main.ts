import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { getSharedDb } from '../db.js';
import { ContactService } from '../service.js';
import { createApp } from './app.js';

/** 请求一个空闲端口：监听 0 由系统分配，再关闭取得端口号 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let port = Number(process.env.PORT ?? args[0] ?? 0);
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data');

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`[启动失败] 非法端口: ${process.env.PORT ?? args[0]}`);
    process.exit(2);
  }
  if (port === 0) {
    port = await pickFreePort();
  }

  const db = getSharedDb(dataDir);
  const service = new ContactService(db);
  const server = createApp(service);

  server.listen(port, '127.0.0.1', () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log('vCard 本地联系人服务已启动');
    console.log(`  地址:   http://127.0.0.1:${actualPort}`);
    console.log(`  数据目录: ${dataDir}`);
    console.log('  按 Ctrl+C 停止');
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[启动失败]', e);
  process.exit(1);
});
