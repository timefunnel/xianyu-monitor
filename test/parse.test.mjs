import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyResponse, extractItems, extractFromDom, findItemId, normalizeItem, toPrice, toTimestamp, unwrapPayload } from '../src/parse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'search-response.json'), 'utf8'));
const NOW = 1_700_000_000_000;
const ctx = { linkTemplate: 'https://www.goofish.com/item?id={id}', now: NOW };

/** 取真实响应里的第一条商品节点，按需改写它的 exContent 后归一化。 */
function normalizeFirst(exContentPatch) {
  const entry = findItemNodesForTest()[0];
  const content = { ...entry.content, ...exContentPatch };
  return normalizeItem({ node: entry.node, content }, ctx);
}

/** 借用解析器自己的节点查找，测试里不重复实现一遍结构遍历。 */
function findItemNodesForTest() {
  // findItemNodes 没导出，这里用 extractItems 的输入约定：从真实 fixture 上取节点
  const entries = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.exContent && typeof node.exContent === 'object' && !Array.isArray(node.exContent)) {
      entries.push({ node, content: node.exContent });
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(fixture);
  return entries;
}

test('卖家信用从 fishTags 里取，组号不固定；没有标签时为 null', () => {
  // 实测组号（r1/r2/r3/r4）随商品而变，不能认准某一个
  const mixed = normalizeFirst({
    fishTags: { r2: { tagList: [{ data: { content: '全新' } }] }, r4: { tagList: [{ data: { content: '卖家信用极好' } }] } },
  });
  assert.equal(mixed.sellerCredit, '极好');

  const excellent = normalizeFirst({ fishTags: { r1: { tagList: [{ data: { content: '卖家信用优秀' } }] } } });
  assert.equal(excellent.sellerCredit, '优秀');

  // 只有普通标签：卖家没到挂信用标签的等级
  const none = normalizeFirst({ fishTags: { r2: { tagList: [{ data: { content: '全新' } }] } } });
  assert.equal(none.sellerCredit, null);

  // 连 fishTags 都没有
  assert.equal(normalizeFirst({}).sellerCredit, null);
});


test('toPrice 覆盖数字、带符号字符串、万元写法与数组结构', () => {
  assert.equal(toPrice(2999), 2999);
  assert.equal(toPrice('¥1,299'), 1299);
  assert.equal(toPrice('1800 元'), 1800);
  assert.equal(toPrice('1.2万'), 12000);
  assert.equal(toPrice([{ price: '2999' }]), 2999);
  assert.equal(toPrice([{ text: '￥88.5' }]), 88.5);
  assert.equal(toPrice([]), null);
  assert.equal(toPrice('面议'), null);
});

test('toPrice 解析闲鱼实际返回的富文本片段数组', () => {
  // 实测结构：价格被拆成 [{text:"¥"},{text:"161"}]，只取第一段会得到 "¥" 而解析失败。
  assert.equal(toPrice([{ text: '¥', textColor: '#ff4400' }, { text: '161', textSize: 20 }]), 161);
  assert.equal(toPrice([{ text: '¥' }, { text: '1' }, { text: '2' }, { text: '9' }, { text: '9' }]), 1299);
  assert.equal(toPrice([{ text: '¥' }, { text: '1.2万' }]), 12000);
  assert.equal(toPrice([{ text: '面议' }]), null, '解析不出数字时返回 null 而不是 0');
});

test('toPrice 优先取货币符号后的数字，避免把型号 M2 当成价格', () => {
  assert.equal(toPrice('MacBook Air M2 ¥2999 上海'), 2999);
  assert.equal(toPrice('iPhone 15 ￥4,500 包邮'), 4500);
  assert.equal(toPrice('MacBook Air M2 8G+256G'), null, '没有货币符号且数字紧邻字母时返回 null，不猜价格');
  assert.equal(toPrice('2999 元 包邮'), 2999);
});

