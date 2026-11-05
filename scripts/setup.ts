import { existsSync, writeFileSync } from 'node:fs';
import { secret } from '../packages/shared.js';
if (existsSync('.env')) {
  console.error('.env 已存在，未覆盖。');
  process.exitCode = 1;
} else {
  writeFileSync(
    '.env',
    `HOST=127.0.0.1\nPORT=3000\nPUBLIC_ORIGIN=http://localhost:3000\nRELAY_URL=http://localhost:3000\nADMIN_KEY=${secret()}\nWORKER_KEY=${secret()}\nWORKER_MODE=codex\nCOOKIE_SECURE=false\n`,
    { mode: 0o600 },
  );
  console.log('已创建 .env。管理员 Key 在本地文件中；请勿上传或提交该文件。');
}
