import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRelay } from '../apps/relay/server.js';
import { startWorker } from '../apps/worker/service.js';
import { Codex } from '../apps/worker/codex.js';
import { secret } from '../packages/shared.js';

test('stdio protocol: restart resumes the same Codex thread and sends only new input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-protocol-')),
    home = join(root, 'worker', 'codex-home'),
    adminKey = secret(),
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
  const relay = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const create = () =>
    new Codex(home, {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
    });
  let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
  const wait = async (fn: () => Promise<boolean>) => {
    const end = Date.now() + 8000;
    while (!(await fn())) {
      if (Date.now() > end) throw new Error('Timed out');
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  try {
    const login = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { key: adminKey },
      }),
      admin = login.cookies[0].value;
    const u = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      cookies: { local_relay_session: admin },
      payload: { name: 'Protocol' },
    });
    const session = (
      await app.inject({ method: 'POST', url: '/api/auth/session', payload: { key: u.json().key } })
    ).cookies[0].value;
    const c = (
      await app.inject({
        method: 'POST',
        url: '/api/conversations',
        cookies: { local_relay_session: session },
      })
    ).json().id;
    for (const [index, prompt] of ['第一条问题', '接着解释第二点'].entries()) {
      worker = await startWorker({
        data: join(root, 'worker'),
        relay,
        key: workerKey,
        mode: 'codex',
        codex: create(),
      });
      await wait(
        async () =>
          (
            await app.inject({ url: '/api/status', cookies: { local_relay_session: session } })
          ).json().ready,
      );
      const sent = await app.inject({
        method: 'POST',
        url: `/api/conversations/${c}/messages`,
        cookies: { local_relay_session: session },
        payload: { prompt, idempotencyKey: randomUUID() },
      });
      assert.equal(sent.statusCode, 200, sent.body);
      await wait(async () => {
        const data = (
          await app.inject({
            url: `/api/conversations/${c}/messages`,
            cookies: { local_relay_session: session },
          })
        ).json();
        return data.tasks[index]?.status === 'completed';
      });
      await worker.close();
      worker = undefined;
    }
    const record = readFileSync(join(home, 'requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(record.filter((r) => r.method === 'thread/start').length, 1);
    assert.equal(record.filter((r) => r.method === 'thread/resume').length, 1);
    const turns = record.filter((r) => r.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].params.threadId, turns[1].params.threadId);
    assert.deepEqual(turns[1].params.input, [
      { type: 'text', text: '接着解释第二点', text_elements: [] },
    ]);
    assert.equal(turns[1].params.sandboxPolicy.type, 'readOnly');
  } finally {
    await worker?.close();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
