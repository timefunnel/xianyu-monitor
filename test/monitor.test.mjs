import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withDefaults } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { Monitor } from '../src/monitor.mjs';
import { SeenStore } from '../src/store.mjs';

const item = (overrides = {}) => ({
  id: '812345678901',
  title: 'MacBook Air M2 国行',
  price: 2999,
  area: '上海',
  seller: '闲置数码小铺',
  picUrl: null,
  url: 'https://www.goofish.com/item?id=812345678901',
  publishTime: Date.now(),
  ...overrides,
});

/** 构造一个按轮次返回固定结果的假浏览器，并在指定轮次后停止主循环。 */
function fakeBrowser(rounds, onRound) {
  let index = 0;
  return {
    calls: 0,
    async search() {
      const current = index;
      index += 1;
      this.calls += 1;
      const items = rounds[current] ?? [];
      const action = onRound?.(this.calls, items);
      if (action === 'stop') monitorRef.value?.stop();
      return { items, source: 'api', raw: null, requests: 2 };
    },
  };
}

// Monitor 在循环里会多次调用 search，这里保存引用以便在 search 内部触发停止。
const monitorRef = { value: null };

/** 运行若干轮后自动停止，返回捕获到的通知请求。 */
async function runRounds(
  rounds,
  {
    filters = { maxPrice: 3200 },
    maxPerCycle = 8,
    fetchStatus = 200,
    loggerLevel = 'error',
    notifyEnabled,
    taskNotify,
    channels,
    /** URL 里含任一片段的请求视为失败，用来构造"部分渠道挂了"。 */
    failUrls = [],
    logger,
  } = {},
) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const broken = fetchStatus >= 400 || failUrls.some((fragment) => String(url).includes(fragment));
    return { ok: !broken, status: broken ? 500 : 200, text: async () => (broken ? 'boom' : '') };
  };

  const config = withDefaults({
    notify: {
      channels: channels ?? [{ type: 'webhook', url: 'https://notify.invalid/hook' }],
      maxPerCycle,
      ...(notifyEnabled === undefined ? {} : { enabled: notifyEnabled }),
    },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0 },
    tasks: [
      {
        name: 't',
        keyword: 'MacBook Air M2',
        intervalSeconds: 1,
        jitterSeconds: 0,
        filters,
        ...(taskNotify === undefined ? {} : { notify: taskNotify }),
      },
    ],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-m-')), 'state.json') }).load();
  const browser = fakeBrowser(rounds, (call) => (call >= rounds.length ? 'stop' : undefined));
  /** 记入命中历史的商品（推送与静默两条路径都会走 onNotified；带 pushed 标记）。 */
  const recorded = [];
  const monitor = new Monitor({
    config,
    store,
    browser,
    logger: logger ?? createLogger({ level: loggerLevel }),
    onNotified: (entry, _task, options) => recorded.push({ id: entry.id, pushed: options?.pushed !== false }),
  });
  monitorRef.value = monitor;

  try {
    await monitor.run();
  } finally {
    globalThis.fetch = originalFetch;
    monitorRef.value = null;
  }
  return { requests, store, browser, recorded, config };
}

test('命中后推送一次，同一商品后续轮次不再重复推送', async () => {
  const { requests, store, browser } = await runRounds([[item()], [item()]]);
  assert.equal(browser.calls, 2, '应该跑满两轮');
  assert.equal(requests.length, 1, '只应推送一次');
  assert.equal(requests[0].body.title, '¥2999 · MacBook Air M2 国行');
  assert.ok(requests[0].body.body.includes('上海'), '元信息行应带地区');
  assert.equal(store.has('812345678901'), true);
});

test('总开关静默时不推送，但照常写去重表与命中历史', async () => {
  // 静默只是不发通知：一条都不能补推，否则重新打开开关会一次性炸出一堆历史商品。
  const { requests, store, recorded } = await runRounds([[item()], [item()]], { notifyEnabled: false });
  assert.equal(requests.length, 0, '不该发出任何推送');
  assert.equal(store.has('812345678901'), true, '要记进去重表，避免重新开启后补推');
  assert.deepEqual(recorded, [{ id: '812345678901', pushed: false }], '命中历史照常记录，并标明没有真推送');
});

