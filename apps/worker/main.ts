import { env } from '../../packages/shared.js';
import { startWorker } from './service.js';
env();
if ((process.env.WORKER_KEY ?? '').length < 24) throw new Error('请先配置 WORKER_KEY');
const mode = process.env.WORKER_MODE === 'mock' ? 'mock' : 'codex';
const worker = await startWorker({
  data: process.env.WORKER_DATA ?? 'data/worker',
  stateDirectory: process.env.WORKER_STATE_DIR,
  relay: process.env.RELAY_URL ?? 'http://localhost:3000',
  key: process.env.WORKER_KEY!,
  mode,
  model: process.env.CODEX_MODEL || undefined,
});
console.log(`Worker (${mode}): ${worker.status().note}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void worker.close().then(() => process.exit());
  });
