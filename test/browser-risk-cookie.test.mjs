// 风控 cookie 复位：`sgcookie` 是被风控标记的状态令牌，带上它的搜索请求会被直接拒绝
// （处罚链接 action=deny）。复位它就能恢复，但**绝不能顺手把登录 cookie 一起端掉**，
// 否则监控会从「被风控」变成「未登录」，问题更难查。所以这里把边界钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoofishBrowser } from '../src/browser.mjs';

/** 替身 logger：GoofishBrowser 内部用 `this.logger?.warn(...)` 记日志，缺方法会直接抛。 */
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 造一个只实现 cookies / clearCookies 的 context 替身。 */
function fakeContext(cookies) {
  const cleared = [];
  return {
    cleared,
    cookies: async () => cookies,
    clearCookies: async (options) => {
      cleared.push(options?.name);
    },
  };
}

test('dropRiskCookies 只复位被标记的 sgcookie，不动登录 cookie', async () => {
  const context = fakeContext([
    { name: 'unb', value: '2214928720161' },
    { name: 'sgcookie', value: 'E1003xDrIXP8' },
    { name: 'cbc', value: 'T2gAltrTVdJ7' },
    { name: '_m_h5_tk', value: 'defa3dd49bf2_1790000000000' },
  ]);
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', userDataDir: 'unused' }, {});
  browser.context = context;

  assert.deepEqual(await browser.dropRiskCookies(), ['sgcookie']);
  assert.deepEqual(context.cleared, ['sgcookie'], '只能清单个 sgcookie，不能波及登录态');
});

test('dropRiskCookies 在没有被标记的 cookie 时什么都不做', async () => {
  const context = fakeContext([{ name: 'unb', value: '2214928720161' }]);
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', userDataDir: 'unused' }, {});
  browser.context = context;

  assert.deepEqual(await browser.dropRiskCookies(), []);
  assert.deepEqual(context.cleared, []);
});

test('dropRiskCookies 在浏览器还没启动时返回空数组而不是抛错', async () => {
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', userDataDir: 'unused' }, {});
  assert.deepEqual(await browser.dropRiskCookies(), []);
});

test('cookies() 在窗口被关掉后会重新拉起，而不是静默返回空', async () => {
  // http 模式下浏览器窗口是空白的，用户很可能顺手关掉；关掉之后如果读到空 cookie，
  // 请求会以「未登录」的身份发出去，看起来像风控或封号——这条防线就是为它立的。
  const opened = [];
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', userDataDir: 'unused' }, silentLogger);
  browser.context = {
    pages() {
      throw new Error('Target page, context or browser has been closed');
    },
  };
  browser.open = async () => {
    opened.push('open');
    browser.context = { cookies: async () => [{ name: 'unb', value: '2214928720161' }] };
  };

  assert.deepEqual(await browser.cookies(), [{ name: 'unb', value: '2214928720161' }]);
  assert.deepEqual(opened, ['open'], '窗口被关掉后必须重新拉起');
});

test('cookies() 读失败时抛出，绝不吞成空数组', async () => {
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', userDataDir: 'unused' }, silentLogger);
  browser.context = {
    pages: () => [],
    cookies: async () => {
      throw new Error('read failed');
    },
  };

  await assert.rejects(() => browser.cookies(), /read failed/);
});
