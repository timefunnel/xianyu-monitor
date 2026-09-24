import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Supervisor } from '../src/supervisor.mjs';
import { withDefaults } from '../src/config.mjs';
import { SeenStore } from '../src/store.mjs';

/** 造一个把状态文件放在临时目录的配置。 */
function makeConfig(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-sup-'));
  const config = withDefaults({
    // 单测**绝不能有机会发真实请求**，靠两条保证：
    //   1. 这里不创建 cookie 文件——直连搜索器没有 cookie 时会直接返回 invalid / 抛 auth，
    //      一个请求都不发（见 mtop.mjs 与 mtop.test.mjs 的「没有 cookie」用例）；
    //   2. 需要搜索器的地方一律注入假的（createSearcher），登录流程也要注入 qrLogin。
    notify: { channels: [{ type: 'webhook', url: 'https://example.invalid/hook' }] },
    tasks: [{ name: 't', keyword: '显示器', intervalSeconds: 180, filters: { maxPrice: 700 } }],
    ...overrides,
  });
  config.storage.stateFile = path.join(dir, 'state.json');
  return config;
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * 假 Monitor：只实现 Supervisor 差异逻辑用到的那部分接口（含 controls 这个 Map），
 * 并记录收到的动作，用来断言「哪些任务被启动/重启/停掉」。
 * @param {any[]} calls 动作记录数组。
 * @returns {any} 假 monitor。
 */
function fakeMonitor(calls) {
  const controls = new Map();
  return {
    controls,
    config: null,
    showTaskName: false,
    isTaskRunning: (name) => controls.get(name)?.running === true,
    startTask(task) {
      calls.push(['start', task.name]);
      controls.set(task.name, { task, running: true });
      return true;
    },
    stopTask(name) {
      if (!controls.has(name)) return false;
      calls.push(['stop', name]);
      controls.delete(name);
      return true;
    },
    restartTask(task) {
      calls.push(['restart', task.name]);
      controls.set(task.name, { task, running: true });
      return true;
    },
  };
}

function makeSupervisor(config = makeConfig()) {
  const configPath = path.join(path.dirname(config.storage.stateFile), 'config.json');
  writeFileSync(configPath, '{}\n', 'utf8');
  return new Supervisor({ config, configPath, logger: silentLogger });
}

test('初始快照是未运行、未检查状态', () => {
  const state = makeSupervisor().snapshot();
  assert.equal(state.running, false);
  assert.equal(state.session, 'unchecked');
  assert.equal(state.seenCount, 0);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].keyword, '显示器');
  assert.equal(state.tasks[0].stats.cycles, 0);
  assert.match(state.tasks[0].filtersSummary, /价格/);
});

test('订阅者能收到广播，取消订阅后不再收到', () => {
  const supervisor = makeSupervisor();
  const seen = [];
  const unsubscribe = supervisor.subscribe((event) => seen.push(event.type));
  supervisor.publish({ type: 'log' });
  unsubscribe();
  supervisor.publish({ type: 'state' });
  assert.deepEqual(seen, ['log']);
});

test('单个订阅者抛错不影响其它订阅者', () => {
  const supervisor = makeSupervisor();
  const seen = [];
  supervisor.subscribe(() => {
    throw new Error('这个订阅者坏了');
  });
  supervisor.subscribe((event) => seen.push(event.type));
  supervisor.publish({ type: 'hit' });
  assert.deepEqual(seen, ['hit']);
});

test('命中历史从磁盘读取，并按最新在前返回', () => {
  const config = makeConfig();
  writeFileSync(
    path.join(path.dirname(config.storage.stateFile), 'hits.json'),
    JSON.stringify([
      { id: '1', title: '旧', pushedAt: 1 },
      { id: '2', title: '新', pushedAt: 2 },
    ]),
    'utf8',
  );
  const { hits } = makeSupervisor(config).snapshot();
  assert.deepEqual(
    hits.map((hit) => hit.id),
    ['2', '1'],
  );
});

