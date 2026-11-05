import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

test('deployment creates a real archive containing only server source and relay credentials', () => {
  const parent = resolve('data/deployment-tests');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'package-'));
  try {
    const config = join(root, 'config.json'),
      state = join(root, 'state');
    writeFileSync(
      config,
      JSON.stringify({
        host: '203.0.113.10',
        user: 'deploy',
        domain: 'chat.acme.test',
        remoteDirectory: '/opt/local-codex-relay',
      }),
    );
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/vps.ts', 'package'], {
      cwd: process.cwd(),
      env: { ...process.env, VPS_CONFIG_FILE: config, VPS_STATE_DIR: state },
      encoding: 'utf8',
      windowsHide: true,
    });
    const archive = join(
      state,
      readdirSync(state).find((n) => n.endsWith('.tgz'))!,
    );
    const list = execFileSync(
      'tar',
      ['-tzf', relative(process.cwd(), archive).replace(/\\/g, '/')],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.match(list, /apps\/relay\/server.ts/);
    assert.match(list, /apps\/web\/src\/main.tsx/);
    assert.match(list, /relay.env/);
    assert.doesNotMatch(
      list,
      /codex-home|auth.json|worker.sqlite|apps\/worker|vps.config|\.env.vps|secrets.json|^\.\/.env$/m,
    );
    const release = readdirSync(join(state, 'releases'))[0];
    const caddy = readFileSync(join(state, 'releases', release, 'Caddyfile'), 'utf8');
    assert.match(caddy, /chat.acme.test/);
    const env = readFileSync(join(state, 'releases', release, 'relay.env'), 'utf8');
    assert.match(env, /PUBLIC_ORIGIN="https:\/\/chat.acme.test"/);
    assert.doesNotMatch(env, /CODEX|WORKER_DATA|RELAY_URL/);
  } finally {
    assert.ok(root.startsWith(parent + (process.platform === 'win32' ? '\\' : '/')));
    rmSync(root, { recursive: true, force: true });
  }
});
