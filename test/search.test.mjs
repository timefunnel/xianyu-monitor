import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyMatchesFilters, collectSearch, dedupeById, isSearchApiResponse, nativeFilterSpec } from '../src/search.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'search-response.json'), 'utf8'));

const SEARCH_URL = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/';
const config = {
  baseUrl: 'https://www.goofish.com',
  linkTemplate: 'https://www.goofish.com/item?id={id}',
  responseTimeoutMs: 30,
};

/** 构造一次价格筛选后的请求体。 */
const priceBody = (filter) => ({ propValueStr: { searchFilter: filter }, extraFilterValue: '{}' });
/** 构造一次带地区筛选的请求体。预设走 extraDivision，具体省份走 divisionList（实测两种形态）。 */
const regionBody = (region, filter = '') =>
  presetBody(region, filter);
/** 预设（江浙沪 / 珠三角 / 京津冀 / 东三省）的形态。 */
const presetBody = (region, filter = '') => ({
  propValueStr: filter ? { searchFilter: filter } : {},
  extraFilterValue: JSON.stringify({ divisionList: [], excludeMultiPlacesSellers: '0', extraDivision: region }),
});
/** 具体省份 / 城市的形态。 */
const provinceBody = (province, filter = '', city) => ({
  propValueStr: filter ? { searchFilter: filter } : {},
  extraFilterValue: JSON.stringify({
    divisionList: [city ? { province, city } : { province }],
    excludeMultiPlacesSellers: '0',
    extraDivision: '',
  }),
});
const EMPTY_BODY = { propValueStr: {}, extraFilterValue: '{}' };

/**
 * 构造一个「像 Page 一样」的替身。
 *
 * 每次触发交互（加载、填价格、点区域确认）都会先发一个搜索请求、再回一个响应，
 * 请求体由 `bodies` 按下标提供——这正是被测代码用来校验「筛选有没有真的带上」的依据。
 * 点地区条目只改页面状态、不发请求，与真实页面一致。
 *
 * @param {{batches: unknown[], bodies?: unknown[], domEntries?: Array, resourceType?: string, priceInputs?: number}} options
 */
function fakePage({ batches, bodies = [], domEntries = [], resourceType = 'xhr', priceInputs = 2 }) {
  /** @type {Map<string, Function[]>} */
  const listeners = new Map();
  let cursor = 0;

  const fire = (event, payload) => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
  };
  /** 发出下一次搜索：先请求后响应。 */
  const next = () => {
    const index = cursor;
    cursor += 1;
    if (index >= batches.length) return false;
    const body = bodies[index] ?? EMPTY_BODY;
    page.requests.push(body);
    fire('request', {
      url: () => SEARCH_URL,
      resourceType: () => resourceType,
      postData: () => `data=${encodeURIComponent(JSON.stringify(body))}&bx-ua=fake`,
    });
    fire('response', {
      url: () => SEARCH_URL,
      request: () => ({ resourceType: () => resourceType, method: () => 'POST' }),
      json: async () => batches[index],
    });
    return true;
  };

  const page = {
    requests: [],
    filled: [],
    clicked: [],
    missingSelectors: [],
    wheels: 0,
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off: (event, handler) => {
      const list = listeners.get(event) ?? [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    },
    async goto() {
      next();
    },
    async $$() {
      return Array.from({ length: priceInputs }, () => ({
        async fill(value) {
          page.filled.push(value);
          next();
        },
      }));
    },
    /** 简化版定位器：确认按钮才触发搜索，地区条目只改状态。 */
    locator(selector, options) {
      const label = options?.hasText ? `${selector} >> text=${options.hasText}` : String(selector);
      const handle = {
        selector: label,
        first: () => handle,
        async count() {
          // 风控弹层：正常情况下页面上不存在；置 page.riskControl 为 true 可模拟被挡住。
          if (/baxia-dialog/.test(label)) return page.riskControl ? 1 : 0;
          return page.missingSelectors.some((missing) => label.includes(missing)) ? 0 : 1;
        },
        /** 真实页面用 waitFor 等元素出现；假页面按 missingSelectors 决定是抛出还是立刻通过。 */
        async waitFor() {
          if (page.missingSelectors.some((missing) => label.includes(missing))) {
            throw new Error(`locator.waitFor: element not found: ${label}`);
          }
        },
        async click() {
          // 风控弹层铺在页面上时，点击会被它拦截——真实页面里表现为 click 超时。
          if (page.riskControl) throw new Error('locator.click: intercepted by .baxia-dialog-mask');
          page.clicked.push(label);
          if (/searchBtn|件宝贝/.test(label)) next();
        },
      };
      return handle;
    },
    mouse: {
      async wheel() {
        page.wheels += 1;
        next();
      },
    },
    waitForTimeout: async () => {},
    isClosed: () => false,
    async evaluate() {
      return domEntries;
    },
  };
  return page;
}

