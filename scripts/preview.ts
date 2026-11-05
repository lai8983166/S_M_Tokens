import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRelay } from '../apps/relay/server.js';
import { startWorker } from '../apps/worker/service.js';
import { secret } from '../packages/shared.js';
// Disposable loopback-only demonstration. It never reads .env or real Codex credentials.
const parent = resolve('data/previews');
mkdirSync(parent, { recursive: true });
const root = mkdtempSync(join(parent, 'session-'));
const adminKey = 'local-preview-admin-only-2026',
  userKey = 'local-preview-user-only-2026',
  workerKey = secret();
const port = 3001,
  origin = `http://localhost:${port}`;
const relay = await createRelay({
  data: join(root, 'relay'),
  adminKey,
  workerKey,
  origin,
  reserve: 0,
});
await relay.listen({ host: '127.0.0.1', port });
const login = await relay.inject({
  method: 'POST',
  url: '/api/auth/session',
  payload: { key: adminKey },
});
const user = await relay.inject({
  method: 'POST',
  url: '/api/admin/users',
  headers: { cookie: login.headers['set-cookie']!.toString().split(';')[0] },
  payload: { name: '体验用户' },
});
// Replace the generated test key in this isolated preview database only.
const { database, hash, run } = await import('../packages/shared.js');
const db = database(join(root, 'relay', 'relay.sqlite'));
run(db, 'UPDATE users SET key_hash=? WHERE id=?', hash(userKey), user.json().id);
db.close();
const worker = await startWorker({
  data: join(root, 'worker'),
  relay: `http://127.0.0.1:${port}`,
  key: workerKey,
  mode: 'mock',
});
console.log(
  `Preview: ${origin}\nTest user Key: ${userKey}\nTest admin Key: ${adminKey}\nThis isolated demo never calls a real model.`,
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void worker
      .close()
      .then(() => relay.close())
      .then(() => process.exit());
  });
