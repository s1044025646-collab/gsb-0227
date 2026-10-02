import { rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, closeSharedDb, getSharedDb } from '../src/db.js';
import { ContactService } from '../src/service.js';
import { parseVCardText } from '../src/vcard/index.js';

const dataDir = resolve(process.cwd(), 'data');
const dbFile = resolve(dataDir, 'vcard.db');

function section(title: string): void {
  console.log(`\n========== ${title} ==========`);
}

function main(): void {
  if (existsSync(dbFile)) rmSync(dbFile, { force: true });
  for (const suffix of ['-wal', '-shmem']) {
    rmSync(dbFile + suffix, { force: true });
  }

  section('1. 读取示例名片（含中文长名、工作/家庭电话、转义分号、多行 FN）');
  const input = readFileSync(resolve(process.cwd(), 'examples/demo.vcf'), 'utf8');

  section('2. 导入（create-only）');
  let service = new ContactService(getSharedDb(dataDir));
  const report = service.importCards(input, 'create-only', 'examples/demo.vcf');
  console.log(
    `新建 ${report.created}，更新 ${report.updated}，跳过 ${report.skipped}，拒绝 ${report.rejected}`,
  );
  for (const item of report.items) {
    console.log(`  [${item.action}] uid=${item.uid}`);
    item.issues.forEach((i) => console.log(`      - ${i}`));
  }

  section('3. 查看联系人字段');
  const before = service.getContact('demo-zh-0001');
  console.log(JSON.stringify({ fn: before.fn, n: before.n, phones: before.phones, emails: before.emails }, null, 2));

  section('4. 修改一项：仅把工作电话改掉（家庭电话必须保留）');
  const newPhones = before.phones.map((p) =>
    p.types.includes('work') ? { ...p, value: '+86-10-99990000' } : p,
  );
  const patched = service.patchContact('demo-zh-0001', { phones: newPhones });
  patched.phones.forEach((p) => console.log(`  TEL [${p.types.join(',')}] ${p.value}`));
  console.log(`  邮箱未受影响，仍有 ${patched.emails.length} 个: ${patched.emails.map((e) => e.value).join(', ')}`);

  section('5. 导出全部联系人（长中文行按 UTF-8 字节折叠）');
  const exported = service.exportContacts(['demo-zh-0001', 'demo-long-0002']);
  console.log(exported);
  writeFileSync(resolve(dataDir, 'exported.vcf'), exported, 'utf8');

  section('6. 重新解析导出文件，核对往返一致');
  const reparsed = parseVCardText(exported);
  const zh = reparsed.cards.find((c) => c.uid === 'demo-zh-0001')!;
  console.log('FN 是否含换行:', JSON.stringify(zh.fn));
  console.log('工作电话:', zh.tels.find((t) => t.types.includes('work'))?.value);
  console.log('家庭电话:', zh.tels.find((t) => t.types.includes('home'))?.value);
  const longCard = reparsed.cards.find((c) => c.uid === 'demo-long-0002')!;
  console.log('长名联系人未知属性是否保留:', longCard.unknown.map((u) => u.name).join(','));

  section('7. 重复 UID：create-only 不覆盖，再用 update 显式更新');
  const againCreateOnly = service.importCards(exported, 'create-only', 'roundtrip');
  console.log('create-only =>', {
    created: againCreateOnly.created,
    skipped: againCreateOnly.skipped,
    updated: againCreateOnly.updated,
  });
  const changedInput = exported.replace('+86-10-99990000', '+86-10-11112222');
  const skipReport = service.importCards(changedInput, 'skip', 'changed-skip');
  console.log('内容变化 + skip => 跳过', skipReport.skipped, '更新', skipReport.updated);
  const updateReport = service.importCards(changedInput, 'update', 'changed-update');
  console.log('内容变化 + update => 更新', updateReport.updated);

  section('8. 模拟重启：关闭数据库句柄后重新打开');
  closeSharedDb();
  const db2 = openDatabase(dataDir);
  service = new ContactService(db2);
  const after = service.getContact('demo-zh-0001');
  console.log('重启后工作电话:', after.phones.find((p) => p.types.includes('work'))?.value);
  console.log('重启后家庭电话:', after.phones.find((p) => p.types.includes('home'))?.value);
  const exportAfterRestart = service.exportOne('demo-zh-0001');
  console.log('重启后导出可再次解析:', parseVCardText(exportAfterRestart).cards.length === 1);
  console.log('\n演示完成。数据文件:', dbFile);
}

main();