/** 从原始响应里剪出指定数量的商品节点，模拟下一批结果。 */
const batch = (from, to) => ({ ret: ['SUCCESS::调用成功'], resultList: fixture.data.resultList.slice(from, to) });

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

test('isSearchApiResponse 排除搜索页自身的 HTML 响应', () => {
  const make = (resourceType, url) => ({ request: () => ({ resourceType: () => resourceType }), url: () => url });
  assert.equal(isSearchApiResponse(make('xhr', SEARCH_URL)), true);
  assert.equal(isSearchApiResponse(make('document', 'https://www.goofish.com/search?q=macbook')), false);
  assert.equal(isSearchApiResponse(make('image', 'https://img.alicdn.com/a.png')), false);
});

test('isSearchApiResponse 排除同名前缀的推荐位与热搜位接口', () => {
  const make = (url) => ({ request: () => ({ resourceType: () => 'xhr' }), url: () => url });
  assert.equal(isSearchApiResponse(make('https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search.shade/1.0/?jsv=2.7.2')), false);
  assert.equal(isSearchApiResponse(make('https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.item.search.activate/1.0/')), false);
});

test('dedupeById 保留先出现的条目', () => {
  const items = dedupeById([{ id: '1', title: 'a' }, { id: '2', title: 'b' }, { id: '1', title: 'c' }]);
  assert.deepEqual(items.map((item) => item.title), ['a', 'b']);
});

test('nativeFilterSpec 认「新发布」的两项：排序与发布时间窗', () => {
  const spec = nativeFilterSpec({ keyword: 'k', nativeFilters: { sort: 'newest', publishDays: 3 } });
  assert.equal(spec.sort, 'newest');
  assert.equal(spec.publishDays, 3);
  assert.equal(spec.hasFilters, true, '只配排序也算有原生筛选');

  // 只接受闲鱼下拉里真实存在的档位，其它值一律当作没配
  assert.equal(nativeFilterSpec({ keyword: 'k', nativeFilters: { publishDays: 5 } }).publishDays, null);
  assert.equal(nativeFilterSpec({ keyword: 'k', nativeFilters: { sort: 'cheap' } }).sort, null);

  // 排序/时间窗不同 → 热页面标识必须不同，否则会复用错页面
  assert.notEqual(
    nativeFilterSpec({ keyword: 'k', nativeFilters: { sort: 'newest' } }).key,
    nativeFilterSpec({ keyword: 'k', nativeFilters: { publishDays: 3 } }).key,
  );
});