test('toTimestamp 覆盖时间戳与相对文案', () => {
  assert.equal(toTimestamp(1700000000, NOW), 1_700_000_000_000);
  assert.equal(toTimestamp(1_700_000_000_000, NOW), 1_700_000_000_000);
  assert.equal(toTimestamp('刚刚', NOW), NOW);
  assert.equal(toTimestamp('5分钟前', NOW), NOW - 5 * 60000);
  assert.equal(toTimestamp('2小时前', NOW), NOW - 2 * 3600000);
  assert.equal(toTimestamp('昨天', NOW), NOW - 86400000);
  assert.equal(toTimestamp('前天', NOW), NOW - 2 * 86400000);
  assert.equal(toTimestamp('不认识的文案', NOW), null);
  assert.equal(toTimestamp(null, NOW), null);
});

test('findItemId 能在嵌套结构里找到商品 ID', () => {
  assert.equal(findItemId({ clickParam: { args: { item_id: '812345678901' } } }), '812345678901');
  assert.equal(findItemId({ itemId: 812345678901 }), '812345678901');
  assert.equal(findItemId({ id: '123' }), null, '位数不足的 id 不当作商品 ID');
  assert.equal(findItemId({ title: '无 ID' }), null);
});

test('unwrapPayload 展开被塞进字符串的 data', () => {
  assert.deepEqual(unwrapPayload({ data: '{"a":1}' }), { a: 1 });
  assert.deepEqual(unwrapPayload('{"a":1}'), { a: 1 });
  assert.deepEqual(unwrapPayload({ data: '不是 JSON' }), { data: '不是 JSON' });
});

test('从 targetUrl 解析 App 深链', () => {
  const items = extractItems(fixture, ctx);
  assert.equal(items[0].appUrl, 'fleamarket://item?id=812345678901&referPageArgs=2K+%E6%98%BE%E7%A4%BA%E5%99%A8&gulSource=search');
  assert.equal(items.length, 4, '每个真实商品都应带上深链');
});

test('targetUrl 不是链接时 appUrl 为 null，不会把普通文本推给用户', () => {
  const payload = {
    resultList: [
      {
        data: {
          item: {
            main: {
              targetUrl: '不是链接',
              exContent: { title: 'X', detailParams: { itemId: '800000000001' } },
              clickParam: { args: { item_id: '800000000001' } },
            },
          },
        },
      },
    ],
  };
  const items = extractItems(payload, ctx);
  assert.equal(items[0].appUrl, null);
  assert.equal(items[0].url, 'https://www.goofish.com/item?id=800000000001');
});

test('extractItems 解析真实结构的搜索结果并丢弃无 ID 节点', () => {
  const items = extractItems(fixture, ctx);
  assert.equal(items.length, 4, '第 5 条没有 item_id，应被丢弃');

  const first = items[0];
  assert.equal(first.id, '812345678901');
  assert.equal(first.title, 'MacBook Air M2 13寸 8G+256G 国行 带票');
  assert.equal(first.price, 2999);
  assert.equal(first.area, '上海 浦东新区');
  assert.equal(first.seller, '闲置数码小铺');
  assert.equal(first.picUrl, 'https://img.alicdn.com/imgextra/macbook.jpg');
  assert.equal(first.url, 'https://www.goofish.com/item?id=812345678901');
  assert.equal(first.publishTime, NOW - 5 * 60000);
});

test('extractItems 处理价格数组、带单位字符串与对象形式地区', () => {
  const items = extractItems(fixture, ctx);
  assert.equal(items[1].price, 1800);
  assert.equal(items[2].price, 9999);
  assert.equal(items[3].price, 12000);
  assert.equal(items[3].area, '浙江 杭州');
  assert.equal(items[3].publishTime, NOW);
});

test('extractItems 按 ID 去重', () => {
  const main = fixture.data.resultList[0].data.item.main;
  const payload = { resultList: [{ data: { item: { main } } }, { data: { item: { main } } }] };
  assert.equal(extractItems(payload, ctx).length, 1);
});

