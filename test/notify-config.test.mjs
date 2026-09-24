// 通知渠道的结构化配置 + 命中历史手动重推。
//
// 这两块都是"界面直接改配置"的路径，所以要点在于：只动 notify 段、校验在保存前拦住、
// 以及手动重推不能被静默开关吃掉（那是用户明确点的一次按钮）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CHANNEL_SCHEMA, validateChannels } from '../src/notify.mjs';
import { Supervisor } from '../src/supervisor.mjs';
import { withDefaults } from '../src/config.mjs';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// ---------- 渠道字段定义与校验 ----------

test('CHANNEL_SCHEMA 覆盖了所有支持的渠道类型，且每种都有字段定义', () => {
  assert.deepEqual(
    CHANNEL_SCHEMA.map((entry) => entry.type).sort(),
    ['bark', 'dingtalk', 'serverchan', 'telegram', 'webhook', 'wecom'],
  );
  for (const entry of CHANNEL_SCHEMA) {
    assert.ok(entry.label, `${entry.type} 要有界面用的显示名`);
    assert.ok(entry.fields.length > 0, `${entry.type} 至少要有一个字段`);
    for (const field of entry.fields) assert.ok(field.key && field.label, `${entry.type} 的字段要有 key 和 label`);
  }
});

test('validateChannels 拦住缺必填字段与未知类型，放行合法配置', () => {
  assert.deepEqual(validateChannels([{ type: 'bark', key: 'abc' }]), []);

  // 缺必填：telegram 没有 chatId
  const missing = validateChannels([{ type: 'telegram', botToken: 'x' }]);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /chatId 必填/);

  // 未知类型要把可用值列出来，否则界面没法提示
  const unknown = validateChannels([{ type: '飞书' }]);
  assert.match(unknown[0], /不支持：飞书/);
  assert.match(unknown[0], /telegram/);

  assert.match(validateChannels([])[0], /非空数组/);
  assert.match(validateChannels('nope')[0], /非空数组/);

  // headers 是 JSON 字段：给了就必须是对象，不能是字符串
  assert.match(validateChannels([{ type: 'webhook', url: 'https://x.invalid', headers: '{}' }])[0], /必须是对象/);
});

// ---------- Supervisor：渠道保存 / 单渠道测试 / 手动重推 ----------

function makeSupervisor(channels = [{ type: 'webhook', url: 'https://hook.invalid/a' }]) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-notify-'));
  const configPath = path.join(dir, 'config.json');
  const raw = {
    notify: { channels },
    tasks: [{ name: 't', keyword: '显示器', intervalSeconds: 180, filters: {} }],
  };
  writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
  const config = withDefaults(raw);
  config.storage.stateFile = path.join(dir, 'state.json');
  const supervisor = new Supervisor({ config, configPath, logger: silentLogger });
  supervisor.hits = [];
  return { supervisor, configPath, raw, dir };
}

/** 临时替换 globalThis.fetch，记录请求体。 */
function captureFetch() {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, text: async () => '', json: async () => ({ code: 0 }) };
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}

test('saveNotify 只替换 notify 段，其余配置原样保留，并且热生效', async () => {
  const { supervisor, configPath } = makeSupervisor();
  const before = JSON.parse(readFileSync(configPath, 'utf8'));

  const result = await supervisor.saveNotify({ channels: [{ type: 'bark', key: 'k1' }] });

  assert.equal(result.ok, true, (result.problems ?? []).join('；'));
  const after = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.deepEqual(after.notify.channels, [{ type: 'bark', key: 'k1' }]);
  assert.deepEqual(after.tasks, before.tasks, 'tasks 不能被顺带改掉');
  // 热生效：Monitor 每次发送前读的是这个对象。
  assert.deepEqual(supervisor.config.notify.channels, [{ type: 'bark', key: 'k1' }]);
});

