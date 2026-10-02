import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getSharedDb } from './db.js';
import { ContactService, ImportMode } from './service.js';
import { ContactRecord } from './repository.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { command, positional, flags };
}

function printContact(c: ContactRecord): void {
  console.log(`#${c.id}  UID=${c.uid}`);
  console.log(`  FN: ${c.fn.replace(/\n/g, '\\n')}`);
  const n = c.n;
  console.log(
    `  N : 姓[${n.familyNames.join(',')}] 名[${n.givenNames.join(',')}] ` +
      `中间[${n.additionalNames.join(',')}] 前缀[${n.honorificPrefixes.join(',')}] ` +
      `后缀[${n.honorificSuffixes.join(',')}]`,
  );
  for (const p of c.phones) {
    console.log(`  TEL  [${p.types.join(',') || '-'}] ${p.value}`);
  }
  for (const e of c.emails) {
    console.log(`  EMAIL[${e.types.join(',') || '-'}] ${e.value}`);
  }
  for (const u of c.unknown) {
    console.log(`  (未知属性原样保留) ${u.name}: ${u.rawValue}`);
  }
}

const HELP = [
  'vcard-local —— 本地 vCard 4.0 联系人 CLI',
  '',
  '用法: npm run cli -- <命令> [参数]',
  '',
  '命令:',
  '  import <文件> [--mode create-only|update|skip] [--source 名称]',
  '  list [--q 关键字]',
  '  get <id 或 UID>',
  '  export <id或UID,...> [--out 文件]',
  '  patch-fn <id或UID> <新 FN>',
  '  patch-phone <id或UID> <JSON 数组>',
  '  patch-email <id或UID> <JSON 数组>',
  '  reports',
  '  report <报告 id>',
  '  help',
].join('\n');

function fail(msg: string): never {
  console.error(`[参数错误] ${msg}`);
  process.exit(2);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolve(process.cwd(), process.env.DATA_DIR ?? 'data');
  const service = new ContactService(getSharedDb(dataDir));

  try {
    switch (args.command) {
      case 'import': {
        const file = args.positional[0];
        if (!file) fail('缺少文件参数');
        const mode = (args.flags.mode ?? 'create-only') as ImportMode;
        const text = readFileSync(resolve(file), 'utf8');
        const report = service.importCards(text, mode, args.flags.source ?? file);
        console.log(
          `报告 #${report.reportId}  模式=${report.mode}  共 ${report.total} 张：` +
            `新建 ${report.created}，更新 ${report.updated}，跳过 ${report.skipped}，拒绝 ${report.rejected}`,
        );
        for (const it of report.items) {
          console.log(
            `  [${it.action}] #${it.cardIndex} uid=${it.uid || '(无)'}${
              it.contactId !== null ? ` -> 联系人#${it.contactId}` : ''
            }`,
          );
          for (const issue of it.issues) console.log(`      - ${issue}`);
        }
        break;
      }
      case 'list': {
        const list = service.listContacts(args.flags.q);
        if (list.length === 0) console.log('（无联系人）');
        list.forEach(printContact);
        break;
      }
      case 'get': {
        if (!args.positional[0]) fail('缺少 id/UID 参数');
        printContact(service.getContact(args.positional[0]));
        break;
      }
      case 'export': {
        if (!args.positional[0]) fail('缺少 id/UID 列表');
        const ids = args.positional[0].split(',').map((s) => s.trim()).filter(Boolean);
        const text = service.exportContacts(ids);
        if (args.flags.out) {
          writeFileSync(resolve(args.flags.out), text, 'utf8');
          console.log(`已导出 ${ids.length} 个联系人到 ${args.flags.out}`);
        } else {
          console.log(text);
        }
        break;
      }
      case 'patch-fn': {
        const [id, ...rest] = args.positional;
        if (!id || rest.length === 0) fail('用法: patch-fn <id或UID> <新 FN>');
        const fn = rest.join(' ').replace(/\\n/g, '\n');
        printContact(service.patchContact(id, { fn }));
        break;
      }
      case 'patch-phone':
      case 'patch-email': {
        const [id, json] = args.positional;
        if (!id || !json) fail(`用法: ${args.command} <id或UID> <JSON 数组>`);
        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch {
          fail('JSON 数组解析失败');
        }
        const body = args.command === 'patch-phone' ? { phones: parsed } : { emails: parsed };
        printContact(service.patchContact(id, body));
        break;
      }
      case 'reports': {
        const reports = service.listReports();
        if (reports.length === 0) console.log('（无导入报告）');
        for (const r of reports) {
          console.log(
            `#${r.reportId} ${r.createdAt} 模式=${r.mode} 来源=${r.sourceName} ` +
              `共${r.total} 新建${r.created} 更新${r.updated} 跳过${r.skipped} 拒绝${r.rejected}`,
          );
        }
        break;
      }
      case 'report': {
        if (!args.positional[0]) fail('缺少报告 id');
        const report = service.getReport(Number(args.positional[0]));
        if (!report) fail('报告不存在');
        for (const it of report.items) {
          console.log(`[${it.action}] #${it.cardIndex} uid=${it.uid || '(无)'}`);
          for (const issue of it.issues) console.log(`    - ${issue}`);
        }
        break;
      }
      case 'help':
      case '--help':
      case '-h':
      case '':
        console.log(HELP);
        break;
      default:
        console.error(`未知命令: ${args.command}\n`);
        console.log(HELP);
        process.exitCode = 2;
    }
  } catch (e) {
    if (e && typeof e === 'object' && 'code' in e && 'status' in e) {
      const err = e as unknown as { code: string; message: string };
      console.error(`[错误 ${err.code}] ${err.message}`);
    } else {
      console.error('[错误]', e instanceof Error ? e.message : String(e));
    }
    process.exitCode = 1;
  }
}

main();
