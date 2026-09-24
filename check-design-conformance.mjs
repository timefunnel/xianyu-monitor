// app-shell-ui（App Mode）交付清单的可执行版本。
//
// 检查的是「设计规范有没有落实」，不是功能正确性：强调色是否唯一、深色表面是否比画布亮、
// 圆角是否只在 8/12/16/999 里、内容区有没有混进 emoji、每个路由是否守得住单屏预算。
// 功能回归由 check-console*.mjs 负责。
import { chromium } from 'playwright';

const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';
const ROUTES = ['overview', 'tasks', 'hits', 'logs', 'config'];
const RADIUS_ALLOWED = [0, 8, 12, 16, 999];

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (/Failed to launch 'fleamarket:/i.test(message.text())) return;
  errors.push(message.text());
});

// ---------- 一、外壳结构 ----------
console.log('\n【一】外壳结构（L0 标题栏 / L1 侧边导航 / L2 内容画布）');
await page.goto(`${base}/#/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const shell = await page.evaluate(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    titlebar: box('.titlebar'),
    sidebar: box('.sidebar'),
    main: box('.main'),
    navItems: document.querySelectorAll('.nav-item').length,
    themeToggle: document.querySelectorAll('[data-theme-toggle]').length,
    hasWindow: Boolean(document.querySelector('.window')),
  };
});
check('存在窗口外壳 .window', shell.hasWindow);
check('标题栏横跨整宽', shell.titlebar?.w === 1280, `${shell.titlebar?.w}px`);
check('侧边栏 220–260px', shell.sidebar?.w >= 220 && shell.sidebar?.w <= 260, `${shell.sidebar?.w}px`);
check('内容画布占满剩余宽度', shell.main?.w === 1280 - (shell.sidebar?.w ?? 0), `${shell.main?.w}px`);
check('五个导航项', shell.navItems === 5, `${shell.navItems} 个`);
check('主题切换在 chrome 里且带 data-theme-toggle', shell.themeToggle === 1);

// ---------- 二、双主题与表面梯度 ----------
console.log('\n【二】双主题与表面梯度');
const readTheme = () =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const probe = (name) => {
      const span = document.createElement('span');
      span.style.color = cs.getPropertyValue(name).trim();
      document.body.appendChild(span);
      const rgb = getComputedStyle(span).color;
      span.remove();
      return rgb;
    };
    const lum = (rgb) => {
      const parts = /rgba?\(([^)]+)\)/.exec(rgb)[1].split(',').map(Number);
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(parts[0]) + 0.7152 * f(parts[1]) + 0.0722 * f(parts[2]);
    };
    const app = lum(probe('--bg-app'));
    const surface = lum(probe('--bg-surface'));
    return { theme: document.documentElement.getAttribute('data-theme'), app, surface, primary: probe('--primary') };
  });

const dark = await readTheme();
check('深色：卡片比画布亮（才浮得起来）', dark.surface > dark.app, `surface=${dark.surface.toFixed(3)} app=${dark.app.toFixed(3)}`);
check('深色：画布不是纯黑', dark.app > 0.005, `亮度 ${dark.app.toFixed(4)}`);

await page.click('#themeBtn');
await page.waitForTimeout(600);
const light = await readTheme();
check('切到亮色后 data-theme 变化', light.theme === 'light');
check('亮色：卡片比画布亮', light.surface > light.app, `surface=${light.surface.toFixed(3)} app=${light.app.toFixed(3)}`);
check('唯一强调色随主题切换（#007AFF ↔ #0A84FF）', dark.primary !== light.primary, `${dark.primary} → ${light.primary}`);
check('主题写入 localStorage', (await page.evaluate(() => localStorage.getItem('app-shell-theme'))) === 'light');

// ---------- 三、强调色唯一 ----------
console.log('\n【三】强调色唯一（按钮 / 开关 / 选中导航 / 链接）');
await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const accents = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const primary = cs.getPropertyValue('--primary').trim().toLowerCase();
  const toRgb = (text) => {
    const span = document.createElement('span');
    span.style.color = text;
    document.body.appendChild(span);
    const rgb = getComputedStyle(span).color;
    span.remove();
    return rgb;
  };
  const primaryRgb = toRgb(primary);
  const style = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };
  return {
    primaryRgb,
    navActive: style('.nav-item.is-active', 'color'),
    navActiveBg: style('.nav-item.is-active', 'backgroundColor'),
    brandMark: style('.brand-mark', 'color'),
    hitOpen: style('.hit-open', 'color'),
  };
});
check('选中导航的文字是强调色', accents.navActive === accents.primaryRgb, `${accents.navActive} vs ${accents.primaryRgb}`);
check('品牌标记用强调色', accents.brandMark === accents.primaryRgb);

// ---------- 四、内容区无 emoji ----------
console.log('\n【四】内容区无 emoji（图标一律描边 SVG）');
const emoji = await page.evaluate(() => {
  // 除了 emoji 本身，还要抓字形符号：箭头、几何图形（▶ ■ ●）、杂项技术符号（⏳）。
  // 这几个区间正是「图标被 textContent 冲掉、退回旧符号文案」时会露出来的地方。
  const re =
    /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const found = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (re.test(node.nodeValue || '')) found.push((node.nodeValue || '').trim().slice(0, 20));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // 只看可见内容：隐藏路由里的商品标题不算界面的文案。
    if (!visible(node)) return;
    for (const child of node.childNodes) walk(child);
  };
  walk(document.body);
  return found;
});
check('可见文本里没有 emoji', emoji.length === 0, emoji.join(' / '));

// 图标是内联 SVG：轮询逻辑若用 textContent 重写按钮，图标会被悄悄清掉，
// 而这一类退化只有对比「按钮里还有没有 svg」才看得出来。
await page.goto(`${base}/#/overview`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000); // 至少跨过一次 5 秒状态轮询
const iconless = await page.evaluate(() => {
  const ids = ['powerBtn', 'checkBtn', 'notifyBtn', 'loginBtn', 'restartBtn', 'themeBtn', 'notifySwitch', 'taskNewBtn'];
  return ids
    .map((id) => document.getElementById(id))
    .filter((el) => el && el.querySelectorAll('svg').length === 0)
    .map((el) => el.id);
});
check('轮询之后按钮仍带内联图标（没被 textContent 冲掉）', iconless.length === 0, iconless.join(' / '));

// ---------- 五、圆角阶梯 ----------
console.log('\n【五】圆角只取 8 / 12 / 16 / 999');
const radii = await page.evaluate(() => {
  const seen = new Map();
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    for (const raw of [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el).borderBottomRightRadius]) {
      // 去掉 50% 这类圆形写法：它算出来的像素值随尺寸变化，不属于圆角阶梯。
      if (raw.includes('%')) continue;
      const px = Math.round(parseFloat(raw) || 0);
      if (px > 0) seen.set(px, (seen.get(px) ?? 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
});
const badRadii = radii.filter(([px]) => !RADIUS_ALLOWED.includes(px));
check('没有阶梯外的圆角', badRadii.length === 0, badRadii.map(([px, n]) => `${px}px×${n}`).join(' / ') || radii.map(([px]) => `${px}px`).join(' '));

// ---------- 六、每个路由守住单屏 ----------
console.log('\n【六】单屏预算（1280×900 下不出现页面级滚动）');
for (const route of ROUTES) {
  await page.goto(`${base}/#/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const height = await page.evaluate(() => document.body.scrollHeight);
  check(`${route} 路由不超出视口`, height <= 900, `${height}px`);
}

// ---------- 七、卡片行内对齐 ----------
console.log('\n【七】任务卡行内垂直对齐');
await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2200);
const align = await page.evaluate(() => {
  const head = document.querySelector('.cards .card .card-head');
  if (!head) return null;
  const items = Array.from(head.querySelectorAll('.task-keyword,.task-interval,.switch,.task-state,.action-row'));
  const centers = items.map((el) => {
    const r = el.getBoundingClientRect();
    return Math.round(r.top + r.height / 2);
  });
  // 「一行」看高度：32px 左右就是单行；折行了会翻倍。
  return { centers, headHeight: Math.round(head.getBoundingClientRect().height) };
});
check('卡片头是单行', align ? align.headHeight <= 44 : false, `head 高 ${align?.headHeight}px`);
check('行内元素垂直中心一致', align ? Math.max(...align.centers) - Math.min(...align.centers) <= 1 : false, align?.centers.join(' / '));

console.log('\n页面错误:', errors.length);
for (const error of errors) console.log('  ✖', error);
if (errors.length > 0) failures.push('页面有 JS 错误');

await browser.close();
console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项未通过`}`);
for (const failure of failures) console.log('  ✖', failure);
process.exitCode = failures.length === 0 ? 0 : 1;
