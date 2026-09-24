// 直连搜索器（src/mtop.mjs）。
//
// 这一组测试要钉死的核心不变量只有一条：**每轮搜索恰好 1 次请求**。
// 之前浏览器方案冷启动会连发 5 次（页面加载 + 价格两次 + 区域 + 「新发布」），
// 而实测「短时间内连续 3 次搜索」就触发 RGV587——所以请求次数是这个模块的头号契约，
// 任何改动让它变成 2 次都必须是显式的、有理由的例外。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MTOP, MtopSearcher, buildSearchBody, createSearcher, mtopSign, tokenOf } from '../src/mtop.mjs';
import { bodyMatchesFilters } from '../src/search.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'search-response.json'), 'utf8'));

/**
 * fixture 的 5 条原始条目里第 5 条没有 id，解析适配层会丢弃它（见 src/parse.mjs 的
 * normalizeItem），所以固定得到 4 条商品。钉住这个数，是为了让「响应体确实被解析了」
 * 这件事可回归——它比 `> 0` 更能挡住"解析突然只出 1 条"这类退化。
 */
const FIXTURE_ITEMS = 4;

const makeConfig = (search = {}, monitor = {}) => ({
  storage: { stateFile: path.join(tmpdir(), 'xianyu-mtop-test', 'state.json') },
  linkTemplate: 'https://www.goofish.com/item?id={id}',
  search: { timeoutMs: 20000, ...search },
  monitor: { minRequestGapSeconds: 30, ...monitor },
});

/** 假 fetch：按顺序返回给定响应，并把每次调用记下来。 */
function fakeFetch(rounds) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const round = rounds[Math.min(calls.length - 1, rounds.length - 1)];
    return typeof round === 'function' ? round(calls.length) : round;
  };
  return { impl, calls };
}

const response = (payload, setCookie = []) => ({
  status: 200,
  headers: { getSetCookie: () => setCookie },
  json: async () => payload,
});

const success = () => response(fixture);
const denied = () =>
  response({
    ret: ['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!'],
    data: { url: 'https://bixi.alicdn.com/punish/punish:resource:template:baba:default_1.html?uuid=1&action=deny&pureDenyWait=' },
  });

/** 从表单体里取回 data 并解析成对象。 */
const bodyOf = (call) => JSON.parse(decodeURIComponent(/^data=(.*)$/.exec(call.init.body)[1]));
/** 请求头里带的 cookie 名。 */
const cookieNames = (call) =>
  call.init.headers.cookie
    .split('; ')
    .map((part) => part.split('=')[0]);

const sourceCookies = [
  { name: 'unb', value: '2214928720161' },
  { name: '_m_h5_tk', value: 'tok_1700000000000' },
  { name: 'sgcookie', value: 'E1003xDrIXP8' },
];

/**
 * 内存版 cookie 仓库，替掉文件版。
 * 记下 save 次数——「有新 cookie 就落盘」是 http 模式能跨重启保住登录态的关键，
 * 所以它值得被断言，而不是只当作实现细节。
 */
function memoryStore(cookies = sourceCookies) {
  const jar = new Map(
    cookies.map((cookie) => [
      cookie.name,
      { domain: '.goofish.com', path: '/', expires: -1, secure: true, httpOnly: false, sameSite: 'Lax', ...cookie },
    ]),
  );
  return {
    file: '(memory)',
    saves: 0,
    refused: [],
    async load() {
      return new Map([...jar].map(([name, cookie]) => [name, { ...cookie }]));
    },
    async save(next) {
      this.saves += 1;
      jar.clear();
      for (const [name, cookie] of next) jar.set(name, { ...cookie });
    },
    isRefused(name, value) {
      return this.refused.some((entry) => entry.name === name && entry.value === value);
    },
    async refuse(current, name, value) {
      if (this.isRefused(name, value)) return false;
      this.refused.push({ name, value });
      await this.save(current);
      return true;
    },
  };
}

const makeSearcher = (rounds, cookies = sourceCookies, search = {}) => {
  const { impl, calls } = fakeFetch(rounds);
  const store = memoryStore(cookies);
  const searcher = new MtopSearcher({ config: makeConfig(search), logger: {}, cookies: store, fetchImpl: impl });
  return { searcher, calls, store };
};