test('单任务开关静默时同样只记账不推送', async () => {
  const { requests, store, recorded } = await runRounds([[item()], [item()]], { taskNotify: false });
  assert.equal(requests.length, 0);
  assert.equal(store.has('812345678901'), true);
  assert.deepEqual(recorded, [{ id: '812345678901', pushed: false }]);
});

test('两级开关是「与」的关系，任一为假都不推送', async () => {
  const masterOff = await runRounds([[item()]], { notifyEnabled: false, taskNotify: true });
  assert.equal(masterOff.requests.length, 0, '总开关关了就静默');

  const bothOn = await runRounds([[item()]], { notifyEnabled: true, taskNotify: true });
  assert.equal(bothOn.requests.length, 1, '两个都开着才推送');
});

test('静默期间的失败告警照常发送（别把故障一起瞒掉）', async () => {
  const errors = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    errors.push(init?.body ? JSON.parse(init.body) : null);
    return { ok: true, status: 200, text: async () => '' };
  };
  const config = withDefaults({
    notify: { channels: [{ type: 'webhook', url: 'https://notify.invalid/hook' }], enabled: false },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0 },
    tasks: [{ name: 't', keyword: 'x', intervalSeconds: 1, jitterSeconds: 0, filters: {} }],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-m-')), 'state.json') }).load();
  const browser = {
    async search() {
      const error = new Error('登录已失效');
      error.code = 'auth';
      throw error;
    },
  };
  const monitor = new Monitor({ config, store, browser, logger: createLogger({ level: 'error' }) });
  try {
    const runPromise = monitor.run();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    monitor.stop();
    await runPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(errors.length, 1, '静默的是商品推送，登录失效这类告警必须照发');
  assert.match(errors[0].title, /异常/);
});

test('累计计数写进状态文件，重启后接着算', async () => {
  const { store } = await runRounds([[item()], [item()]]);
  const totals = store.getTotals('t');
  assert.equal(totals.cycles, 2);
  assert.equal(totals.scanned, 2);
  assert.equal(totals.matched, 1, '同一商品只算一次命中');
  assert.equal(totals.notified, 1);
});

test('被过滤的商品不写入去重表，降价后仍能推送', async () => {
  const filtered = await runRounds([[item({ price: 9999 })]]);
  assert.equal(filtered.requests.length, 0);
  assert.equal(filtered.store.size, 0, '被过滤不等于已推送');

  const dropped = await runRounds([[item({ price: 9999 })], [item({ price: 2999 })]]);
  assert.equal(dropped.requests.length, 1, '第二轮降价后才命中');
  assert.ok(dropped.requests[0].body.title.includes('¥2999'));
});

test('所有渠道推送失败时不写去重表，下一轮重试', async () => {
  const { requests, store } = await runRounds([[item()], [item()]], { fetchStatus: 500 });
  assert.equal(requests.length, 2, '两轮各重试一次');
  assert.equal(store.size, 0, '失败不能被标记为已推送');
});

test('超过 maxPerCycle 的命中合并成一条汇总消息', async () => {
  const items = [item({ id: '100000000001' }), item({ id: '100000000002' }), item({ id: '100000000003' })];
  const { requests, store } = await runRounds([items, []], { maxPerCycle: 2 });
  assert.equal(requests.length, 3, '2 条即时 + 1 条汇总');
  assert.equal(requests[2].body.title, '还有 1 条命中 · t');
  assert.ok(requests[2].body.body.startsWith('· ¥2999 MacBook Air M2 国行'));
  assert.equal(store.size, 3, '汇总里的商品也要记为已推送');
});

test('关键词无结果时不会推送任何消息', async () => {
  const { requests, store } = await runRounds([[], []]);
  assert.equal(requests.length, 0);
  assert.equal(store.size, 0);
});

test('每轮都留下 info 摘要，连续空结果会告警一次', async () => {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await runRounds([[], [], [], [], [], []], { loggerLevel: 'info' });
  } finally {
    process.stdout.write = original;
  }
  const output = lines.join('');
  assert.ok(output.includes('第 1 轮：2 次请求，扫描 0 条（0 条带 App 直达链接），命中 0 条'), '每轮都应有摘要');
  assert.ok(output.includes('连续 5 轮扫描到 0 条'), '连续空结果应告警一次');
  assert.equal(output.split('连续 5 轮扫描到 0 条').length - 1, 1, '只告警一次，不刷屏');
});

/**
 * 用一个会抛指定错误的假浏览器跑若干轮，返回每轮的时间点与发出的通知。
 * @param {{code: string, message: string, rounds: number, maxBackoffSeconds?: number}} options
 */
