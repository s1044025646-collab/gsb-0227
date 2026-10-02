# vcard-local：本地 vCard 4.0 联系人导入导出服务

一个只运行在本机 Windows 上的 vCard 联系人后端，使用 **TypeScript + Node.js + SQLite**。
仅提供 HTTP API 与命令行（CLI），无前端、无 Docker/WSL、不连接任何通讯录账户或邮件平台，
所有示例数据均为虚构联系人。

## 功能概览

- 导入/导出 **UTF-8 编码的 vCard 4.0** 文本（`.vcf`）。
- 查看与维护：格式化姓名 `FN`、结构化姓名 `N`（姓/名/中间名/前缀/后缀五段）、
  多个 `TEL` 与 `EMAIL` 及其 `TYPE` 参数（如 `work,voice`、`home`）。
- 正确处理 **折叠行、反斜杠转义、字段内换行、分号/逗号**，不按“每行/每个分号”粗暴切分。
- 多个电话/邮箱全部保留；结构化姓名与显示姓名严格区分，互不覆盖。
- 导出时按 **UTF-8 字节数（每行不超过 75 字节）** 折叠长行，绝不在一个多字节字符中间断开。
- 未知属性（如 `NOTE`、`X-*`）**原样保留**并在导入报告中标注“不在受支持子集内”。
- 同一 `UID` 不重复建档；内容变化时采用**显式更新策略**，绝不静默覆盖。
- 每次导入都生成持久化的**导入报告**：新建/更新/跳过/拒绝数量、逐卡问题与非法卡片的**行号和原因**。
- 非法卡片不会伪装成空联系人入库。

## 支持的 vCard 子集

| 类别 | 内容 |
| --- | --- |
| 版本 | 仅 `VERSION:4.0`（2.1/3.0 报 `UNSUPPORTED_VERSION`） |
| 核心属性 | `FN`（必需）、`N`（可选，严格 5 段）、`UID`（必需）、`TEL`、`EMAIL` |
| 参数 | `TYPE`（可逗号多值，大小写不敏感，导出统一大写）、其它参数原样存取（如 `PREF=1`） |
| 转义 | `\\n`/`\\N` 换行、`\\,`、`\\;`、`\\\\`；非法转义序列报 `BAD_ESCAPE` |
| 折叠 | 支持 CRLF/LF 输入；导出使用 `CRLF + 空格` 折叠 |
| 结构标记 | `BEGIN:VCARD` / `END:VCARD`，写错结束标记报 `BAD_END` |
| 未知属性 | 原样保留名称、分组、参数与原始值，不解析语义，往返不丢失 |
| 明确不支持 | 照片（`PHOTO`）、加密密钥（`KEY`）、IMPP/GEO 等扩展语义、vCard 2.1/3.0 |

## 更新策略（重复 UID）

导入通过 `mode` 显式指定，默认 `create-only`：

- `create-only`：只新建；UID 已存在时**一律跳过**（无论内容是否相同），不覆盖。
- `skip`：内容相同跳过；内容不同也**跳过并在报告中说明**，不覆盖。
- `update`：内容相同跳过；内容不同则在事务中**显式整卡覆盖更新**，报告记录为 `updated`。

单联系人局部修改走 `PATCH`：只修改提交的字段。提交 `phones` 时整体替换该联系人的电话集合，
但**不会触碰邮箱、姓名**；只改 `FN` 也不会影响电话/邮箱，因此“改一个电话不会删掉其它号码”。

## 字符编码

- 所有读写均按 **UTF-8** 处理，中文字符以多字节正确存取。
- 折叠以 **UTF-8 字节长度** 计算（物理行 ≤ 75 字节），按代码点边界断开，不会产生半个字符。

## 环境要求

- Node.js **>= 22.5**（使用内置实验模块 `node:sqlite`；已在 Node v25 验证）。
- Windows 本地运行，无需安装数据库服务、Docker 或 WSL。

## 安装

```powershell
npm install
```

## 构建 / 测试 / 启动

```powershell
npm run build     # TypeScript 编译到 dist/
npm test          # 运行 node:test 全部测试（解析、往返、服务、HTTP、重启持久化）
npm start         # 启动 HTTP 服务（默认自动选择空闲端口）
npm run demo      # 一键端到端演示（导入 -> 修改 -> 导出 -> 重读 -> 模拟重启）
```

指定端口与数据目录：

```powershell
$env:PORT="3000"; $env:DATA_DIR="data"; npm start
# 或直接：node dist/src/server/main.js 8080
```

数据默认存放在项目内 `data/vcard.db`（SQLite，WAL 模式）。

## CLI 命令样例

