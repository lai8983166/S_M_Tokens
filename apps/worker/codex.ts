import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

// Deliberately isolated from the owner's everyday Codex profile and relay secrets.
export function codexEnvironment(home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ])
    if (process.env[key]) result[key] = process.env[key];
  result.CODEX_HOME = resolve(home);
  return result;
}
export function codexExecutable() {
  if (process.env.CODEX_BIN && process.env.CODEX_BIN !== 'codex') return process.env.CODEX_BIN;
  if (process.platform === 'win32') {
    const bin = join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe',
    );
    if (existsSync(bin)) return bin;
    const vendor = join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'node_modules',
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex',
      'codex.exe',
    );
    if (existsSync(vendor)) return vendor;
    const old = join(
      process.env.APPDATA ?? '',
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'vendor',
      'x86_64-pc-windows-msvc',
      'codex',
      'codex.exe',
    );
    if (existsSync(old)) return old;
  }
  return 'codex';
}
export const safeConfig: Record<string, unknown> = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.code_mode': false,
  'features.code_mode_host': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.hooks': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.memories': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.computer_use': false,
  'features.in_app_browser': false,
  'features.image_generation': false,
  'features.view_image': false,
  'features.workspace_dependencies': false,
  'features.skill_search': false,
  'features.skip_host_skill_discovery': true,
  web_search: 'disabled',
  project_doc_max_bytes: 0,
  approval_policy: 'never',
  sandbox_mode: 'read-only',
};
export class Codex extends EventEmitter {
  process?: ChildProcessWithoutNullStreams;
  private counter = 0;
  private requests = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    readonly home: string,
    readonly invocation?: { command: string; args: string[] },
  ) {
    super();
  }
  async start() {
    mkdirSync(this.home, { recursive: true });
    const args = ['app-server'];
    for (const [key, value] of Object.entries(safeConfig))
      args.push('-c', `${key}=${JSON.stringify(value)}`);
    this.process = spawn(
      this.invocation?.command ?? codexExecutable(),
      [...(this.invocation?.args ?? []), ...args],
      { env: codexEnvironment(this.home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const rejectAll = () => {
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('Codex 进程已退出'));
      }
      this.requests.clear();
      this.emit('exit');
    };
    this.process.on('error', rejectAll);
    this.process.on('exit', rejectAll);
    // Never forward stderr, credentials, local paths, or arbitrary RPC payloads to the relay.
    this.process.stderr.on('data', () => {});
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && message.method) {
        this.process?.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message:
                'Interactive tools and permission elevation are disabled in this application',
            },
          }) + '\n',
        );
        return;
      }
      if (message.id !== undefined) {
        const p = this.requests.get(message.id);
        if (p) {
          clearTimeout(p.timer);
          this.requests.delete(message.id);
          if (message.error) p.reject(new Error('Codex 请求失败，请在本地检查授权、版本和配置'));
          else p.resolve(message.result);
        }
      } else if (message.method) this.emit('notification', message.method, message.params);
    });
    await this.rpc('initialize', {
      clientInfo: { name: 'local_codex_relay', title: 'Local Codex Relay', version: '0.1.0' },
    });
    this.process.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  }
  rpc(method: string, params: unknown): Promise<any> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error('Codex RPC 超时，执行状态需要核对'));
      }, 45_000);
      this.requests.set(id, { resolve, reject, timer });
      this.process?.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) {
          clearTimeout(timer);
          this.requests.delete(id);
          reject(error);
        }
      });
    });
  }
  close() {
    this.process?.kill();
  }
}
