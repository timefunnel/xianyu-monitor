import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, describeFilters } from '../src/rules.mjs';

/** 构造一条基础商品，测试内按需覆盖字段。 */
const item = (overrides = {}) => ({
  id: '1',
  title: 'MacBook Air M2 13寸',
  price: 2999,
  area: '上海 浦东新区',
  seller: '闲置数码小铺',
  picUrl: null,
  url: 'https://example.invalid/item?id=1',
  publishTime: 1_700_000_000_000,
  ...overrides,
});

const NOW = 1_700_000_000_000 + 10 * 60000;

test('价格在区间内时通过', () => {
  const verdict = evaluate(item(), { minPrice: 2000, maxPrice: 3200 }, { now: NOW });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.rejections, []);
  assert.deepEqual(verdict.unknown, []);
});

test('价格超上限与低于下限分别被排除', () => {
  assert.equal(evaluate(item({ price: 3500 }), { maxPrice: 3200 }, { now: NOW }).ok, false);
  assert.equal(evaluate(item({ price: 1500 }), { minPrice: 2000 }, { now: NOW }).ok, false);
  assert.match(evaluate(item({ price: 3500 }), { maxPrice: 3200 }, { now: NOW }).rejections[0], /高于上限/);
});

test('价格未知时默认放行并记录未判定字段', () => {
  const verdict = evaluate(item({ price: null }), { maxPrice: 3200 }, { now: NOW });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.unknown, ['price']);
});

test('onUnknown 为 reject 时价格未知被排除', () => {
  const verdict = evaluate(item({ price: null }), { maxPrice: 3200 }, { now: NOW, onUnknown: 'reject' });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.unknown, ['price']);
  assert.deepEqual(verdict.rejections, ['价格未知']);
});

test('排除词大小写不敏感', () => {
  const verdict = evaluate(item({ title: 'MacBook Air m2 展示机' }), { excludeKeywords: ['展示机'] }, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.rejections[0], /排除词/);
});

test('必需词需要命中其一', () => {
  assert.equal(evaluate(item({ title: 'MacBook Air M2 国行 带票' }), { requireKeywords: ['国行', '港版'] }, { now: NOW }).ok, true);
  assert.equal(evaluate(item(), { requireKeywords: ['港版', '日版'] }, { now: NOW }).ok, false);
});

test('超过发布窗口的商品被排除', () => {
  const stale = item({ publishTime: NOW - 61 * 60000 });
  const verdict = evaluate(stale, { maxAgeMinutes: 60 }, { now: NOW });
  assert.equal(verdict.ok, false);
  assert.match(verdict.rejections[0], /超出 60 分钟窗口/);
});

test('发布时间未知时按策略处理', () => {
  assert.equal(evaluate(item({ publishTime: null }), { maxAgeMinutes: 60 }, { now: NOW }).ok, true);
  assert.equal(evaluate(item({ publishTime: null }), { maxAgeMinutes: 60 }, { now: NOW, onUnknown: 'reject' }).ok, false);
});

test('卖家黑名单精确匹配', () => {
  assert.equal(evaluate(item({ seller: '商家专营' }), { excludeSellers: ['商家专营'] }, { now: NOW }).ok, false);
  assert.equal(evaluate(item({ seller: '商家专营' }), { excludeSellers: ['商家'] }, { now: NOW }).ok, true);
});

test('requirePattern 用边界匹配刷新率，不会把 1440P 当成 144Hz', () => {
  const filters = { requirePattern: '(144|165|240)\\s*hz' };
  assert.equal(evaluate(item({ title: 'AOC 2K 144Hz 显示器' }), filters, { now: NOW }).ok, true);
  assert.equal(evaluate(item({ title: 'AOC 2K 165HZ 显示器' }), filters, { now: NOW }).ok, true, '大小写不敏感');
  assert.equal(
    evaluate(item({ title: 'AOC 2K 1440P 60Hz 显示器' }), filters, { now: NOW }).ok,
    false,
    '1440P 不能命中 144Hz',
  );
});

test('excludePattern 排除 1080P 与低刷', () => {
  const filters = { excludePattern: '1080|60\\s*hz' };
  assert.equal(evaluate(item({ title: 'AOC 24G2 1080P 144Hz' }), filters, { now: NOW }).ok, false);
  assert.equal(evaluate(item({ title: 'AOC 2K 60Hz' }), filters, { now: NOW }).ok, false);
  assert.equal(evaluate(item({ title: 'AOC 2K 165Hz' }), filters, { now: NOW }).ok, true);
});

