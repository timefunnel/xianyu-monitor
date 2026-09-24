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

const calls = [];
/** 登录弹层要读的状态；测试中途会改它来模拟"二维码生成好了"。 */
const loginState = { active: false, qrUrl: '/api/login-qr.svg', qrSvg: null, status: null };
/** 真实 supervisor 把 login 暴露成属性（服务端 /api/login-qr.svg 直接从它取二维码），桩也照做。 */
const currentLogin = () => ({ ...loginState, qrReady: Boolean(loginState.qrSvg) });
const supervisor = {
  configPath,
  subscribe: () => () => {},
  get login() {
    return currentLogin();
  },
  snapshot: () => ({
    running: true,
    starting: false,
    session: 'valid',
    startedAt: Date.now(),
    seenCount: 0,
    lastError: null,
    hits: [{ id: '1', task: 't', title: 'AOC 27寸 2K 180Hz', price: 568, area: '上海', seller: 'b', url: 'https://www.goofish.com/item?id=1', appUrl: null, pushedAt: Date.now(), pushed: true }],
    // 二维码本体不进快照，只给标记（真实 supervisor 也是这么做的）。
    login: currentLogin(),
    notifyEnabled: true,
    channelTypes: CHANNEL_SCHEMA,
    tasks: [],
  }),
  check: async () => ({ ok: true, results: [] }),
  testNotify: async () => ({ ok: true, results: [{ type: 'bark', ok: true }] }),
  saveNotify: async () => ({ ok: true }),
  repushHit: async (id) => {
    calls.push(['repushHit', id]);
    return { ok: true, results: [{ type: 'bark', ok: true }] };
  },
  loginWithQr: async () => {
    loginState.active = true;
    return { ok: true, active: true };
  },
  cancelLogin: async () => {
    calls.push(['cancelLogin']);
    loginState.active = false;
    return { ok: true, cancelled: true };
  },
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
// 商品链接现在由**本机浏览器**直接打开（不再走服务端），所以这里必须把外部请求拦掉：
// 我们要验证的是"点了会开新标签"，而不是真去访问闲鱼。
const blocked = [];
await page.context().route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(base) || url.startsWith('data:')) return route.continue();
  // 记下被拦下的地址：请求真的发出去了才说明"点了会打开"，而弹窗本身会变成错误页，
  // 从它身上读不到目标 URL。
  blocked.push(url);
  return route.abort();
});
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
  // 视觉改动光靠断言看不出好坏，留一张图。
  await page.screenshot({ path: 'data/console-channels.png' }).catch(() => {});

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

  // 光有按钮不算数：点下去，请求要真的到服务端，并且给出提示。
  const repushBtn = page.locator('#hits .hit button', { hasText: '重推' }).first();
  // 美化不能牺牲可点区域：项目对按钮有 32×44 的下限（check-ui-metrics.mjs 会量）。
  const box = await repushBtn.boundingBox();
  check(box.width >= 44 && box.height >= 32, '重推的可点区域达标（≥44×32）', `${Math.round(box.width)}×${Math.round(box.height)}`);
  check((await repushBtn.locator('svg').count()) === 1, '重推带图标，和「打开」是同一套行内动作语言');

  await repushBtn.click();
  await page.waitForTimeout(700);
  const repushCalls = calls.filter((entry) => entry[0] === 'repushHit');
  check(repushCalls.length === 1 && repushCalls[0][1] === '1', '点「重推」把商品 id 发到了服务端', JSON.stringify(repushCalls));
  const toastText = await page.locator('.toast .toast-text').allInnerTexts();
  check(toastText.some((text) => /已重新推送/.test(text)), '重推成功后给出提示', toastText.join(' / ') || '(没有提示)');
  // setBusy 只改 <span>，图标不能被清掉；文案也要复原
  check(/重推/.test(await repushBtn.innerText()), '重推结束后文案复原');
  check((await repushBtn.locator('svg').count()) === 1, '重推结束后图标仍在');
  // 按钮必须吃掉 click，否则会连带触发整行的「打开商品」
  check(page.context().pages().length === 1, '点「重推」没有连带打开商品页', `${page.context().pages().length} 个标签页`);

  // 反过来：点整行**应该**打开商品（链接走本机浏览器，服务端那条路径已经删掉）
  await page.locator('#hits .hit').first().click();
  await page.waitForTimeout(600);
  const opened = page.context().pages().filter((entry) => entry !== page);
  check(opened.length === 1, '点整行会打开商品页', `${opened.length} 个新标签页`);
  check(
    blocked.some((url) => /goofish\.com\/item/.test(url)),
    '打开的是商品链接（请求已拦截，全程没碰闲鱼）',
    blocked.slice(-1)[0]?.slice(0, 60) ?? '(没有外部请求)',
  );
  await page.screenshot({ path: 'data/console-hits-repush.png' }).catch(() => {});

  // ---- 登录弹层：二维码没生成好之前不能显示「图裂」----
  await page.click('#loginBtn');
  await page.waitForTimeout(500);
  check(await page.locator('#loginMask').isVisible(), '点「重新登录」会打开扫码弹层');
  const srcWhilePending = await page.locator('#qrImg').getAttribute('src');
  check(srcWhilePending === null, '二维码没生成时不给 <img> 设 src（设了就是图裂）', String(srcWhilePending));
  check(await page.locator('#qrPlaceholder').isVisible(), '此时显示占位提示而不是图裂');
  check(/生成|启动/.test(await page.locator('#qrPlaceholder').innerText()), '占位文案要说清在等什么');

  // 服务端生成好之后（状态里 qrReady 变真），应显示真实二维码。
  // 主动拉一次状态并刷新二维码，不等定时器——否则这条断言会跟轮询节奏赛跑。
  loginState.qrSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#000"/></svg>';
  await page.evaluate(async () => {
    await refreshState();
    refreshQr();
  });
  await page.waitForTimeout(300);
  check((await page.locator('#qrImg').getAttribute('src')) !== null, '生成好之后设上了 src');
  check(await page.locator('#qrImg').isVisible(), '二维码显示出来了');
  check(!(await page.locator('#qrPlaceholder').isVisible()), '占位提示要收起来');

  // 关掉弹层就是取消：要告诉服务端别继续轮询
  await page.click('#loginClose');
  await page.waitForTimeout(300);
  check(calls.some((entry) => entry[0] === 'cancelLogin'), '关弹层会通知服务端取消登录');
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