test('命中历史损坏时从空表启动，不影响服务', () => {
  const config = makeConfig();
  writeFileSync(path.join(path.dirname(config.storage.stateFile), 'hits.json'), '{ 不是数组', 'utf8');
  assert.deepEqual(makeSupervisor(config).snapshot().hits, []);
});

test('saveConfig 拒绝非法配置并列出问题，合法配置才落盘', async () => {
  const supervisor = makeSupervisor();
  const bad = await supervisor.saveConfig({ tasks: [], notify: { channels: [] } });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length > 0);

  const good = {
    notify: { channels: [{ type: 'bark', key: 'k' }] },
    tasks: [{ name: 'n', keyword: '显示器', intervalSeconds: 180 }],
  };
  assert.deepEqual(await supervisor.saveConfig(good), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(supervisor.configPath, 'utf8')).tasks[0].keyword, '显示器');
});

test('saveConfig 对结构完全不对的输入也只返回问题列表', async () => {
  const supervisor = makeSupervisor();
  const result = await supervisor.saveConfig({ tasks: '不是数组' });
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > 0);
});

test('setTaskEnabled 写回配置；监控没在跑时只改配置', async () => {
  const config = makeConfig();
  const supervisor = makeSupervisor(config);
  writeFileSync(
    supervisor.configPath,
    JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks: [{ name: 't', keyword: '显示器', enabled: true }] }),
    'utf8',
  );

  const result = await supervisor.setTaskEnabled('t', false);
  assert.deepEqual(result, { ok: true, running: false }, '监控没在跑时 running 应为 false');
  const saved = JSON.parse(readFileSync(supervisor.configPath, 'utf8'));
  assert.equal(saved.tasks[0].enabled, false, '选择要留住，重启后依然生效');
  assert.deepEqual(saved.notify.channels, [{ type: 'bark', key: 'k' }], '别处的配置不能被覆盖');
  assert.equal(supervisor.config.tasks[0].enabled, false, '内存里的任务对象也要同步');
});

test('setTaskEnabled 在监控运行时立刻启停该任务', async () => {
  const config = makeConfig();
  const supervisor = makeSupervisor(config);
  writeFileSync(
    supervisor.configPath,
    JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks: [{ name: 't', keyword: '显示器', enabled: false }] }),
    'utf8',
  );
  const calls = [];
  supervisor.monitor = fakeMonitor(calls);

  assert.deepEqual(await supervisor.setTaskEnabled('t', true), { ok: true, running: true });
  assert.deepEqual(calls, [['start', 't']], '启用时要真的把循环拉起来，而不是等重启');

  assert.deepEqual(await supervisor.setTaskEnabled('t', false), { ok: true, running: false });
  assert.deepEqual(calls.at(-1), ['stop', 't']);
});

