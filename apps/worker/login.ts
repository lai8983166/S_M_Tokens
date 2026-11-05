import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { env } from '../../packages/shared.js';
import { codexEnvironment, codexExecutable } from './codex.js';
env();
const home = resolve(process.env.WORKER_DATA ?? 'data/worker', 'codex-home');
mkdirSync(home, { recursive: true });
console.log('登录本应用专用 Codex 配置；凭据只保存在本机。');
const p = spawn(codexExecutable(), ['login'], {
  env: codexEnvironment(home),
  stdio: 'inherit',
  windowsHide: true,
});
p.on('error', () => {
  console.error('无法启动 Codex，请设置 CODEX_BIN 为 codex.exe 的完整路径');
  process.exitCode = 1;
});
p.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
