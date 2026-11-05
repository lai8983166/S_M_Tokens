# VPS 中继部署与公网联调

支持两种模式，从本机 Git Bash 通过 SSH 部署。公网服务器仅运行中继和网页，Codex 继续留在本机。

- `docker`：适用于新服务器，预装 Docker Engine/Compose。
- `systemd`：复用已有 Caddy，从 Node.js 官网下载并校验指定 Node 24 运行时，独立非特权账号运行中继，无需 Docker。

## 部署配置示例

实际服务器、SSH 用户与密钥路径填写在未跟踪的 `deploy/vps.config.json`。下面仅展示配置格式，请按自己的环境填写。

额外配置项：

```json
{
  "mode": "systemd",
  "basePath": "/agent",
  "relayPort": 3300,
  "existingUpstream": "127.0.0.1:8080",
  "expectedCaddySha256": "填入核对过的原 Caddyfile SHA-256"
}
```

`systemd` 部署只允许覆盖已核对的原 Caddyfile，或本脚本上一版管理的配置。如果别人修改过 Caddyfile，脚本会停止，不自动覆盖。修改前会备份配置和已有 unit，失败尝试恢复。此模板适用于一个已知域名/原上游；多域名复杂 Caddy 配置需要单独合并。

systemd 运行数据在 `/var/lib/local-codex-relay`，服务名为 `local-codex-relay`，Node 工具安装在部署目录的 `tools/`。排障：

```bash
systemctl status local-codex-relay
journalctl -u local-codex-relay --no-pager -n 100
```

## 1. 填写配置

```bash
npm run vps:init
```

编辑 `deploy/vps.config.json`：

```json
{
  "host": "你的VPS地址",
  "port": 22,
  "user": "root",
  "identityFile": "C:/Users/你的用户名/.ssh/id_ed25519",
  "domain": "chat.你的域名.com",
  "acmeEmail": "",
  "remoteDirectory": "/opt/local-codex-relay",
  "userQuotaBytes": 10000000000,
  "diskReserveBytes": 1073741824
}
```

- `identityFile` 填绝对路径；留空则使用 SSH Agent/默认密钥。不要填写私钥正文或密码。
- host 支持 IPv4 或 SSH 主机名，第一版不支持裸 IPv6 地址。
- 域名不带 `https://`、端口或路径，需要可申请公开 TLS 证书的域名。
- 私钥文件不会被读取打包或上传，只作为本机 SSH 的身份参数。
- 配置文件、部署凭据和压缩包均已加入版本控制忽略规则。

## 2. VPS 前置条件

1. 域名 A 记录指向 VPS；若设置 AAAA，也必须指向可用的 IPv6 地址。初次验证建议 DNS 直连，先不要加 CDN。
2. 防火墙/云安全组允许 SSH 端口、TCP 80 和 TCP 443；可选 UDP 443。
3. Docker 模式要求 80/443 空闲；systemd 模式复用已有 Caddy。脚本不会停止现有 FRP 或修改防火墙。
4. Docker 模式需要 Docker Engine 和支持 `docker compose up --wait` 的 Compose。systemd 模式需要 root SSH、systemd、Caddy、curl、tar、sha256sum，运行时从 Node.js 官方站下载并核对 SHA-256。
5. VPS 安装 bash、tar、flock（util-linux）。