test('任务增删改即时生效：新增启动、修改重启、删除停止', async () => {
  const supervisor = makeSupervisor();
  const calls = [];
  const write = (tasks) =>
    writeFileSync(supervisor.configPath, JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks }), 'utf8');

  write([{ name: 'a', keyword: '原有任务', intervalSeconds: 120 }]);
  // 模拟进程启动：先读配置，再把启用的任务拉起来
  await supervisor.reloadConfig();
  supervisor.monitor = fakeMonitor(calls);
  supervisor.monitor.startTask(supervisor.config.tasks[0]);
  calls.length = 0;

  await supervisor.saveTasks([{ name: 'a', keyword: '原有任务', intervalSeconds: 120 }]);
  assert.deepEqual(calls, [], '定义没变就不该动循环');

  // 新增
  await supervisor.saveTasks([
    { name: 'a', keyword: '原有任务', intervalSeconds: 120 },
    { name: 'b', keyword: '新任务', intervalSeconds: 60 },
  ]);
  assert.deepEqual(calls.at(-1), ['start', 'b']);

  // 改关键词 → 用新定义重启
  calls.length = 0;
  await supervisor.saveTasks([
    { name: 'a', keyword: '改过的关键词', intervalSeconds: 120 },
    { name: 'b', keyword: '新任务', intervalSeconds: 60 },
  ]);
  assert.deepEqual(calls, [['restart', 'a']], '改了定义要重启循环');

  // 只改 notify 不该重启循环
  calls.length = 0;
  await supervisor.saveTasks([
    { name: 'a', keyword: '改过的关键词', intervalSeconds: 120, notify: false },
    { name: 'b', keyword: '新任务', intervalSeconds: 60 },
  ]);
  assert.deepEqual(calls, [], '推送开关是运行期动态读取的，不该重启抓取循环');
  assert.equal(supervisor.monitor.controls.get('a').task.notify, false, '循环手里的任务对象要换成新的');

  // 删除
  calls.length = 0;
  await supervisor.saveTasks([{ name: 'a', keyword: '改过的关键词', intervalSeconds: 120, notify: false }]);
  assert.deepEqual(calls, [['stop', 'b']], '删掉的任务要停掉循环');

  // 停用的任务不启动
  calls.length = 0;
  await supervisor.saveTasks([{ name: 'a', keyword: '改过的关键词', enabled: false }]);
  assert.deepEqual(calls, [['stop', 'a']]);
});

test('setTaskEnabled 拒绝非法参数与不存在的任务', async () => {
  const supervisor = makeSupervisor();
  writeFileSync(supervisor.configPath, JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks: [{ name: 't', keyword: 'k' }] }), 'utf8');

  assert.match((await supervisor.setTaskEnabled('', true)).error, /name 必填/);
  assert.match((await supervisor.setTaskEnabled('t', 'yes')).error, /布尔值/);
  assert.match((await supervisor.setTaskEnabled('不存在', true)).error, /没有这个任务/);
  assert.equal(JSON.parse(readFileSync(supervisor.configPath, 'utf8')).tasks[0].enabled, undefined, '失败的调用不该写坏配置');
});

test('setTaskEnabled 在配置文件损坏时返回错误而不是抛错', async () => {
  const supervisor = makeSupervisor();
  writeFileSync(supervisor.configPath, '{ 不是 JSON', 'utf8');
  const result = await supervisor.setTaskEnabled('t', false);
  assert.equal(result.ok, false);
  assert.match(result.error, /读取配置文件失败/);
});

test('snapshot 列出所有任务（含停用的），并分别标出是否在跑', () => {
  const config = makeConfig();
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), '{}\n', 'utf8');
  const supervisor = new Supervisor({ config, configPath: path.join(dir, 'config.json'), logger: silentLogger });
  supervisor.config.tasks.push({ name: '停用的', keyword: '停', intervalSeconds: 120, enabled: false });
  supervisor.monitor = { isTaskRunning: (name) => name === 't' };

  const { tasks } = supervisor.snapshot();
  assert.equal(tasks.length, 2, '停用的任务也要列出来，界面才能显示「已停用」');
  const running = tasks.find((task) => task.name === 't');
  const stopped = tasks.find((task) => task.name === '停用的');
  assert.deepEqual({ enabled: running.enabled, running: running.running }, { enabled: true, running: true });
  assert.deepEqual({ enabled: stopped.enabled, running: stopped.running }, { enabled: false, running: false });
});