async function runFailing({ code, message, rounds, maxBackoffSeconds = 2, riskControlCooldownSeconds = 2, extra = {} }) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push(init?.body ? JSON.parse(init.body) : {});
    return { ok: true, status: 200, text: async () => '' };
  };

  const config = withDefaults({
    notify: { channels: [{ type: 'webhook', url: 'https://notify.invalid/hook' }] },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0, failureAlertThreshold: 3, maxBackoffSeconds, riskControlCooldownSeconds },
    tasks: [{ name: 't', keyword: 'x', intervalSeconds: 1, jitterSeconds: 0, filters: {} }],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-f-')), 'state.json') }).load();

  const callTimes = [];
  const browser = {
    async search() {
      callTimes.push(Date.now());
      const error = new Error(message);
      error.code = code;
      // 有些错误要带附加信息（比如「刚刚复位了哪些 cookie」），主循环据此决定退避策略。
      Object.assign(error, extra);
      if (callTimes.length >= rounds) stopRef.value?.stop();
      throw error;
    },
  };
  const monitor = new Monitor({ config, store, browser, logger: createLogger({ level: 'error' }) });
  stopRef.value = monitor;

  try {
    await monitor.run();
  } finally {
    globalThis.fetch = originalFetch;
    stopRef.value = null;
  }
  return { requests, callTimes };
}

const stopRef = { value: null };

/** 造一个永远返回空结果、但会被记为一次请求的假浏览器。 */
function idleBrowser() {
  return {
    calls: 0,
    async search() {
      this.calls += 1;
      return { items: [], source: 'api', raw: [], requests: 1 };
    },
  };
}