```powershell
# 导入（默认 create-only；可显式 --mode update 或 skip）
npm run cli -- import examples/demo.vcf --mode create-only

# 列出 / 模糊查询
npm run cli -- list
npm run cli -- list --q 欧阳

# 查看单个人的全部字段
npm run cli -- get demo-zh-0001

# 修改显示姓名（\n 会变成真正的字段内换行）
npm run cli -- patch-fn demo-zh-0001 "欧阳`n新名字"

# 整体替换电话集合（其它字段与邮箱不受影响）
npm run cli -- patch-phone demo-zh-0001 '[{"value":"+86-10-99990000","types":["work","voice"],"params":{"PREF":"1"}}]'

# 导出一个或多个联系人
npm run cli -- export demo-zh-0001,demo-long-0002 --out data/exported.vcf

# 查看导入报告（含非法卡片行号与原因）
npm run cli -- reports
npm run cli -- report 1
```

## HTTP API 样例

服务启动后基址形如 `http://127.0.0.1:<port>`（端口打印在控制台）。

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /contacts/import?mode=update&source=a.vcf` | 导入，请求体为 `text/plain` 的 vCard 文本，返回导入报告 |
| `GET /contacts?q=关键字` | 列出/按 FN、UID 模糊查询 |
| `GET /contacts/{id或UID}` | 查看单个联系人全部字段 |
| `PATCH /contacts/{id或UID}` | 局部修改，JSON：`{fn?, n?, phones?, emails?}` |
| `GET /contacts/{id或UID}/vcard` | 导出单个 vCard（`text/vcard`） |
| `POST /contacts/export` | 批量导出，JSON：`{"ids":["uid1",2]}` |
| `GET /reports` | 导入报告列表 |
| `GET /reports/{id}` | 某次导入逐项明细 |

```powershell
# PowerShell 导入
Invoke-RestMethod http://127.0.0.1:$port/contacts/import?mode=create-only `
  -Method Post -ContentType 'text/plain; charset=utf-8' `
  -InFile examples/demo.vcf

# 修改
Invoke-RestMethod http://127.0.0.1:$port/contacts/demo-zh-0001 `
  -Method Patch -ContentType 'application/json' `
  -Body '{"fn":"欧阳\n新名字"}'
```

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `EMPTY_PATCH` / `INVALID_JSON` / `INVALID_MODE` | 请求参数不合法 |
| 404 | `NOT_FOUND` / `NO_ROUTE` | 联系人/报告/路由不存在 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 8MB |
| 200（报告项 action=`rejected`） | `MISSING_FN`/`MISSING_UID`/`MISSING_VERSION`/`UNSUPPORTED_VERSION`/`BAD_END`/`BAD_LINE`/`BAD_PARAM`/`BAD_ESCAPE`/`N_COMPONENT_COUNT` | 单张卡片非法，附带行号与原因 |

非法卡片属于**逐卡校验**结果：一次导入中好的卡片照常入库，坏卡片出现在报告 `rejected` 项里并带行号。

## 演示数据

`examples/demo.vcf` 包含两位虚构联系人：

- 中文姓名、工作电话与家庭电话、工作/家庭邮箱、转义分号逗号、字段内换行的显示名；
- 超长中文姓名（用于验证按 UTF-8 字节折叠）与一个未知扩展属性（验证原样保留）。

运行 `npm run demo` 会在 `data/` 下生成数据库与 `exported.vcf`，并打印完整往返核对结果。

## 项目结构

```
src/
  vcard/        # 词法展开、解析、转义、序列化（自行实现，不使用通讯录/第三方 vCard 库）
  db.ts         # SQLite 建表迁移
  repository.ts # 联系人/多值字段存取（电话、邮箱、未知属性分表）
  service.ts    # 导入策略、语义对比、PATCH 校验、导入报告
  server/       # HTTP 服务与空闲端口选择
  cli.ts        # 命令行
scripts/demo.ts # 端到端演示
test/           # 固定预期测试
examples/demo.vcf
```

## 已知限制与假设

- 仅支持 vCard 4.0；不解析也不转换照片、二进制附件与 vCard 2.1/3.0 语法。
- `N` 按 RFC 五段文本列表处理；未提供 `N` 时存为五个空列表。
- 未知属性按原始（未反转义的）值原样往返，不保证其专属语义。
- `UID` 在同一数据库内唯一；同一批次内重复 UID 的后续卡片记为 `rejected`。
- 服务仅监听 `127.0.0.1`，不对外暴露。
- `node:sqlite` 在当前 Node 版本标记为实验性，运行时会有一条实验性警告，功能正常。