test('bodyMatchesFilters 校验排序与发布时间窗', () => {
  const sorted = { ...EMPTY_BODY, sortField: 'create', sortValue: 'desc' };
  const spec = { priceRange: null, region: null, sort: 'newest', publishDays: 3 };

  assert.equal(bodyMatchesFilters({ ...sorted, propValueStr: { searchFilter: 'publishDays:3;' } }, spec), true);
  assert.equal(bodyMatchesFilters(sorted, spec), false, '少了时间窗不算通过');
  assert.equal(
    bodyMatchesFilters({ ...EMPTY_BODY, propValueStr: { searchFilter: 'publishDays:3;' } }, spec),
    false,
    '少了排序不算通过',
  );
  // 价格与时间窗共用 searchFilter，分号分隔，要能同时认出来
  const both = { ...sorted, propValueStr: { searchFilter: 'priceRange:500,700;publishDays:3;' } };
  assert.equal(bodyMatchesFilters(both, { priceRange: [500, 700], region: null, sort: 'newest', publishDays: 3 }), true);
  // 综合排序（sortField 为空）不算「最新」
  assert.equal(bodyMatchesFilters({ ...EMPTY_BODY, sortField: '', sortValue: '' }, { sort: 'newest' }), false);
});

test('nativeFilterSpec 把任务条件算成筛选描述与热页面标识', () => {
  const plain = nativeFilterSpec({ keyword: 'k' });
  assert.equal(plain.hasFilters, false);
  assert.equal(plain.key, null, '没有原生筛选时不需要热页面标识');

  const spec = nativeFilterSpec({ keyword: 'k', nativeFilters: { priceRange: [500, 700], region: '江浙沪' } });
  assert.equal(spec.hasFilters, true);
  assert.equal(spec.region, '江浙沪');
  assert.match(spec.key, /江浙沪/);
  assert.notEqual(spec.key, nativeFilterSpec({ keyword: '别的', nativeFilters: { priceRange: [500, 700], region: '江浙沪' } }).key);
});

test('bodyMatchesFilters 按实际字段判定筛选是否带上', () => {
  const spec = { priceRange: [500, 700], region: '江浙沪' };
  assert.equal(bodyMatchesFilters(priceBody('priceRange:500,700;'), { priceRange: [500, 700], region: null }), true);
  assert.equal(bodyMatchesFilters(priceBody('priceRange:500,undefined;'), { priceRange: [500, 700], region: null }), false, '中间态不算数');
  assert.equal(bodyMatchesFilters(regionBody('江浙沪'), { priceRange: null, region: '江浙沪' }), true);
  assert.equal(bodyMatchesFilters(EMPTY_BODY, spec), false, '两个条件都没带上');
  assert.equal(bodyMatchesFilters({ ...priceBody('priceRange:500,700;'), extraFilterValue: '{"extraDivision":"江浙沪"}' }, spec), true);
  assert.equal(bodyMatchesFilters(null, spec), false);
  assert.equal(bodyMatchesFilters({ extraFilterValue: '不是 JSON' }, { priceRange: null, region: '江浙沪' }), false);
});

test('bodyMatchesFilters 认得出具体省份与城市的区域形态', () => {
  // 实测：选预设走 extraDivision，选具体省份走 divisionList，只看前者会把省份误判成「没生效」。
  assert.equal(bodyMatchesFilters(provinceBody('上海'), { priceRange: null, region: '上海' }), true);
  assert.equal(bodyMatchesFilters(provinceBody('江苏'), { priceRange: null, region: '江苏' }), true);
  assert.equal(bodyMatchesFilters(provinceBody('浙江', '', '杭州'), { priceRange: null, region: '杭州' }), true);
  assert.equal(bodyMatchesFilters(provinceBody('江苏'), { priceRange: null, region: '上海' }), false, '地区不对不能算通过');
  assert.equal(bodyMatchesFilters(presetBody('江浙沪'), { priceRange: null, region: '上海' }), false);
});

test('单批响应即可解析出商品', async () => {
  const page = fakePage({ batches: [fixture] });
  const result = await collectSearch(page, config, { keyword: 'MacBook Air M2' }, silentLogger);
  assert.equal(result.source, 'api');
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].id, '812345678901');
  assert.equal(page.wheels, 0, '未配置滚动就不该滚动');
});

