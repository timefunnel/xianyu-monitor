// 验证任务表单里新增的三个筛选字段能否真的存进 config.json。
//
// 全程只走本地 /api/tasks，不触发任何闲鱼请求。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:7788';
const CONFIG = 'config.json';
const original = readFileSync(CONFIG, 'utf8');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const readTask = () => JSON.parse(readFileSync(CONFIG, 'utf8')).tasks.find((t) => t.name === '2k-144hz-monitor');

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to launch 'fleamarket:/i.test(m.text())) errors.push(m.text());
  });

  await page.goto(`${base}/#/tasks`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);

  await page.locator('.cards .card').first().getByRole('button', { name: '编辑' }).click();
  await page.waitForTimeout(1200);

  // 展开高级筛选，找到三个新字段
  const advOpen = await page.locator('#taskAdv').evaluate((el) => el.open);
  if (!advOpen) {
    await page.locator('#taskAdv summary').first().click();
    await page.waitForTimeout(600);
  }

  check('表单里有「原生排序」字段', (await page.locator('#teSort').count()) === 1);
  check('表单里有「原生发布时间窗」字段', (await page.locator('#tePublishDays').count()) === 1);
  check('表单里有「卖家信用」字段', (await page.locator('#teSellerCredit').count()) === 1);

  await page.selectOption('#teSort', 'newest');
  await page.selectOption('#tePublishDays', '3');
  await page.selectOption('#teSellerCredit', '极好');
  console.log('  已把三个字段设为：最新发布 / 3 天内 / 极好');

  await page.locator('.modal-wide').getByRole('button', { name: /保存/ }).first().click();
  await page.waitForTimeout(3000);

  const task = readTask();
  check('排序存进了 nativeFilters.sort', task?.nativeFilters?.sort === 'newest', JSON.stringify(task?.nativeFilters));
  check('时间窗存进了 nativeFilters.publishDays', task?.nativeFilters?.publishDays === 3);
  check('信用存进了 filters.requireSellerCredit', task?.filters?.requireSellerCredit === '极好', JSON.stringify(task?.filters?.requireSellerCredit));
  check('原有的价格区间没被弄丢', JSON.stringify(task?.nativeFilters?.priceRange) === JSON.stringify([500, 700]));
  check('原有的品牌白名单没被弄丢', (task?.filters?.requireKeywords?.length ?? 0) === 36, String(task?.filters?.requireKeywords?.length));

  // 再打开一次，确认回填正确（存进去和读出来都要对）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.locator('.cards .card').first().getByRole('button', { name: '编辑' }).click();
  await page.waitForTimeout(1200);
  if (!(await page.locator('#taskAdv').evaluate((el) => el.open))) {
    await page.locator('#taskAdv summary').first().click();
    await page.waitForTimeout(600);
  }
  check('重新打开时排序回填正确', (await page.inputValue('#teSort')) === 'newest');
  check('重新打开时时间窗回填正确', (await page.inputValue('#tePublishDays')) === '3');
  check('重新打开时信用回填正确', (await page.inputValue('#teSellerCredit')) === '极好');

  // 清回空值也要能存进去（不能只进不出）
  await page.selectOption('#teSort', '');
  await page.selectOption('#tePublishDays', '');
  await page.selectOption('#teSellerCredit', '');
  await page.locator('.modal-wide').getByRole('button', { name: /保存/ }).first().click();
  await page.waitForTimeout(3000);
  const cleared = readTask();
  check('清空后 sort 已移除', !('sort' in (cleared?.nativeFilters ?? {})), JSON.stringify(cleared?.nativeFilters));
  check('清空后 publishDays 已移除', !('publishDays' in (cleared?.nativeFilters ?? {})));
  check('清空后 requireSellerCredit 已移除', !('requireSellerCredit' in (cleared?.filters ?? {})));

  console.log('\n页面错误:', errors.length);
  for (const e of errors) console.log('  ✖', e);
  if (errors.length) failures.push('页面有 JS 错误');
} catch (error) {
  console.log('脚本异常:', error.message);
  failures.push(error.message);
} finally {
  await browser?.close();
  writeFileSync(CONFIG, original, 'utf8');
  const restored = readFileSync(CONFIG, 'utf8') === original;
  console.log('\n配置已还原:', restored);
  // 表单改动是即时生效的，把运行时也改回去
  await fetch(`${base}/api/tasks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tasks: JSON.parse(original).tasks }),
  }).catch(() => {});
}

console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
for (const f of failures) console.log('  ✖', f);
process.exitCode = failures.length === 0 ? 0 : 1;
