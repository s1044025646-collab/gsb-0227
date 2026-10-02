# 本地 vCard 联系人导入导出服务

一个只跑在本机的 vCard 4.0 联系人后端，**只有 API 与 CLI，没有任何前端界面**。
使用 TypeScript + Node.js 内置 `node:sqlite` 持久化，无需 Docker、WSL、原生编译、
付费服务或任何在线通讯录 / 邮件平台。所有示例数据均为虚构联系人。

## 支持的 vCard 子集

- 仅支持 **vCard 4.0**（必须有 `VERSION:4.0`）。遇到 `VERSION:2.1/3.0` 直接报错，不做兼容转换。
- 受支持属性：
  - `FN`：显示姓名（必需）。
  - `N`：结构化姓名，固定 5 个分号段：姓;名;中间名/附加名;尊称前缀;尊称后缀；每段内部逗号列多值。
  - `UID`：联系人唯一标识；缺失时由内容派生确定性 UID。
  - `TEL` 与 `EMAIL`：可出现任意多次，各自携带 `TYPE` 参数（如 `work,voice`、`home`），多值全部保留。
- 文本语法：
  - **折叠行**：正确还原 CRLF/LF 后的空格或制表符续行。
  - **反斜杠转义**：`\\;`、`\\,`、`\\\\`、`\\n`（字段内换行）。
  - 结构化分号/逗号在引号参数与转义状态下解析，不会简单按行或分号硬切。
- **未知属性**（如 `X-*`、`NOTE`、`TITLE`、`ADR` 等）：原样保存在 `contact_unknown` 表，
  导出时写回，并在导入报告中以 `UNKNOWN_PROPERTY_PRESERVED` 警告标注。
- 明确**不支持**：vCard 2.1/3.0、`PHOTO` 等二进制/照片、`KEY` 等加密附件、参数级完整语义校验。

### 编码与折叠

- 全程以 UTF-8 读写（CLI/HTTP 均为 UTF-8）。
- 导出按 RFC 6350 在 CRLF 后用单个空格折叠长行；按 **UTF-8 字节数**计算
  （首行 ≤ 75 字节，续行连同前导空格 ≤ 75 字节），绝不在单个字符（含汉字）的字节中间断开。

## 重复 UID 与更新策略（显式，不静默覆盖）

导入时对每张卡片计算内容指纹（FN/N/TEL/EMAIL/未知属性，TYPE 排序后参与），
结合 UID 决定动作，结果写入导入报告：

| `onDuplicate` | 含义 |
| --- | --- |
| `skip`（默认） | UID 不存在则新建；内容一致记 `unchanged`；**内容不同则跳过并给 `CONFLICT_UID_SKIPPED` 警告，绝不覆盖** |
| `update` | 内容不同时显式整体替换该联系人，`version + 1` |
| `error` | 内容不同时直接返回 `409 UID_CONFLICT`，不改动数据 |

同一批次内重复 UID 记 `DUP_UID_WITHIN_BATCH` 错误并跳过后者。
非法卡片（缺 FN、版本不对、坏/缺结束标记等）**不会建为空联系人**，
报告里给出折叠还原后的逻辑行号、错误码与原因。

字段级修改（`PATCH` / `cli patch`）只替换请求体中显式给出的字段：
修改 `fn` 不会动电话；替换 `tels` 数组时给出的就是该字段的新集合，
因此“改一个号码”应把保留的号码一并提交，其他字段（邮箱等）不受影响。

## 数据目录

- 默认 SQLite 文件：`data/contacts.sqlite`（首次运行自动创建）。
- 可用环境变量 `DB_PATH` 覆盖。
- 表：`contacts`、`contact_tels`、`contact_emails`、`contact_unknown`、
  `import_reports`、`import_report_issues`、`import_items`。

## 环境要求

- Node.js ≥ 22.5（内置 `node:sqlite`；本仓库在 Node 25 上验证）。
- Windows / macOS / Linux 均可，开发与验证环境为 Windows + PowerShell。

