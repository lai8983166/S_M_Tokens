import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env, terminal } from '../packages/shared.js';

// Explicit opt-in live test. Never included in `npm test`.
env();
const base = (process.env.RELAY_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const reportDirectory = resolve(process.env.SMOKE_REPORT_DIR ?? 'data/real-test');
mkdirSync(reportDirectory, { recursive: true });
let cookie = '';
async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return result;
}

await call('/auth/session', 'POST', { key: process.env.ADMIN_KEY });
const status = await call('/status');
assert.equal(status.mode, 'codex', 'This command requires a real Codex worker, not mock mode');
assert.equal(status.ready, true, 'Local Codex must be signed in and ready');
const keyFile = join(reportDirectory, 'user-key.txt');
let userKey: string;
if (existsSync(keyFile)) userKey = readFileSync(keyFile, 'utf8').trim();
else {
  const created = await call('/admin/users', 'POST', { name: '真实联调用户' });
  userKey = created.key;
  writeFileSync(keyFile, userKey, { mode: 0o600 });
}
await call('/auth/session', 'POST', { key: userKey });
const conversation = await call('/conversations', 'POST');
await call(`/conversations/${conversation.id}`, 'PATCH', { title: '真实联调：对话、文件与上下文' });
const results: any[] = [];
const marker = '验证-' + randomUUID().slice(0, 8);

async function turn(prompt: string, files: string[] = []) {
  const { taskId } = await call(`/conversations/${conversation.id}/messages`, 'POST', {
    prompt,
    files,
    idempotencyKey: randomUUID(),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let content = '',
    deltaCount = 0,
    state = '',
    reason = '';
  try {
    const response = await fetch(`${base}/api/tasks/${taskId}/events`, {
      headers: { cookie },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    read: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const line = packet.split('\n').find((line) => line.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.event === 'delta') {
          content += event.data;
          deltaCount++;
        }
        if (terminal.has(event.event)) {
          state = event.event;
          reason = event.data;
          await reader.cancel();
          break read;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  const result = { taskId, prompt, state, reason, deltaCount, content };
  results.push(result);
  writeFileSync(
    join(reportDirectory, 'report.json'),
    JSON.stringify({ origin: base, conversationId: conversation.id, marker, results }, null, 2),
  );
  console.log(JSON.stringify(result));
  assert.equal(state, 'completed', reason || 'Task did not complete');
  assert.ok(deltaCount > 0, 'No streamed content received');
  return content;
}

const first = await turn(
  `这是一条真实对话测试。请记住本会话标记“${marker}”，仅回复这个标记，不要调用工具。`,
);
assert.ok(first.includes(marker));
const bytes = Buffer.from('item,quantity\napples,17\npears,25\n', 'utf8');
writeFileSync(join(reportDirectory, 'sample.csv'), bytes);
const upload = await call('/uploads', 'POST', { name: 'sample.csv', size: bytes.length });
const uploaded = await fetch(`${base}/api/uploads/${upload.id}/parts/0`, {
  method: 'PUT',
  headers: { cookie, 'Content-Type': 'application/octet-stream' },
  body: bytes,
});
assert.equal(uploaded.status, 200, 'File chunk upload failed');
await call(`/uploads/${upload.id}/complete`, 'POST');
const second = await turn(
  '读取本次 CSV 附件，计算 quantity 总和，并写出上一轮记住的会话标记。请简短回答，不要调用工具。',
  [upload.id],
);
assert.match(second, /42/);
assert.ok(second.includes(marker), 'Codex did not retain the conversation marker');
console.log(
  'PASS: real generation, streamed deltas, CSV upload/reading, and Codex conversation continuity.',
);
console.log(`Report: ${join(reportDirectory, 'report.json')}`);
