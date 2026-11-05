# Local / Codex Web Relay

供少量用户使用的自托管 Web 应用。用户凭 Key 聊天、上传文件并接收流式回复。订阅登录与 Codex 会话均在本地；公网中继不接触模型凭据。

## 已实现

- React 中文聊天页与管理页；Key 登录、替换、禁用、独立用户空间。
- 一对一网页会话 / Codex thread 映射；后续只提交新输入，上下文由 Codex 管理。
- Codex app-server stdio 集成、thread 创建/恢复、turn 流式事件、停止生成。
- 每条消息最多 20 个文件，单文件最多 **100,000,000 字节（100 MB）**。
- 分块上传、分块重试、服务端上传状态查询、SHA-256 校验。
- 用户文件下载鉴权；本地附件按会话持久化。
- 全局单并发、用户轮转队列、同会话互斥、幂等提交。
- SQLite 消息/任务持久化、本地事件 outbox、SSE 重连与事件去重。
- 中继重启对账；不确定任务不自动重新调用模型。
- 删除会话后本地和中继异步清理；24 小时孤立上传清理。
- 独立模拟执行端和自动化集成测试，不消耗模型额度。

## 环境

- Node.js 24 或以上，npm。
- 真实模式需要本机安装 Codex CLI；本次协议握手验证使用 **0.160.0**。
- Windows 命令推荐在 Git Bash 中运行。
- `node:sqlite` 目前可能输出 experimental 提示，不影响本项目运行。

## 先体验界面（不登录 Codex）

```bash
npm ci
npm run build
npm run preview
```

打开 http://localhost:3001。

- 用户 Key：`local-preview-user-only-2026`
- 管理员 Key：`local-preview-admin-only-2026`

这两个 Key **只用于隔离的本机演示**。预览仅监听 `127.0.0.1`，每次创建新的演示数据目录，不读取 `.env`，不读取或调用真实 Codex。不要把演示端口通过反向代理公开。页面会明显标注模拟模式。

## 本机真实运行

```bash
npm run setup
npm run build
npm run login
```

`setup` 生成 `.env` 和两个不同的随机管理/设备密钥，不覆盖已有配置。登录命令使用 `data/worker/codex-home` 专用配置，不读取日常 Codex 配置，也不复制你的现有登录缓存。请在系统浏览器完成登录。

随后分别打开两个终端，在项目根目录运行：

```bash
# 终端一：网页和中继
npm run dev
```

```bash
# 终端二：本地执行端
npm run worker
```

打开 http://localhost:3000，用 `.env` 中的 `ADMIN_KEY` 进入管理页，创建用户，将生成的用户 Key 单独发给对应用户。退出管理员后，可以用用户 Key 进入聊天。

若 Codex 无法启动，在 `.env` 中设置 `CODEX_BIN` 为 **codex.exe 的绝对路径**，不使用 `.cmd` 包装脚本。可以运行：

```bash
npm run check:codex
```

该命令只检查本地协议握手、授权是否存在和主要工具关闭配置，不发送模型生成请求，也不输出凭据。完成登录后重启 worker。

## 分开部署

自动部署、独立连接配置和公网验收命令见 [VPS 部署指南](deploy/README.md)。实际部署地址仅保存在本机未跟踪配置中。

公网服务器运行中继，Windows 电脑运行 worker。两个位置都需要项目代码和依赖，但配置应分开保存。

中继环境（参考 `.env.example`）：

```dotenv
HOST=0.0.0.0
PORT=3000
PUBLIC_ORIGIN=https://chat.example.com
COOKIE_SECURE=true
ADMIN_KEY=至少24字符的随机管理员密钥
WORKER_KEY=与本地一致的随机设备密钥
RELAY_DATA=/var/lib/local-codex-relay
USER_QUOTA_BYTES=10000000000
DISK_RESERVE_BYTES=1073741824
```

本地环境：

```dotenv
RELAY_URL=https://chat.example.com
WORKER_KEY=与中继一致的随机设备密钥
WORKER_DATA=./data/worker
WORKER_MODE=codex
```

本地不需要配置 `ADMIN_KEY`。中继不需要 Codex，不需要模型账号令牌，不需要本地 Codex 数据目录。

