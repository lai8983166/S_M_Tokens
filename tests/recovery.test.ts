import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRelay } from '../apps/relay/server.js';
import { startWorker } from '../apps/worker/service.js';
import { secret } from '../packages/shared.js';

test('relay restart replays worker outbox without repeating text or generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-reconnect-')),
    adminKey = secret(),
    workerKey = secret();
  const opts = {
    data: join(root, 'relay'),
    adminKey,
    workerKey,
    origin: 'http://localhost:3000',
    reserve: 0,
    web: join(root, 'none'),
  };
  let app = await createRelay(opts);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as any).port,
    base = `http://127.0.0.1:${port}`;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const call = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.ok(r.ok, `${path}: ${r.status}`);
    return { data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const wait = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 15_000;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error('Timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    const admin = (await call('/auth/session', 'POST', { key: adminKey })).cookie!;
    const key = (await call('/admin/users', 'POST', { name: 'Reconnect' }, admin)).data.key;
    const cookie = (await call('/auth/session', 'POST', { key })).cookie!;
    worker = await startWorker({
      data: join(root, 'worker'),
      relay: base,
      key: workerKey,
      mode: 'mock',
      mockDelay: 50,
    });
    await wait(async () => (await call('/status', 'GET', undefined, cookie)).data.ready);
    const c = (await call('/conversations', 'POST', undefined, cookie)).data.id;
    const prompt = '恢复测试'.repeat(40);
    await call(
      `/conversations/${c}/messages`,
      'POST',
      { prompt, idempotencyKey: randomUUID() },
      cookie,
    );
    await wait(
      async () =>
        (await call(`/conversations/${c}/messages`, 'GET', undefined, cookie)).data.messages[1]
          .content.length > 0,
    );
    await app.close();
    app = await createRelay(opts);
    await app.listen({ host: '127.0.0.1', port });
    let history: any;
    await wait(async () => {
      try {
        history = (await call(`/conversations/${c}/messages`, 'GET', undefined, cookie)).data;
        return history.tasks[0].status === 'completed';
      } catch (error) {
        if (error instanceof TypeError) return false;
        throw error;
      }
    });
    assert.equal(
      history.messages[1].content,
      `[模拟模式 · 不消耗订阅] 这是本会话第 1 次请求。\n\n${prompt}\n\n已接收 0 个附件。独立会话、任务转发和流式输出正常。`,
    );
    assert.equal(history.tasks.length, 1);
  } finally {
    await worker?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
