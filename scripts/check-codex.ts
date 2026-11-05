import { resolve } from 'node:path';
import { Codex } from '../apps/worker/codex.js';
import { env } from '../packages/shared.js';
env();
const codex = new Codex(resolve(process.env.WORKER_DATA ?? 'data/worker', 'codex-home'));
try {
  await codex.start();
  const result = await codex.rpc('account/read', { refreshToken: false });
  const config = await codex.rpc('config/read', { includeLayers: false });
  console.log(
    JSON.stringify({
      protocol: 'connected',
      authenticated: !!result.account,
      shellTool: config.config?.features?.shell_tool,
      plugins: config.config?.features?.plugins,
      apps: config.config?.features?.apps,
    }),
  );
} finally {
  codex.close();
}
