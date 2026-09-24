// 三项 UI 增强的验收：主题切换、滚动条、单任务开关。
//
// 单任务开关会真的改 config.json（把任务停用/启用），所以脚本先备份、结束时无条件还原，
// 并在还原后重启一次监控，让运行中的循环回到原配置。
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const CONFIG = 'config.json';
const BACKUP = 'data/config.ui-test-backup';
const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';

mkdirSync('data', { recursive: true });
copyFileSync(CONFIG, BACKUP);
const original = readFileSync(CONFIG, 'utf8');

const failures = [];
let browser;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** 页内对比度计算（WCAG 相对亮度）。 */
const CONTRAST_FN = `
  function parseRgb(text) {
    const m = /rgba?\\(([^)]+)\\)/.exec(text);
    if (!m) return null;
    const parts = m[1].split(',').map((v) => parseFloat(v));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(fgText, bgText) {
    const fg = parseRgb(fgText), bg = parseRgb(bgText);
    if (!fg || !bg) return null;
    const l1 = lum(fg), l2 = lum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  }
`;

try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'dark' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`未捕获异常: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/Failed to launch 'fleamarket:/i.test(message.text())) return;
    errors.push(`console.error: ${message.text()}`);
  });
  const toggles = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/toggle-task')) toggles.push(JSON.parse(request.postData() ?? '{}'));
  });

  // ---------- 一、主题切换 ----------
  console.log('\n【1】主题切换');
  // 概览路由：标题栏与统计卡都可见，正好用来比对两套主题的底色
  await page.goto(`${base}/#/overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  const themeOf = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const stylesOf = () =>
    page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const card = document.querySelector('.stat-card') || document.querySelector('.card');
      return { bodyBg: body.backgroundColor, bodyColor: body.color, cardBg: card ? getComputedStyle(card).backgroundColor : null };
    });

  check('默认跟随系统偏好（模拟暗色 → data-theme=dark）', (await themeOf()) === 'dark', await themeOf());
  const dark = await stylesOf();

  await page.click('#themeBtn');
  await page.waitForTimeout(500);
  check('点切换后变为亮色', (await themeOf()) === 'light', await themeOf());
  const light = await stylesOf();
  check('背景色确实变了', dark.bodyBg !== light.bodyBg, `${dark.bodyBg} → ${light.bodyBg}`);
  check('文字色确实变了', dark.bodyColor !== light.bodyColor, `${dark.bodyColor} → ${light.bodyColor}`);
  check(
    'localStorage 记住了选择',
    (await page.evaluate(() => localStorage.getItem('app-shell-theme'))) === 'light',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('刷新后仍是亮色（持久化生效）', (await themeOf()) === 'light', await themeOf());

  // 清掉手动选择后，应重新跟随系统偏好。
  // 用 reload 而不是 goto(base)：只改 hash 属于同文档导航，不会重跑 <head> 里的首屏脚本，
  // 而这条检查要测的正是「首屏」拿到的主题。
  await page.evaluate(() => localStorage.removeItem('app-shell-theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  check('未手动选择时首屏跟随系统亮色', (await themeOf()) === 'light', await themeOf());

  // ---------- 二、亮色主题可读性 ----------
  console.log('\n【2】亮色主题对比度');
  // 命中行在「命中」路由里，先切过去再量
  await page.goto(`${base}/#/hits`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const contrast = await page.evaluate(
    (fnSource) => {
      eval(fnSource);
      const panel = document.querySelector('.stat-card, .card, .hits') || document.body;
      const panelBg = getComputedStyle(panel).backgroundColor;
      const pick = (selector) => {
        const el = document.querySelector(selector);
        return el ? { text: getComputedStyle(el).color, size: getComputedStyle(el).fontSize } : null;
      };
      const targets = {
        正文: 'body',
        次要文字: '.muted',
        价格: '.hit-price',
      };
      const out = {};
      for (const [label, selector] of Object.entries(targets)) {
        const found = pick(selector);
        if (!found) continue;
        out[label] = contrast(found.text, panelBg);
      }
      return out;
    },
    CONTRAST_FN,
  );
  for (const [label, value] of Object.entries(contrast)) {
    check(`${label} 对比度 ≥ 4.5`, value === null || value >= 4.5, String(value));
  }

  // ---------- 三、滚动条 ----------
  console.log('\n【3】滚动条');
  const scrollbar = await page.evaluate(() => {
    let hasRule = false;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules || [])) {
        if (rule.selectorText && rule.selectorText.includes('::-webkit-scrollbar')) hasRule = true;
      }
    }
    return {
      hasRule,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
    };
  });
  check('存在 ::-webkit-scrollbar 规则', scrollbar.hasRule);
  check('color-scheme 跟随主题', scrollbar.colorScheme === 'light', scrollbar.colorScheme);
  check('设置了 scrollbar-color（Firefox）', Boolean(scrollbar.scrollbarColor) && scrollbar.scrollbarColor !== 'auto', scrollbar.scrollbarColor);

  // ---------- 四、单任务开关 ----------
  console.log('\n【4】单任务开关');
  await page.click('#themeBtn'); // 切回暗色，避免影响后续断言
  await page.waitForTimeout(400);
  // 任务卡在「任务」路由里
  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const taskName = JSON.parse(original).tasks[0].name;
  // 卡片上现在有两个开关（监控 / 推送），取「监控」那个
  const switchEl = page
    .locator('.cards .card')
    .first()
    .locator('.switch-group')
    .filter({ hasText: '监控' })
    .locator('.switch');
  check('卡片上有开关', (await switchEl.count()) === 1);

  // 不假设起始状态：脚本可能在任务已被停用（用户手动关掉）的情况下运行，
  // 所以按「当前值取反」来断言，跑完也会回到起始值。
  const startOn = (await switchEl.getAttribute('aria-checked')) === 'true';
  const cardText = () => page.locator('.cards .card').first().innerText();
  check(
    `三态标签与开关一致（初始 ${startOn ? '运行中' : '已停用'}）`,
    startOn ? /运行中/.test(await cardText()) : /已停用/.test(await cardText()),
    (await cardText()).split('\n').slice(0, 3).join(' / '),
  );

  await switchEl.click();
  await page.waitForTimeout(2500);
  check(`发出了 POST /api/toggle-task（目标 ${!startOn}）`, toggles.length === 1, JSON.stringify(toggles[0]));
  check('请求体正确', toggles[0]?.name === taskName && toggles[0]?.enabled === !startOn, JSON.stringify(toggles[0]));
  check('开关翻转', (await switchEl.getAttribute('aria-checked')) === String(!startOn));
  check(
    `卡片标签跟着翻（${startOn ? '已停用' : '已启用 · 未运行 / 运行中'}）`,
    startOn ? /已停用/.test(await cardText()) : /已启用|运行中/.test(await cardText()),
    (await cardText()).split('\n').slice(0, 3).join(' / '),
  );
  check('配置已写盘', JSON.parse(readFileSync(CONFIG, 'utf8')).tasks[0].enabled === !startOn);

  await switchEl.click();
  await page.waitForTimeout(2500);
  check('再次点击回到起始状态', (await switchEl.getAttribute('aria-checked')) === String(startOn));
  check('配置也回到起始状态', JSON.parse(readFileSync(CONFIG, 'utf8')).tasks[0].enabled === startOn);

  // 失败回滚：拦掉接口返回错误
  await page.route('**/api/toggle-task', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '测试用失败' }) }),
  );
  await switchEl.click();
  await page.waitForTimeout(1500);
  check('失败时开关回滚到原状', (await switchEl.getAttribute('aria-checked')) === String(startOn));
  check('失败时提示条给出原因', /测试用失败/.test(await page.evaluate(() => document.body.innerText)));
  await page.unroute('**/api/toggle-task');

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
