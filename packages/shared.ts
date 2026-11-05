import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 100_000_000;
export const CHUNK_BYTES = 8 * 1024 * 1024;
export const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'expired']);
export const id = () => randomUUID();
export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const now = () => Date.now();
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const taskSchema = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userId: z.string().uuid(),
  prompt: z.string().max(100_000),
  files: z.array(attachmentSchema).max(MAX_FILES),
});
export type Task = z.infer<typeof taskSchema>;
export const eventSchema = z.object({
  type: z.literal('event'),
  taskId: z.string().uuid(),
  seq: z.number().int().positive(),
  event: z.enum(['started', 'delta', 'completed', 'failed', 'cancelled', 'interrupted']),
  data: z.string().max(2_000_000),
});
export type WorkerEvent = z.infer<typeof eventSchema>;
export function env() {
  const file = process.env.RELAY_ENV_FILE ?? '.env';
  if (process.env.RELAY_ENV_FILE && !existsSync(file)) throw new Error(`配置文件不存在：${file}`);
  if (existsSync(file)) process.loadEnvFile(file);
}
export function database(path: string) {
  const db = new DatabaseSync(resolve(path));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return db;
}
export function rows<T = any>(db: DatabaseSync, sql: string, ...args: any[]): T[] {
  return db.prepare(sql).all(...args) as T[];
}
export function row<T = any>(db: DatabaseSync, sql: string, ...args: any[]): T | undefined {
  return db.prepare(sql).get(...args) as T | undefined;
}
export function run(db: DatabaseSync, sql: string, ...args: any[]) {
  return db.prepare(sql).run(...args);
}
