import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/);
export const configSchema = z
  .object({
    host,
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().regex(/^[a-z_][a-z0-9_-]*$/i),
    identityFile: z.string().default(''),
    domain: z
      .string()
      .max(253)
      .regex(/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/),
    acmeEmail: z.union([z.literal(''), z.email()]).default(''),
    remoteDirectory: z
      .string()
      .regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/)
      .refine((p) => !['/opt', '/root', '/home', '/usr', '/var', '/tmp', '/etc'].includes(p)),
    mode: z.enum(['docker', 'systemd']).default('docker'),
    basePath: z
      .string()
      .regex(/^(?:\/[a-zA-Z0-9_-]+)*$/)
      .default(''),
    relayPort: z.number().int().min(1024).max(65535).default(3300),
    existingUpstream: z
      .string()
      .regex(/^127\.0\.0\.1:\d{2,5}$/)
      .optional(),
    expectedCaddySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    userQuotaBytes: z.number().int().positive().default(10_000_000_000),
    diskReserveBytes: z
      .number()
      .int()
      .nonnegative()
      .default(1024 ** 3),
  })
  .strict();
export type VpsConfig = z.infer<typeof configSchema>;
export function loadConfig() {
  const path = resolve(process.env.VPS_CONFIG_FILE ?? 'deploy/vps.config.json');
  if (!existsSync(path)) throw new Error('请先运行 npm run vps:init 并填写 deploy/vps.config.json');
  const config = configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (config.domain.endsWith('.example.com') || config.domain === 'example.com')
    throw new Error('请填写实际域名');
  if (config.identityFile && !existsSync(resolve(config.identityFile)))
    throw new Error('SSH 私钥路径不存在');
  return config;
}
export const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export function sshArgs(c: VpsConfig) {
  return [
    '-p',
    String(c.port),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
    ...(c.identityFile ? ['-i', resolve(c.identityFile), '-o', 'IdentitiesOnly=yes'] : []),
    `${c.user}@${c.host}`,
  ];
}
export const sourceAllowlist = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.dockerignore',
  'apps/relay',
  'apps/web',
  'packages',
  'deploy/Dockerfile',
  'deploy/remote-deploy.sh',
  'deploy/remote-native.sh',
];
export function caddyfile(c: VpsConfig) {
  const upstream = c.mode === 'systemd' ? `127.0.0.1:${c.relayPort}` : 'relay:3000';
  const proxy = `reverse_proxy ${upstream} {\n      flush_interval -1\n    }`;
  const routes = c.basePath
    ? `  redir ${c.basePath} ${c.basePath}/ 308\n  handle_path ${c.basePath}/* {\n    ${proxy}\n  }\n  handle {\n    ${c.existingUpstream ? `reverse_proxy ${c.existingUpstream}` : 'respond "Not found" 404'}\n  }`
    : `  ${proxy}`;
  return `${c.acmeEmail ? `{\n  email ${c.acmeEmail}\n}\n` : ''}${c.domain} {\n${routes}\n}\n`;
}