test('setNotify 不带 name 切总开关、带 name 切单任务，并即时同步到内存配置', async () => {
  const config = makeConfig();
  const supervisor = makeSupervisor(config);
  writeFileSync(
    supervisor.configPath,
    JSON.stringify({
      notify: { channels: [{ type: 'bark', key: 'k' }] },
      tasks: [{ name: 't', keyword: '显示器' }],
    }),
    'utf8',
  );

  assert.deepEqual(await supervisor.setNotify({ enabled: false }), { ok: true, enabled: false });
  let saved = JSON.parse(readFileSync(supervisor.configPath, 'utf8'));
  assert.equal(saved.notify.enabled, false);
  assert.deepEqual(saved.notify.channels, [{ type: 'bark', key: 'k' }], '别处的配置不能被覆盖');
  assert.equal(supervisor.config.notify.enabled, false, '运行中的循环读的是内存配置，要立刻生效');
  assert.equal(saved.tasks[0].notify, undefined, '总开关不该顺手改每个任务的字段');

  assert.deepEqual(await supervisor.setNotify({ name: 't', enabled: false }), { ok: true, enabled: false });
  saved = JSON.parse(readFileSync(supervisor.configPath, 'utf8'));
  assert.equal(saved.tasks[0].notify, false);
  assert.equal(supervisor.config.tasks[0].notify, false);
});

test('setNotify 拒绝非法参数与不存在的任务', async () => {
  const supervisor = makeSupervisor();
  writeFileSync(supervisor.configPath, JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks: [{ name: 't' }] }), 'utf8');

  assert.match((await supervisor.setNotify({ enabled: 'yes' })).error, /布尔值/);
  assert.match((await supervisor.setNotify({ name: '不存在', enabled: true })).error, /没有这个任务/);
  assert.equal(JSON.parse(readFileSync(supervisor.configPath, 'utf8')).notify.enabled, undefined, '失败的调用不该写坏配置');
});

test('snapshot 暴露推送总开关与每个任务的推送开关', () => {
  const config = makeConfig();
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), '{}\n', 'utf8');
  const supervisor = new Supervisor({ config, configPath: path.join(dir, 'config.json'), logger: silentLogger });
  supervisor.config.notify.enabled = false;
  supervisor.config.tasks[0].notify = false;

  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.notifyEnabled, false);
  assert.equal(snapshot.tasks[0].notify, false);
});

test('停用的任务也显示持久化的累计计数，而不是全 0', () => {
  const config = makeConfig();
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), '{}\n', 'utf8');
  const seeded = new SeenStore({ file: config.storage.stateFile }).load();
  seeded.setTotals('t', { cycles: 12, scanned: 360, matched: 9, notified: 7 });
  seeded.save();

  const supervisor = new Supervisor({ config, configPath: path.join(dir, 'config.json'), logger: silentLogger });
  supervisor.store = new SeenStore({ file: config.storage.stateFile }).load();
  // 任务被停用：没有任何运行中的循环，this.stats 里也就没有它的条目
  supervisor.config.tasks[0].enabled = false;
  supervisor.stats = new Map();

  const task = supervisor.snapshot().tasks[0];
  assert.equal(task.running, false);
  assert.equal(task.stats.cycles, 12, '累计轮询要从状态文件里读出来');
  assert.equal(task.stats.notified, 7);
  assert.equal(task.stats.matched, 9);
});

test('监控从未启动时，也能读到持久化的累计计数与已记录条数', () => {
  // 会话失效会导致 start() 直接失败；那时 store 如果只在 start() 里创建，
  // 界面就会显示「已记录 0 条」和一堆 0，而状态文件里明明有数。
  const config = makeConfig();
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), '{}\n', 'utf8');
  const seeded = new SeenStore({ file: config.storage.stateFile }).load();
  seeded.add('1001');
  seeded.add('1002');
  seeded.setTotals('t', { cycles: 12, scanned: 360, matched: 9, notified: 7 });
  seeded.save();

  const supervisor = new Supervisor({ config, configPath: path.join(dir, 'config.json'), logger: silentLogger });
  const snapshot = supervisor.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.seenCount, 2, '已记录条数要从状态文件读出来');
  assert.equal(snapshot.tasks[0].stats.cycles, 12);
  assert.equal(snapshot.tasks[0].stats.notified, 7);
});