## 安装、构建、测试

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # node:test + tsx，14 个用例
npm run demo      # 端到端演示：导入 -> 修改一个电话 -> 导出 -> 重新读取
```

## 启动 API

```powershell
npm start
# 或指定端口 / 数据文件
node --experimental-sqlite dist/server.js --port=8080
$env:DB_PATH="data/my.sqlite"; npm start
```

不传 `--port` 且未设 `PORT` 环境变量时，自动选择一个**空闲端口**并打印监听地址。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/contacts/import` | 导入。JSON `{text, source?, onDuplicate?}`，或直接 `text/vcard` 文本 |
| GET | `/api/contacts?q=` | 联系人列表与摘要（按 FN/UID/电话/邮箱模糊查） |
| GET | `/api/contacts/:id` | 查看全部受支持字段与未知属性名 |
| PATCH | `/api/contacts/:id` | 修改 `fn`/`n`/`tels`/`emails` |
| DELETE | `/api/contacts/:id` | 删除联系人 |
| GET | `/api/contacts/:id/export` | 导出单个 vCard |
| GET | `/api/contacts/export?ids=1,2` | 批量导出 vCard |
| GET | `/api/reports`、`/api/reports/:id` | 导入报告与问题明细 |

错误统一返回 `{ "error": 错误码, "message": 中文说明 }`，常见码：
`MISSING_FN`、`UNSUPPORTED_VERSION`、`BAD_END_MARKER`、`VCARD_NOT_CLOSED`、
`CONFLICT_UID_SKIPPED`、`UID_CONFLICT(409)`、`CONTACT_NOT_FOUND(404)`、
`INVALID_FN/INVALID_N/INVALID_TYPES/INVALID_MULTIVALUE(400)`、`PAYLOAD_TOO_LARGE(413)`。

### curl / PowerShell 示例

```powershell
Invoke-RestMethod -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes((@{ text = Get-Content demo/sample.vcf -Raw } | ConvertTo-Json))) `
  http://127.0.0.1:8080/api/contacts/import

Invoke-RestMethod http://127.0.0.1:8080/api/contacts/1
Invoke-WebRequest http://127.0.0.1:8080/api/contacts/1/export -OutFile out.vcf
```

## CLI

```powershell
node --experimental-sqlite dist/cli.js import demo/sample.vcf
node --experimental-sqlite dist/cli.js import demo/sample.vcf --on-duplicate=update
node --experimental-sqlite dist/cli.js list
node --experimental-sqlite dist/cli.js list --q=欧阳
node --experimental-sqlite dist/cli.js get 1

# 只把工作电话改成新号码，家庭电话随数组一并保留
node --experimental-sqlite dist/cli.js patch 1 '{"tels":[{"value":"+86 10 9999 0000","types":["work","voice"]},{"value":"+86 21 5555 2222","types":["home","voice"]}]}'

node --experimental-sqlite dist/cli.js export 1,2 --out out.vcf
node --experimental-sqlite dist/cli.js reports
node --experimental-sqlite dist/cli.js report 1
```

## 演示数据要点（`demo/sample.vcf`）

- 中文长姓名与完整结构化姓名（姓/名/中间名/前缀/后缀）。
- 工作与家庭两个电话、工作与家庭两个邮箱，验证多值不丢失。
- FN 内含转义分号 `\\;` 与字段内换行 `\\n`。
- 超长中英混排 `NOTE`，验证 UTF-8 按字节折叠。
- 未知属性 `X-HOBBY` / `NOTE`，验证原样往返与警告标注。

## 假设与限制

- 仅监听 `127.0.0.1`，定位为单机本地服务，未实现鉴权/TLS。
- `N` 视为一个完整结构化字段整体更新；不提供对单个姓名组成部分的独立 PATCH。
- 未支持属性不做语义校验，仅保证原文往返；`PREF` 等其他参数随未知属性保留，
  受支持属性上除 `TYPE` 外的参数不在领域模型中单独展开。
- `node:sqlite` 在当前 Node 版本仍带实验性警告，不影响功能。
