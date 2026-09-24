import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startWebConsole } from '../src/server.mjs';

/** 造一个记录调用参数的假 supervisor：只关心 HTTP 层，不碰浏览器。 */
function fakeSupervisor(overrides = {}) {
  const subscribers = new Set();
  const calls = [];
  const base = {
    calls,
    configPath: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-web-')), 'config.json'),
    qrPath: path.join(tmpdir(), 'xianyu-not-there', 'login-qr.png'),
    snapshot: () => ({ running: true, session: 'valid', tasks: [{ name: 't' }], hits: [] }),
    start: async () => ({ ok: true }),
    stop: async () => ({ ok: true }),
    check: async () => ({ ok: true, results: [{ task: 't', scanned: 3, hits: [] }] }),
    testNotify: async () => ({ ok: true, results: [{ type: 'bark', ok: true }] }),
    loginWithQr: async () => ({ ok: true }),
    restart: async () => ({ ok: true }),
    saveConfig: async (config) => {
      calls.push(['saveConfig', config]);
      return { ok: true };
    },
    saveTasks: async (tasks) => {
      calls.push(['saveTasks', tasks]);
      return { ok: true };
    },
    setTaskEnabled: async (name, enabled) => {
      calls.push(['setTaskEnabled', name, enabled]);
      return { ok: true, running: enabled };
    },
    setNotify: async ({ name, enabled } = {}) => {
      calls.push(['setNotify', name ?? null, enabled]);
      return { ok: true, enabled };
    },
    subscribe: (handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    publish: (event) => {
      for (const handler of subscribers) handler(event);
    },
    ...overrides,
  };
  writeFileSync(base.configPath, JSON.stringify({ tasks: [], notify: { channels: [] } }), 'utf8');
  return base;
}

/** 起一个用随机端口的控制台，返回基址与关闭函数。 */
async function withConsole(supervisor, options = {}) {
  const handle = await startWebConsole({ supervisor, port: 0, host: '127.0.0.1', logger: null, ...options });
  return { base: `http://127.0.0.1:${handle.port}`, close: handle.close };
}

test('状态接口直接返回 supervisor 的快照', async () => {
  const console_ = await withConsole(fakeSupervisor());
  try {
    const response = await fetch(`${console_.base}/api/state`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.running, true);
    assert.equal(state.tasks[0].name, 't');
  } finally {
    await console_.close();
  }
});

test('控制类接口把动作转给 supervisor', async () => {
  const calls = [];
  const supervisor = fakeSupervisor({
    start: async () => {
      calls.push('start');
      return { ok: true };
    },
    check: async () => {
      calls.push('check');
      return { ok: true, results: [] };
    },
  });
  const console_ = await withConsole(supervisor);
  try {
    assert.deepEqual(await (await fetch(`${console_.base}/api/check`, { method: 'POST' })).json(), { ok: true, results: [] });
    assert.deepEqual(calls, ['check']);
  } finally {
    await console_.close();
  }
});

test('不再提供服务启停接口：生命周期归进程而不是页面', async () => {
  const console_ = await withConsole(fakeSupervisor());
  try {
    for (const path of ['start', 'stop', 'restart']) {
      const response = await fetch(`${console_.base}/api/${path}`, { method: 'POST' });
      assert.equal(response.status, 404, `/api/${path} 不该存在`);
    }
  } finally {
    await console_.close();
  }
});

test('未知接口返回 404 JSON 而不是空白页', async () => {
  const console_ = await withConsole(fakeSupervisor());
  try {
    const response = await fetch(`${console_.base}/api/nope`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /没有这个接口/);
  } finally {
    await console_.close();
  }
});

test('配置读写走文件，保存失败时把 problems 透出来', async () => {
  const supervisor = fakeSupervisor({
    saveConfig: async () => ({ ok: false, problems: ['tasks[0].keyword 必填'] }),
  });
  const console_ = await withConsole(supervisor);
  try {
    const loaded = await (await fetch(`${console_.base}/api/config`)).json();
    assert.equal(loaded.path, supervisor.configPath);
    assert.deepEqual(loaded.config.notify.channels, []);

    const saved = await fetch(`${console_.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { tasks: [] } }),
    });
    assert.deepEqual(await saved.json(), { ok: false, problems: ['tasks[0].keyword 必填'] });

    const bad = await fetch(`${console_.base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: 'not-an-object' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await console_.close();
  }
});

test('任务保存接口只提交 tasks，并在结构不对时返回 400', async () => {
  const calls = [];
  const supervisor = fakeSupervisor({
    saveTasks: async (tasks) => {
      calls.push(tasks);
      return { ok: true };
    },
  });
  const console_ = await withConsole(supervisor);
  try {
    const tasks = [{ name: 'n', keyword: '显示器', intervalSeconds: 120 }];
    const saved = await fetch(`${console_.base}/api/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks }),
    });
    assert.deepEqual(await saved.json(), { ok: true });
    assert.deepEqual(calls, [tasks]);

    const bad = await fetch(`${console_.base}/api/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: '不是数组' }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual(calls.length, 1, '结构不对时不该调用保存');
  } finally {
    await console_.close();
  }
});

test('单任务开关接口校验参数并转给 supervisor', async () => {
  const calls = [];
  const supervisor = fakeSupervisor({
    setTaskEnabled: async (name, enabled) => {
      calls.push([name, enabled]);
      return { ok: true, running: enabled };
    },
  });
  const console_ = await withConsole(supervisor);
  try {
    const response = await fetch(`${console_.base}/api/toggle-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 't', enabled: false }),
    });
    assert.deepEqual(await response.json(), { ok: true, running: false });
    assert.deepEqual(calls, [['t', false]]);

    const noName = await fetch(`${console_.base}/api/toggle-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(noName.status, 400);

    const badEnabled = await fetch(`${console_.base}/api/toggle-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 't', enabled: 'yes' }),
    });
    assert.equal(badEnabled.status, 400);
    assert.equal(calls.length, 1, '参数不合法时不该调用 supervisor');
  } finally {
    await console_.close();
  }
});

test('推送开关接口：不带 name 是总开关，带 name 是单任务', async () => {
  const calls = [];
  const supervisor = fakeSupervisor({
    setNotify: async ({ name, enabled } = {}) => {
      calls.push([name ?? null, enabled]);
      return { ok: true, enabled };
    },
  });
  const console_ = await withConsole(supervisor);
  try {
    const master = await fetch(`${console_.base}/api/toggle-notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.deepEqual(await master.json(), { ok: true, enabled: false });

    const perTask = await fetch(`${console_.base}/api/toggle-notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 't', enabled: true }),
    });
    assert.deepEqual(await perTask.json(), { ok: true, enabled: true });
    assert.deepEqual(calls, [[null, false], ['t', true]]);

    const bad = await fetch(`${console_.base}/api/toggle-notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: 'yes' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 2, '参数不合法时不该调用 supervisor');
  } finally {
    await console_.close();
  }
});


test('二维码还没生成时返回 404 而不是空图', async () => {
  const console_ = await withConsole(fakeSupervisor());
  try {
    const response = await fetch(`${console_.base}/api/login-qr.png`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /尚未生成/);
  } finally {
    await console_.close();
  }
});

test('对外监听时必须带令牌，带对之后种 Cookie', async () => {
  const console_ = await withConsole(fakeSupervisor(), { token: 'secret' });
  try {
    assert.equal((await fetch(`${console_.base}/api/state`)).status, 401);

    const authorized = await fetch(`${console_.base}/api/state?token=secret`);
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get('set-cookie') ?? '', /xy_token=secret/);

    // 之后只带 Cookie 也能通过。
    const viaCookie = await fetch(`${console_.base}/api/state`, { headers: { cookie: 'xy_token=secret' } });
    assert.equal(viaCookie.status, 200);
  } finally {
    await console_.close();
  }
});

test('SSE 连上时会补发最近的日志（否则刷新后日志面板一直是空的）', async () => {
  const supervisor = fakeSupervisor();
  // 连接建立之前就已经发生过的日志
  supervisor.recentLogs = [
    { type: 'log', level: 'info', message: '监控已启动', tag: 'web' },
    { type: 'log', level: 'warn', message: '当前没有启用中的任务', tag: 'monitor' },
  ];
  const console_ = await withConsole(supervisor);
  const controller = new AbortController();
  try {
    const response = await fetch(`${console_.base}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async () => {
      for (;;) {
        const line = buffer.split('\n').find((entry) => entry.startsWith('data: '));
        if (line) {
          buffer = buffer.slice(buffer.indexOf(line) + line.length);
          return JSON.parse(line.slice(6));
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 流提前结束');
        buffer += decoder.decode(value, { stream: true });
      }
    };

    const first = await nextEvent();
    assert.equal(first.message, '监控已启动');
    const second = await nextEvent();
    assert.equal(second.message, '当前没有启用中的任务');

    // 补发之后，新事件照常推
    supervisor.publish({ type: 'log', level: 'info', message: '之后的新日志' });
    const third = await nextEvent();
    assert.equal(third.message, '之后的新日志');
  } finally {
    controller.abort();
    await console_.close();
  }
});

test('SSE 把 supervisor 广播的事件推给页面', async () => {
  const supervisor = fakeSupervisor();
  const console_ = await withConsole(supervisor);
  const controller = new AbortController();
  try {
    const response = await fetch(`${console_.base}/api/events`, { signal: controller.signal });
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextEvent = async () => {
      for (;;) {
        const line = buffer.split('\n').find((entry) => entry.startsWith('data: '));
        if (line) {
          buffer = buffer.slice(buffer.indexOf(line) + line.length);
          return JSON.parse(line.slice(6));
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 流提前结束');
        buffer += decoder.decode(value, { stream: true });
      }
    };

    // 等连接建立后再广播，避免事件发在订阅之前。
    await new Promise((resolve) => setTimeout(resolve, 100));
    supervisor.publish({ type: 'log', level: 'info', message: '第 1 轮：扫描 59 条', tag: 't' });
    supervisor.publish({ type: 'hit', hit: { id: '1', price: 568 } });

    const first = await nextEvent();
    assert.equal(first.type, 'log');
    assert.match(first.message, /扫描 59 条/);

    const second = await nextEvent();
    assert.equal(second.type, 'hit');
    assert.equal(second.hit.price, 568);
  } finally {
    controller.abort();
    await console_.close();
  }
});

test('接口抛错时返回 500 JSON，不把服务带崩', async () => {
  const supervisor = fakeSupervisor({
    check: async () => {
      throw new Error('浏览器启动失败');
    },
  });
  const console_ = await withConsole(supervisor);
  try {
    const response = await fetch(`${console_.base}/api/check`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /浏览器启动失败/);

    // 同一个服务仍然可用。
    assert.equal((await fetch(`${console_.base}/api/state`)).status, 200);
  } finally {
    await console_.close();
  }
});

test('首页返回控制台 HTML（前端文件存在时）', async () => {
  const console_ = await withConsole(fakeSupervisor());
  try {
    const response = await fetch(console_.base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  } finally {
    await console_.close();
  }
});