test('最近日志进环形缓冲，供新连接补发（SSE 自己不回溯）', () => {
  const supervisor = makeSupervisor();
  supervisor.publish({ type: 'log', level: 'info', message: '第一行' });
  supervisor.publish({ type: 'state' });
  supervisor.publish({ type: 'log', level: 'warn', message: '第二行' });

  assert.deepEqual(
    supervisor.recentLogs.map((event) => event.message),
    ['第一行', '第二行'],
    '只缓存日志，不缓存状态事件',
  );

  // 缓冲要有上限，不能一直涨
  for (let index = 0; index < 400; index += 1) {
    supervisor.publish({ type: 'log', message: `第 ${index} 行` });
  }
  assert.ok(supervisor.recentLogs.length <= 300, `缓冲应被裁剪，实际 ${supervisor.recentLogs.length}`);
  assert.equal(supervisor.recentLogs.at(-1).message, '第 399 行', '保留的是最新的');
});

test('saveTasks 只替换 tasks 段，别处的配置原样保留', async () => {
  const config = makeConfig();
  const supervisor = makeSupervisor(config);
  // 先把文件写成一份「有通知渠道、有控制台设置、有任务」的完整配置。
  writeFileSync(
    supervisor.configPath,
    JSON.stringify(
      {
        notify: { channels: [{ type: 'bark', key: 'k' }], maxPerCycle: 8 },
        web: { port: 9000, host: '127.0.0.1' },
        tasks: [{ name: '旧任务', keyword: '旧', intervalSeconds: 999 }],
      },
      null,
      2,
    ),
    'utf8',
  );

  const result = await supervisor.saveTasks([
    { name: '新任务', keyword: '显示器', intervalSeconds: 120, nativeFilters: { region: '江浙沪' } },
  ]);
  assert.deepEqual(result, { ok: true });

  const saved = JSON.parse(readFileSync(supervisor.configPath, 'utf8'));
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.tasks[0].name, '新任务');
  assert.deepEqual(saved.notify.channels, [{ type: 'bark', key: 'k' }], '通知渠道不能被任务保存覆盖');
  assert.equal(saved.notify.maxPerCycle, 8);
  assert.equal(saved.web.port, 9000, '控制台设置不能被任务保存覆盖');
});

test('saveTasks 校验不通过时不落盘', async () => {
  const supervisor = makeSupervisor();
  writeFileSync(supervisor.configPath, JSON.stringify({ notify: { channels: [{ type: 'bark', key: 'k' }] }, tasks: [{ name: 'n', keyword: 'k' }] }), 'utf8');

  const result = await supervisor.saveTasks([{ name: '缺关键词', intervalSeconds: 120 }]);
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('keyword')));

  const saved = JSON.parse(readFileSync(supervisor.configPath, 'utf8'));
  assert.equal(saved.tasks[0].name, 'n', '校验失败不该写进文件');
});

test('saveTasks 在配置文件损坏时返回问题而不是抛错', async () => {
  const supervisor = makeSupervisor();
  writeFileSync(supervisor.configPath, '{ 不是 JSON', 'utf8');
  const result = await supervisor.saveTasks([{ name: 'n', keyword: 'k' }]);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /读取配置文件失败/);
});

/** 造一个只实现控制台用得上的方法的假浏览器。 */
function fakeBrowser(items) {
  return {
    searched: 0,
    async search() {
      this.searched += 1;
      return { items, source: 'api', raw: [] };
    },
    async checkSession() {
      return 'valid';
    },
    async close() {},
  };
}

const sampleItem = (overrides = {}) => ({
  id: '1',
  title: 'AOC 27寸 2K 180Hz 显示器',
  price: 568,
  area: '上海',
  seller: '数码小铺',
  picUrl: null,
  url: 'https://www.goofish.com/item?id=1',
  appUrl: 'fleamarket://item?id=1',
  publishTime: null,
  ...overrides,
});

