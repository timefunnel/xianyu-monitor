// 临时验收脚本：用真实浏览器加载控制台，抓 JS 错误并点一次「测试通知」。
// 只访问控制台的本地接口，「测试通知」走 Bark、不碰闲鱼，因此不会消耗抓取配额。
import { chromium } from 'playwright';

const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
const warnings = [];
page.on('pageerror', (error) => errors.push(`未捕获异常: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  if (message.type() === 'warning') warnings.push(message.text());
});
page.on('requestfailed', (request) => errors.push(`请求失败: ${request.url()} ${request.failure()?.errorText}`));

try {
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  const text = await page.evaluate(() => document.body.innerText);
  const has = (needle) => text.includes(needle);

  console.log('页面文本长度:', text.length);
  console.log('  标题「闲鱼监控」:', has('闲鱼监控'));
  console.log('  会话状态:', ['登录正常', '登录失效', '会话未知', '未检查'].filter(has).join('/') || '未找到');
  console.log('  任务关键词:', has('2K') ? '有' : '未找到');
  console.log('  日志面板:', has('日志') ? '有' : '未找到');
  console.log('  按钮:', ['立即检查', '测试通知', '重新登录', '新建任务'].filter(has).join(' / '));

  // 服务生命周期不归页面管：监控随进程启动、随进程退出，页面上不该有启停/重启入口。
  for (const label of ['停止', '启动', '重启']) {
    if ((await page.getByRole('button', { name: new RegExp(`^${label}$`) }).count()) > 0) {
      errors.push(`页面上不该有「${label}」按钮`);
    }
  }
  console.log('  无启停/重启入口:', (await page.getByRole('button', { name: /^(启动|停止|重启)$/ }).count()) === 0 ? '是' : '否');

  // 点「测试通知」：只发 Bark，不消耗闲鱼配额，正好验证按钮 → 接口 → 通知整条链路。
  const button = page.getByRole('button', { name: /测试通知/ }).first();
  if ((await button.count()) === 0) {
    errors.push('页面上找不到「测试通知」按钮');
  } else {
    await button.click();
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => document.body.innerText);
    const ok = /成功|已发送|送达/.test(after);
    console.log('  点「测试通知」后的提示:', ok ? '出现成功提示' : '未见成功提示');
    if (!ok) errors.push('点「测试通知」后没有看到成功提示');
  }

  await page.screenshot({ path: 'data/console-screenshot.png', fullPage: true });
  console.log('  截图: data/console-screenshot.png');
} catch (error) {
  errors.push(`脚本异常: ${error.message}`);
} finally {
  await browser.close();
}

console.log('\n警告', warnings.length, '条', warnings.slice(0, 5));
console.log('错误', errors.length, '条');
for (const error of errors) console.log('  ✖', error);
process.exitCode = errors.length > 0 ? 1 : 0;