test('无限滚动的多批结果会合并并按 ID 去重', async () => {
  const page = fakePage({ batches: [batch(0, 2), batch(1, 3)] });
  const result = await collectSearch(page, config, { keyword: 'x', scrollRounds: 1 }, silentLogger);
  assert.equal(result.source, 'api');
  assert.deepEqual(result.items.map((item) => item.id), ['812345678901', '812345678902', '812345678903']);
  assert.equal(page.wheels, 1);
});

test('只有 document 响应时不算搜索接口，回退到 DOM 解析', async () => {
  const page = fakePage({
    batches: [fixture],
    resourceType: 'document',
    domEntries: [{ href: 'https://www.goofish.com/item?id=812345678999', text: 'MacBook Air M2 ¥2999' }],
  });
  const result = await collectSearch(page, config, { keyword: 'x' }, silentLogger);
  assert.equal(result.source, 'dom');
  assert.deepEqual(result.items.map((item) => item.id), ['812345678999']);
  assert.equal(result.raw, null);
});

test('接口结构变化解析出 0 条时回退到 DOM 解析', async () => {
  const page = fakePage({
    batches: [{ ret: ['SUCCESS::调用成功'], data: { resultList: [{ foo: 'bar' }] } }],
    domEntries: [{ href: 'https://www.goofish.com/item?id=812345678998', text: 'iPhone 15 ¥4500' }],
  });
  const result = await collectSearch(page, config, { keyword: 'x' }, silentLogger);
  assert.equal(result.source, 'dom');
  assert.equal(result.items[0].price, 4500);
});

test('解析成功时 raw 保留全部原始响应供 dump 使用', async () => {
  const page = fakePage({ batches: [batch(0, 1), batch(4, 5)] });
  const result = await collectSearch(page, config, { keyword: 'x', scrollRounds: 1 }, silentLogger);
  assert.equal(result.source, 'api');
  assert.equal(result.raw.length, 2);
});

test('监听器在每轮结束后被摘除，不会跨轮泄漏', async () => {
  const page = fakePage({ batches: [fixture, fixture] });
  const first = await collectSearch(page, config, { keyword: 'x' }, silentLogger);
  const second = await collectSearch(page, config, { keyword: 'x' }, silentLogger);
  assert.equal(first.items.length, 4);
  assert.equal(second.items.length, 4, '第二轮不应把第一轮的响应重复计入');
  assert.equal(page.listenerCount('response'), 0);
  assert.equal(page.listenerCount('request'), 0);
});

// ---------- 限流与登录失效 ----------

test('被限流时抛出可操作的错误，并提示先降速而不是重新登录', async () => {
  const page = fakePage({
    batches: [
      {
        ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'],
        data: { url: 'https://passport.goofish.com/mini_login.htm?lang=zh_cn' },
      },
    ],
  });
  await assert.rejects(() => collectSearch(page, config, { keyword: 'x' }, silentLogger), /被闲鱼拦截.*intervalSeconds/s);
});

test('风控直接拒绝（action=deny）时抛出的错误带 denied 标记，不走限流那条退避', async () => {
  // 限流与直接拒绝的 ret 一模一样，只有处罚链接里的 action 不同。
  // 主循环靠 error.code 决定退避策略与提示语，所以这里必须能区分出来。
  const page = fakePage({
    batches: [
      {
        ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'],
        data: { url: 'https://bixi.alicdn.com/punish/punish:resource:template:baba:default_1.html?uuid=1&action=deny&pureDenyWait=' },
      },
    ],
  });
  await assert.rejects(
    () => collectSearch(page, config, { keyword: 'x' }, silentLogger),
    (error) => error.code === 'denied' && /直接拒绝/.test(error.message),
  );
});

test('会话过期时抛出引导重新登录的错误，并清掉热页面状态', async () => {
  const page = fakePage({ batches: [{ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} }] });
  const session = { warmKey: 'stale' };
  await assert.rejects(() => collectSearch(page, config, { keyword: 'x' }, silentLogger, session), /要求登录.*login/s);
  assert.equal(session.warmKey, null, '会话失效后不能继续复用热页面');
});