test('累计计数为空时按命中历史回填（否则会出现「已推送 0 条、历史一堆」）', async () => {
  const config = makeConfig();
  // 不关掉启动通知的话，start() 会去 fetch 那个不存在的 webhook，卡满通知超时。
  config.monitor.notifyOnStart = false;
  const dir = path.dirname(config.storage.stateFile);
  // start() 会从文件重新加载配置，必须写一份合法的，否则校验失败、store 根本不会建起来。
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  const now = Date.now();
  writeFileSync(
    path.join(dir, 'hits.json'),
    JSON.stringify([
      { id: '1', task: 't', title: 'a', pushedAt: now },
      { id: '2', task: 't', title: 'b', pushedAt: now },
      { id: '3', task: 't', title: 'c', pushedAt: now },
      { id: '4', task: '别的任务', title: 'd', pushedAt: now },
    ]),
    'utf8',
  );

  const supervisor = new Supervisor({
    config,
    configPath: path.join(dir, 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
  });
  try {
    await supervisor.start();
    // 历史里只有 3 条属于任务 t；轮询/扫描次数无法回溯，保持 0。
    assert.deepEqual(supervisor.store.getTotals('t'), { cycles: 0, scanned: 0, matched: 3, notified: 3 });
  } finally {
    await supervisor.stop();
  }
});

test('回填是单调取大：历史比计数多就补齐，但不会把已有的计数改小', async () => {
  const config = makeConfig();
  config.monitor.notifyOnStart = false;
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  writeFileSync(
    path.join(dir, 'hits.json'),
    JSON.stringify([
      { id: '1', task: 't', title: 'a', pushedAt: Date.now() },
      { id: '2', task: 't', title: 'b', pushedAt: Date.now() },
      { id: '3', task: 't', title: 'c', pushedAt: Date.now() },
    ]),
    'utf8',
  );
  // 计数已经被新版本写了一部分：轮询有值，但推送还没跟上历史
  const seeded = new SeenStore({ file: config.storage.stateFile }).load();
  seeded.setTotals('t', { cycles: 9, scanned: 270, matched: 1, notified: 1 });
  seeded.save();

  const supervisor = new Supervisor({
    config,
    configPath: path.join(dir, 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
  });
  try {
    await supervisor.start();
    const totals = supervisor.store.getTotals('t');
    assert.equal(totals.cycles, 9, '轮询次数无法回溯，保持原值');
    assert.equal(totals.notified, 3, '补齐到历史条数');
    assert.equal(totals.matched, 3, '命中不会少于推送');
  } finally {
    await supervisor.stop();
  }
});

test('静默期间记的账不算已推送', async () => {
  const config = makeConfig();
  config.monitor.notifyOnStart = false;
  const dir = path.dirname(config.storage.stateFile);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config), 'utf8');
  writeFileSync(
    path.join(dir, 'hits.json'),
    JSON.stringify([
      { id: '1', task: 't', title: 'a', pushedAt: Date.now(), pushed: true },
      { id: '2', task: 't', title: 'b', pushedAt: Date.now(), pushed: false },
      { id: '3', task: 't', title: 'c', pushedAt: Date.now(), pushed: false },
    ]),
    'utf8',
  );

  const supervisor = new Supervisor({
    config,
    configPath: path.join(dir, 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
  });
  try {
    await supervisor.start();
    const totals = supervisor.store.getTotals('t');
    assert.equal(totals.notified, 1, '只有真发出去的那条算推送');
    assert.equal(totals.matched, 1);
  } finally {
    await supervisor.stop();
  }
});

test('check 同时返回命中项与被过滤项，被过滤项带原因', async () => {
  const config = makeConfig();
  const browser = fakeBrowser([
    sampleItem({ id: '1', price: 568 }),
    sampleItem({ id: '2', title: '同款面板显示器', price: 568 }),
    sampleItem({ id: '3', price: 9999 }),
  ]);
  config.tasks[0].filters = { maxPrice: 700, excludeKeywords: ['同款'] };
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => browser,
  });

  const result = await supervisor.check();
  assert.equal(result.ok, true);
  const [entry] = result.results;
  assert.equal(entry.scanned, 3);
  assert.equal(entry.hits.length, 3, '逐条判定结果都要返回，界面才能解释为什么没推');

  const matched = entry.hits.filter((hit) => !hit.reasons);
  const skipped = entry.hits.filter((hit) => hit.reasons);
  assert.deepEqual(
    matched.map((hit) => hit.id),
    ['1'],
  );
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reasons.join('；'), /排除词/);
  assert.match(skipped[1].reasons.join('；'), /高于上限/);
  assert.equal(matched[0].appUrl, 'fleamarket://item?id=1');
  assert.equal(matched[0].alreadyPushed, false);
});

