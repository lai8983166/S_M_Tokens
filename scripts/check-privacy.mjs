import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';

const git = (...args) => execFileSync('git', args, { maxBuffer: 50 * 1024 * 1024 });
const history = process.argv.includes('--history');
const known = [];
const add = (label, value) => {
  if (typeof value === 'string' && value.length >= 6) known.push([label, value]);
};
const collect = (value, label) => {
  if (typeof value === 'string' && value.length >= 16) add(label, value);
  else if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) collect(child, `${label}.${key}`);
};
for (const file of ['.env', '.env.vps']) {
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8'))))
    if (/(KEY|TOKEN|SECRET|PASSWORD)$/.test(key)) add(`${file}:${key}`, value);
}
for (const file of ['data/vps/secrets.json', 'data/worker/codex-home/auth.json'])
  if (existsSync(file)) collect(JSON.parse(readFileSync(file, 'utf8')), file);
const userKey = 'data/vps/public-test/user-key.txt';
if (existsSync(userKey)) add(userKey, readFileSync(userKey, 'utf8').trim());
const configFile = 'deploy/vps.config.json';
if (existsSync(configFile)) {
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  for (const field of ['host', 'domain', 'identityFile', 'acmeEmail'])
    add(`deployment.${field}`, config[field]);
}
add('local home', homedir());
add('local home', homedir().replaceAll('\\', '/'));
add('local project', process.cwd());
add('local project', process.cwd().replaceAll('\\', '/'));

const failures = new Set();
const report = (file, rule) => failures.add(`${file}: ${rule}`);
const forbiddenPath =
  /^(?:data\/|\.env(?:\.|$)(?!example$)|deploy\/vps\.config\.json$)|(?:^|\/)(?:auth\.json|id_rsa|id_ed25519|.*\.sqlite(?:-wal|-shm)?|.*\.pem|.*\.key)$/;
const approvedImages = new Set(['docs/admin-preview.png', 'docs/chat-preview.png']);
function inspect(file, bytes) {
  if (forbiddenPath.test(file)) report(file, 'private runtime/configuration file');
  for (const [label, value] of known)
    if (bytes.includes(Buffer.from(value))) report(file, `matches local private value (${label})`);
  if (/\.(png|jpe?g|webp|pdf|zip|gz)$/i.test(file)) {
    if (!approvedImages.has(file))
      report(
        file,
        'binary artifact requires manual privacy review; keep private captures in data/',
      );
    return;
  }
  const text = bytes.toString('utf8');
  const patterns = [
    ['private key', /-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/],
    ['credential', /sk-(?:proj-|local-)?[A-Za-z0-9_-]{30,}/],
    ['JWT token', /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/],
    [
      'personal absolute path',
      /(?:[A-Za-z]:[\\/]Users[\\/]|\/(?:home|Users)\/)[A-Za-z0-9_.-]+[\\/]/,
    ],
    [
      'personal email',
      /[A-Za-z0-9._%+-]+@(?:qq\.com|gmail\.com|outlook\.com|hotmail\.com|163\.com|126\.com)\b/i,
    ],
  ];
  for (const [rule, regex] of patterns) if (regex.test(text)) report(file, rule);
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const parts = match[0].split('.').map(Number);
    if (parts.some((n) => n > 255)) continue;
    const safe =
      parts[0] === 127 ||
      match[0] === '0.0.0.0' ||
      match[0] === '255.255.255.255' ||
      /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(match[0]);
    if (!safe) report(file, 'non-example IP address');
  }
}
const seen = new Set();
if (history) {
  for (const commit of git('rev-list', '--all').toString().trim().split('\n').filter(Boolean)) {
    const emails = git('show', '-s', '--format=%ae%n%ce', commit).toString().trim().split('\n');
    if (emails.some((e) => !e.endsWith('@users.noreply.github.com')))
      report(commit.slice(0, 8), 'non-noreply commit email');
    for (const entry of git('ls-tree', '-rz', commit).toString().split('\0').filter(Boolean)) {
      const [, oid, file] = entry.match(/^\d+ blob (\w+)\t([\s\S]+)$/) ?? [];
      if (!oid || seen.has(oid + file)) continue;
      seen.add(oid + file);
      inspect(file, git('cat-file', 'blob', oid));
    }
  }
} else {
  const identity = git('var', 'GIT_AUTHOR_IDENT').toString();
  if (!/<[^<>]+@users\.noreply\.github\.com>/.test(identity))
    report('git author', 'configure a GitHub noreply email before committing');
  for (const entry of git('ls-files', '--stage', '-z').toString().split('\0').filter(Boolean)) {
    const [, oid, file] = entry.match(/^\d+ (\w+) 0\t([\s\S]+)$/) ?? [];
    if (oid) inspect(file, git('cat-file', 'blob', oid));
  }
}
if (failures.size) {
  console.error('Privacy check blocked:\n' + [...failures].join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Privacy check passed (${history ? 'all reachable history' : 'staged tree'}). Review screenshots and new external destinations manually as well.`,
  );
