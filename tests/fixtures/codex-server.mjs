import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const home = process.env.CODEX_HOME,
  path = join(home, 'threads.json'),
  record = join(home, 'requests.jsonl');
let threads = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.method) return;
  appendFileSync(record, JSON.stringify(m) + '\n');
  const reply = (result) => send({ id: m.id, result });
  if (m.method === 'initialize') reply({ userAgent: 'fixture' });
  else if (m.method === 'account/read') reply({ account: { type: 'chatgpt' } });
  else if (m.method === 'model/list')
    reply({
      data: [
        { model: 'test-a', displayName: 'Test A', isDefault: true },
        { model: 'test-b', displayName: 'Test B', isDefault: false },
      ],
      nextCursor: null,
    });
  else if (m.method === 'thread/start') {
    const id = randomUUID();
    threads[id] = { id, turns: [], status: { type: 'idle' } };
    writeFileSync(path, JSON.stringify(threads));
    reply({ thread: threads[id] });
  } else if (m.method === 'thread/resume' || m.method === 'thread/read') {
    const thread = threads[m.params.threadId];
    if (thread) reply({ thread });
    else send({ id: m.id, error: { code: -32000, message: 'missing thread' } });
  } else if (m.method === 'turn/start') {
    const thread = threads[m.params.threadId],
      turn = { id: randomUUID(), status: 'inProgress', items: [] };
    thread.turns.push(turn);
    writeFileSync(path, JSON.stringify(threads));
    reply({ turn });
    send({ method: 'turn/started', params: { threadId: thread.id, turn } });
    const text = `会话轮次 ${thread.turns.length}；新输入：${m.params.input[0].text}`;
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: thread.id, turnId: turn.id, delta: text },
    });
    turn.status = 'completed';
    turn.items = [{ type: 'agentMessage', text }];
    writeFileSync(path, JSON.stringify(threads));
    send({ method: 'turn/completed', params: { threadId: thread.id, turn } });
  } else if (m.method === 'thread/delete') {
    delete threads[m.params.threadId];
    writeFileSync(path, JSON.stringify(threads));
    reply({});
  }
});