test('check 标出已经推送过的商品', async () => {
  const config = makeConfig();
  writeFileSync(config.storage.stateFile, JSON.stringify({ version: 1, seen: { 1: Date.now() } }), 'utf8');
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([sampleItem({ id: '1' })]),
  });

  const [entry] = (await supervisor.check()).results;
  assert.equal(entry.hits[0].alreadyPushed, true);
});

test('「重新登录」起一个纯 HTTP 的二维码会话，成功后把登录态落盘', async () => {
  // 这条盯的是：登录不再需要浏览器，而且**注入点存在**——默认的 qrLogin 会真的请求
  // passport.goofish.com，单测必须能把它换掉，否则跑测试就等于在打闲鱼的登录接口。
  const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-login-'));
  const cookieFile = path.join(dir, 'cookies.json');
  const config = makeConfig({ search: { cookieFile } });
  config.monitor.notifyOnStart = false;

  const seen = [];
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
    qrLogin: async ({ store, onQr }) => {
      seen.push(store.file);
      // 真实现会先给二维码，界面靠 onQr 拿到 SVG
      onQr({ codeContent: 'https://passport.goofish.com/qrcodeCheck.htm?lgToken=x', svg: '<svg/>', terminal: 'QR' });
      await store.save(
        new Map([
          ['unb', { name: 'unb', value: '2214928720161', domain: '.goofish.com', path: '/' }],
          ['cookie2', { name: 'cookie2', value: 'c2', domain: '.goofish.com', path: '/' }],
        ]),
      );
      return { ok: true, cookies: 2, missing: [] };
    },
  });

  const result = await supervisor.loginWithQr();
  assert.equal(result.ok, true);
  assert.equal(result.active, true, 'HTTP 路径是异步开始的，界面靠轮询看进度');
  assert.equal(supervisor.login.qrUrl, '/api/login-qr.svg', '二维码改由接口以 SVG 提供');
  await supervisor.loginPromise;

  assert.deepEqual(seen, [cookieFile], '登录态要写进配置里的 cookie 文件');
  assert.equal(existsSync(cookieFile), true, 'cookie 文件必须真的被创建');
  assert.equal(supervisor.session, 'valid');
  assert.equal(supervisor.snapshot().login.active, false, '流程结束后 active 要归位');
  assert.equal(supervisor.snapshot().login.qrSvg, null, '二维码用完就清掉，别一直挂在状态里');
});

test('登录失败时不覆盖原有的 cookie 文件，并给出可读的原因', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-login-bad-'));
  const cookieFile = path.join(dir, 'cookies.json');
  const config = makeConfig({ search: { cookieFile } });
  config.monitor.notifyOnStart = false;
  writeFileSync(cookieFile, JSON.stringify({ version: 1, cookies: [{ name: 'unb', value: 'good' }], refused: [] }), 'utf8');
  const before = readFileSync(cookieFile, 'utf8');

  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
    qrLogin: async () => ({ ok: false, cookies: 0, missing: ['unb'] }),
  });

  await supervisor.loginWithQr();
  await supervisor.loginPromise;

  assert.equal(readFileSync(cookieFile, 'utf8'), before, '登录没成功就不能动原来那份登录态');
  assert.match(supervisor.lastError, /unb/, '要说清缺什么');
  assert.equal(supervisor.snapshot().login.active, false);
});

