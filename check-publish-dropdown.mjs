// 「新发布」下拉的可控验收：不碰闲鱼，用探针抓到的真实 DOM 结构跑一遍原生筛选的交互逻辑。
//
// 为什么要有它：选不中「最新」会让整轮以 filters-not-applied 结束（不推送任何商品），
// 而这类失效只有真机才暴露得出来——但真机每验证一次就要加载一次搜索页、消耗一次风控额度。
// 把结构固化成 fixture 之后，改选择器就能在这里先跑通。
//
// fixture 的元素层级、类名、文案都照抄探针抓到的实测结果（2026-09-24）：
//   search-select-container > search-select-title-container > span.search-select-title
//                            > search-select-items-container > div.search-select-item
// 关键一点：容器 div 的类名里也含 `search-select-title`，事件监听挂在容器上（靠冒泡），
// 所以"点容器"和"点 span"都能展开下拉——这正是老实现点错元素却看不出问题的原因。
//
// 用法：node check-publish-dropdown.mjs
import { chromium } from 'playwright';
import { applyPublishOptions } from './src/search.mjs';

const FIXTURE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>.search-select-items-container--pWk5bY4P { display: none; }</style></head>
<body>
<div id="bar">
  <div class="search-select-container--ANusUe9S">
    <div class="search-select-title-container--PqkTXn91"><span class="search-select-title--zzthyzLG">综合</span></div>
    <div class="search-select-arrow--vizKZTFD"></div>
    <div class="search-select-items-container--pWk5bY4P">
      <div class="search-select-item--H_AJBURX">综合</div>
      <div class="search-select-item--H_AJBURX">最近活跃</div>
      <div class="search-select-item--H_AJBURX">距离最近</div>
      <div class="search-select-item--H_AJBURX">信用排序</div>
    </div>
  </div>
  <div class="search-select-container--ANusUe9S">
    <div class="search-select-title-container--PqkTXn91"><span class="search-select-title--zzthyzLG">新降价</span></div>
  </div>
  <div class="search-select-container--ANusUe9S" id="publish">
    <div class="search-select-title-container--PqkTXn91"><span class="search-select-title--zzthyzLG">新发布</span></div>
    <div class="search-select-arrow--vizKZTFD"></div>
    <div class="search-select-items-container--pWk5bY4P">
      <div class="search-select-item--H_AJBURX">最新</div>
      <div class="search-select-item--H_AJBURX">1天内</div>
      <div class="search-select-item--H_AJBURX">3天内</div>
      <div class="search-select-item--H_AJBURX">7天内</div>
      <div class="search-select-item--H_AJBURX">14天内</div>
    </div>
  </div>
  <div class="search-select-container--ANusUe9S">
    <div class="search-select-title-container--PqkTXn91"><span class="search-select-title--zzthyzLG">价格</span></div>
    <div class="search-select-items-container--pWk5bY4P">
      <div class="search-select-item--H_AJBURX">价格从低到高</div>
      <div class="search-select-item--H_AJBURX">价格从高到低</div>
    </div>
  </div>
</div>
<script>
  // 复刻闲鱼：监听挂在 container 上，靠冒泡接住 span 的点击，点完 toggle 面板。
  // 每次点击都记下「目标是谁」和「点它之前面板是否已展开」——后者才是"没有点在隐藏元素上"的证据。
  window.__events = [];
  document.querySelectorAll('.search-select-container--ANusUe9S').forEach(function (container) {
    container.addEventListener('click', function (event) {
      var panel = container.querySelector('.search-select-items-container--pWk5bY4P');
      var wasOpen = panel ? panel.style.display === 'block' : false;
      window.__events.push({
        target: String(event.target.className),
        text: (event.target.textContent || '').trim(),
        wasOpen: wasOpen,
      });
      if (panel) panel.style.display = wasOpen ? 'none' : 'block';
    });
  });
</script>
</body></html>`;

const logs = [];
const logger = { info: () => {}, warn: (message) => logs.push(message), error: () => {} };
const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};
const events = (page) => page.evaluate(() => window.__events);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
try {
  // ---- 用例 1：正常选中「最新」 ----
  console.log('用例 1：sort=newest，面板里选项齐全');
  await page.setContent(FIXTURE);
  check((await applyPublishOptions(page, { sort: 'newest', publishDays: null }, logger, 't')) === true, 'applyPublishOptions 返回 true');

  const seen = await events(page);
  // 老实现用 [class*="search-select-title"] 会先命中容器 div，这里把"点的是 span"钉死。
  check(
    String(seen[0]?.target ?? '').includes('search-select-title--'),
    '第一次点击落在标题 span 上，而不是容器 div',
    `首个点击目标="${seen[0]?.target ?? '<无>'}"`,
  );
  const onOption = seen.find((event) => event.target.includes('search-select-item--'));
  check(Boolean(onOption), '确实点到了选项元素');
  // 这条才是关键：点选项之前下拉必须是展开的，否则等于在点一个隐藏元素。
  check(onOption?.wasOpen === true, '点选项时下拉是展开的', `wasOpen=${onOption?.wasOpen}`);
  check(onOption?.text === '最新', '点中的正是「最新」', `实际="${onOption?.text ?? '<无>'}"`);
  const display = await page.evaluate(() => document.querySelector('#publish .search-select-items-container--pWk5bY4P').style.display);
  check(display === 'none', '选完自动收起（真实下拉就是这样，不是缺陷）', `display=${display}`);

  // ---- 用例 2：排序 + 发布时间窗两项都要选（第二次要重新展开，且触发器文案已变成「最新」）----
  console.log('\n用例 2：sort=newest + publishDays=3，两个选项连续施加');
  await page.setContent(FIXTURE);
  logs.length = 0;
  check(
    (await applyPublishOptions(page, { sort: 'newest', publishDays: 3 }, logger, 't')) === true,
    '两项都选中',
    logs.join(' / ') || '无告警',
  );
  const texts = (await events(page)).filter((event) => event.target.includes('search-select-item--')).map((event) => event.text);
  check(texts.join(',') === '最新,3天内', '依次点中「最新」和「3天内」', `实际="${texts.join(',')}"`);

  // ---- 用例 3：找不到选项时必须返回 false 并报出面板里实际有什么 ----
  console.log('\n用例 3：要一个面板里没有的选项');
  await page.setContent(FIXTURE.replace('<div class="search-select-item--H_AJBURX">最新</div>', ''));
  logs.length = 0;
  check((await applyPublishOptions(page, { sort: 'newest', publishDays: null }, logger, 't')) === false, '返回 false，不静默通过');
  check(
    logs.some((message) => message.includes('实际有') && message.includes('1天内')),
    '告警里带上面板实际内容，便于区分改版还是点错下拉',
    logs.join(' / ') || '无告警',
  );

  // ---- 用例 4：没有任何原生筛选时不动作 ----
  console.log('\n用例 4：spec 里没有「新发布」相关项');
  await page.setContent(FIXTURE);
  check((await applyPublishOptions(page, { sort: null, publishDays: null }, logger, 't')) === true, '直接返回 true');
} finally {
  await browser.close();
}

console.log(failures.length === 0 ? '\n全部通过。' : `\n失败 ${failures.length} 项：${failures.join('、')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