Docker 安装参考官方 [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) 或 [Debian](https://docs.docker.com/engine/install/debian/) 文档；脚本不执行下载后直接运行的安装器，也不自动改动系统软件源。

首次连接请先在本机手动 SSH，核对 VPS 控制台提供的主机密钥指纹再接受：

```bash
ssh -p 22 -i /c/Users/你的用户名/.ssh/id_ed25519 root@你的VPS地址
```

部署脚本使用严格主机密钥检查和非交互认证；不会设置 `StrictHostKeyChecking=no`，不会自动接受未知主机指纹。

## 3. 检查并部署

```bash
npm run vps:plan
npm run vps:deploy
```

部署过程：

1. 校验配置并检查 SSH、Docker、Compose 权限。
2. 在本机生成独立 VPS 管理 Key 和设备 Key，存于 `data/vps/secrets.json`；重部署复用，避免用户登录意外失效。
3. 白名单打包网页、中继和共享代码；**不打包 `.env`、本地 worker、GPT 凭据、Codex 会话或用户上传数据**。
4. 压缩包经 SSH stdin 传输，展开到独立 release 目录；部署密钥不出现在命令行参数。
5. 构建 relay 镜像或 systemd 服务，验证 Caddy 配置，然后启动服务并等待健康检查。
6. 从本机验证公网 HTTPS 证书、`/health`、管理认证和 Secure/HttpOnly Cookie。
7. 公网检查成功后生成 `.env.vps` 和本地测试配置。原 `.env` 不修改。

压缩包中包含该 VPS 的中继密钥，因此 `data/vps/` 仍应当作敏感目录保护。中继 Key 与你的 GPT 凭据不同。

如果容器启动成功但 DNS/证书未就绪，修正后运行：

```bash
npm run vps:verify
```

只打包、不连接服务器：`npm run vps:package`。

## 4. 本地后台连接 VPS

**先停止之前的本地 worker**（之前运行 `npm run worker` 的终端按 Ctrl+C）。同一个 Codex 登录配置不要同时交给两个 worker 进程使用。中继服务和模拟预览不需要关闭。

```bash
npm run vps:connect
```

该命令再次验证公网地址，随后前台运行真实 worker。保持终端开启，或自行配置系统服务/任务计划程序。

- 继续使用原 `WORKER_DATA/codex-home`，不要求再次登录。
- VPS 的任务映射、文件和事件缓存放在 `WORKER_DATA/relays/<domain>/`，避免把本机联调事件重放给 VPS。
- 网络连接是本地主动建立的 WSS；电脑不需要入站端口。
- 退出后回到本机联调：运行原来的 `npm run worker`，它仍读取 `.env`。
- 公网的用户和会话数据库是新建的，不自动迁移本机联调记录。

## 5. 公网真实测试

保持 `vps:connect` 运行，在另一个终端执行：

```bash
npm run vps:test
```

此命令会产生少量真实订阅用量。使用临时生成的合成测试内容，不读取你的私人文件。

覆盖 HTTPS 登录、设备 WSS 就绪、真实文本流式回复、CSV 上传/本地读取、计算 17+25=42，以及同一 Codex 会话的上下文延续。报告在 `data/vps/public-test/report.json`，测试用户 Key 在同目录 `user-key.txt`。不要将 Key 或报告目录公开。

只有报告里的 `origin` 是实际域名，并且测试全部通过，才能认定公网链路完成。`localhost` 或模拟执行端不算公网验收。

## 更新、排障与回退

更新代码后再次运行 `vps:deploy`，保留数据库/附件/证书数据卷。远程目录：

```text
/opt/local-codex-relay/
  current -> releases/<release>
  releases/<release>/
    compose.yaml
    Caddyfile
    relay.env
    .env
    ...中继源码...
```

Docker 模式 SSH 到 VPS 后查看（systemd 模式使用文档开头的 systemctl/journalctl）：

```bash
cd /opt/local-codex-relay/current
docker compose ps
docker compose logs --tail=100 relay caddy
```

不要在公开位置粘贴 `relay.env`、Compose 完整配置或 secrets 文件。日志通常不含用户正文，分享前仍应检查。

部署失败会尝试恢复上一版容器；这不回滚数据库迁移。第一版没有破坏性迁移。首次部署失败需按日志修正，脚本不会删除数据卷。

手动切换历史版本时，在对应 `releases/<release>` 目录运行 `docker compose up -d --wait`，确认成功后更新 `current` 链接。不要使用 `docker compose down -v`；该命令会删除数据卷。建议在升级前停止服务并备份 Docker 数据卷，或使用 SQLite 一致性备份工具。

当前默认单套 Compose 项目名 `local-codex-relay`，一台 VPS 部署一套。不支持用同一脚本并排部署多租户实例。

## 官方依据

- [Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)：DNS、80/443 和持久化证书存储条件。
- [Docker Compose up](https://docs.docker.com/reference/cli/docker/compose/up/)：后台启动与 `--wait` 健康检查。
