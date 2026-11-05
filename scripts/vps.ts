import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  cpSync,
  createReadStream,
} from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { parseEnv } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import {
  loadConfig,
  sourceAllowlist,
  caddyfile,
  quote,
  sshArgs,
  type VpsConfig,
} from './vps-config.js';

const root = resolve('.'),
  state = resolve(process.env.VPS_STATE_DIR ?? join(root, 'data', 'vps'));
function command(
  executable: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
      env: env ?? process.env,
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? accept() : reject(new Error(`${executable} exited ${code}`)),
    );
    if (input !== undefined) child.stdin!.end(input);
  });
}
function secrets() {
  mkdirSync(state, { recursive: true });
  const path = join(state, 'secrets.json');
  if (!existsSync(path))
    writeFileSync(
      path,
      JSON.stringify(
        {
          adminKey: randomBytes(32).toString('base64url'),
          workerKey: randomBytes(32).toString('base64url'),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  const keys = JSON.parse(readFileSync(path, 'utf8'));
  for (const key of [keys.adminKey, keys.workerKey])
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key))
      throw new Error('部署密钥文件格式错误');
  if (keys.adminKey === keys.workerKey) throw new Error('管理和设备密钥必须不同');
  return keys;
}
export function envLine(key: string, value: string) {
  if (/[\r\n\0"\\]/.test(value)) throw new Error(`Invalid environment value: ${key}`);
  return `${key}="${value}"\n`;
}
function profile(c: VpsConfig) {
  const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const keys = secrets();
  const workerData = resolve(local.WORKER_DATA ?? 'data/worker').replace(/\\/g, '/');
  let text =
    envLine('RELAY_URL', `https://${c.domain}${c.basePath}`) +
    envLine('WORKER_KEY', keys.workerKey) +
    envLine('WORKER_DATA', workerData) +
    envLine('WORKER_STATE_DIR', workerData + '/relays/' + c.domain) +
    envLine('WORKER_MODE', 'codex');
  if (local.CODEX_BIN) text += envLine('CODEX_BIN', local.CODEX_BIN.replace(/\\/g, '/'));
  if (local.CODEX_MODEL) text += envLine('CODEX_MODEL', local.CODEX_MODEL);
  writeFileSync(join(root, '.env.vps'), text, { mode: 0o600 });
  // Full test profile is local-only and never included in the release archive.
  writeFileSync(
    join(state, 'test.env'),
    text +
      envLine('ADMIN_KEY', keys.adminKey) +
      envLine('SMOKE_REPORT_DIR', join(state, 'public-test').replace(/\\/g, '/')),
    { mode: 0o600 },
  );
}
function childEnvironment(file: string) {
  const env = { ...process.env };
  for (const key of [
    'RELAY_URL',
    'WORKER_KEY',
    'WORKER_DATA',
    'WORKER_STATE_DIR',
    'WORKER_MODE',
    'CODEX_MODEL',
    'CODEX_BIN',
    'ADMIN_KEY',
    'SMOKE_REPORT_DIR',
  ])
    delete env[key];
  env.RELAY_ENV_FILE = file;
  return env;
}
async function verify(c: VpsConfig) {
  const url = `https://${c.domain}${c.basePath}`;
  const response = await fetch(url + '/health', {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || (await response.json()).ok !== true)
    throw new Error('公网 HTTPS 健康检查失败');
  const keys = secrets();
  const login = await fetch(url + '/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: keys.adminKey }),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!login.ok) throw new Error('公网中继管理认证失败，未切换本地连接');
  const cookie = login.headers.get('set-cookie') ?? '';
  if (!/;\s*Secure/i.test(cookie) || !/;\s*HttpOnly/i.test(cookie))
    throw new Error('公网登录 Cookie 安全配置不正确');
  await fetch(url + '/api/auth/session', {
    method: 'DELETE',
    headers: { cookie: cookie.split(';')[0] },
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`HTTPS / health / 管理认证 / Secure Cookie 已验证：${url}`);
}
async function prepare(c: VpsConfig) {
  const keys = secrets();
  const release =
    new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14) +
    '-' +
    randomBytes(4).toString('hex');
  const staging = join(state, 'releases', release);
  mkdirSync(staging, { recursive: true });
  for (const item of sourceAllowlist)
    cpSync(join(root, item), join(staging, item), { recursive: true });
  copyFileSync(join(root, 'deploy/compose.yaml'), join(staging, 'compose.yaml'));
  writeFileSync(join(staging, 'Caddyfile'), caddyfile(c));
  writeFileSync(join(staging, 'build-path'), c.basePath + '/');
  writeFileSync(
    join(staging, 'relay.env'),
    envLine('PUBLIC_ORIGIN', `https://${c.domain}`) +
      envLine('ADMIN_KEY', keys.adminKey) +
      envLine('WORKER_KEY', keys.workerKey) +
      envLine('HOST', c.mode === 'systemd' ? '127.0.0.1' : '0.0.0.0') +
      envLine('PORT', String(c.mode === 'systemd' ? c.relayPort : 3000)) +
      envLine('RELAY_DATA', c.mode === 'systemd' ? '/var/lib/local-codex-relay' : '/data') +
      envLine('COOKIE_SECURE', 'true') +
      envLine('USER_QUOTA_BYTES', String(c.userQuotaBytes)) +
      envLine('DISK_RESERVE_BYTES', String(c.diskReserveBytes)),
    { mode: 0o600 },
  );
  const archive = join(state, `${release}.tgz`);
  // Relative slash paths work with both Git Bash GNU tar and Windows bsdtar.
  await command('tar', [
    '-czf',
    relative(root, archive).replace(/\\/g, '/'),
    '-C',
    relative(root, staging).replace(/\\/g, '/'),
    '.',
  ]);
  console.log(
    `已打包 ${release}：仅中继与网页源码，不含本地配置、会话或 GPT 凭据。压缩包包含中继密钥，请保密。`,
  );
  return { release, archive };
}
async function deploy(c: VpsConfig) {
  // Read-only preflight before uploading anything or changing remote state.
  await command('ssh', [
    ...sshArgs(c),
    c.mode === 'systemd'
      ? 'test "$(id -u)" = 0 && command -v caddy >/dev/null && command -v curl >/dev/null && command -v flock >/dev/null && systemctl is-active caddy'
      : 'command -v bash >/dev/null && command -v tar >/dev/null && command -v flock >/dev/null && docker info >/dev/null && docker compose version',
  ]);
  if (c.mode === 'systemd' && !c.expectedCaddySha256)
    throw new Error('systemd 模式必须配置已核对的 expectedCaddySha256');
  const { release, archive } = await prepare(c);
  const remote = `${c.remoteDirectory}/releases/${release}`;
  const child = spawn(
    'ssh',
    [...sshArgs(c), `umask 077; mkdir -p ${quote(remote)} && tar -xzf - -C ${quote(remote)}`],
    { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true },
  );
  const done = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? accept() : reject(new Error(`SSH upload exited ${code}`)),
    );
  });
  await Promise.all([pipeline(createReadStream(archive), child.stdin!), done]);
  await command('ssh', [
    ...sshArgs(c),
    c.mode === 'systemd'
      ? `bash ${quote(remote + '/deploy/remote-native.sh')} ${quote(c.remoteDirectory)} ${quote(release)} ${quote(c.expectedCaddySha256!)} ${quote(c.basePath)} ${quote(String(c.relayPort))}`
      : `bash ${quote(remote + '/deploy/remote-deploy.sh')} ${quote(c.remoteDirectory)} ${quote(release)}`,
  ]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await verify(c);
      profile(c);
      console.log(
        '公网部署成功，已生成 .env.vps（原 .env 未修改）。停止旧 worker 后运行 npm run vps:connect，再运行 npm run vps:test。',
      );
      return;
    } catch (error) {
      lastError = error;
      console.log('等待 DNS / HTTPS 证书就绪…');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error(
    `服务已部署，但公网校验未通过，尚未生成连接配置。检查 DNS、80/443 和证书后运行 vps:verify。${lastError instanceof Error ? lastError.message : ''}`,
  );
}
async function main() {
  const action = process.argv[2] ?? 'plan';
  if (action === 'init') {
    const path = resolve('deploy/vps.config.json');
    if (!existsSync(path)) copyFileSync('deploy/vps.config.example.json', path);
    console.log(
      '请填写 deploy/vps.config.json：host / user / port / domain / identityFile。不要填写密码或私钥内容。',
    );
    return;
  }
  const c = loadConfig();
  if (action === 'plan') {
    console.log(
      JSON.stringify(
        {
          ssh: `${c.user}@${c.host}:${c.port}`,
          url: `https://${c.domain}${c.basePath}/`,
          mode: c.mode,
          remoteDirectory: c.remoteDirectory,
          upload: sourceAllowlist,
          publicPorts: [80, 443],
          requires: [
            c.mode === 'systemd'
              ? 'Linux + systemd + existing Caddy (root SSH)'
              : 'Linux + Docker Engine + Compose (--wait)',
            'SSH host key already verified',
            'Domain DNS points to VPS',
          ],
          localCredentials: '保留原 Codex 登录，仅生成独立 .env.vps',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === 'package') {
    await prepare(c);
    return;
  }
  if (action === 'deploy') {
    await deploy(c);
    return;
  }
  if (action === 'verify') {
    await verify(c);
    profile(c);
    return;
  }
  if (action === 'connect') {
    await verify(c);
    profile(c);
    console.log('连接 VPS，使用已有本地 Codex 登录。按 Ctrl+C 停止。');
    await command(
      process.execPath,
      ['--import', 'tsx', 'apps/worker/main.ts'],
      undefined,
      childEnvironment(resolve('.env.vps')),
    );
    return;
  }
  if (action === 'test') {
    await verify(c);
    profile(c);
    console.log(
      '公网真实测试：将消耗少量订阅用量，验证 HTTPS → VPS → WSS → 本地 Codex → SSE 及文件读取。',
    );
    await command(
      process.execPath,
      ['--import', 'tsx', 'scripts/smoke-real.ts'],
      undefined,
      childEnvironment(join(state, 'test.env')),
    );
    return;
  }
  throw new Error('Unknown action');
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : '部署操作失败');
  process.exitCode = 1;
});
