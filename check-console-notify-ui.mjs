// 通知渠道界面 + 命中历史重推的验收：真浏览器、真 HTTP 服务，但**用桩 supervisor**，
// 所以既不碰闲鱼、也不启动监控浏览器，可以随时跑。
//
// 它盯的是几件光读代码看不出来的事：
//   * 动态渲染的字段有没有真的占满弹层宽度（`#channelFields` 少个 display:contents 就会缩成一半）
//   * 「取消」「右上角 X」能不能关掉弹层
//   * 密钥是不是脱敏显示、编辑时是否回填原值
//   * 命中行上有没有「重推」
//   * **前端新、服务端旧**（/api/state 里没有 channelTypes）时，界面给的是可读提示而不是空弹层
//
// 用法：node check-console-notify-ui.mjs
import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startWebConsole } from './src/server.mjs';
import { CHANNEL_SCHEMA } from './src/notify.mjs';

// 桩要给出一份**真实存在**的 config.json，否则 GET /api/config 会 500，
// 通知渠道区就渲染不出来——那样测的就不是用户看到的那个界面。
const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-ui-'));
const configPath = path.join(dir, 'config.json');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      notify: { channels: [{ type: 'bark', key: 'abc123def456ghi' }, { type: 'telegram', botToken: '123456:AAbb', chatId: '-100123' }] },
      tasks: [{ name: 't', keyword: '显示器', intervalSeconds: 180, filters: {} }],
      web: { port: 7788, host: '127.0.0.1', token: '', open: false },
      storage: { stateFile: path.join(dir, 'state.json') },
      browser: { userDataDir: path.join(dir, 'profile'), baseUrl: 'https://www.goofish.com' },
      monitor: {},
      linkTemplate: 'https://www.goofish.com/item?id={id}',
    },
    null,
    2,
  ),
  'utf8',
);

const supervisor = {
  configPath,
  subscribe: () => () => {},
  snapshot: () => ({
    running: true,
    starting: false,
    session: 'valid',
    startedAt: Date.now(),
    seenCount: 0,
    lastError: null,
    hits: [{ id: '1', task: 't', title: 'AOC 27寸 2K 180Hz', price: 568, area: '上海', seller: 'b', url: 'https://www.goofish.com/item?id=1', appUrl: null, pushedAt: Date.now(), pushed: true }],
    login: { active: false },
    notifyEnabled: true,
    channelTypes: CHANNEL_SCHEMA,
    tasks: [],
  }),
  check: async () => ({ ok: true, results: [] }),
  testNotify: async () => ({ ok: true, results: [{ type: 'bark', ok: true }] }),
  saveNotify: async () => ({ ok: true }),
  repushHit: async () => ({ ok: true, results: [{ type: 'bark', ok: true }] }),
  openItem: async () => ({ ok: true }),
  loginWithQr: async () => ({ ok: true }),
  setNotify: async () => ({ ok: true }),
  setTaskEnabled: async () => ({ ok: true }),
  saveTasks: async () => ({ ok: true }),
  saveConfig: async () => ({ ok: true }),
};

const console_ = await startWebConsole({ supervisor, port: 0, host: '127.0.0.1', token: '', logger: { info() {}, warn() {}, error() {} }, openBrowser: false });
const base = `http://127.0.0.1:${console_.port}`;
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push('console.error: ' + message.text());
});

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.click('.nav-item[data-route="config"]');
  await page.waitForTimeout(800);

  // 配置页：渠道卡片应该按配置渲染出来
  const cards = await page.locator('#channelList .card').count();
  check(cards === 2, '配置页渲染出 2 个渠道卡片', `实际 ${cards}`);
  const summary = await page.locator('#channelList .task-interval').first().innerText().catch(() => '');
  check(/abc1…/.test(summary), '密钥脱敏显示（只露头尾）', summary);

  // 走「编辑」打开弹层——和用户路径一致
  await page.locator('#channelList .card').first().locator('button', { hasText: '编辑' }).click();
  await page.waitForTimeout(300);
  check(await page.locator('#channelMask').isVisible(), '「编辑」能打开弹层');

  const fieldCount = await page.locator('#channelFields input, #channelFields textarea').count();
  check(fieldCount === 3, '按 schema 渲染出 Bark 的 3 个字段', `${fieldCount} 个`);
  const width = await page.locator('#channelFields input').first().evaluate((node) => Math.round(node.getBoundingClientRect().width)).catch(() => 0);
  const modalWidth = await page.locator('#channelMask .modal').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  check(width >= 360, '输入框宽度够用（≥360px）', `实际 ${width}px，弹层宽 ${modalWidth}px`);
  const prefilled = await page.locator('#cf-key').inputValue();
  check(prefilled === 'abc123def456ghi', '编辑时回填原值');

  // 取消
  await page.click('#channelFormCancel');
  await page.waitForTimeout(250);
  check(!(await page.locator('#channelMask').isVisible()), '「取消」能关掉弹层');

  // 右上角 X 也要能关
  await page.click('#channelAdd');
  await page.waitForTimeout(200);
  await page.click('#channelX');
  await page.waitForTimeout(250);
  check(!(await page.locator('#channelMask').isVisible()), '右上角 X 也能关掉弹层');

  // 重推按钮
  await page.click('.nav-item[data-route="hits"]');
  await page.waitForTimeout(600);
  const rows = await page.locator('#hits .hit').count();
  const repush = await page.locator('#hits .hit button', { hasText: '重推' }).count();
  check(rows === 1, '命中历史有 1 行', `实际 ${rows}`);
  check(repush === 1, '命中行上有「重推」按钮', `实际 ${repush}`);
  // ---- 老进程场景：前端新、服务端旧（/api/state 里没有 channelTypes）----
  const stale = { ...supervisor, snapshot: () => ({ ...supervisor.snapshot(), channelTypes: undefined }) };
  const staleConsole = await startWebConsole({ supervisor: stale, port: 0, host: '127.0.0.1', token: '', logger: { info() {}, warn() {}, error() {} }, openBrowser: false });
  try {
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page2.goto(`http://127.0.0.1:${staleConsole.port}/`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(900);
    await page2.click('.nav-item[data-route="config"]');
    await page2.waitForTimeout(700);
    const text = await page2.locator('#channelList').innerText();
    check(/channelTypes/.test(text), '老服务端下给出明确提示，而不是空区块', text.replace(/\s+/g, ' ').slice(0, 46));
    await page2.click('#channelAdd');
    await page2.waitForTimeout(250);
    check(!(await page2.locator('#channelMask').isVisible()), '字段定义缺失时不打开空弹层');
    await page2.close();
  } finally {
    await staleConsole.close();
  }
} finally {
  await browser.close();
  await console_.close();
}

if (errors.length > 0) {
  console.log('\n--- 浏览器报错 ---');
  for (const error of [...new Set(errors)]) console.log('  ' + error);
}
console.log(failures.length === 0 ? '\n全部通过。' : `\n失败 ${failures.length} 项：${failures.join('、')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
