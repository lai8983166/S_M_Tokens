import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { configSchema, caddyfile, sourceAllowlist, sshArgs, quote } from '../scripts/vps-config.js';

const sample = {
  host: '203.0.113.10',
  port: 22,
  user: 'deploy',
  identityFile: '',
  domain: 'chat.acme.test',
  acmeEmail: '',
  remoteDirectory: '/opt/local-codex-relay',
  mode: 'docker' as const,
  basePath: '',
  relayPort: 3300,
  userQuotaBytes: 10_000_000_000,
  diskReserveBytes: 1024 ** 3,
};
test('deployment config rejects shell/template injection and unsafe paths', () => {
  assert.equal(configSchema.parse(sample).port, 22);
  for (const [field, value] of [
    ['host', 'host; touch /tmp/pwn'],
    ['host', '-oProxyCommand=evil'],
    ['domain', 'chat.test\n{\n}'],
    ['remoteDirectory', '/'],
    ['remoteDirectory', '/opt'],
    ['remoteDirectory', '/opt/../etc'],
    ['user', 'root;id'],
    ['port', 0],
  ])
    assert.equal(
      configSchema.safeParse({ ...sample, [field]: value }).success,
      false,
      `${field}: ${value}`,
    );
  const args = sshArgs(sample);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.equal(quote("a'b"), "'a'\\''b'");
});
test('release upload allowlist excludes all local Codex state and secrets', () => {
  for (const item of sourceAllowlist) {
    assert.ok(!item.startsWith('apps/worker'));
    assert.ok(!item.startsWith('data'));
    assert.ok(!item.startsWith('.env'));
    assert.ok(!item.includes('vps.config'));
  }
  assert.ok(sourceAllowlist.includes('apps/relay'));
  assert.ok(sourceAllowlist.includes('apps/web'));
  const generated = caddyfile(sample);
  assert.match(generated, /reverse_proxy relay:3000/);
  assert.match(generated, /flush_interval -1/);
  assert.ok(!generated.includes('localhost:3000'));
  const compose = readFileSync('deploy/compose.yaml', 'utf8');
  assert.ok(!compose.includes('3000:3000'));
  assert.match(compose, /service_healthy/);
  assert.match(compose, /relay_data/);
});