// ---------- 纯函数 ----------

test('mtopSign 是 md5(token&t&appKey&data)，顺序与分隔符不能变', () => {
  // 定值向量：改拼接顺序、少一个 & 都会让这个断言失败——服务端就是这么验的。
  assert.equal(
    mtopSign({ token: 'tok', t: '1700000000000', appKey: '34839810', data: '{"keyword":"x"}' }),
    '1b3287d67cecd51d2fe7eff92b236a8c',
  );
});

test('tokenOf 取 _m_h5_tk 第一个下划线之前的部分', () => {
  assert.equal(tokenOf('defa3dd49bf2_1790000000000'), 'defa3dd49bf2');
  assert.equal(tokenOf('nodash'), 'nodash');
  assert.equal(tokenOf(undefined), '');
});

test('buildSearchBody 把筛选放对位置：价格与时间窗进 searchFilter，区域进 extraFilterValue，排序进顶层', () => {
  const task = {
    keyword: 'k',
    nativeFilters: { priceRange: [500, 700], region: '江浙沪', sort: 'newest', publishDays: 3 },
  };
  const { body, spec } = buildSearchBody(task);

  assert.equal(body.propValueStr.searchFilter, 'priceRange:500,700;publishDays:3;');
  assert.equal(body.extraFilterValue, '{"extraDivision":"江浙沪"}');
  assert.equal(body.sortField, 'create');
  assert.equal(body.sortValue, 'desc');
  assert.equal(body.keyword, 'k');
  assert.equal(body.fromFilter, true);
  // 自己拼的体也必须过同一套校验，否则拼装回归没人挡。
  assert.equal(bodyMatchesFilters(body, spec), true);
});

test('buildSearchBody 对具体省份用 divisionList，而不是 extraDivision', () => {
  const { body } = buildSearchBody({ keyword: 'k', nativeFilters: { region: '上海' } });
  assert.equal(body.extraFilterValue, '{"divisionList":[{"province":"上海"}]}');
});

test('buildSearchBody 没有原生筛选时字段留空但仍然齐全', () => {
  const { body, spec } = buildSearchBody({ keyword: 'k' });
  assert.equal(body.propValueStr.searchFilter, '');
  assert.equal(body.extraFilterValue, '{}');
  assert.equal(body.sortField, '');
  assert.equal(body.sortValue, '');
  assert.equal(body.fromFilter, false);
  assert.equal(bodyMatchesFilters(body, spec), true);
});

// ---------- 核心不变量：每轮 1 次请求 ----------

test('一次搜索恰好发 1 次请求，响应直接解析成商品', async () => {
  const { searcher, calls } = makeSearcher([success()]);
  const task = {
    name: 't',
    keyword: '2K 显示器',
    nativeFilters: { priceRange: [500, 700], region: '江浙沪', sort: 'newest', publishDays: 3 },
  };
  const result = await searcher.search(task);

  assert.equal(calls.length, 1, '每轮必须恰好 1 次请求');
  assert.equal(result.requests, 1);
  assert.equal(result.source, 'api');
  assert.equal(result.items.length, FIXTURE_ITEMS, '结果应来自同一个响应体');
  assert.equal(result.items[0].url.includes('item?id='), true);

  const { spec } = buildSearchBody(task);
  assert.equal(bodyMatchesFilters(bodyOf(calls[0]), spec), true, '请求体必须带上配置的全部条件');
  assert.ok(calls[0].url.startsWith(`${MTOP.baseUrl}/${MTOP.api}/`), calls[0].url);
});

test('默认策略 omit：压根不发风控状态 cookie，所以不会有"先试一次"这回事', async () => {
  const { searcher, calls } = makeSearcher([success()]);
  await searcher.search({ name: 't', keyword: 'x' });

  assert.deepEqual(cookieNames(calls[0]), ['unb', '_m_h5_tk']);
  assert.deepEqual(searcher.refusedCookies, []);
});

