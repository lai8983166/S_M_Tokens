import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRelay } from '../apps/relay/server.js';
import { startWorker } from '../apps/worker/service.js';
import { secret, MAX_FILE_BYTES } from '../packages/shared.js';

const wait = async (fn: () => Promise<boolean>, timeout = 10_000) => {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
};
test('real HTTP: auth isolation, uploads, durable threads, streaming, cancel, revocation and cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-relay-test-'));
  const adminKey = secret(),
    workerKey = secret();
  const app = await createRelay({
    data: join(root, 'relay'),
    adminKey,
    workerKey,
    origin: 'http://localhost:3000',
    reserve: 0,
    web: join(root, 'none'),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const request = async (path: string, method = 'GET', body?: any, cookie?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get('set-cookie')?.split(';')[0],
    };
  };
  try {
    assert.equal((await request('/api/conversations')).status, 401);
    const admin = (await request('/api/auth/session', 'POST', { key: adminKey })).cookie!;
    const userA = (await request('/api/admin/users', 'POST', { name: 'Alice' }, admin)).body;
    const userB = (await request('/api/admin/users', 'POST', { name: 'Bob' }, admin)).body;
    const cookieA = (await request('/api/auth/session', 'POST', { key: userA.key })).cookie!;
    const cookieB = (await request('/api/auth/session', 'POST', { key: userB.key })).cookie!;
    assert.equal((await request('/api/admin/users', 'GET', undefined, cookieA)).status, 403);
    const cross = await fetch(base + '/api/conversations', {
      method: 'POST',
      headers: { cookie: cookieA, Origin: 'https://evil.invalid' },
    });
    assert.equal(cross.status, 403);
    const c = (await request('/api/conversations', 'POST', undefined, cookieA)).body;
    assert.equal(
      (await request(`/api/conversations/${c.id}/messages`, 'GET', undefined, cookieB)).status,
      404,
    );
    assert.equal(
      (
        await request(
          '/api/uploads',
          'POST',
          { name: 'huge.pdf', size: MAX_FILE_BYTES + 1 },
          cookieA,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          '/api/uploads',
          'POST',
          { name: 'boundary.pdf', size: MAX_FILE_BYTES },
          cookieA,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request('/api/uploads', 'POST', { name: '../secret.txt', size: 10 }, cookieA)).status,
      400,
    );
    const bytes = Buffer.from('A test document. Important number: 42.');
    const f = (
      await request('/api/uploads', 'POST', { name: 'notes.txt', size: bytes.length }, cookieA)
    ).body;
    assert.equal((await request(`/api/uploads/${f.id}`, 'GET', undefined, cookieB)).status, 404);
    assert.equal(
      (await request(`/api/uploads/${f.id}/complete`, 'POST', undefined, cookieA)).status,
      400,
    );
    const upload = await fetch(base + `/api/uploads/${f.id}/parts/0`, {
      method: 'PUT',
      headers: { cookie: cookieA, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(
      (await request(`/api/uploads/${f.id}`, 'GET', undefined, cookieA)).body.parts,
      [0],
    );
    assert.equal(
      (await request(`/api/uploads/${f.id}/complete`, 'POST', undefined, cookieA)).status,
      200,
    );
    assert.equal(
      (await fetch(base + `/api/files/${f.id}`, { headers: { cookie: cookieB } })).status,
      404,
    );
    assert.equal(
      await (await fetch(base + `/api/files/${f.id}`, { headers: { cookie: cookieA } })).text(),
      bytes.toString(),
    );
    worker = await startWorker({
      data: join(root, 'worker'),
      relay: base,
      key: workerKey,
      mode: 'mock',
      mockDelay: 20,
    });
    await wait(async () => (await request('/api/status', 'GET', undefined, cookieA)).body.ready);
    assert.equal(
      (
        await request(
          `/api/conversations/${c.id}/messages`,
          'POST',
          {
            prompt: 'x',
            files: Array.from({ length: 21 }, () => randomUUID()),
            idempotencyKey: randomUUID(),
          },
          cookieA,
        )
      ).status,
      400,
    );
    const payload = { prompt: '分析文件', files: [f.id], idempotencyKey: randomUUID() };
    const submitted = await request(
      `/api/conversations/${c.id}/messages`,
      'POST',
      payload,
      cookieA,
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    const tid = submitted.body.taskId;
    assert.equal(
      (await request(`/api/conversations/${c.id}/messages`, 'POST', payload, cookieA)).body.taskId,
      tid,
    );
    assert.equal(
      (
        await request(
          `/api/conversations/${c.id}/messages`,
          'POST',
          { ...payload, prompt: 'different' },
          cookieA,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/conversations/${c.id}/messages`,
          'POST',
          { prompt: 'busy', idempotencyKey: randomUUID() },
          cookieA,
        )
      ).status,
      409,
    );
    assert.equal(
      (await fetch(base + `/api/tasks/${tid}/events`, { headers: { cookie: cookieB } })).status,
      404,
    );
    const stream = await fetch(base + `/api/tasks/${tid}/events`, { headers: { cookie: cookieA } });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    let received = '';
    while (!received.includes('"event":"completed"') && !received.includes('"event":"failed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    await reader.cancel();
    assert.ok(received.includes('"event":"delta"'), received);
    assert.ok(received.includes('"event":"completed"'), received);
    let history = (await request(`/api/conversations/${c.id}/messages`, 'GET', undefined, cookieA))
      .body;
    assert.match(history.messages[1].content, /第 1 次请求/);
    assert.match(history.messages[1].content, /1 个附件/);
    await worker.close();
    worker = await startWorker({
      data: join(root, 'worker'),
      relay: base,
      key: workerKey,
      mode: 'mock',
      mockDelay: 20,
    });
    await wait(async () => (await request('/api/status', 'GET', undefined, cookieA)).body.ready);
    const next = (
      await request(
        `/api/conversations/${c.id}/messages`,
        'POST',
        { prompt: '继续', idempotencyKey: randomUUID() },
        cookieA,
      )
    ).body.taskId;
    await wait(async () => {
      history = (await request(`/api/conversations/${c.id}/messages`, 'GET', undefined, cookieA))
        .body;
      return history.tasks.find((t: any) => t.id === next)?.status === 'completed';
    });
    assert.match(history.messages[3].content, /第 2 次请求/);
    const stopping = (
      await request(
        `/api/conversations/${c.id}/messages`,
        'POST',
        { prompt: 'stop me', idempotencyKey: randomUUID() },
        cookieA,
      )
    ).body.taskId;
    await request(`/api/tasks/${stopping}/cancel`, 'POST', undefined, cookieA);
    await wait(
      async () =>
        (
          await request(`/api/conversations/${c.id}/messages`, 'GET', undefined, cookieA)
        ).body.tasks.find((t: any) => t.id === stopping)?.status === 'cancelled',
    );
    assert.equal(
      (await request(`/api/conversations/${c.id}`, 'DELETE', undefined, cookieA)).status,
      200,
    );
    await wait(
      async () =>
        (await fetch(base + `/api/files/${f.id}`, { headers: { cookie: cookieA } })).status === 404,
    );
    await request(`/api/admin/users/${userA.id}/key`, 'POST', undefined, admin);
    assert.equal((await request('/api/conversations', 'GET', undefined, cookieA)).status, 401);
  } finally {
    await worker?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