/** 造一个两个任务、间隔 1 秒的监控器，用于验证单任务启停。 */
function twoTaskMonitor(intervalSeconds = 1) {
  const config = withDefaults({
    notify: { channels: [{ type: 'webhook', url: 'https://example.invalid/hook' }] },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0 },
    tasks: [
      { name: 'a', keyword: 'a', intervalSeconds, jitterSeconds: 0, filters: {} },
      { name: 'b', keyword: 'b', intervalSeconds, jitterSeconds: 0, filters: {} },
    ],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-two-')), 'state.json') }).load();
  const browser = idleBrowser();
  const monitor = new Monitor({ config, store, browser, logger: createLogger({ level: 'error' }) });
  return { monitor, browser };
}

test('一个任务都没启用时待命而不是退出（界面打开开关就能直接跑）', async () => {
  const config = withDefaults({
    notify: { channels: [{ type: 'webhook', url: 'https://example.invalid/hook' }] },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0 },
    tasks: [{ name: 't', keyword: 'x', intervalSeconds: 1, jitterSeconds: 0, enabled: false, filters: {} }],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-m-')), 'state.json') }).load();
  const browser = idleBrowser();
  const monitor = new Monitor({ config, store, browser, logger: createLogger({ level: 'error' }) });

  const runPromise = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(monitor.isTaskRunning('t'), false, '停用的任务不该跑');
  assert.equal(browser.calls, 0);

  // 运行期间把任务打开：应该直接把循环拉起来，不需要重启
  assert.equal(monitor.startTask({ ...config.tasks[0], enabled: true }), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(monitor.isTaskRunning('t'), true);
  assert.ok(browser.calls >= 1, '打开开关后应该开始抓取');

  monitor.stop();
  await runPromise;
});

test('全局请求间隔闸：跨任务的搜索会被拉开到最小间隔', async () => {
  // 单任务的 intervalSeconds 只约束它自己；多任务串行时总频率会叠加，
  // 几个 60 秒的任务就能凑到实测触发风控的「每分钟 3 次」量级。
  const config = withDefaults({
    notify: { channels: [{ type: 'webhook', url: 'https://notify.invalid/hook' }] },
    monitor: { notifyOnStart: false, heartbeatHours: 24, minRequestGapSeconds: 0.6 },
    tasks: [
      { name: 'a', keyword: 'a', intervalSeconds: 1, jitterSeconds: 0, filters: {} },
      { name: 'b', keyword: 'b', intervalSeconds: 1, jitterSeconds: 0, filters: {} },
    ],
  });
  const store = new SeenStore({ file: path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-gap-')), 'state.json') }).load();
  const started = [];
  const browser = {
    async search() {
      started.push(Date.now());
      return { items: [], source: 'api', raw: [], requests: 1 };
    },
  };
  const monitor = new Monitor({ config, store, browser, logger: createLogger({ level: 'error' }) });

  const runPromise = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 2600));
  monitor.stop();
  await runPromise;

  assert.ok(started.length >= 3, `应该发生多次搜索，实际 ${started.length} 次`);
  for (let index = 1; index < started.length; index += 1) {
    const gap = started[index] - started[index - 1];
    // 留一点调度误差：配置 600ms，实测不应低于 500ms
    assert.ok(gap >= 500, `第 ${index} 次与上一次只隔了 ${gap}ms，间隔闸没生效`);
  }
});

test('同时跑两个任务时，stop() 要把两个都唤醒', async () => {
  // 唤醒句柄曾经是共用的：两个任务同时等下一轮会互相覆盖，stop() 只能唤醒最后登记的那个，
  // 另一个要一直睡到间隔结束——间隔动辄几分钟，等于「停止」按钮没生效。
  const { monitor } = twoTaskMonitor(60);
  const runPromise = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(monitor.isTaskRunning('a'), true);
  assert.equal(monitor.isTaskRunning('b'), true);

  const stopStarted = Date.now();
  monitor.stop();
  await Promise.race([
    runPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop() 之后 run() 仍未结束，说明有任务没被唤醒')), 3000)),
  ]);
  assert.ok(Date.now() - stopStarted < 3000, '整体停止必须在秒级完成，而不是等满轮询间隔');
  assert.equal(monitor.isTaskRunning('a'), false);
  assert.equal(monitor.isTaskRunning('b'), false);
});

test('stopTask 只停指定任务，其它任务继续轮询', async () => {
  const { monitor } = twoTaskMonitor(1);
  const runPromise = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(monitor.stopTask('b'), true);
  assert.equal(monitor.isTaskRunning('a'), true, 'a 不该被牵连');
  assert.equal(monitor.isTaskRunning('b'), false);

  const cyclesOfA = monitor.stats.get('a').cycles;
  const cyclesOfB = monitor.stats.get('b').cycles;
  await new Promise((resolve) => setTimeout(resolve, 1300));

  assert.ok(monitor.stats.get('a').cycles > cyclesOfA, 'a 应该继续轮询');
  assert.equal(monitor.stats.get('b').cycles, cyclesOfB, 'b 停了就不该再有新轮次');

  monitor.stop();
  await runPromise;
});

test('stopTask 之后可以再 startTask 把它单独拉起来', async () => {
  const { monitor } = twoTaskMonitor(1);
  const runPromise = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 300));

  monitor.stopTask('a');
  assert.equal(monitor.isTaskRunning('a'), false);
  const task = monitor.config.tasks.find((entry) => entry.name === 'a');
  assert.equal(monitor.startTask(task), true, '重新启动应返回 true');
  assert.equal(monitor.isTaskRunning('a'), true);
  assert.equal(monitor.startTask(task), false, '已经在跑时不应重复启动');

  const cycles = monitor.stats.get('a').cycles;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(monitor.stats.get('a').cycles > cycles, '重新启动后要继续轮询');

  monitor.stop();
  await runPromise;
});

test('重复调用 run() 不会起第二套循环', async () => {
  const { monitor } = twoTaskMonitor(60);
  const first = monitor.run();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await monitor.run();
  assert.equal(monitor.controls.size, 2, '仍然只有两个任务控制块');
  monitor.stop();
  await first;
});

test('登录失效时第一次失败就告警，不等连续失败阈值', async () => {
  const { requests, callTimes } = await runFailing({ code: 'auth', message: '会话过期', rounds: 1 });
  assert.equal(callTimes.length, 1);
  assert.equal(requests.length, 1, 'auth 错误应立即告警');
  assert.match(requests[0].title, /异常/);
  assert.match(requests[0].body, /会话过期/);
});

test('筛选没生效时也立即告警：这种情况不会自己恢复', async () => {
  const { requests } = await runFailing({ code: 'filters-not-applied', message: '原生筛选没有生效', rounds: 1 });
  assert.equal(requests.length, 1, '筛选没生效应立即告警，而不是等连续失败 3 次');
  assert.match(requests[0].body, /原生筛选没有生效/);
});

test('被限流时直接进入最长冷却，而不是按间隔继续撞墙', async () => {
  const { requests, callTimes } = await runFailing({
    code: 'throttled',
    message: '被挤爆啦',
    rounds: 2,
    maxBackoffSeconds: 3,
  });
  assert.equal(callTimes.length, 2);
  const gap = callTimes[1] - callTimes[0];
  assert.ok(gap >= 2800, `两次请求间隔应接近冷却时长 3 秒，实际 ${gap}ms`);
  assert.equal(requests.length, 0, '未达阈值不应告警');
});

test('撞上风控时用专门的长时间退避，而不是普通的 5 分钟一直撞', async () => {
  // 风控验证在自动化窗口里过不了，重试没有意义还会加重风控，所以退避时长单独配置。
  // maxBackoffSeconds 故意设得比它小，用来说明「没用普通退避」。
  const { callTimes } = await runFailing({
    code: 'risk-control',
    message: '闲鱼弹出了风控验证（baxia 弹层）',
    rounds: 2,
    maxBackoffSeconds: 1,
    riskControlCooldownSeconds: 3,
  });
  assert.equal(callTimes.length, 2);
  const gap = callTimes[1] - callTimes[0];
  assert.ok(gap >= 2800, `两次尝试间隔应接近风控退避 3 秒（而不是普通退避 1 秒），实际 ${gap}ms`);
});

test('被直接拒绝但刚复位过 cookie 时，按正常间隔马上重试，不干等半小时', async () => {
  // 实测：复位掉被标记的 sgcookie 之后，下一轮就是一次**不同**的请求，立刻就能搜到。
  // 之前两种 denied 都走 riskControlCooldownSeconds，会把一次本可成功的自愈拖成半小时——
  // 而用户在半小时内早就把任务关了，于是"下一轮重试"永远不会发生。
  const { callTimes } = await runFailing({
    code: 'denied',
    message: '被直接拒绝',
    rounds: 2,
    riskControlCooldownSeconds: 3, // 长退避故意设短，用来证明它没被走
    extra: { droppedCookies: ['sgcookie'] },
  });

  assert.equal(callTimes.length, 2);
  const gap = callTimes[1] - callTimes[0];
  assert.ok(gap < 2800, `复位过 cookie 时不该走长退避，实际间隔 ${gap}ms`);
});

test('被直接拒绝且没有可复位的 cookie 时，才走长时间退避', async () => {
  const { callTimes } = await runFailing({
    code: 'denied',
    message: '被直接拒绝',
    rounds: 2,
    riskControlCooldownSeconds: 3,
    extra: { droppedCookies: [] },
  });

  const gap = callTimes[1] - callTimes[0];
  assert.ok(gap >= 2800, `没有可复位的东西说明重试无意义，应走长退避，实际 ${gap}ms`);
});

test('已知缺口：部分渠道失败时该商品仍被标记为已处理，失败的渠道不会再收到它', async () => {
  // 这条钉住的是**当前**行为，不是理想行为：去重是按「商品」记账的，所以「任一渠道成功」就记账，
  // 失败那个渠道永久收不到这条命中。改成「按渠道记账」时这条会失败——那正是回来更新它的信号。
  const logs = [];
  const logger = {
    info: (...args) => logs.push(args.join(' ')),
    warn: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
    debug: () => {},
  };

  const { store, requests } = await runRounds([[item()], [item()]], {
    channels: [
      { type: 'webhook', url: 'https://notify.invalid/ok' },
      { type: 'webhook', url: 'https://notify.invalid/broken' },
    ],
    failUrls: ['/broken'],
    logger,
  });

  assert.equal(requests.filter((entry) => entry.url.includes('/ok')).length, 1, '成功的渠道投递一次');
  assert.equal(requests.filter((entry) => entry.url.includes('/broken')).length, 1, '失败的渠道也尝试过');
  assert.equal(store.has('812345678901'), true, '当前行为：任一渠道成功就记为已处理');

  // 但至少不能撒谎：日志必须点名失败的渠道，而不是笼统地写「已推送」。
  const partial = logs.find((line) => /个渠道失败/.test(line));
  assert.ok(partial, `部分失败必须有明确的告警日志，实际日志：\n${logs.join('\n')}`);
  assert.match(partial, /1\/2 个渠道失败/);
  assert.match(partial, /webhook#1/, '同类型多渠道要带下标，否则分不清是哪一个');
  assert.match(partial, /不会再收到它/, '要说清后果，而不是只报个错');
});