test('saveNotify 在校验不通过时不落盘', async () => {
  const { supervisor, configPath } = makeSupervisor();
  const before = readFileSync(configPath, 'utf8');

  const result = await supervisor.saveNotify({ channels: [{ type: 'telegram', botToken: 'x' }] });

  assert.equal(result.ok, false);
  assert.match(result.problems.join('；'), /chatId 必填/);
  assert.equal(readFileSync(configPath, 'utf8'), before, '校验失败就不能动文件');
});

test('saveNotify 可以单独切总开关，不动渠道', async () => {
  const { supervisor, configPath } = makeSupervisor();
  await supervisor.saveNotify({ enabled: false });

  assert.equal(supervisor.config.notify.enabled, false);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).notify.channels, [{ type: 'webhook', url: 'https://hook.invalid/a' }]);
});

test('testNotify 传单条渠道时只测它，而且半填的表单会被校验拦住、不发请求', async () => {
  const { supervisor } = makeSupervisor([{ type: 'webhook', url: 'https://hook.invalid/a' }]);
  const capture = captureFetch();
  try {
    const bad = await supervisor.testNotify({ type: 'bark' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /key 必填/);
    assert.equal(capture.requests.length, 0, '校验没过就一个请求都不该发');

    const good = await supervisor.testNotify({ type: 'webhook', url: 'https://unsaved.invalid/b' });
    assert.equal(good.ok, true);
    assert.equal(capture.requests.length, 1);
    assert.equal(capture.requests[0].url, 'https://unsaved.invalid/b', '测的应该是传进来的那条，而不是配置里的');
  } finally {
    capture.restore();
  }
});

test('repushHit 重推指定记录，标题带 [重推] 前缀', async () => {
  const { supervisor } = makeSupervisor();
  supervisor.hits = [
    { id: '1', task: 't', title: '旧的那条', price: 100, area: '上海', seller: 'a', url: 'https://www.goofish.com/item?id=1', appUrl: null, pushedAt: 1, pushed: true },
    { id: '2', task: 't', title: 'AOC 27寸 2K 180Hz', price: 568, area: '上海', seller: 'b', url: 'https://www.goofish.com/item?id=2', appUrl: null, pushedAt: 2, pushed: true },
  ];
  const capture = captureFetch();
  try {
    const result = await supervisor.repushHit('2');
    assert.equal(result.ok, true);
    assert.equal(capture.requests.length, 1);
    const message = capture.requests[0].body;
    // formatItem 把商品名放在**标题**行（`¥568 · <压缩后的商品名>`），正文是地区/卖家/时间。
    assert.match(message.title, /^\[重推\] ¥568 · /);
    assert.match(message.title, /AOC 27寸 2K 180Hz/);
    assert.match(message.body, /上海/);
    assert.equal(message.url, 'https://www.goofish.com/item?id=2');
  } finally {
    capture.restore();
  }
});

test('repushHit 不受两级静默开关影响——静默是别自动刷屏，不是禁止手动', async () => {
  const { supervisor } = makeSupervisor();
  supervisor.config.notify.enabled = false; // 总开关静默
  supervisor.config.tasks[0].notify = false; // 该任务也静默
  supervisor.hits = [{ id: '9', task: 't', title: 'x', price: 1, url: 'https://www.goofish.com/item?id=9', appUrl: null, pushedAt: 1 }];
  const capture = captureFetch();
  try {
    const result = await supervisor.repushHit('9');
    assert.equal(result.ok, true);
    assert.equal(capture.requests.length, 1, '手动重推必须真的发出去');
  } finally {
    capture.restore();
  }
});

test('repushHit 对不存在的记录给出可读的错误，且不发请求', async () => {
  const { supervisor } = makeSupervisor();
  supervisor.hits = [{ id: '1', task: 't', title: 'x', url: 'https://www.goofish.com/item?id=1', pushedAt: 1 }];
  const capture = captureFetch();
  try {
    const result = await supervisor.repushHit('404');
    assert.equal(result.ok, false);
    assert.match(result.error, /没有这条记录/);
    assert.equal(capture.requests.length, 0);
  } finally {
    capture.restore();
  }
});