test('riskCookies=remembered 时带上整份 cookie，但不预先摘', async () => {
  const { searcher, calls } = makeSearcher([success()], sourceCookies, { riskCookies: 'remembered' });
  await searcher.search({ name: 't', keyword: 'x' });

  assert.deepEqual(cookieNames(calls[0]), ['unb', '_m_h5_tk', 'sgcookie']);
  assert.deepEqual(searcher.refusedCookies, []);
});

test('被风控直接拒绝：当轮不重试，记下那个值不再重发，下一轮起不再携带', async () => {
  const { searcher, calls, store } = makeSearcher([denied(), success()], sourceCookies, { riskCookies: 'remembered' });

  await assert.rejects(
    () => searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'denied' && error.droppedCookies?.includes('sgcookie'),
  );
  assert.equal(calls.length, 1, '被拒当轮不能再打第二次，否则等于在被处罚期间加倍请求');

  const result = await searcher.search({ name: 't', keyword: 'x' });
  assert.equal(result.items.length, FIXTURE_ITEMS);
  assert.equal(calls.length, 2, '下一轮仍然只有 1 次请求');
  assert.deepEqual(cookieNames(calls[1]), ['unb', '_m_h5_tk'], '下一轮不再带被标记的 sgcookie');
  // 关键：拒绝要**落盘**。只在本进程内摘的话，每次启动都会先带着这个已知会被拒的 cookie 撞一次。
  assert.ok(
    store.refused.some((entry) => entry.name === 'sgcookie'),
    '被拒的值必须被记住并落盘',
  );
});

test('riskCookies=omit 时根本不发这类 cookie，省掉任何一次注定失败的请求', async () => {
  const { impl, calls } = fakeFetch([success()]);
  const searcher = new MtopSearcher({
    config: makeConfig({ riskCookies: 'omit' }),
    logger: {},
    cookies: memoryStore(),
    fetchImpl: impl,
  });

  await searcher.search({ name: 't', keyword: 'x' });

  assert.deepEqual(cookieNames(calls[0]), ['unb', '_m_h5_tk'], '压根不带 sgcookie，也就没有"试一次"');
});

test('记住的是「值」不是「名字」：服务端换发新的 sgcookie 时照常发出去', async () => {
  // 这正是与「永远不发 sgcookie」的区别——平台换发新值时，客户端应该有机会回到正常状态，
  // 而不是被我们永久地挡在门外。
  const store = memoryStore([...sourceCookies.slice(0, 2), { name: 'sgcookie', value: 'E1003-NEW' }]);
  store.refused.push({ name: 'sgcookie', value: 'E1003xDrIXP8' });
  const { impl, calls } = fakeFetch([success()]);
  const searcher = new MtopSearcher({
    config: makeConfig({ riskCookies: 'remembered' }),
    logger: {},
    cookies: store,
    fetchImpl: impl,
  });

  await searcher.search({ name: 't', keyword: 'x' });

  assert.deepEqual(cookieNames(calls[0]), ['unb', '_m_h5_tk', 'sgcookie'], '新值必须照发');
});