test('check 在搜索器起不来时返回错误而不是抛出', async () => {
  const config = makeConfig();
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => {
      throw new Error('搜索器起不来');
    },
  });

  const result = await supervisor.check();
  assert.equal(result.ok, false);
  assert.match(result.error, /搜索器起不来/);
  assert.equal(supervisor.snapshot().lastError, '搜索器起不来');
});

test('开始登录不会停掉监控——纯 HTTP 登录和搜索互不干扰', async () => {
  // 回归：「点重新登录 → 关掉弹层 → 任务再也不跑」。
  // 根因是 loginWithQr 一进来就 stop()，而只有登录成功才会重新 start()。
  const config = makeConfig();
  config.monitor.notifyOnStart = false;
  // start() 会 reloadConfig()，所以配置得真的落在磁盘上（别的用 start() 的用例也都这么做）。
  writeFileSync(path.join(path.dirname(config.storage.stateFile), 'config.json'), JSON.stringify(config), 'utf8');
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
    qrLogin: async ({ signal }) => {
      // 模拟"等用户扫码"：一直等，直到被取消
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('登录已取消')));
      });
      return { ok: true, cookies: 1, missing: [] };
    },
  });

  try {
    const started = await supervisor.start();
    assert.equal(started.ok, true, `启动失败：${started.error}`);
    assert.equal(supervisor.snapshot().running, true);

    await supervisor.loginWithQr();
    assert.equal(supervisor.snapshot().running, true, '开始登录不该把监控停掉');
    assert.equal(supervisor.snapshot().login.active, true);
  } finally {
    await supervisor.stop();
  }
});

test('取消登录：中止轮询、清掉状态、不记错误，监控照常跑', async () => {
  const config = makeConfig();
  config.monitor.notifyOnStart = false;
  writeFileSync(path.join(path.dirname(config.storage.stateFile), 'config.json'), JSON.stringify(config), 'utf8');
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
    qrLogin: async ({ signal }) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('登录已取消')));
      });
      return { ok: true, cookies: 1, missing: [] };
    },
  });

  try {
    await supervisor.start();
    await supervisor.loginWithQr();
    assert.equal(supervisor.snapshot().login.active, true);

    const cancelled = supervisor.cancelLogin();
    assert.equal(cancelled.cancelled, true, '要真的取消掉一个进行中的流程');
    await supervisor.loginPromise;

    assert.equal(supervisor.snapshot().login.active, false, '取消后 active 要归位');
    assert.equal(supervisor.snapshot().login.qrSvg, null, '二维码要清掉，别继续挂在状态里');
    assert.equal(supervisor.snapshot().running, true, '取消后监控必须还在跑');
    assert.equal(supervisor.snapshot().lastError, null, '取消是用户主动行为，不该记成错误');
    assert.equal(supervisor.cancelLogin().cancelled, false, '没有流程在跑时取消是空操作');
  } finally {
    await supervisor.stop();
  }
});

test('取消后重新发起登录是可以的（不会卡在 active）', async () => {
  const config = makeConfig();
  config.monitor.notifyOnStart = false;
  let calls = 0;
  const supervisor = new Supervisor({
    config,
    configPath: path.join(path.dirname(config.storage.stateFile), 'config.json'),
    logger: silentLogger,
    createSearcher: async () => fakeBrowser([]),
    qrLogin: async ({ signal }) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('登录已取消')));
        });
      }
      return { ok: true, cookies: 1, missing: [] };
    },
  });

  try {
    config.search = { ...config.search };
    await supervisor.loginWithQr();
    supervisor.cancelLogin();
    await supervisor.loginPromise;

    const second = await supervisor.loginWithQr();
    assert.equal(second.ok, true, '取消之后必须还能再发一次');
    await supervisor.loginPromise;
    assert.equal(supervisor.snapshot().login.active, false);
    assert.equal(calls, 2);
  } finally {
    await supervisor.stop();
  }
});