test('接口返回其它错误码时抛异常，走退避与告警路径', async () => {
  const page = fakePage({ batches: [{ ret: ['FAIL_SYS_PARAM_INVALID::参数错误'], data: {} }] });
  await assert.rejects(() => collectSearch(page, config, { keyword: 'x' }, silentLogger), /搜索接口返回错误.*参数错误/s);
});

// ---------- 原生筛选 ----------

test('原生价格筛选生效时，只采信最后那次带条件的搜索', async () => {
  const task = { keyword: 'x', name: 't', nativeFilters: { priceRange: [500, 700] } };
  const page = fakePage({
    batches: [batch(0, 1), batch(0, 1), batch(2, 4)],
    bodies: [EMPTY_BODY, priceBody('priceRange:500,undefined;'), priceBody('priceRange:500,700;')],
  });

  const session = { warmKey: null };
  const result = await collectSearch(page, config, task, silentLogger, session);

  assert.deepEqual(page.filled, ['500', '700']);
  assert.deepEqual(
    result.items.map((item) => item.price).sort((a, b) => a - b),
    [9999, 12000],
    '未筛选那批和 priceRange:500,undefined 那个中间态都是全国范围的结果，不能混进来',
  );
  assert.equal(result.requests, 3);
  assert.equal(
    session.warmKey,
    JSON.stringify({ keyword: 'x', priceRange: [500, 700], region: null, sort: null, publishDays: null }),
    '筛选生效后应记住热页面标识',
  );
});

test('配置原生区域筛选时，走完「开面板 → 选地区 → 确认」三步', async () => {
  const task = { keyword: 'x', name: 't', nativeFilters: { region: '江浙沪' } };
  const page = fakePage({ batches: [batch(0, 1), batch(2, 4)], bodies: [EMPTY_BODY, regionBody('江浙沪')] });

  const result = await collectSearch(page, config, task, silentLogger, { warmKey: null });

  assert.equal(page.clicked.length, 3, '入口、地区、确认按钮各点一次');
  assert.match(page.clicked[0], /areaTextContainer|区域/);
  assert.match(page.clicked[1], /江浙沪/);
  assert.match(page.clicked[2], /searchBtn|件宝贝/);
  assert.equal(result.items.length, 2, '只取筛选后那一批');
});

test('没有配置原生筛选时不去碰页面输入框', async () => {
  const page = fakePage({ batches: [fixture] });
  await collectSearch(page, config, { keyword: 'x' }, silentLogger);
  assert.deepEqual(page.filled, []);
  assert.deepEqual(page.clicked, []);
});

test('页面被风控弹层挡住时，报出明确原因而不是点击超时', async () => {
  const logger = { warn() {}, error() {}, info() {}, debug() {} };
  const task = { keyword: 'x', name: 't', nativeFilters: { region: '江浙沪' } };
  const page = fakePage({ batches: [fixture, fixture], bodies: [EMPTY_BODY, EMPTY_BODY] });
  page.riskControl = true;
  const session = { warmKey: null };

  await assert.rejects(
    () => collectSearch(page, config, task, logger, session),
    (error) => {
      assert.equal(error.code, 'risk-control', '要给出可识别的错误码，监控据此立即告警');
      assert.match(error.message, /风控/, '文案要说清是风控、以及要在监控窗口里人工完成验证');
      return true;
    },
  );
  assert.equal(session.warmKey, null, '风控期间不能记住热页面');
});

test('筛选没生效时直接报错，不推送任何结果', async () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(['warn', m]), error: (m) => warnings.push(['error', m]), info() {}, debug() {} };
  const task = { keyword: 'x', name: 't', nativeFilters: { region: '火星' } };
  const page = fakePage({ batches: [fixture, fixture], bodies: [EMPTY_BODY, EMPTY_BODY] });
  page.missingSelectors = ['火星'];
  const session = { warmKey: null };

  // 退回用全部批次会把「页面加载时的未筛选结果」一起推出去——实测推过 31 条无关商品。
  await assert.rejects(
    () => collectSearch(page, config, task, logger, session),
    (error) => error.code === 'filters-not-applied' && /没有生效/.test(error.message),
  );
  assert.ok(warnings.some(([, m]) => m.includes('火星')), '要指出面板里没有这个地区');
  assert.equal(session.warmKey, null, '没生效就不该进入热路径');
});