使用 HTTPS 反向代理，并保持同源访问。参考 `deploy/Caddyfile`。浏览器走 HTTPS/SSE，本地 worker 主动建立 WSS。远程中继地址如果不是 HTTPS，worker 会拒绝连接。

Linux 中继可以使用 `deploy/Dockerfile` 构建，挂载数据卷；不要把 `.env`、本地 worker 数据或 Codex 凭据复制进镜像。Windows worker 可通过任务计划程序在用户登录后启动 `npm run worker`，工作目录设为项目根目录。

## 附件支持与实际限制

- 文本、代码、CSV：UTF-8；直接读取上限 8 MB，解析文本最多 200 万字符。
- PDF：最多 500 页，提取文字；不含 OCR，不保证表格/复杂排版完全还原。
- 图片：PNG/JPG，以 Codex `localImage` 输入提交，最终仍受模型输入限制。
- 单条消息附件提取文本合计最多 200 万字符，超限明确报错，不静默截断。
- PDF 解析在受限堆大小的独立工作线程运行，最长 60 秒。
- 上传限额与模型处理能力不同。100 MB 文件可以上传保存，但超出解析/模型能力时不能直接完成分析。
- 网页刷新后会保留服务端上传分块；重新选择同一文件尚未自动关联旧 upload ID。当前网页内的重试会复用已有分块，接口也支持客户端自行查询和续传。

为适配本机 Codex 0.160.0，第一版关闭 Shell、代码执行、插件、MCP 宿主集成、浏览器/电脑操作等能力，附件在本地转换后只作为**本轮新增输入**提交。并非每轮重新拼接历史。Codex 自己维护已提交内容及压缩历史，因此长会话不能保证永远保留所有附件原文；需要精确重读时可再次附上文件。

## 安全边界与运行说明

- 一人一个用户身份。更换 Key 不改变用户 ID；旧 Key 和网页登录立即失效。
- 用户数据、任务、SSE、附件访问均检查用户归属。
- 管理页不提供读取用户聊天内容的入口；服务器运营者仍可直接访问磁盘数据。
- 本地使用专用 `CODEX_HOME` 和工具关闭配置，不加载你的日常个人会话。
- **独立 thread / cwd 不是操作系统级隔离。** 本次已验证关闭配置生效，但未登录真实账号进行模型越权测试。启用新的工具能力或开放给不可信用户之前，需要在实际目标环境验证权限边界；不要启用全盘访问。
- 所有 Codex 主动发起的交互工具/权限请求由适配器拒绝，不自动授权；当前不提供交互式批准 UI。
- Codex 进程退出或授权失效需要本地处理，重新登录后重启 worker。
- 本地服务不自动重放可能已执行的请求。重启后有已知 turn ID 的已完成输出会尝试恢复，无法确认则显示中断。
- 网页历史和 Codex 会话分别存储，备份必须覆盖中继数据目录和本地 worker 目录；凭据备份留在可信本地位置。
- 默认配额每用户 10 GB；中继磁盘剩余预留 1 GiB。
- 日志不打印 prompt、文件内容、账号信息或完整 Key。

官方 app-server 文档说明传统 app-server 认证不用于商业或托管服务。多人公网服务的实际认证/授权范围仍需落实；代码实现不代表获得该授权。参阅 https://learn.chatgpt.com/docs/app-server#auth-endpoints 。

## 开发与验证

```bash
npm run check
npm test
npm run build
npm audit
```

前端热更新：先启动中继，再运行 `npm run web`，访问 http://localhost:5173。开发代理转发到 3000。

测试包含真实 HTTP/WebSocket/SSE 链路、跨用户拒绝、上传边界、附件完整性、幂等、停止、重启后会话续用、中继重启事件补发及 Key 撤销。模型部分使用独立模拟执行端。

## 目录

```text
apps/web/          用户和管理页面
apps/relay/        公网中继
apps/worker/       本地 Codex 集成、附件处理、事件缓存
packages/         共享协议和存储工具
scripts/          初始化、预览、本地协议检查
tests/            集成和恢复测试
deploy/           部署参考
data/             运行时数据，不入版本库
```
