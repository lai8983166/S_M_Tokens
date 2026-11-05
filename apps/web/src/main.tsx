import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
const apiBase = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api';

async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(apiBase + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '请求失败');
  return result;
}
type Conversation = { id: string; title: string; model?: string };
type Attachment = { id: string; name: string; size: number };
type Message = { id: string; role: string; content: string; files: Attachment[] };
type Task = { id: string; reply_id: string; status: string };
const finished = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'expired']);
const labels: Record<string, string> = {
  queued: '排队中',
  dispatched: '准备附件',
  running: '生成中',
  cancelling: '正在停止',
  completed: '已完成',
  cancelled: '已停止',
  failed: '生成失败',
  interrupted: '已中断',
  expired: '排队超时',
};
const size = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1000)} KB`);

function App() {
  const [me, setMe] = useState<any>(undefined),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const [status, setStatus] = useState<any>({}),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState('');
  const [messages, setMessages] = useState<Message[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [prompt, setPrompt] = useState('');
  const [files, setFiles] = useState<
      { file: File; id?: string; progress: number; error?: string; ready?: boolean }[]
    >([]),
    [uploading, setUploading] = useState(false);
  const [users, setUsers] = useState<any[]>([]),
    [adminTasks, setAdminTasks] = useState<any[]>([]),
    [userName, setUserName] = useState(''),
    [newKey, setNewKey] = useState('');
  const [model, setModel] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEffect(() => {
    setModel(conversations.find((c) => c.id === selected)?.model ?? '');
  }, [selected, conversations]);
  const bottom = useRef<HTMLDivElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0),
    selectedRef = useRef(''),
    requestRef = useRef<{ signature: string; id: string }>({ signature: '', id: '' });
  const active = tasks.find((t) => !finished.has(t.status));
  useEffect(() => {
    api('/me')
      .then(setMe)
      .catch(() => setMe(null));
  }, []);
  async function refreshConversations() {
    setConversations(await api('/conversations'));
  }
  async function refreshMessages(cid = selectedRef.current) {
    if (!cid) return;
    const result = await api(`/conversations/${cid}/messages`);
    if (selectedRef.current !== cid) return;
    setMessages(result.messages);
    setTasks(result.tasks);
  }
  async function refreshAdmin() {
    const [u, t] = await Promise.all([api('/admin/users'), api('/admin/tasks')]);
    setUsers(u);
    setAdminTasks(t);
  }
  useEffect(() => {
    if (!me) return;
    const refresh = () => {
      api('/status')
        .then(setStatus)
        .catch(() => {});
      if (me.admin) void refreshAdmin().catch(() => {});
    };
    refresh();
    if (!me.admin) void refreshConversations();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [me]);
  useEffect(() => {
    selectedRef.current = selected;
    setMessages([]);
    setTasks([]);
    setError('');
    if (selected) void refreshMessages(selected).catch((e) => setError(e.message));
  }, [selected]);
  useEffect(() => {
    if (!active) return;
    const cid = selected;
    const source = new EventSource(`${apiBase}/tasks/${active.id}/events`);
    // Render server snapshots instead of appending a delta twice after a reconnect.
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = (message) => {
      const e = JSON.parse(message.data);
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refreshMessages(cid).catch(() => {});
        }, 300);
      if (finished.has(e.event)) {
        source.close();
        if (e.data && e.event !== 'completed') setError(e.data);
        void refreshMessages(cid).catch(() => {});
      }
    };
    source.onerror = () => {
      void refreshMessages(cid).catch(() => {});
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [active?.id, selected]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);
  async function act(fn: () => Promise<void>) {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    await act(async () => {
      await api('/auth/session', 'POST', { key });
      setKey('');
      setMe(await api('/me'));
    });
    setPending(false);
  }
  async function create() {
    if (uploading) return;
    await act(async () => {
      const c = await api('/conversations', 'POST');
      setSelected(c.id);
      setPrompt('');
      setFiles([]);
      await refreshConversations();
    });
  }
  async function renameConversation() {
    const c = conversations.find((c) => c.id === selected);
    const title = window.prompt('会话名称', c?.title);
    if (title?.trim())
      await act(async () => {
        await api(`/conversations/${selected}`, 'PATCH', { title });
        await refreshConversations();
      });
  }
  async function removeConversation() {
    if (!window.confirm('删除此会话及关联文件？本地服务离线时会稍后完成清理。')) return;
    await act(async () => {
      await api(`/conversations/${selected}`, 'DELETE');
      setSelected('');
      await refreshConversations();
    });
  }
  async function upload(list: typeof files) {
    const epoch = generation.current;
    setUploading(true);
    let cursor = 0;
    const update = (index: number, patch: any) => {
      if (epoch === generation.current)
        setFiles((current) => current.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    };
    async function next() {
      while (cursor < list.length) {
        const i = cursor++,
          item = list[i];
        if (item.ready) continue;
        try {
          let fid = item.id,
            chunkSize = 8 * 1024 * 1024,
            parts: number[] = [];
          if (fid) {
            const state = await api(`/uploads/${fid}`);
            if (state.state === 'ready') {
              update(i, { ready: true, progress: 100, error: undefined });
              continue;
            }
            parts = state.parts;
            chunkSize = state.chunkSize;
          } else {
            const result = await api('/uploads', 'POST', {
              name: item.file.name,
              size: item.file.size,
            });
            fid = result.id;
            chunkSize = result.chunkSize;
            update(i, { id: fid });
          }
          for (let part = 0; part < Math.ceil(item.file.size / chunkSize); part++) {
            if (!parts.includes(part)) {
              let ok = false;
              for (let attempt = 0; attempt < 3 && !ok; attempt++) {
                const result = await fetch(`${apiBase}/uploads/${fid}/parts/${part}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/octet-stream' },
                  body: item.file.slice(
                    part * chunkSize,
                    Math.min((part + 1) * chunkSize, item.file.size),
                  ),
                });
                if (result.ok) ok = true;
                else if (attempt === 2) throw new Error((await result.json()).error ?? '上传失败');
                else await new Promise((r) => setTimeout(r, 500));
              }
            }
            update(i, {
              progress: Math.round(
                (Math.min((part + 1) * chunkSize, item.file.size) / item.file.size) * 95,
              ),
              error: undefined,
            });
          }
          await api(`/uploads/${fid}/complete`, 'POST');
          update(i, { progress: 100, ready: true, error: undefined });
        } catch (e) {
          update(i, { error: e instanceof Error ? e.message : '上传失败' });
        }
      }
    }
    await Promise.all([next(), next()]);
    if (epoch === generation.current) setUploading(false);
  }
  async function chooseFiles(incoming: FileList | null) {
    if (!incoming) return;
    const added = Array.from(incoming);
    if (files.length + added.length > 20) {
      setError('每条消息最多 20 个附件');
      return;
    }
    if (added.some((f) => f.size > 100_000_000 || f.size === 0)) {
      setError('单个文件须大于 0 且不超过 100 MB');
      return;
    }
    const list = [...files, ...added.map((file) => ({ file, progress: 0 }))];
    setFiles(list);
    await upload(list);
  }
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (active || pending || uploading) return;
    setPending(true);
    await act(async () => {
      let cid = selected;
      if (!cid) {
        const c = await api('/conversations', 'POST');
        cid = c.id;
        selectedRef.current = cid;
        setSelected(cid);
      }
      const payload = { prompt, model, files: files.map((f) => f.id!) };
      const signature = JSON.stringify({ cid, ...payload });
      if (requestRef.current.signature !== signature)
        requestRef.current = { signature, id: crypto.randomUUID() };
      await api(`/conversations/${cid}/messages`, 'POST', {
        ...payload,
        idempotencyKey: requestRef.current.id,
      });
      setPrompt('');
      setFiles([]);
      requestRef.current = { signature: '', id: '' };
      await refreshConversations();
      await refreshMessages(cid);
    });
    setPending(false);
  }
  async function logout() {
    generation.current++;
    await api('/auth/session', 'DELETE');
    setMe(null);
    setSelected('');
    setFiles([]);
    setNewKey('');
  }
  if (me === undefined) return <div className="loading">加载中…</div>;
  if (!me)
    return (
      <div className="login-layout">
        <form className="login-card" onSubmit={login}>
          <div className="brand">
            Agent
            <span className="brand-dot" />
          </div>
          <input
            aria-label="访问 Key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="current-password"
            placeholder="访问 Key"
            required
          />
          <button className="primary" disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </button>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
        </form>
      </div>
    );
  return (
    <div className={'app-shell' + (sidebarOpen ? ' sidebar-open' : '')}>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭会话列表"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          Agent
          <span className="brand-dot" />
        </div>
        {!me.admin && (
          <>
            <button
              className="new-chat"
              onClick={() => {
                void create();
                setSidebarOpen(false);
              }}
              disabled={uploading || pending}
            >
              ＋ 新对话
            </button>
            <nav aria-label="会话列表">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  className={selected === c.id ? 'conversation selected' : 'conversation'}
                  disabled={uploading || pending}
                  onClick={() => {
                    setSelected(c.id);
                    setPrompt('');
                    setFiles([]);
                    setSidebarOpen(false);
                  }}
                >
                  <span>{c.title}</span>
                </button>
              ))}
            </nav>
          </>
        )}
        <div className="sidebar-bottom">
          <div className="profile">
            <i
              className={status.ready ? 'dot online' : 'dot'}
              title={status.ready ? '服务已连接' : '服务未就绪'}
            />
            <span>{me.name}</span>
            <button
              className="icon-button"
              onClick={() => void act(logout)}
              title="退出登录"
              aria-label="退出登录"
            >
              ↪
            </button>
          </div>
          {status.mode === 'mock' && <small>模拟模式</small>}
        </div>
      </aside>
      <main>
        <header>
          <button
            className="mobile-menu icon-button"
            aria-label="打开会话列表"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          {me.admin ? (
            <span>管理</span>
          ) : (
            <select
              className="model-select"
              aria-label="选择模型"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!!active || pending || !status.ready}
            >
              <option value="">
                默认 · {status.models?.find((m: any) => m.isDefault)?.displayName ?? '等待连接'}
              </option>
              {model && !status.models?.some((m: any) => m.model === model) && (
                <option value={model}>{model}（不可用）</option>
              )}
              {(status.models ?? []).map((m: any) => (
                <option key={m.model} value={m.model}>
                  {m.displayName}
                </option>
              ))}
            </select>
          )}
          <div className="header-actions">
            {!me.admin && selected && (
              <>
                <button
                  className="icon-button"
                  onClick={renameConversation}
                  title="重命名会话"
                  aria-label="重命名会话"
                >
                  ✎
                </button>
                <button
                  className="icon-button"
                  disabled={!!active || pending}
                  onClick={removeConversation}
                  title="删除会话"
                  aria-label="删除会话"
                >
                  ×
                </button>
              </>
            )}
          </div>
        </header>
        {error && (
          <div role="alert" className="error top-error">
            {error}
            <button onClick={() => setError('')} aria-label="关闭提示">
              ×
            </button>
          </div>
        )}
        {me.admin ? (
          <div className="admin-content">
            <p className="admin-status">
              {status.note || '等待连接'} · 排队 {status.queue ?? 0}
            </p>
            <section className="panel">
              <div className="panel-heading">
                <h3>用户</h3>
                <button
                  onClick={() =>
                    void act(async () => {
                      await api('/admin/pause', 'POST', { paused: !status.paused });
                      setStatus(await api('/status'));
                    })
                  }
                >
                  {status.paused ? '恢复接单' : '暂停接单'}
                </button>
              </div>
              <form
                className="create-user"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const result = await api('/admin/users', 'POST', { name: userName });
                    setNewKey(result.key);
                    setUserName('');
                    await refreshAdmin();
                  });
                }}
              >
                <input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  placeholder="用户名称"
                  aria-label="用户名称"
                  maxLength={80}
                  required
                />
                <button className="primary">创建用户与 Key</button>
              </form>
              {newKey && (
                <div className="new-key">
                  <strong>请保存并发送给对应用户，仅本次展示</strong>
                  <code>{newKey}</code>
                  <button
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(newKey)
                        .catch(() => setError('复制失败，请手动复制'))
                    }
                  >
                    复制 Key
                  </button>
                  <button onClick={() => setNewKey('')}>已保存</button>
                </div>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>已用空间</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td>{u.name}</td>
                        <td>{size(u.used)}</td>
                        <td>
                          <span className={u.enabled ? 'pill' : 'pill muted'}>
                            {u.enabled ? '已启用' : '已禁用'}
                          </span>
                        </td>
                        <td>
                          <button
                            onClick={() =>
                              void act(async () => {
                                await api(`/admin/users/${u.id}`, 'PATCH', { enabled: !u.enabled });
                                await refreshAdmin();
                              })
                            }
                          >
                            {u.enabled ? '禁用' : '启用'}
                          </button>
                          <button
                            onClick={() => {
                              if (window.confirm('替换后旧 Key 和登录会话立即失效，继续？'))
                                void act(async () => {
                                  setNewKey((await api(`/admin/users/${u.id}/key`, 'POST')).key);
                                });
                            }}
                          >
                            替换 Key
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!users.length && <p className="empty-table">创建第一位用户，开始使用。</p>}
              </div>
            </section>
            <section className="panel">
              <div className="panel-heading">
                <h3>近期任务</h3>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>状态</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {adminTasks.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{labels[t.status] ?? t.status}</td>
                      <td>{new Date(t.created).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!adminTasks.length && <p className="empty-table">暂无任务记录</p>}
            </section>
          </div>
        ) : (
          <>
            <div className="chat-scroll">
              {messages.length === 0 ? (
                <div className="welcome">有什么想聊的？</div>
              ) : (
                <div className="messages">
                  {messages.map((m) => {
                    const task = tasks.find((t) => t.reply_id === m.id);
                    return (
                      <article key={m.id} className={`message ${m.role}`}>
                        <div className="message-label">
                          <span className="message-avatar">{m.role === 'user' ? '你' : '✳'}</span>
                          <strong>{m.role === 'user' ? me.name : 'Codex'}</strong>
                          {task && task.status !== 'completed' && (
                            <span className="task-label">{labels[task.status]}</span>
                          )}
                        </div>
                        {m.files?.length > 0 && (
                          <div className="message-files">
                            {m.files.map((f) => (
                              <a key={f.id} href={`${apiBase}/files/${f.id}`}>
                                ▤ {f.name}
                                <small>{size(f.size)}</small>
                              </a>
                            ))}
                          </div>
                        )}
                        <div className="message-body">
                          {m.content ||
                            (!task || finished.has(task.status) ? (
                              '未产生文本回复。'
                            ) : (
                              <span className="thinking">
                                正在处理<span>…</span>
                              </span>
                            ))}
                        </div>
                      </article>
                    );
                  })}
                  <div ref={bottom} />
                </div>
              )}
            </div>
            <div className="composer-area">
              {(!status.ready || status.paused) && (
                <div className="availability">
                  {status.paused ? '接单已暂停' : status.note || '本地执行端未连接'} ·
                  历史记录仍可查看
                </div>
              )}
              <form className="composer" onSubmit={send}>
                {files.length > 0 && (
                  <div className="upload-list">
                    {files.map((f, i) => (
                      <div className="upload-chip" key={`${f.file.name}-${i}`}>
                        <span>▤</span>
                        <div>
                          <strong>{f.file.name}</strong>
                          <small>
                            {f.error ?? (f.ready ? size(f.file.size) : `上传中 ${f.progress}%`)}
                          </small>
                        </div>
                        {!uploading && (
                          <button
                            type="button"
                            aria-label={`移除 ${f.file.name}`}
                            onClick={() =>
                              setFiles((current) => current.filter((_, index) => index !== i))
                            }
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="输入消息…"
                  title="Enter 发送，Shift + Enter 换行"
                  aria-label="消息"
                  maxLength={100000}
                  disabled={!!active}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-tools">
                  <input
                    ref={fileInput}
                    type="file"
                    multiple
                    hidden
                    accept=".txt,.md,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sql,.log,.pdf,.png,.jpg,.jpeg"
                    onChange={(e) => {
                      void chooseFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    className="attach-button"
                    aria-label="添加文件"
                    title="添加文件：最多 20 个，每个 100 MB"
                    disabled={uploading || !!active}
                    onClick={() => fileInput.current?.click()}
                  >
                    ＋
                  </button>
                  <span className="file-limit">{files.length > 0 ? `${files.length}/20` : ''}</span>
                  {files.some((f) => f.error) && (
                    <button type="button" disabled={uploading} onClick={() => void upload(files)}>
                      重试上传
                    </button>
                  )}
                  {active ? (
                    <button
                      type="button"
                      className="stop-button"
                      onClick={() =>
                        void act(async () => {
                          await api(`/tasks/${active.id}/cancel`, 'POST');
                          await refreshMessages();
                        })
                      }
                    >
                      ■ 停止
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="send-button"
                      aria-label="发送消息"
                      disabled={
                        pending ||
                        uploading ||
                        !status.ready ||
                        status.paused ||
                        (!prompt.trim() && !files.length) ||
                        files.some((f) => !f.ready)
                      }
                    >
                      ↑
                    </button>
                  )}
                </div>
              </form>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