test('cityAnyOf 命中任一地区即通过', () => {
  const filters = { cityAnyOf: ['上海', '浙江', '江苏'] };
  assert.equal(evaluate(item({ area: '浙江 杭州' }), filters, { now: NOW }).ok, true);
  assert.equal(evaluate(item({ area: '上海 浦东新区' }), filters, { now: NOW }).ok, true);
  assert.equal(evaluate(item({ area: '广东 深圳' }), filters, { now: NOW }).ok, false);
  assert.match(evaluate(item({ area: '广东 深圳' }), filters, { now: NOW }).rejections[0], /不在指定地区内/);
  assert.equal(evaluate(item({ area: null }), filters, { now: NOW }).ok, true, '未知地区默认放行');
  assert.equal(evaluate(item({ area: null }), filters, { now: NOW, onUnknown: 'reject' }).ok, false);
});

test('地区过滤按包含匹配，未知地区按策略处理', () => {
  assert.equal(evaluate(item(), { cityContains: '上海' }, { now: NOW }).ok, true);
  assert.equal(evaluate(item(), { cityContains: '北京' }, { now: NOW }).ok, false);
  assert.equal(evaluate(item({ area: null }), { cityContains: '上海' }, { now: NOW }).ok, true);
  assert.equal(evaluate(item({ area: null }), { cityContains: '上海' }, { now: NOW, onUnknown: 'reject' }).ok, false);
});

test('多条排除原因会全部列出', () => {
  const verdict = evaluate(item({ price: 9999, title: '展示机 求购' }), { maxPrice: 3200, excludeKeywords: ['展示机', '求购'] }, { now: NOW });
  assert.equal(verdict.rejections.length, 3);
});

test('过滤器摘要为空时说明全部推送', () => {
  assert.equal(describeFilters({}), '无过滤（全部推送）');
  assert.match(describeFilters({ minPrice: 1, maxPrice: 2, cityContains: '上海' }), /价格 1~2，地区含 上海/);
});

test('过滤器摘要默认紧凑：列表类条件只报条数', () => {
  // 品牌白名单动辄几十项，全列出来会变成三百多字的文字墙，把控制台日志面板刷满。
  const brands = Array.from({ length: 28 }, (_, index) => `品牌${index}`);
  const summary = describeFilters({ requireKeywords: brands, excludeKeywords: ['同款', '求购'], excludeSellers: ['某某'] });
  assert.equal(summary, '必需词 28 条，排除词 2 条，黑名单卖家 1 条');
  assert.ok(!summary.includes('品牌0'), '紧凑模式不该列出具体内容');
});

test('verbose 模式列出列表类条件的全部取值，供 check 核对配置', () => {
  const summary = describeFilters({ requireKeywords: ['AOC', 'HKC'], excludeKeywords: ['同款'] }, null, { verbose: true });
  assert.equal(summary, '必需词 AOC|HKC，排除词 同款');
});

test('卖家信用筛选：只放行达标等级，没有标签的按不达标处理', () => {
  const base = { id: '1', title: 'AOC 27寸 2K 180Hz 显示器', price: 568, area: '上海', seller: '小铺' };
  const filters = { requireSellerCredit: '极好' };

  assert.equal(evaluate({ ...base, sellerCredit: '极好' }, filters).ok, true);
  // 服务端没有信用筛选，只能客户端判；低一档要被拦下
  assert.equal(evaluate({ ...base, sellerCredit: '优秀' }, filters).ok, false);
  assert.match(evaluate({ ...base, sellerCredit: '优秀' }, filters).rejections[0], /未达「极好」/);
  // 没有标签 = 卖家没到挂标签的等级
  const bare = evaluate(base, filters);
  assert.equal(bare.ok, false);
  assert.match(bare.rejections[0], /未标注/);

  // 放宽到优秀时，优秀与极好都放行
  const loose = { requireSellerCredit: '优秀' };
  assert.equal(evaluate({ ...base, sellerCredit: '优秀' }, loose).ok, true);
  assert.equal(evaluate({ ...base, sellerCredit: '良好' }, loose).ok, false);

  // 不配置就完全不看信用
  assert.equal(evaluate(base, {}).ok, true);
});

test('原生筛选与控制台摘要一起出现', () => {
  const summary = describeFilters({ maxAgeMinutes: 120 }, { priceRange: [500, 700], region: '江浙沪' });
  assert.equal(summary, '原生价格筛选 500~700，原生区域筛选 江浙沪，120 分钟内');
});
