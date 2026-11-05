import { env } from '../../packages/shared.js';
import { createRelay } from './server.js';
env();
const port = Number(process.env.PORT ?? 3000);
const app = await createRelay({
  data: process.env.RELAY_DATA ?? 'data/relay',
  adminKey: process.env.ADMIN_KEY ?? '',
  workerKey: process.env.WORKER_KEY ?? '',
  origin: process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`,
  secure: process.env.COOKIE_SECURE === 'true',
  quota: Number(process.env.USER_QUOTA_BYTES ?? 10_000_000_000),
  reserve: Number(process.env.DISK_RESERVE_BYTES ?? 1024 ** 3),
});
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
console.log(`Relay: http://localhost:${port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit());
  });
