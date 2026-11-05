import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

test('privacy guard checks staged blobs, local credentials, commit identity and history', () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  const script = fileURLToPath(new URL('../scripts/check-privacy.mjs', import.meta.url));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@users.noreply.github.com');
    writeFileSync(join(root, 'README.md'), 'Use https://chat.example.com\n');
    git('add', 'README.md');
    assert.equal(check().status, 0);
    const credential = randomBytes(32).toString('base64url');
    writeFileSync(join(root, '.env'), 'ADMIN_KEY=' + credential + '\n');
    writeFileSync(join(root, 'README.md'), credential);
    git('add', 'README.md');
    writeFileSync(join(root, 'README.md'), 'clean working file');
    const blocked = check();
    assert.equal(blocked.status, 1, 'must inspect staged data, not working file');
    assert.ok(!blocked.stderr.includes(credential), 'must not print secret values');
    git('add', 'README.md');
    mkdirSync(join(root, 'deploy'));
    writeFileSync(
      join(root, 'deploy', 'vps.config.json'),
      JSON.stringify({ domain: 'private-server.invalid' }),
    );
    writeFileSync(join(root, 'README.md'), 'private-server.invalid');
    git('add', 'README.md');
    assert.equal(check().status, 1);
    writeFileSync(join(root, 'README.md'), 'clean');
    git('add', 'README.md');
    git('add', '-f', '.env');
    assert.equal(check().status, 1);
    git('rm', '--cached', '.env');
    git('config', 'user.email', 'test@example.com');
    assert.equal(check().status, 1);
    git('config', 'user.email', 'test@users.noreply.github.com');
    git('commit', '--quiet', '-m', 'safe');
    assert.equal(check('--history').status, 0);
    writeFileSync(join(root, 'README.md'), credential);
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'fixture leak');
    writeFileSync(join(root, 'README.md'), 'clean again');
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'fixture removed');
    assert.equal(check().status, 0);
    assert.equal(check('--history').status, 1, 'removed secrets remain detectable in history');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
