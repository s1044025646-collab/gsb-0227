import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, getContactById, listContacts, getReport, listReports } from "./db.js";
import { importVCard, updateContactFields } from "./contacts.js";
import { serializeVCards } from "./vcard/serializer.js";

function usage(): never {
  console.error(`用法: vcard <命令> [选项]

命令:
  import <文件.vcf> [--on-duplicate=skip|update|error] [--source=名字]
                   导入 UTF-8 vCard 4.0，默认 skip：重复 UID 内容变化时拒绝覆盖
  list [--q=关键字]                列出联系人摘要
  get <id>                         查看联系人全部受支持字段
  patch <id> '<JSON>'              修改受支持字段 fn/n/tels/emails（仅改给出的字段）
  export <id[,id...]> [--out=a.vcf] 导出一个或多个联系人
  reports                          列出导入报告
  report <id>                      查看某次导入的问题明细

环境:
  DB_PATH   SQLite 文件路径（默认 ./data/contacts.sqlite）

示例:
  vcard import demo/sample.vcf
  vcard patch 1 '{"tels":[{"value":"+86 138 0000 1234","types":["work","voice"]}]}'
  vcard export 1 --out out.vcf`);
  process.exit(1);
}

function getDbPath(): string {
  return process.env.DB_PATH ?? resolve("data/contacts.sqlite");
}

function flag(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const db = openDatabase({ path: getDbPath() });

  switch (cmd) {
    case "import": {
      const file = rest.find((a) => !a.startsWith("--"));
      if (!file) usage();
      const onDuplicate = flag(rest, "on-duplicate");
      const text = readFileSync(resolve(file), "utf8");
      const result = importVCard(db, {
        text,
        source: flag(rest, "source") ?? file,
        onDuplicate: (onDuplicate as "skip" | "update" | "error") ?? undefined,
      });
      printJson(result);
      break;
    }
    case "list": {
      printJson({ contacts: listContacts(db, flag(rest, "q")) });
      break;
    }
    case "get": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) usage();
      const contact = getContactById(db, id);
      if (!contact) {
        console.error(`联系人 id=${id} 不存在`);
        process.exit(2);
      }
      printJson(contact);
      break;
    }
    case "patch": {
      const id = Number(rest[0]);
      const json = rest[1];
      if (!Number.isInteger(id) || !json) usage();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(json) as Record<string, unknown>;
      } catch {
        console.error("第二个参数必须是合法 JSON");
        process.exit(1);
      }
      printJson(updateContactFields(db, id, body));
      break;
    }
    case "export": {
      const idsArg = rest.find((a) => !a.startsWith("--"));
      if (!idsArg) usage();
      const ids = idsArg.split(",").map((x) => Number(x.trim()));
      const cards = ids.map((id) => {
        const c = getContactById(db, id);
        if (!c) {
          console.error(`联系人 id=${id} 不存在`);
          process.exit(2);
        }
        return c!;
      });
      const text = serializeVCards(cards);
      const out = flag(rest, "out");
      if (out) {
        writeFileSync(resolve(out), text, "utf8");
        console.error(`已写出 ${out}（${Buffer.byteLength(text, "utf8")} 字节）`);
      } else {
        process.stdout.write(text);
      }
      break;
    }
    case "reports":
      printJson({ reports: listReports(db) });
      break;
    case "report": {
      const id = Number(rest[0]);
      if (!Number.isInteger(id)) usage();
      const report = getReport(db, id);
      if (!report) {
        console.error(`报告 id=${id} 不存在`);
        process.exit(2);
      }
      printJson(report);
      break;
    }
    default:
      usage();
  }
}

main();
