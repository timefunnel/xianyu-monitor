// 推送开关（总开关 + 单任务）、命中行跳转链接、任务弹层关闭按钮的验收。
//
// 推送开关会真的改 config.json，所以先备份、结束时无条件还原并重启。
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const CONFIG = 'config.json';
const BACKUP = 'data/config.notify-test-backup';
const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

mkdirSync('data', { recursive: true });
copyFileSync(CONFIG, BACKUP);
const original = readFileSync(CONFIG, 'utf8');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const readConfig = () => JSON.parse(readFileSync(CONFIG, 'utf8'));
const taskName = JSON.parse(original).tasks[0].name;
/** 总开关操作前后要比对每个任务的 notify，确认它没被顺手改掉。 */
const taskNotifyBefore = JSON.parse(original).tasks.map((task) => task.notify);

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  const calls = [];
  page.on('pageerror', (error) => errors.push(`未捕获异常: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to launch 'fleamarket:/i.test(message.text())) return;
    errors.push(`console.error: ${message.text()}`);
  });
  page.on('request', (request) => {
    if (request.url().endsWith('/api/toggle-notify')) calls.push(JSON.parse(request.postData() ?? '{}'));
  });

  // ---------- 一、推送总开关 ----------
  console.log('\n【1】推送总开关');
  await page.goto(`${base}/#/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);

  const master = page.locator('#notifySwitch');
  check('标题栏有推送总开关', (await master.count()) === 1);
  check('默认是开启状态', (await master.getAttribute('aria-pressed')) === 'true');
  const iconOn = await master.locator('.ico').innerHTML();

  await master.click();
  await page.waitForTimeout(2500);
  check('发出了 POST /api/toggle-notify', calls.length === 1, JSON.stringify(calls[0]));
  check('请求体只带 enabled（总开关）', calls[0]?.enabled === false && calls[0]?.name === undefined, JSON.stringify(calls[0]));
  check('按钮变为关闭', (await master.getAttribute('aria-pressed')) === 'false');
  check('图标换成了带斜杠的铃铛', (await master.locator('.ico').innerHTML()) !== iconOn);
  check('配置写进了 notify.enabled', readConfig().notify?.enabled === false);
  // 总开关只写 notify.enabled，不该顺手改动每个任务的 notify（两级各自独立）。
  // 注意不能断言「任务上没有 notify 字段」——表单保存本来就会写入它，所以只比对前后是否变化。
  check(
    '没动每个任务的字段（两级各自独立）',
    JSON.stringify(readConfig().tasks.map((task) => task.notify)) === JSON.stringify(taskNotifyBefore),
    `${JSON.stringify(taskNotifyBefore)} → ${JSON.stringify(readConfig().tasks.map((task) => task.notify))}`,
  );

  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('单任务开关置灰，表示被总开关压住', (await page.locator('.switch-group.is-overridden').count()) >= 1);

  // 总开关关着时，任务级开关仍可点，只是当前不生效
  await page.goto(`${base}/#/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.locator('#notifySwitch').click();
  await page.waitForTimeout(2500);
  check('再点一次恢复开启', (await page.locator('#notifySwitch').getAttribute('aria-pressed')) === 'true');
  check('配置恢复 notify.enabled=true', readConfig().notify?.enabled === true);

  // ---------- 二、单任务推送开关 ----------
  console.log('\n【2】单任务推送开关');
  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const card = page.locator('.cards .card').first();
  const notifyGroup = card.locator('.switch-group').filter({ hasText: '推送' });
  const notifySwitch = notifyGroup.locator('.switch');
  check('卡片上两个开关各带标签（监控 / 推送）', (await card.locator('.switch-group').count()) === 2, `${await card.locator('.switch-group').count()} 个`);
  check('推送开关默认打开', (await notifySwitch.getAttribute('aria-checked')) === 'true');

  const before = calls.length;
  await notifySwitch.click();
  await page.waitForTimeout(2500);
  const perTask = calls.slice(before);
  check('请求体带 name（单任务）', perTask[0]?.name === taskName && perTask[0]?.enabled === false, JSON.stringify(perTask[0]));
  check('开关变为关闭', (await notifySwitch.getAttribute('aria-checked')) === 'false');
  check('配置写进了 task.notify', readConfig().tasks[0].notify === false);
  check('总开关不受影响', readConfig().notify?.enabled !== false);

  await notifySwitch.click();
  await page.waitForTimeout(2500);
  check('再次点击恢复', (await notifySwitch.getAttribute('aria-checked')) === 'true');
  check('配置恢复 task.notify=true', readConfig().tasks[0].notify === true);

  // 失败回滚
  await page.route('**/api/toggle-notify', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '测试用失败' }) }),
  );
  await notifySwitch.click();
  await page.waitForTimeout(1500);
  check('失败时开关回滚', (await notifySwitch.getAttribute('aria-checked')) === 'true');
  check('失败时提示条给出原因', /测试用失败/.test(await page.evaluate(() => document.body.innerText)));
  await page.unroute('**/api/toggle-notify');

  // ---------- 三、命中行跳转链接 ----------
  console.log('\n【3】命中行跳转链接（按设备分别处理）');
  const stubOpen = () =>
    page.evaluate(() => {
      window.__opened = [];
      window.open = (url) => {
        window.__opened.push(String(url));
        return null;
      };
    });

  await page.goto(`${base}/#/hits`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // 概览页的「最近命中」也是 .hit，必须限定到命中路由的容器，否则会匹配到隐藏元素
  check('命中历史有数据', (await page.locator('#hits .hit').count()) > 0, `${await page.locator('#hits .hit').count()} 条`);
  await stubOpen();
  await page.locator('#hits .hit').first().click();
  await page.waitForTimeout(600);
  const desktopTarget = (await page.evaluate(() => window.__opened))[0] ?? '';
  check('桌面点开的是网页链接（fleamarket:// 在桌面打不开）', desktopTarget.startsWith('https://'), desktopTarget.slice(0, 60));
  check('桌面路径不再尝试唤 App', !desktopTarget.startsWith('fleamarket://'));

  // 手机 UA：应该优先用 App 深链
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: MOBILE_UA,
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(`${base}/#/hits`, { waitUntil: 'domcontentloaded' });
  await mobilePage.waitForTimeout(2500);
  await mobilePage.evaluate(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  await mobilePage.locator('#hits .hit').first().click();
  await mobilePage.waitForTimeout(600);
  const mobileTarget = (await mobilePage.evaluate(() => window.__opened))[0] ?? '';
  const hasAppLink = await mobilePage.evaluate(() => Boolean(document.querySelector('.hit')) && true);
  check('手机点开的是 App 深链', mobileTarget.startsWith('fleamarket://') || mobileTarget.startsWith('https://'), mobileTarget.slice(0, 60));
  check('手机上没有多余的「网页」次级按钮', (await mobilePage.locator('.hit-alt').count()) === 0, String(hasAppLink));
  await mobileContext.close();

  // ---------- 四、任务弹层关闭按钮 ----------
  console.log('\n【4】任务弹层关闭按钮');
  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  await page.locator('#taskNewBtn').click();
  await page.waitForTimeout(900);
  const closeBtn = await page.evaluate(() => {
    const el = document.getElementById('taskX');
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      cls: el.className,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      radius: style.borderTopLeftRadius,
      background: style.backgroundColor,
      borderStyle: style.borderTopStyle,
      color: style.color,
      svg: el.querySelectorAll('svg').length,
    };
  });
  check('用的是弹层专用类，不再复用提示条的 toast-close', closeBtn.cls === 'modal-close', closeBtn.cls);
  check('尺寸 32×32', closeBtn.w === 32 && closeBtn.h === 32, `${closeBtn.w}×${closeBtn.h}`);
  check('有圆角与透明的初始底色（不再是浏览器默认按钮）', closeBtn.radius === '8px' && closeBtn.background === 'rgba(0, 0, 0, 0)', `${closeBtn.radius} / ${closeBtn.background}`);
  check('图标是描边 SVG，不是字形', closeBtn.svg === 1);

  // 悬停有反馈
  await page.locator('#taskX').hover();
  await page.waitForTimeout(300);
  const hovered = await page.evaluate(() => getComputedStyle(document.getElementById('taskX')).backgroundColor);
  check('悬停有背景反馈', hovered !== 'rgba(0, 0, 0, 0)', hovered);

  // 点关闭真的能关掉
  await page.locator('#taskX').click();
  await page.waitForTimeout(700);
  check('点关闭后弹层消失', await page.locator('#taskMask').isHidden());

  console.log('\n页面错误:', errors.length);
  for (const error of errors) console.log('  ✖', error);
  if (errors.length > 0) failures.push('页面有 JS 错误');
} catch (error) {
  console.log('脚本异常:', error.message);
  failures.push(error.message);
} finally {
  await browser?.close();
  writeFileSync(CONFIG, original, 'utf8');
  const restored = readFileSync(CONFIG, 'utf8') === original;
  console.log('\n配置已还原:', restored);
  if (restored) {
    rmSync(BACKUP, { force: true });
    // 任务/推送改动是即时生效的，光还原文件不够：再按原配置写一次，让运行中的循环也回去。
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
process.exitCode = failures.length === 0 ? 0 : 1;
