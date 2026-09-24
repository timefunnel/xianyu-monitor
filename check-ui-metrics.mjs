// 界面度量：逐个路由量页面高度、横向溢出、超长文本、偏小按钮、最小字号。
//
// 布局改成了「外壳 + 多路由」，单屏预算也变成按路由核算，所以这里逐页跑一遍。
import { chromium } from 'playwright';

const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';
const ROUTES = ['overview', 'tasks', 'hits', 'logs', 'config'];

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];

for (const route of ROUTES) {
  await page.goto(`${base}/#/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);

  const metrics = await page.evaluate(() => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const overflow = Array.from(document.querySelectorAll('*'))
      .filter((el) => el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && visible(el))
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 24)} (${el.scrollWidth}>${el.clientWidth})`)
      .slice(0, 4);

    const longTexts = Array.from(document.querySelectorAll('div,span,p,li'))
      .filter((el) => el.children.length === 0 && visible(el) && (el.textContent || '').trim() !== '')
      .map((el) => {
        const text = (el.textContent || '').trim();
        const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
        return { len: text.length, lines: Math.round(el.getBoundingClientRect().height / lineHeight), cls: String(el.className).slice(0, 20) };
      })
      // 日志与代码块天生多行，只挑「本该一行却排了很多行」的文本块。
      .filter((entry) => entry.lines > 2 && !/log|mono|code/.test(entry.cls))
      .slice(0, 4);

    const smallButtons = Array.from(document.querySelectorAll('button'))
      .filter((el) => visible(el))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 12), w: Math.round(rect.width), h: Math.round(rect.height) };
      })
      .filter((entry) => entry.h < 30 || entry.w < 40);

    const fontSizes = Array.from(document.querySelectorAll('body *'))
      .filter((el) => visible(el) && (el.textContent || '').trim() !== '' && el.children.length === 0)
      .map((el) => parseFloat(getComputedStyle(el).fontSize))
      .filter((size) => Number.isFinite(size));

    return {
      pageHeight: document.body.scrollHeight,
      overflow,
      longTexts,
      smallButtons,
      minFont: fontSizes.length > 0 ? Math.min(...fontSizes) : null,
      title: document.getElementById('pageTitle')?.textContent ?? '',
    };
  });

  const okHeight = metrics.pageHeight <= 900;
  const ok = okHeight && metrics.overflow.length === 0 && metrics.longTexts.length === 0 && metrics.smallButtons.length === 0;
  console.log(`${ok ? '✔' : '✖'} ${route.padEnd(9)} 页面高 ${String(metrics.pageHeight).padStart(4)}px  最小字号 ${metrics.minFont}  标题「${metrics.title}」`);
  if (metrics.overflow.length > 0) console.log(`    横向溢出: ${metrics.overflow.join(' / ')}`);
  if (metrics.longTexts.length > 0) console.log(`    超过 2 行的文本: ${metrics.longTexts.map((entry) => `${entry.cls}(${entry.lines} 行)`).join(' / ')}`);
  if (metrics.smallButtons.length > 0) console.log(`    偏小按钮: ${metrics.smallButtons.map((entry) => `"${entry.label}" ${entry.w}x${entry.h}`).join(' / ')}`);
  if (!ok) problems.push(route);
}

// 窄屏横向滚动 + 页面长度
await page.setViewportSize({ width: 400, height: 800 });
for (const route of ['tasks', 'hits', 'config']) {
  await page.goto(`${base}/#/${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const narrow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth, tall: document.body.scrollHeight }));
  const noSideScroll = narrow.doc <= narrow.win + 1;
  // 窄屏允许纵向滚动，但主区域要有高度上限，否则长列表会把页面拉成几千像素
  const bounded = narrow.tall <= 2400;
  console.log(`窄屏 400px ${route.padEnd(8)} 文档宽 ${narrow.doc}/${narrow.win} ${noSideScroll ? '无横向滚动 ✔' : '有横向滚动 ✖'} | 页高 ${narrow.tall}px ${bounded ? '✔' : '✖ 过长'}`);
  if (!noSideScroll) problems.push(`窄屏横向滚动:${route}`);
  if (!bounded) problems.push(`窄屏页面过长:${route}`);
}

await browser.close();
console.log(`\n结果：${problems.length === 0 ? '五个路由全部通过' : `${problems.length} 项未通过：${problems.join(', ')}`}`);
process.exitCode = problems.length === 0 ? 0 : 1;
