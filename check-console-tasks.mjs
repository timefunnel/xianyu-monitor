// 任务增删改的验收脚本：真机加载控制台，走一遍「编辑已有任务 → 新建 → 重启 → 删除」。
//
// 这个功能会真的改 config.json 并重启监控循环，所以脚本：
//   1. 先把 config.json 备份；
//   2. 往现有任务里塞一个「表单没有控件的字段」，验证编辑时不会被静默丢掉；
//   3. 结束时无条件还原配置，并再重启一次，让运行中的循环回到原配置。
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const CONFIG = 'config.json';
const BACKUP = 'data/config.ui-test-backup';
const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';
const CUSTOM_FIELD = 'myCustomField';

/** 表单没有控件、必须原样带过去的字段值。 */
const CUSTOM_VALUE = { keep: 'me', nested: [1, 2] };

mkdirSync('data', { recursive: true });
copyFileSync(CONFIG, BACKUP);
const original = readFileSync(CONFIG, 'utf8');

/** 给配置里的第一个任务塞一个未知字段，用来验证编辑不会丢字段。 */
const seeded = JSON.parse(original);
seeded.tasks[0][CUSTOM_FIELD] = CUSTOM_VALUE;
writeFileSync(CONFIG, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

const records = [];
const failures = [];
let browser;
let exitCode = 0;

/** 记录一条断言结果。 */
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  const errors = [];
  page.on('pageerror', (error) => errors.push(`未捕获异常: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // 桌面 Chrome 没注册 fleamarket:// 这个 scheme，点击商品行必然报这条；
    // 真机上由闲鱼 App 接管，属于预期行为，不计为缺陷。
    if (/Failed to launch 'fleamarket:/i.test(message.text())) return;
    errors.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (/\/api\/(tasks|restart)$/.test(request.url()) && request.method() === 'PUT') {
      records.push({ url: request.url(), body: JSON.parse(request.postData() ?? '{}') });
    }
  });

  // 任务卡片在「任务」路由里，默认路由是概览——直接打开根路径会点不到卡片。
  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const savedTasks = () => {
    const last = [...records].reverse().find((entry) => entry.url.endsWith('/api/tasks'));
    return last ? last.body.tasks : null;
  };

  // ---------- 1. 编辑已有任务：未知字段必须保留 ----------
  console.log('\n【1】编辑已有任务');
  const originalTask = seeded.tasks[0];
  const firstCard = () => page.locator('.cards .card').first();
  await firstCard().getByRole('button', { name: '编辑' }).click({ timeout: 8000 });
  await page.waitForTimeout(1500);

  const prefilled = await page.inputValue('#teName');
  check('编辑弹层预填了任务名', prefilled === originalTask.name, prefilled);
  check('预填了关键词', (await page.inputValue('#teKeyword')) === originalTask.keyword);
  check('预填了价格区间', (await page.inputValue('#tePriceMin')) === String(originalTask.nativeFilters.priceRange[0]));
  check('预填了地区', (await page.inputValue('#teRegion')) === originalTask.nativeFilters.region);
  check('预填了品牌白名单（逗号分隔）', (await page.inputValue('#teRequireKeywords')).includes('AOC'));

  // 只改关键词，其它一律不动
  const editedKeyword = `${originalTask.keyword} 测试`;
  await page.fill('#teKeyword', editedKeyword);
  await page.locator('.modal-wide').getByRole('button', { name: /保存/ }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);

  const afterEdit = savedTasks();
  check('发出了 PUT /api/tasks', Array.isArray(afterEdit));
  const edited = afterEdit?.[0];
  check('关键词已改', edited?.keyword === editedKeyword, edited?.keyword);
  check('未知字段被保留', JSON.stringify(edited?.[CUSTOM_FIELD]) === JSON.stringify(CUSTOM_VALUE), JSON.stringify(edited?.[CUSTOM_FIELD]));
  check('品牌白名单条数未变', edited?.filters?.requireKeywords?.length === originalTask.filters.requireKeywords.length);
  check('原生筛选未丢', edited?.nativeFilters?.region === originalTask.nativeFilters.region);

  // 改回原关键词，避免影响后续
  await firstCard().getByRole('button', { name: '编辑' }).click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.fill('#teKeyword', originalTask.keyword);
  await page.locator('.modal-wide').getByRole('button', { name: /保存/ }).first().click({ timeout: 8000 });
  await page.waitForTimeout(2500);
  check('已把关键词改回', savedTasks()?.[0]?.keyword === originalTask.keyword);

  // ---------- 2. 新建任务 ----------
  console.log('\n【2】新建任务');
  const testName = `ui-test-${Date.now()}`;
  await page.getByRole('button', { name: /新建任务|新建/ }).first().click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  check('新任务默认启用', await page.isChecked('#teEnabled'));
  check('新任务默认推送', await page.isChecked('#teNotify'));
  check('新任务默认间隔 120 秒', (await page.inputValue('#teInterval')) === '120');
  // 这个测试任务没有过滤条件，脚本最后会重启一次监控让它真的跑起来——若不禁用推送，
  // 它会把搜索页上所有商品（含「¥88000 老纸币」这类）真推到用户手机上，并堆进命中历史。
  await page.uncheck('#teNotify');
  check('已关掉测试任务的推送，避免污染真实命中历史', !(await page.isChecked('#teNotify')));
  check('高级筛选默认折叠', await page.locator('#taskAdv').evaluate((el) => !el.open).catch(() => true));
  // 高级区默认折叠，要填里面的字段得先展开。
  await page.locator('#taskAdv summary').first().click();
  await page.waitForTimeout(600);
  check('点开后高级区已展开', await page.locator('#taskAdv').evaluate((el) => el.open));

  await page.fill('#teName', testName);
  await page.fill('#teKeyword', 'UI 测试关键词');
  await page.fill('#tePriceMin', '300');
  await page.fill('#tePriceMax', '400');
  await page.fill('#teRegion', '上海');
  await page.fill('#teExcludeKeywords', ' 求购 , 同款 ,, ');
  await page.locator('.modal-wide').getByRole('button', { name: /保存/ }).first().click({ timeout: 8000 });
  await page.waitForTimeout(3000);

  const created = savedTasks()?.find((task) => task.name === testName);
  check('新任务写进了请求体', Boolean(created));
  check('数组字段按逗号切分并去空', JSON.stringify(created?.filters?.excludeKeywords) === JSON.stringify(['求购', '同款']), JSON.stringify(created?.filters?.excludeKeywords));
  check('价格区间已组装', JSON.stringify(created?.nativeFilters?.priceRange) === JSON.stringify([300, 400]));
  check('空字段被省略', created && !('cityContains' in (created.filters ?? {})), JSON.stringify(created?.filters));
  // 这条曾经漏掉过：表单读到了复选框，组装任务对象时却没写进 notify，于是取消勾选被静默丢弃。
  check('取消勾选的推送真的写进了任务对象', created?.notify === false, String(created?.notify));

  await page.waitForTimeout(2500);
  const afterCreate = await page.evaluate(() => document.body.innerText);
  check('卡片区立刻出现新任务', afterCreate.includes(testName));

  // ---------- 3. 即时生效 ----------
  console.log('\n【3】即时生效（不再需要重启）');
  const liveState = async () => (await (await fetch(`${base}/api/state`)).json()).tasks.find((task) => task.name === testName) ?? null;
  const live = await liveState();
  check('服务端已经有了这个任务', Boolean(live));
  check('且已经在跑，不需要重启', live?.running === true, `running=${live?.running}`);
  const cardText = await page.locator('.cards .card').filter({ hasText: testName }).first().innerText();
  check('卡片显示运行中', /运行中/.test(cardText), cardText.split('\n').slice(0, 3).join(' / '));
  check('没有「未生效 · 需重启」这类中间状态', !/未生效|需重启|待移除/.test(afterCreate));
  check('页面上不该再有「重启」按钮', (await page.getByRole('button', { name: /^重启$/ }).count()) === 0);

  // ---------- 4. 删除 ----------
  console.log('\n【4】删除测试任务（应立即停止抓取）');
  const card = page.locator('.cards .card').filter({ hasText: testName }).first();
  await card.getByRole('button', { name: '删除' }).click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  // 确认条就在卡片里，按钮文字是「确认删除」。用宽松的 /确认|删除/ 会点到命中历史那一行。
  await card.locator('.card-confirm').getByRole('button', { name: '确认删除' }).click({ timeout: 8000 });
  await page.waitForTimeout(3000);
  check('删除后保存里已无该任务', !savedTasks()?.some((task) => task.name === testName));
  check('删除后服务端也不再跑它', (await liveState()) === null);

  console.log('\n页面错误:', errors.length);
  for (const error of errors) console.log('  ✖', error);
  if (errors.length > 0) failures.push('页面有 JS 错误');
} catch (error) {
  console.log('脚本异常:', error.message);
  failures.push(error.message);
} finally {
  await browser?.close();
  // 无条件还原：这个脚本会真改用户配置，绝不能留下测试任务。
  writeFileSync(CONFIG, original, 'utf8');
  const restored = readFileSync(CONFIG, 'utf8') === original;
  console.log('\n配置已还原:', restored);
  if (restored) {
    rmSync(BACKUP, { force: true });
    // 任务改动是即时生效的，光还原文件不够：再按原配置写一次，让运行中的循环也回到原样
    // （否则测试任务会一直在后台抓取）。
    await fetch(`${base}/api/tasks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: JSON.parse(original).tasks }),
    })
      .then((response) => console.log('运行中的循环已回到原配置:', response.status))
      .catch((error) => console.log('恢复运行时失败，请检查任务列表:', error.message));
  } else {
    console.log('!! 还原失败，备份留在', BACKUP);
    failures.push('配置还原失败');
  }
}

console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
for (const failure of failures) console.log('  ✖', failure);
exitCode = failures.length === 0 ? 0 : 1;
process.exitCode = exitCode;