test('接口结构完全变化时返回空数组而不是抛错', () => {
  assert.deepEqual(extractItems({ data: { resultList: [{ foo: 'bar' }] } }, ctx), []);
  assert.deepEqual(extractItems(null, ctx), []);
});

test('无 exContent 时退化为「标题 + ID」结构', () => {
  const payload = { items: [{ itemId: '800000000001', title: '降级结构商品', price: '1234' }] };
  const items = extractItems(payload, ctx);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '800000000001');
  assert.equal(items[0].price, 1234);
});

test('extractFromDom 只信任链接里的 ID', () => {
  const entries = [
    { href: 'https://www.goofish.com/item?id=812345678901', text: 'MacBook Air M2 ¥2999 上海' },
    { href: 'https://www.goofish.com/item?id=812345678901', text: '重复' },
    { href: 'https://www.goofish.com/search?q=x', text: '不是商品' },
  ];
  const items = extractFromDom(entries, ctx);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '812345678901');
  assert.equal(items[0].price, 2999);
  assert.equal(items[0].publishTime, null);
});

test('classifyResponse 识别成功响应', () => {
  assert.equal(classifyResponse({ ret: ['SUCCESS::调用成功'] }).kind, 'success');
});

test('classifyResponse 把 RGV587 判定为限流而不是登录失效', () => {
  // 实测：RGV587 同时出现在「未登录」和「频率过高」两种场景，data.url 都指向登录页，
  // 因此必须按错误码本身判定，不能只看登录页地址。
  const payload = {
    ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'],
    data: { url: 'https://passport.goofish.com/mini_login.htm?lang=zh_cn', dialogSize: { width: '856px' } },
  };
  const verdict = classifyResponse(payload);
  assert.equal(verdict.kind, 'throttle');
  assert.match(verdict.message, /RGV587/);
});

test('classifyResponse 把带 action=deny 的 RGV587 判成「直接拒绝」而不是限流', () => {
  // 实测：这两种情况的 ret 完全一样，只有处罚链接里的 action 不同。必须分开——
  // 限流等几分钟就自己好；action=deny 的页面上写的是「访问被拒绝」，没有任何可操作的
  // 验证项，等多久都不会好，重试、重新登录、过验证全都无效。
  const payload = {
    ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'],
    data: {
      url:
        'https://bixi.alicdn.com/punish/punish:resource:template:baba:default_35969158.html' +
        '?qrcode=abc|def&uuid=1234&action=deny' +
        '&origin=https%3A%2F%2Fh5api.m.goofish.com%3A443%2Fh5%2Fmtop.taobao.idlemtopsearch.pc.search%2F1.0&pureDenyWait=',
    },
  };
  const verdict = classifyResponse(payload);
  assert.equal(verdict.kind, 'denied');
  assert.match(verdict.message, /RGV587/);
  // 处罚链接里还有人工出口（action=verify）时仍旧按限流处理。
  const verify = { ret: ['RGV587_ERROR::x'], data: { url: 'https://bixi.alicdn.com/punish/t.html?uuid=1&action=verify' } };
  assert.equal(classifyResponse(verify).kind, 'throttle');
});

test('classifyResponse 识别会话过期', () => {
  const verdict = classifyResponse({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} });
  assert.equal(verdict.kind, 'auth');
  assert.equal(classifyResponse({ ret: ['FAIL_SYS_ONSESSION_INVALID::会话失效'], data: {} }).kind, 'auth');
});

test('classifyResponse 用登录页地址兜底识别 auth', () => {
  const verdict = classifyResponse({ ret: ['FAIL_SYS_UNKNOWN::未知'], data: { url: 'https://passport.goofish.com/mini_login.htm' } });
  assert.equal(verdict.kind, 'auth');
});

test('classifyResponse 把其它错误码判定为 error 并保留原文', () => {
  const verdict = classifyResponse({ ret: ['FAIL_SYS_PARAM_INVALID::参数错误'], data: {} });
  assert.equal(verdict.kind, 'error');
  assert.match(verdict.message, /参数错误/);
  assert.equal(classifyResponse({ data: {} }).kind, 'error');
});