// ---------- 热路径：把每轮请求从 4 次压到 1 次 ----------

test('第二轮起走热路径：不重新加载，只发 1 次请求就能拿到带完整筛选的结果', async () => {
  const task = { keyword: 'x', name: 't', nativeFilters: { priceRange: [500, 700], region: '江浙沪' } };
  const full = { propValueStr: { searchFilter: 'priceRange:500,700;' }, extraFilterValue: JSON.stringify({ extraDivision: '江浙沪' }) };
  const page = fakePage({
    // 第一轮冷启动 4 次请求，第二轮热刷新 1 次
    batches: [batch(0, 1), batch(0, 1), batch(2, 4), batch(2, 4), batch(2, 4)],
    bodies: [EMPTY_BODY, priceBody('priceRange:500,undefined;'), priceBody('priceRange:500,700;'), full, full],
  });
  const session = { warmKey: null };

  await collectSearch(page, config, task, silentLogger, session);
  assert.equal(page.requests.length, 4, '冷启动：加载 + 填价格下限 + 上限 + 区域确认');

  const before = page.requests.length;
  const warm = await collectSearch(page, config, task, silentLogger, session);
  assert.equal(page.requests.length - before, 1, '热刷新只要 1 次请求');
  assert.equal(warm.items.length, 2, '热刷新的结果就是那一次请求返回的那批');
  assert.equal(page.wheels, 0, '热路径不该重新滚动');
});

test('热刷新拿到的请求体没带筛选条件时，退回重新加载', async () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), error() {}, info() {}, debug() {} };
  const task = { keyword: 'x', name: 't', nativeFilters: { region: '江浙沪' } };
  const full = regionBody('江浙沪');
  const page = fakePage({
    // 顺序：① 首轮 goto ② 首轮区域确认 ③ 热刷新（请求体为空 → 不采信）
    //       ④ 回退后的 goto ⑤ 回退后的区域确认
    batches: [batch(0, 1), batch(2, 4), batch(2, 4), batch(0, 1), batch(2, 4)],
    bodies: [EMPTY_BODY, full, EMPTY_BODY, EMPTY_BODY, full],
  });
  const session = { warmKey: null };

  await collectSearch(page, config, task, silentLogger, session);
  assert.ok(session.warmKey, '第一轮筛选生效后应进入可热刷新的状态');
  const before = page.requests.length;

  const result = await collectSearch(page, config, task, logger, session);

  assert.ok(page.requests.length - before > 1, '热刷新不可信时应重新走冷路径');
  assert.ok(warnings.some((m) => m.includes('退回重新加载')), '要明确说明为什么重新加载');
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['812345678903', '812345678904'],
    '回退后取冷路径最终那批带条件的结果',
  );
});

test('换了关键词就不会复用热页面', async () => {
  const first = { keyword: 'A', name: 't', nativeFilters: { region: '江浙沪' } };
  const second = { keyword: 'B', name: 't', nativeFilters: { region: '江浙沪' } };
  const full = regionBody('江浙沪');
  const page = fakePage({
    batches: [batch(0, 1), batch(2, 4), batch(2, 4), batch(2, 4)],
    bodies: [EMPTY_BODY, full, full, full],
  });
  const session = { warmKey: null };

  await collectSearch(page, config, first, silentLogger, session);
  const before = page.requests.length;
  await collectSearch(page, config, second, silentLogger, session);
  assert.ok(page.requests.length - before > 1, '关键词不同必须重新加载');
  assert.match(session.warmKey, /"keyword":"B"/);
});
