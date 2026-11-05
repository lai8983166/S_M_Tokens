import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import {
  mkdirSync,
  existsSync,
  createReadStream,
  createWriteStream,
  statSync,
  readdirSync,
  unlinkSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CHUNK_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  database,
  rows,
  row,
  run,
  hash,
  secret,
  id,
  now,
  eventSchema,
  modelsSchema,
  type Model,
  terminal,
} from '../../packages/shared.js';

type Options = {
  data: string;
  adminKey: string;
  workerKey: string;
  origin: string;
  secure?: boolean;
  quota?: number;
  reserve?: number;
  web?: string;
};
const allowedExt = new Set([
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sql',
  '.log',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
]);
const fail = (message: string, statusCode = 400): never => {
  throw Object.assign(new Error(message), { statusCode });
};

export async function createRelay(options: Options) {
  if (
    options.adminKey.length < 24 ||
    options.workerKey.length < 24 ||
    options.adminKey === options.workerKey
  )
    throw new Error('管理员和设备密钥必须不同，且各至少 24 字符');
  const data = resolve(options.data);
  mkdirSync(join(data, 'files'), { recursive: true });
  const db = database(join(data, 'relay.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,key_hash TEXT UNIQUE NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,admin INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,created INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,size INTEGER NOT NULL,state TEXT NOT NULL,sha256 TEXT,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS message_files(message_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(message_id,file_id));
    CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,reply_id TEXT NOT NULL,status TEXT NOT NULL,idem TEXT NOT NULL,fingerprint TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(user_id,idem));
    CREATE TABLE IF NOT EXISTS events(task_id TEXT NOT NULL,seq INTEGER NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task_id,seq));
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS conv_owner ON conversations(user_id,created);
    CREATE INDEX IF NOT EXISTS task_status ON tasks(status,created);
  `);
  for (const table of ['conversations', 'tasks']) {
    if (!rows(db, 'PRAGMA table_info(' + table + ')').some((c) => c.name === 'model'))
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN model TEXT');
  }
  let models: Model[] = [];
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  await app.register(cookie);
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: CHUNK_BYTES },
    (_req, body, done) => done(null, body),
  );
  let socket: WebSocket | undefined,
    lastSeen = 0,
    workerReady = false,
    workerMode = 'unknown',
    workerNote = '',
    lastUser = '';
  const subscriptions = new Map<string, Set<any>>();
  function revokeUser(uid: string) {
    run(db, 'DELETE FROM sessions WHERE user_id=?', uid);
    for (const task of rows(db, 'SELECT id FROM tasks WHERE user_id=?', uid))
      for (const client of subscriptions.get(task.id) ?? []) client.end();
  }
  const uploading = new Set<string>();
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  const online = () => socket?.readyState === WebSocket.OPEN && now() - lastSeen < 45_000;
  const paused = () => row(db, "SELECT value FROM settings WHERE key='paused'")?.value === '1';
  const owner = (req: FastifyRequest) => {
    const session = row(
      db,
      'SELECT * FROM sessions WHERE token_hash=? AND expires>?',
      hash(req.cookies.local_relay_session ?? ''),
      now(),
    );
    if (!session) fail('请先输入 Key 登录', 401);
    if (!session.admin) {
      const user = row(db, 'SELECT * FROM users WHERE id=? AND enabled=1', session.user_id);
      if (!user) fail('Key 已失效', 401);
    }
    return session;
  };
  const user = (req: FastifyRequest) => {
    const s = owner(req);
    if (s.admin) fail('请使用用户 Key 进入聊天', 403);
    return s.user_id as string;
  };
  const admin = (req: FastifyRequest) => {
    if (!owner(req).admin) fail('需要管理员身份', 403);
  };
  const device = (req: FastifyRequest) => {
    if (hash(req.headers.authorization ?? '') !== hash(`Bearer ${options.workerKey}`))
      fail('设备认证失败', 401);
  };
  const conversation = (req: FastifyRequest, cid: string) => {
    const c = row(
      db,
      'SELECT * FROM conversations WHERE id=? AND user_id=? AND deleted=0',
      cid,
      user(req),
    );
    if (!c) fail('会话不存在', 404);
    return c;
  };
  const ownTask = (req: FastifyRequest, tid: string) => {
    const t = row(
      db,
      'SELECT t.* FROM tasks t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=? AND t.user_id=? AND c.deleted=0',
      tid,
      user(req),
    );
    if (!t) fail('任务不存在', 404);
    return t;
  };
  function publish(tid: string, seq: number, event: string, value: string) {
    for (const client of subscriptions.get(tid) ?? []) {
      if (!client.write(`id: ${seq}\ndata: ${JSON.stringify({ seq, event, data: value })}\n\n`))
        client.end();
    }
  }
  function localFinish(task: any, status: string, message: string) {
    transaction(() => {
      const seq = (row(db, 'SELECT MAX(seq) n FROM events WHERE task_id=?', task.id)?.n ?? 0) + 1;
      run(db, 'INSERT INTO events VALUES(?,?,?,?)', task.id, seq, status, message);
      run(db, 'UPDATE tasks SET status=?,updated=? WHERE id=?', status, now(), task.id);
      publish(task.id, seq, status, message);
    });
  }
  function dispatch() {
    if (!online() || !workerReady || paused()) return;
    if (row(db, "SELECT id FROM tasks WHERE status IN ('dispatched','running','cancelling')"))
      return;
    const tasks = rows(db, "SELECT * FROM tasks WHERE status='queued' ORDER BY created");
    const task = tasks.find((t) => t.user_id !== lastUser) ?? tasks[0];
    if (!task) return;
    if (task.created < now() - 600_000) {
      localFinish(task, 'expired', '排队超时，请重新发送');
      return;
    }
    const message = row(db, 'SELECT * FROM messages WHERE id=?', task.message_id);
    const files = rows(
      db,
      'SELECT f.id,f.name,f.size,f.sha256 FROM files f JOIN message_files mf ON mf.file_id=f.id WHERE mf.message_id=?',
      task.message_id,
    );
    run(db, "UPDATE tasks SET status='dispatched',updated=? WHERE id=?", now(), task.id);
    lastUser = task.user_id;
    socket!.send(
      JSON.stringify({
        type: 'task',
        task: {
          id: task.id,
          conversationId: task.conversation_id,
          userId: task.user_id,
          prompt: message.content,
          model: task.model ?? undefined,
          files,
        },
      }),
    );
  }
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== options.origin
    )
      fail('请求来源不允许', 403);
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      fail('请求来源不允许', 403);
  });
  app.setErrorHandler((error: any, _req, reply) => {
    const code = error instanceof z.ZodError ? 400 : (error.statusCode ?? 500);
    reply.code(code).send({
      error:
        code >= 500
          ? '服务暂时不可用'
          : error instanceof z.ZodError
            ? '请求格式或限制不符合要求'
            : error.message,
    });
  });
  app.get('/health', async () => ({ ok: true }));
  app.post(
    '/api/auth/session',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { key } = z.object({ key: z.string().min(1).max(256) }).parse(req.body);
      const isAdmin = hash(key) === hash(options.adminKey);
      const u = isAdmin
        ? null
        : row(db, 'SELECT * FROM users WHERE key_hash=? AND enabled=1', hash(key));
      if (!isAdmin && !u) fail('Key 无效或已禁用', 401);
      const token = secret();
      run(
        db,
        'INSERT INTO sessions VALUES(?,?,?,?)',
        hash(token),
        u?.id ?? null,
        isAdmin ? 1 : 0,
        now() + 7 * 86400_000,
      );
      reply.setCookie('local_relay_session', token, {
        httpOnly: true,
        secure: options.secure ?? false,
        sameSite: 'strict',
        path: '/',
        maxAge: 7 * 86400,
      });
      return { admin: isAdmin };
    },
  );
  app.delete('/api/auth/session', async (req, reply) => {
    run(db, 'DELETE FROM sessions WHERE token_hash=?', hash(req.cookies.local_relay_session ?? ''));
    reply.clearCookie('local_relay_session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/me', async (req) => {
    const s = owner(req);
    return {
      admin: !!s.admin,
      name: s.admin ? '管理员' : row(db, 'SELECT name FROM users WHERE id=?', s.user_id)?.name,
    };
  });
  app.get('/api/status', async (req) => {
    owner(req);
    return {
      online: !!online(),
      ready: workerReady && !!online(),
      paused: paused(),
      mode: workerMode,
      models,
      note: workerNote,
      queue: row(db, "SELECT COUNT(*) n FROM tasks WHERE status='queued'")!.n,
    };
  });
  app.get('/api/admin/users', async (req) => {
    admin(req);
    return rows(
      db,
      'SELECT id,name,enabled,created,(SELECT COALESCE(SUM(size),0) FROM files WHERE user_id=users.id) used FROM users ORDER BY created',
    );
  });
  app.post('/api/admin/users', async (req) => {
    admin(req);
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
    const key = `sk-local-${secret()}`,
      uid = id();
    run(
      db,
      'INSERT INTO users(id,name,key_hash,created) VALUES(?,?,?,?)',
      uid,
      name,
      hash(key),
      now(),
    );
    return { id: uid, key };
  });
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/key', async (req) => {
    admin(req);
    if (!row(db, 'SELECT id FROM users WHERE id=?', req.params.id)) fail('用户不存在', 404);
    const key = `sk-local-${secret()}`;
    transaction(() => {
      run(db, 'UPDATE users SET key_hash=? WHERE id=?', hash(key), req.params.id);
      revokeUser(req.params.id);
    });
    return { key };
  });
  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (req) => {
    admin(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    run(db, 'UPDATE users SET enabled=? WHERE id=?', enabled ? 1 : 0, req.params.id);
    if (!enabled) {
      revokeUser(req.params.id);
      for (const task of rows(
        db,
        "SELECT * FROM tasks WHERE user_id=? AND status='queued'",
        req.params.id,
      ))
        localFinish(task, 'cancelled', '用户已禁用');
    }
    return { ok: true };
  });
  app.post('/api/admin/pause', async (req) => {
    admin(req);
    const { paused: p } = z.object({ paused: z.boolean() }).parse(req.body);
    run(db, "INSERT OR REPLACE INTO settings VALUES('paused',?)", p ? '1' : '0');
    return { ok: true };
  });
  app.get('/api/admin/tasks', async (req) => {
    admin(req);
    return rows(
      db,
      'SELECT t.id,t.status,t.created,t.updated,u.name FROM tasks t JOIN users u ON u.id=t.user_id ORDER BY t.created DESC LIMIT 100',
    );
  });
  app.get('/api/conversations', async (req) =>
    rows(
      db,
      'SELECT id,title,created,model FROM conversations WHERE user_id=? AND deleted=0 ORDER BY created DESC',
      user(req),
    ),
  );
  app.post('/api/conversations', async (req) => {
    const uid = user(req);
    const cid = id();
    run(
      db,
      'INSERT INTO conversations(id,user_id,title,created) VALUES(?,?,?,?)',
      cid,
      uid,
      '新会话',
      now(),
    );
    return { id: cid, title: '新会话' };
  });
  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    conversation(req, req.params.id);
    const { title } = z.object({ title: z.string().trim().min(1).max(100) }).parse(req.body);
    run(db, 'UPDATE conversations SET title=? WHERE id=?', title, req.params.id);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    conversation(req, req.params.id);
    if (
      row(
        db,
        "SELECT id FROM tasks WHERE conversation_id=? AND status IN ('queued','dispatched','running','cancelling')",
        req.params.id,
      )
    )
      fail('请先停止当前任务', 409);
    run(db, 'UPDATE conversations SET deleted=1 WHERE id=?', req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req) => {
    conversation(req, req.params.id);
    return {
      messages: rows(
        db,
        'SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid',
        req.params.id,
      ).map((m) => ({
        ...m,
        files: rows(
          db,
          'SELECT f.id,f.name,f.size FROM files f JOIN message_files mf ON mf.file_id=f.id WHERE mf.message_id=?',
          m.id,
        ),
      })),
      tasks: rows(
        db,
        'SELECT id,reply_id,status,model FROM tasks WHERE conversation_id=? ORDER BY created',
        req.params.id,
      ),
    };
  });
  app.post<{ Params: { id: string } }>('/api/conversations/:id/messages', async (req) => {
    const c = conversation(req, req.params.id);
    const b = z
      .object({
        prompt: z.string().trim().max(100_000),
        files: z.array(z.string().uuid()).max(MAX_FILES).default([]),
        model: z.string().max(200).optional(),
        idempotencyKey: z.string().uuid(),
      })
      .parse(req.body);
    if (!b.prompt && !b.files.length) fail('请输入消息或选择附件');
    if (new Set(b.files).size !== b.files.length) fail('附件重复');
    const fingerprint = hash(
      JSON.stringify({
        conversation: c.id,
        prompt: b.prompt,
        files: b.files,
        ...(b.model ? { model: b.model } : {}),
      }),
    );
    const prior = row(
      db,
      'SELECT id,fingerprint FROM tasks WHERE user_id=? AND idem=?',
      c.user_id,
      b.idempotencyKey,
    );
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('幂等键不能用于不同请求', 409);
      return { taskId: prior.id };
    }
    if (!online() || !workerReady) fail('本地 Codex 暂未就绪，历史仍可查看', 503);
    const model = b.model || models.find((m) => m.isDefault)?.model || models[0]?.model || null;
    if (b.model && !models.some((m) => m.model === b.model)) fail('所选模型当前不可用');
    if (paused()) fail('管理员已暂停接单', 409);
    if (
      row(
        db,
        "SELECT id FROM tasks WHERE conversation_id=? AND status IN ('queued','dispatched','running','cancelling')",
        c.id,
      )
    )
      fail('当前会话已有未结束任务', 409);
    if (
      row(
        db,
        "SELECT COUNT(*) n FROM tasks WHERE user_id=? AND status IN ('queued','dispatched','running','cancelling')",
        c.user_id,
      )!.n >= 2
    )
      fail('最多允许两个未结束任务', 429);
    if (row(db, "SELECT COUNT(*) n FROM tasks WHERE status='queued'")!.n >= 6)
      fail('队列已满，请稍后重试', 429);
    for (const fid of b.files)
      if (
        !row(db, "SELECT id FROM files WHERE id=? AND user_id=? AND state='ready'", fid, c.user_id)
      )
        fail('附件不存在或未完成上传', 404);
    const tid = id(),
      mid = id(),
      rid = id(),
      time = now();
    transaction(() => {
      run(db, 'INSERT INTO messages VALUES(?,?,?,?,?)', mid, c.id, 'user', b.prompt, time);
      run(db, 'INSERT INTO messages VALUES(?,?,?,?,?)', rid, c.id, 'assistant', '', time + 1);
      for (const fid of b.files) run(db, 'INSERT INTO message_files VALUES(?,?)', mid, fid);
      run(
        db,
        'INSERT INTO tasks(id,user_id,conversation_id,message_id,reply_id,status,idem,fingerprint,created,updated,model) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        tid,
        c.user_id,
        c.id,
        mid,
        rid,
        'queued',
        b.idempotencyKey,
        fingerprint,
        time,
        time,
        model,
      );
      run(db, 'UPDATE conversations SET model=? WHERE id=?', model, c.id);
      if (c.title === '新会话')
        run(
          db,
          'UPDATE conversations SET title=? WHERE id=?',
          (b.prompt || '附件分析').slice(0, 40),
          c.id,
        );
    });
    dispatch();
    return { taskId: tid };
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => {
    const t = ownTask(req, req.params.id);
    if (terminal.has(t.status)) return { ok: true };
    if (t.status === 'queued') localFinish(t, 'cancelled', '已取消');
    else {
      run(db, "UPDATE tasks SET status='cancelling',updated=? WHERE id=?", now(), t.id);
      if (online()) socket!.send(JSON.stringify({ type: 'cancel', taskId: t.id }));
    }
    return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/api/tasks/:id/events',
    async (req, reply) => {
      const t = ownTask(req, req.params.id);
      const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0) fail('无效事件序号');
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      for (const event of rows(
        db,
        'SELECT seq,event,data FROM events WHERE task_id=? AND seq>? ORDER BY seq',
        t.id,
        after,
      ))
        reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      if (terminal.has(t.status)) {
        reply.raw.end();
        return;
      }
      const set = subscriptions.get(t.id) ?? new Set();
      set.add(reply.raw);
      subscriptions.set(t.id, set);
      const timer = setInterval(() => {
        try {
          ownTask(req, t.id);
          reply.raw.write(': heartbeat\n\n');
        } catch {
          reply.raw.end();
        }
      }, 10_000);
      reply.raw.on('close', () => {
        clearInterval(timer);
        set.delete(reply.raw);
        if (!set.size) subscriptions.delete(t.id);
      });
    },
  );

  app.post('/api/uploads', async (req) => {
    const uid = user(req);
    const { name, size } = z
      .object({
        name: z
          .string()
          .min(1)
          .max(200)
          .refine((v) => !/[\\/\x00-\x1f]/.test(v)),
        size: z.number().int().min(1).max(MAX_FILE_BYTES),
      })
      .parse(req.body);
    if (!allowedExt.has(extname(name).toLowerCase())) fail('暂不支持此文件类型');
    const used = row(db, 'SELECT COALESCE(SUM(size),0) n FROM files WHERE user_id=?', uid)!.n;
    if (used + size > (options.quota ?? 10_000_000_000)) fail('用户存储配额不足', 413);
    const disk = statfsSync(data);
    const reserved = row(
      db,
      "SELECT COALESCE(SUM(size),0) n FROM files WHERE state='uploading'",
    )!.n;
    if (disk.bavail * disk.bsize - reserved - size < (options.reserve ?? 1024 ** 3))
      fail('服务器磁盘空间不足', 507);
    const fid = id();
    mkdirSync(join(data, 'files', fid));
    run(
      db,
      'INSERT INTO files VALUES(?,?,?,?,?,?,?)',
      fid,
      uid,
      name,
      size,
      'uploading',
      null,
      now(),
    );
    return { id: fid, chunkSize: CHUNK_BYTES };
  });
  app.get<{ Params: { id: string } }>('/api/uploads/:id', async (req) => {
    const f = row(db, 'SELECT * FROM files WHERE id=? AND user_id=?', req.params.id, user(req));
    if (!f) fail('附件不存在', 404);
    return {
      id: f.id,
      state: f.state,
      parts: readdirSync(join(data, 'files', f.id))
        .filter((n) => /^\d+\.part$/.test(n))
        .map((n) => Number(n.split('.')[0])),
      chunkSize: CHUNK_BYTES,
    };
  });
  app.put<{ Params: { id: string; part: string } }>(
    '/api/uploads/:id/parts/:part',
    { bodyLimit: CHUNK_BYTES },
    async (req) => {
      const f = row(db, 'SELECT * FROM files WHERE id=? AND user_id=?', req.params.id, user(req));
      if (!f) fail('附件不存在', 404);
      if (f.state !== 'uploading') fail('附件已完成', 409);
      const part = Number(req.params.part);
      if (!Number.isInteger(part) || part < 0 || part >= Math.ceil(f.size / CHUNK_BYTES))
        fail('分块序号无效');
      const body = req.body as Buffer;
      if (
        !Buffer.isBuffer(body) ||
        body.length !== Math.min(CHUNK_BYTES, f.size - part * CHUNK_BYTES)
      )
        fail('分块大小不匹配');
      if (uploading.has(f.id)) fail('附件正在写入，请重试', 409);
      uploading.add(f.id);
      try {
        const { writeFile, rename } = await import('node:fs/promises');
        const temp = join(data, 'files', f.id, `${part}.tmp`);
        await writeFile(temp, body);
        await rename(temp, join(data, 'files', f.id, `${part}.part`));
        return { ok: true };
      } finally {
        uploading.delete(f.id);
      }
    },
  );
  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async (req) => {
    const f = row(db, 'SELECT * FROM files WHERE id=? AND user_id=?', req.params.id, user(req));
    if (!f) fail('附件不存在', 404);
    if (f.state === 'ready') return { id: f.id, name: f.name, size: f.size };
    if (uploading.has(f.id)) fail('附件正在写入，请重试', 409);
    for (let i = 0; i < Math.ceil(f.size / CHUNK_BYTES); i++) {
      const path = join(data, 'files', f.id, `${i}.part`);
      if (
        !existsSync(path) ||
        statSync(path).size !== Math.min(CHUNK_BYTES, f.size - i * CHUNK_BYTES)
      )
        fail('文件尚未上传完整');
    }
    uploading.add(f.id);
    try {
      const sha = createHash('sha256');
      async function* chunks() {
        for (let i = 0; i < Math.ceil(f.size / CHUNK_BYTES); i++)
          for await (const chunk of createReadStream(join(data, 'files', f.id, `${i}.part`))) {
            sha.update(chunk);
            yield chunk;
          }
      }
      await pipeline(chunks(), createWriteStream(join(data, 'files', f.id, 'content')));
      run(db, "UPDATE files SET state='ready',sha256=? WHERE id=?", sha.digest('hex'), f.id);
      for (let i = 0; i < Math.ceil(f.size / CHUNK_BYTES); i++)
        unlinkSync(join(data, 'files', f.id, `${i}.part`));
      return { id: f.id, name: f.name, size: f.size };
    } finally {
      uploading.delete(f.id);
    }
  });
  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const f = row(
      db,
      "SELECT * FROM files WHERE id=? AND user_id=? AND state='ready'",
      req.params.id,
      user(req),
    );
    if (!f) fail('附件不存在', 404);
    reply
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`)
      .type('application/octet-stream');
    return reply.send(createReadStream(join(data, 'files', f.id, 'content')));
  });
  app.get<{ Params: { taskId: string; fileId: string } }>(
    '/internal/tasks/:taskId/files/:fileId',
    async (req, reply) => {
      device(req);
      const f = row(
        db,
        "SELECT f.* FROM files f JOIN message_files mf ON mf.file_id=f.id JOIN tasks t ON t.message_id=mf.message_id WHERE t.id=? AND f.id=? AND t.status IN ('dispatched','running','cancelling')",
        req.params.taskId,
        req.params.fileId,
      );
      if (!f) fail('附件不可访问', 404);
      reply.header('Content-Length', f.size).type('application/octet-stream');
      return reply.send(createReadStream(join(data, 'files', f.id, 'content')));
    },
  );

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2_100_000 });
  app.server.on('upgrade', (req, sock, head) => {
    if (
      req.url !== '/internal/worker/connect' ||
      hash(req.headers.authorization ?? '') !== hash(`Bearer ${options.workerKey}`)
    ) {
      sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      sock.destroy();
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) {
      sock.write('HTTP/1.1 409 Conflict\r\n\r\n');
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    socket = ws;
    lastSeen = now();
    workerReady = false;
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        lastSeen = now();
        if (m.type === 'hello' || m.type === 'heartbeat') {
          models = modelsSchema.parse(m.models ?? []);
          workerReady = m.ready === true;
          workerMode = m.mode === 'mock' ? 'mock' : 'codex';
          workerNote = typeof m.note === 'string' ? m.note.slice(0, 200) : '';
          if (m.type === 'hello') {
            ws.send(
              JSON.stringify({
                type: 'reconcile',
                tasks: rows(
                  db,
                  "SELECT id,status FROM tasks WHERE status IN ('dispatched','running','cancelling')",
                ),
              }),
            );
          }
          dispatch();
          return;
        }
        if (m.type === 'missing' && typeof m.taskId === 'string') {
          const task = row(
            db,
            "SELECT * FROM tasks WHERE id=? AND status IN ('dispatched','running','cancelling')",
            m.taskId,
          );
          if (task) localFinish(task, 'interrupted', '本地任务状态缺失，未自动重复执行');
          return;
        }
        if (m.type === 'cleanup.done' && typeof m.conversationId === 'string') {
          const c = row(
            db,
            'SELECT id FROM conversations WHERE id=? AND deleted=1',
            m.conversationId,
          );
          if (c) {
            const fids = rows(
              db,
              'SELECT mf.file_id FROM message_files mf JOIN messages m ON m.id=mf.message_id WHERE m.conversation_id=?',
              c.id,
            );
            transaction(() => {
              run(
                db,
                'DELETE FROM events WHERE task_id IN (SELECT id FROM tasks WHERE conversation_id=?)',
                c.id,
              );
              run(
                db,
                'DELETE FROM message_files WHERE message_id IN (SELECT id FROM messages WHERE conversation_id=?)',
                c.id,
              );
              run(db, 'DELETE FROM tasks WHERE conversation_id=?', c.id);
              run(db, 'DELETE FROM messages WHERE conversation_id=?', c.id);
              run(db, 'DELETE FROM conversations WHERE id=?', c.id);
            });
            for (const f of fids) {
              if (!row(db, 'SELECT file_id FROM message_files WHERE file_id=?', f.file_id)) {
                rmSync(join(data, 'files', f.file_id), { recursive: true, force: true });
                run(db, 'DELETE FROM files WHERE id=?', f.file_id);
              }
            }
          }
          return;
        }
        const e = eventSchema.parse(m),
          task = row(db, 'SELECT * FROM tasks WHERE id=?', e.taskId);
        if (!task) return;
        if (row(db, 'SELECT seq FROM events WHERE task_id=? AND seq=?', e.taskId, e.seq)) {
          ws.send(JSON.stringify({ type: 'ack', taskId: e.taskId, seq: e.seq }));
          return;
        }
        const last = row(
          db,
          'SELECT COALESCE(MAX(seq),0) n FROM events WHERE task_id=?',
          e.taskId,
        )!.n;
        if (e.seq !== last + 1 || terminal.has(task.status)) return;
        transaction(() => {
          run(db, 'INSERT INTO events VALUES(?,?,?,?)', e.taskId, e.seq, e.event, e.data);
          if (e.event === 'delta')
            run(db, 'UPDATE messages SET content=content||? WHERE id=?', e.data, task.reply_id);
          const state =
            e.event === 'started'
              ? task.status === 'cancelling'
                ? 'cancelling'
                : 'running'
              : terminal.has(e.event)
                ? e.event
                : task.status;
          run(db, 'UPDATE tasks SET status=?,updated=? WHERE id=?', state, now(), task.id);
        });
        publish(e.taskId, e.seq, e.event, e.data);
        ws.send(JSON.stringify({ type: 'ack', taskId: e.taskId, seq: e.seq }));
        dispatch();
      } catch {
        ws.close(1008, 'Invalid protocol message');
      }
    });
    ws.on('close', () => {
      if (socket === ws) {
        socket = undefined;
        workerReady = false;
      }
    });
    ws.on('error', () => {});
  });
  const timer = setInterval(() => {
    if (socket && now() - lastSeen > 45_000) socket.terminate();
    dispatch();
    if (online()) {
      for (const t of rows(db, "SELECT id FROM tasks WHERE status='cancelling'"))
        socket!.send(JSON.stringify({ type: 'cancel', taskId: t.id }));
      for (const c of rows(db, 'SELECT id FROM conversations WHERE deleted=1'))
        socket!.send(JSON.stringify({ type: 'cleanup', conversationId: c.id }));
    }
  }, 2000);
  const cleanup = setInterval(() => {
    run(db, 'DELETE FROM sessions WHERE expires<?', now());
    for (const f of rows(
      db,
      'SELECT id FROM files WHERE created<? AND id NOT IN (SELECT file_id FROM message_files)',
      now() - 86400_000,
    )) {
      if (!uploading.has(f.id)) {
        rmSync(join(data, 'files', f.id), { recursive: true, force: true });
        run(db, 'DELETE FROM files WHERE id=?', f.id);
      }
    }
  }, 60_000);
  const web = resolve(options.web ?? 'dist');
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/internal/'))
        return reply.code(404).send({ error: '接口不存在' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(cleanup);
    for (const set of subscriptions.values()) for (const client of set) client.end();
    socket?.terminate();
    wss.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });
  return app;
}
