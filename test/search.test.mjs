import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyMatchesFilters, nativeFilterSpec } from '../src/search.mjs';

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
