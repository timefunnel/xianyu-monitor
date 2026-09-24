import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoofishBrowser } from '../src/browser.mjs';

/**
 * 构造一个「像 Page 一样」的替身，按脚本在 goto 与每次 waitForTimeout 时发出 loginuser.get 响应。
 * @param {{results: Array<string|null>, resourceType?: string}} options
 */
function fakePage({ results }) {
  const listeners = [];
  let index = 0;
  const emit = () => {
    if (index >= results.length) return;
    const ret = results[index];
    index += 1;
    if (ret === null) return;
    const response = {
      url: () => 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.loginuser.get/1.0/',
      json: async () => ({ ret: [ret] }),
    };
    for (const handler of [...listeners]) handler(response);
  };
  return {
    on: (event, handler) => {
      if (event === 'response') listeners.push(handler);
    },
    off: (event, handler) => {
      const at = listeners.indexOf(handler);
      if (at >= 0) listeners.splice(at, 1);
    },
    async goto() {
      emit();
    },
    async waitForTimeout() {
      emit();
    },
    listenerCount: () => listeners.length,
  };
}

/** 用极短的确认窗口跑一次 checkSession。 */
async function check(results) {
  const browser = new GoofishBrowser({ baseUrl: 'https://www.goofish.com', responseTimeoutMs: 300 }, { warn() {} });
  browser.page = fakePage({ results });
  const verdict = await browser.checkSession();
  return { verdict, page: browser.page };
}

test('登录后第一次失败、重试成功时判定为有效（实测 mtop 冷启动就是这个行为）', async () => {
  const { verdict, page } = await check(['FAIL_SYS_SESSION_EXPIRED::Session过期', 'SUCCESS::调用成功']);
  assert.equal(verdict, 'valid');
  assert.equal(page.listenerCount(), 0, '监听器应被摘除');
});

test('全部返回会话过期才判定为失效', async () => {
  const { verdict } = await check(['FAIL_SYS_SESSION_EXPIRED::Session过期', 'FAIL_SYS_SESSION_EXPIRED::Session过期']);
  assert.equal(verdict, 'invalid');
});

test('一次都没等到 loginuser.get 时返回 unknown，不据此判定登录失败', async () => {
  const { verdict } = await check([]);
  assert.equal(verdict, 'unknown');
});

test('第一次就成功时立即返回，不等满确认窗口', async () => {
  const started = Date.now();
  const { verdict } = await check(['SUCCESS::调用成功']);
  assert.equal(verdict, 'valid');
  assert.ok(Date.now() - started < 250, '应当在第一个 SUCCESS 处提前返回');
});

test('浏览器窗口被关掉后，下一次搜索会先重新拉起（否则会永久卡在 closed）', async () => {
  const opened = [];
  const browser = new GoofishBrowser(
    { baseUrl: 'https://www.goofish.com', linkTemplate: 'https://www.goofish.com/item?id={id}', navigationTimeoutMs: 1000, responseTimeoutMs: 1000 },
    { warn() {} },
  );
  // 模拟「窗口已被手动关闭」：关闭后的上下文调用任何方法都会抛，Playwright 就是这个行为
  browser.context = {
    pages() {
      throw new Error('Target page, context or browser has been closed');
    },
  };
  browser.open = async () => {
    opened.push('open');
    browser.context = { pages: () => [] };
  };

  // 走到「创建页面」那步就会停（替身里没有 newPage），这里只关心它有没有先重新 open
  await browser.search({ keyword: 'x', name: 't' }).catch(() => {});
  assert.deepEqual(opened, ['open'], '上下文关闭时必须先重新拉起浏览器');
});