test('token 过期时换新 token 重签一次——这是「每轮 1 次」唯一的例外', async () => {
  const { searcher, calls } = makeSearcher([
    response({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'], data: {} }, ['_m_h5_tk=newtok_1700000000001; Path=/']),
    success(),
  ]);
  const result = await searcher.search({ name: 't', keyword: 'x' });

  assert.equal(calls.length, 2, '握手失败必须重签，否则整个链路是坏的');
  assert.equal(result.requests, 2);
  // 第二次必须用 Set-Cookie 里新下发的 token 签名，而不是沿用旧的。
  const second = new URL(calls[1].url);
  assert.equal(
    second.searchParams.get('sign'),
    mtopSign({
      token: 'newtok',
      t: second.searchParams.get('t'),
      appKey: MTOP.appKey,
      data: decodeURIComponent(/^data=(.*)$/.exec(calls[1].init.body)[1]),
    }),
  );
});

test('会话失效与其它错误按已有分类抛出，交给主循环退避', async () => {
  const auth = makeSearcher([response({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} })]);
  await assert.rejects(
    () => auth.searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'auth',
  );
  assert.equal(auth.calls.length, 1, '会话问题不重试');

  const api = makeSearcher([response({ ret: ['FAIL_SYS_PARAM_INVALID::参数错误'], data: {} })]);
  await assert.rejects(
    () => api.searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'api',
  );

  const down = makeSearcher([
    () => {
      throw new Error('socket hang up');
    },
  ]);
  await assert.rejects(
    () => down.searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'api' && /发不出去/.test(error.message),
  );
});

// ---------- 登录态探测：不再加载页面 ----------

test('checkSession 直接问 loginuser.get，一次请求、不加载任何页面', async () => {
  const { impl, calls } = fakeFetch([response({ ret: ['SUCCESS::调用成功'], data: {} })]);
  const searcher = new MtopSearcher({ config: makeConfig(), logger: {}, cookies: memoryStore(), fetchImpl: impl });

  assert.equal(await searcher.checkSession(), 'valid');
  assert.equal(calls.length, 1, '启动探测只要 1 次请求');
  assert.ok(calls[0].url.includes('loginuser.get'), calls[0].url);
});

test('checkSession 把「失效」和「判不准」分开，探测失败不拦启动', async () => {
  const expired = makeSearcher([response({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'], data: {} })]);
  assert.equal(await expired.searcher.checkSession(), 'invalid');

  const unclear = makeSearcher([response({ ret: ['FAIL_SYS_PARAM_INVALID::参数错误'], data: {} })]);
  assert.equal(await unclear.searcher.checkSession(), 'unknown');

  const offline = makeSearcher([
    () => {
      throw new Error('offline');
    },
  ]);
  assert.equal(await offline.searcher.checkSession(), 'unknown', '探测失败只能算不知道，不能拦住启动');
});

test('服务端把 EXPIRED 拼成 EXOIRED 时也必须认出来并重签', async () => {
  // 实测踩到的坑：`FAIL_SYS_TOKEN_EXOIRED::令牌过期`（服务端的拼写错误）。
  // 按字面枚举 TOKEN_EMPTY/TOKEN_ILLEGAL 会漏掉它，于是本该自动重签的一次握手
  // 被当成「搜索接口返回错误」，白白冷却两分钟，看上去像个神秘的新故障。
  const { searcher, calls } = makeSearcher([
    response({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'], data: {} }, ['_m_h5_tk=exoired_1700000000004; Path=/']),
    success(),
  ]);

  const result = await searcher.search({ name: 't', keyword: 'x' });

  assert.equal(calls.length, 2, '必须重签一次，而不是当成业务错误去退避');
  assert.equal(result.requests, 2);
  const second = new URL(calls[1].url);
  assert.equal(
    second.searchParams.get('sign'),
    mtopSign({
      token: 'exoired',
      t: second.searchParams.get('t'),
      appKey: MTOP.appKey,
      data: decodeURIComponent(/^data=(.*)$/.exec(calls[1].init.body)[1]),
    }),
    '第二次要用新下发的 token 签名',
  );
});

test('重签之后仍是 token 错误时，明确让人重新登录，而不是含糊的「接口返回错误」', async () => {
  const tokenError = () => response({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'], data: {} });
  const { searcher, calls } = makeSearcher([tokenError(), tokenError()]);

  await assert.rejects(
    () => searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'auth' && /重新扫码登录/.test(error.message),
  );
  assert.equal(calls.length, 2, '最多试两次，不能在这里反复撞');
});

test('checkSession 在 token 冷启动时报空时，换新 token 重问一次', async () => {
  const { searcher, calls } = makeSearcher([
    response({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'], data: {} }, ['_m_h5_tk=freshtok_1700000000002; Path=/']),
    response({ ret: ['SUCCESS::调用成功'], data: {} }),
  ]);

  assert.equal(await searcher.checkSession(), 'valid');
  assert.equal(calls.length, 2);
});

test('读不到 cookie 时明确报「登录态读不到」，而不是空 cookie 发出去被当成未登录', async () => {
  const { impl, calls } = fakeFetch([success()]);
  const searcher = new MtopSearcher({
    config: makeConfig(),
    logger: {},
    cookies: {
      file: '/broken/cookies.json',
      async load() {
        throw new Error('Unexpected token in JSON');
      },
      async save() {},
    },
    fetchImpl: impl,
  });

  await assert.rejects(
    () => searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'auth' && /读不到登录 cookie/.test(error.message),
  );
  assert.equal(calls.length, 0, '读不到 cookie 就一个请求都不该发出去');
});

test('一个 cookie 都没有时直接说清怎么办，不把空 cookie 发出去', async () => {
  const { impl, calls } = fakeFetch([success()]);
  const searcher = new MtopSearcher({ config: makeConfig(), logger: {}, cookies: memoryStore([]), fetchImpl: impl });

  await assert.rejects(
    () => searcher.search({ name: 't', keyword: 'x' }),
    (error) => error.code === 'auth' && /login/.test(error.message),
  );
  assert.equal(calls.length, 0);
  assert.equal(await searcher.checkSession(), 'invalid', '没有 cookie 就是「没登录过」，不该报成判不准');
});

test('响应里的 cookie2 也会被吸收并落盘，不只 _m_h5_tk', async () => {
  // cookie2 是会话级 cookie（关掉浏览器即失效），而 mtop 必须带它；以前它靠加载页面续期，
  // 现在搜索不经过页面，只剩 Set-Cookie 这一条途径——这条断言就是钉住那条途径。
  const { searcher, store } = makeSearcher([
    response(fixture, [
      '_m_h5_tk=tok2_1700000000003; Path=/',
      'cookie2=abc123; Path=/; Domain=.goofish.com; Max-Age=31536000',
    ]),
  ]);

  await searcher.search({ name: 't', keyword: 'x' });

  assert.equal(store.saves, 1, '收到新 cookie 就应该落盘一次');
  const jar = await store.load();
  assert.equal(jar.get('cookie2').value, 'abc123');
  assert.equal(jar.get('_m_h5_tk').value, 'tok2_1700000000003');
});


test('http 模式下一个浏览器都不需要', async () => {
  // 这就是 C 方案的全部意义：监控侧不启浏览器、没有窗口、服务器上也不需要 Xvfb。
  const searcher = await createSearcher({ config: makeConfig(), logger: {} });
  assert.ok(searcher instanceof MtopSearcher);
});

// ---------- 不并发、不短时高频 ----------

test('同时发起的多次搜索会被自动拉开，不会并发打出去', async () => {
  const { impl, calls } = fakeFetch([success(), success(), success()]);
  const searcher = new MtopSearcher({
    // 0.12 秒的间隔足够短，不会拖慢测试；又足够长，能挡住"同一瞬间飞出去"。
    config: makeConfig({ mode: 'http' }, { minRequestGapSeconds: 0.12 }),
    logger: {},
    cookies: memoryStore(),
    fetchImpl: impl,
  });

  const started = Date.now();
  await Promise.all([
    searcher.search({ name: 'a', keyword: 'x' }),
    searcher.search({ name: 'b', keyword: 'x' }),
    searcher.search({ name: 'c', keyword: 'x' }),
  ]);
  const elapsed = Date.now() - started;

  assert.equal(calls.length, 3);
  // 三个请求彼此至少隔 0.12s，所以总耗时不可能低于 0.24s。若闸失效，三个会几乎同时返回。
  assert.ok(elapsed >= 240, `三个并发搜索应被拉开到至少 240ms，实际 ${elapsed}ms`);
});

test('间隔设为 0 时不做任何等待（留给需要急速验证的场合）', async () => {
  const { impl, calls } = fakeFetch([success(), success()]);
  const searcher = new MtopSearcher({
    config: makeConfig({ mode: 'http' }, { minRequestGapSeconds: 0 }),
    logger: {},
    cookies: memoryStore(),
    fetchImpl: impl,
  });

  const started = Date.now();
  await searcher.search({ name: 'a', keyword: 'x' });
  await searcher.search({ name: 'b', keyword: 'x' });
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 200, '显式把间隔设成 0 时不应该还有等待');
});
