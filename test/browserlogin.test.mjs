// 浏览器登录助手（src/browserlogin.mjs）。
//
// 这一段真正值钱的不变量只有两条：
//   1. 只把闲鱼/淘宝域的 cookie 收进登录态（浏览器 profile 里还有一堆别的站点）；
//   2. **登录没被验证通过之前**，绝不把抓到的 cookie 交出去——否则一次失败的登录
//      会把磁盘上那份还能用的登录态冲掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  authFingerprint,
  browserLogin,
  captureFromChromeProfile,
  chromeUserDataDir,
  cookiesToJar,
  isChromeRunning,
  isProfileBusy,
  isSiteDomain,
  prepareProfileCopy,
} from '../src/browserlogin.mjs';

const cookie = (name, value, domain = '.goofish.com') => ({ name, value, domain, path: '/', expires: -1 });

test('isSiteDomain 认闲鱼与淘宝的子域，别的一律不要', () => {
  assert.equal(isSiteDomain('.goofish.com'), true);
  assert.equal(isSiteDomain('passport.goofish.com'), true);
  assert.equal(isSiteDomain('.taobao.com'), true);
  assert.equal(isSiteDomain('.google.com'), false);
  // 防后缀拼接：notgoofish.com 不是 goofish.com 的子域。
  assert.equal(isSiteDomain('notgoofish.com'), false);
});

test('cookiesToJar 只留本站 cookie，并丢掉空值', () => {
  const jar = cookiesToJar([
    cookie('unb', '2214928720161'),
    cookie('cookie2', 'abc', '.taobao.com'),
    cookie('NID', 'google', '.google.com'),
    cookie('empty', '', '.goofish.com'),
  ]);
  assert.deepEqual([...jar.keys()].sort(), ['cookie2', 'unb']);
  assert.equal(jar.get('unb').expires, -1, '会话级 cookie 保持 -1');
});

test('authFingerprint 在 cookie2 变化时会变——这是"刚登录过"的判据', () => {
  const before = new Map([['unb', cookie('unb', 'u1')], ['cookie2', cookie('cookie2', 'c1')]]);
  const after = new Map([['unb', cookie('unb', 'u1')], ['cookie2', cookie('cookie2', 'c2')]]);
  assert.notEqual(authFingerprint(before), authFingerprint(after));
  assert.equal(authFingerprint(before), authFingerprint(new Map(before)));
});

/**
 * 假的 Playwright 上下文：每次 `cookies()` 返回当前快照，`setCookies` 用来模拟用户登录。
 */
function fakeBrowser(initialCookies) {
  let current = initialCookies;
  const page = { async goto() {} };
  const context = {
    closed: false,
    async cookies() {
      return current;
    },
    pages() {
      return this.closed ? [] : [page];
    },
    async newPage() {
      return page;
    },
    async close() {
      this.closed = true;
    },
    /** 模拟"用户在窗口里登录成功"。 */
    login(cookies) {
      current = cookies;
    },
  };
  return context;
}

test('浏览器里本来就登录着：不用打扰用户，直接复用并校验', async () => {
  const context = fakeBrowser([cookie('unb', 'u1'), cookie('cookie2', 'c1')]);
  const seen = [];
  const result = await browserLogin({
    userDataDir: '(test)',
    timeoutSeconds: 5,
    pollIntervalMs: 1,
    launch: async () => context,
    verify: async (jar) => {
      seen.push(jar);
      return true;
    },
  });
  assert.equal(result.alreadyLoggedIn, true);
  assert.equal(result.jar.get('unb').value, 'u1');
  assert.equal(seen.length, 1, '只问一次登录态');
  assert.equal(context.closed, true, '用完要关窗口，别留一个看不见的 Chrome');
});

test('用户完成手机号+验证码登录后，抓到新 cookie 才返回', async () => {
  const context = fakeBrowser([cookie('cookie2', 'old')]);
  let verified = 0;
  const pending = browserLogin({
    userDataDir: '(test)',
    timeoutSeconds: 5,
    pollIntervalMs: 1,
    launch: async () => context,
    verify: async (jar) => {
      verified += 1;
      return jar.get('unb')?.value === 'u-new';
    },
  });
  // 等第一轮轮询过去，再模拟登录成功。
  await new Promise((resolve) => setTimeout(resolve, 50));
  context.login([cookie('unb', 'u-new'), cookie('cookie2', 'new')]);
  const result = await pending;
  assert.equal(result.alreadyLoggedIn, false);
  assert.equal(result.jar.get('unb').value, 'u-new');
  assert.ok(verified >= 1);
  assert.equal(context.closed, true);
});

test('一直没登录就超时报错，而不是把旧 cookie 当成功交出去', async () => {
  const context = fakeBrowser([]);
  await assert.rejects(
    () =>
      browserLogin({
        userDataDir: '(test)',
        timeoutSeconds: 0.2,
        pollIntervalMs: 5,
        launch: async () => context,
        verify: async () => false,
      }),
    /超时/,
  );
  assert.equal(context.closed, true, '超时也要把窗口关掉');
});

test('用户把窗口关了：立刻说清楚，不干等满超时', async () => {
  const context = fakeBrowser([cookie('cookie2', 'old')]);
  const pending = browserLogin({
    userDataDir: '(test)',
    timeoutSeconds: 30,
    pollIntervalMs: 5,
    launch: async () => context,
    verify: async () => false,
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  context.closed = true;
  await assert.rejects(() => pending, /关掉/);
});

test('chromeUserDataDir 按平台给出 Chrome 的 profile 目录', () => {
  assert.equal(
    chromeUserDataDir({ LOCALAPPDATA: String.raw`C:\Users\x\AppData\Local` }, 'win32'),
    String.raw`C:\Users\x\AppData\Local\Google\Chrome\User Data`,
  );
  assert.equal(
    chromeUserDataDir({ HOME: '/Users/x' }, 'darwin'),
    '/Users/x/Library/Application Support/Google/Chrome',
  );
  assert.equal(chromeUserDataDir({ HOME: '/home/x' }, 'linux'), '/home/x/.config/google-chrome');
  assert.equal(chromeUserDataDir({}, 'win32'), '', '拿不到环境变量时返回空串，由调用方报错');
});

test('isProfileBusy 认得出「Chrome 还开着」，别的启动错误不吞', () => {
  // 真实报错长这样：Failed to create a ProcessSingleton for your profile directory.
  assert.equal(isProfileBusy(new Error('Failed to create a ProcessSingleton for your profile directory.')), true);
  assert.equal(isProfileBusy(new Error('SingletonLock: File exists')), true);
  assert.equal(isProfileBusy(new Error('browserType.launch: Executable doesn\'t exist')), false);
});

test('从 Chrome 读登录态：先等它退出，再抓 cookie 并校验', async () => {
  const context = fakeBrowser([cookie('unb', 'u-chrome'), cookie('cookie2', 'c-chrome')]);
  let attempts = 0;
  const result = await captureFromChromeProfile({
    chromeRunning: async () => false,
    userDataDir: '(test)',
    prepareProfile: () => '(copy)',
    timeoutSeconds: 5,
    pollIntervalMs: 1,
    launch: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Failed to create a ProcessSingleton for your profile directory.');
      return context;
    },
    verify: async (jar) => jar.get('unb')?.value === 'u-chrome',
  });
  assert.equal(attempts, 2, '第一次被占用，等下一轮再试');
  assert.equal(result.jar.get('unb').value, 'u-chrome');
  assert.equal(context.closed, true);
});

test('从 Chrome 读到的会话服务端不认时，明确报错而不是写盘', async () => {
  const context = fakeBrowser([cookie('unb', 'u-old')]);
  await assert.rejects(
    () =>
      captureFromChromeProfile({
        chromeRunning: async () => false,
        userDataDir: '(test)',
        prepareProfile: () => '(copy)',
        timeoutSeconds: 5,
        pollIntervalMs: 1,
        launch: async () => context,
        verify: async () => false,
      }),
    /服务端不认/,
  );
  assert.equal(context.closed, true);
});

test('从 Chrome 里读不到登录态时，说明是应用绑定加密并给出粘贴导入这条路', async () => {
  const context = fakeBrowser([cookie('cookie2', 'c-only')]);
  await assert.rejects(
    () =>
      captureFromChromeProfile({
        chromeRunning: async () => false,
        userDataDir: '(test)',
        prepareProfile: () => '(copy)',
        timeoutSeconds: 5,
        pollIntervalMs: 1,
        launch: async () => context,
        verify: async () => true,
      }),
    /应用绑定加密/,
  );
});

test('Chrome 还开着时不去反复启动它，只安静地等进程消失', async () => {
  // 线上踩过：旧实现每 2 秒都试着启动一次，被占用就报错重试——等于每 2 秒拉起一个 chrome.exe
  // 又立刻退出，白白折腾几十分钟。现在先查进程，进程还在就什么都不做。
  const context = fakeBrowser([cookie('unb', 'u1'), cookie('cookie2', 'c1')]);
  let running = 2;
  let launches = 0;
  const result = await captureFromChromeProfile({
    userDataDir: '(test)',
    prepareProfile: () => '(copy)',
    timeoutSeconds: 10,
    pollIntervalMs: 1,
    chromeRunning: async () => running-- > 0,
    launch: async () => {
      launches += 1;
      return context;
    },
    verify: async () => true,
  });
  assert.equal(launches, 1, 'Chrome 还在的前两轮不该启动浏览器');
  assert.equal(result.jar.get('unb').value, 'u1');
});

test('isChromeRunning 认得出进程在不在，命令失败时按「不在」处理', async () => {
  const ok = (stdout) => async () => ({ stdout });
  assert.equal(await isChromeRunning(ok('chrome.exe\t1234 Console\t1\t10,000 K\r\n')), true);
  assert.equal(await isChromeRunning(ok('信息: 没有运行的任务匹配指定标准。')), false);
  assert.equal(
    await isChromeRunning(async () => {
      throw new Error('tasklist 不存在');
    }),
    false,
  );
});

test('复制默认 profile 时只搬登录态要用的文件，搬完能启动、用完能删', async () => {
  // 线上踩过：Chrome 136 起拒绝把默认 profile 直接当 --user-data-dir
  //（"DevTools remote debugging requires a non-default data directory."），
  // 所以必须先复制出副本。这里验证副本内容够用（含 Local State 里的解密密钥），用完删掉。
  const real = mkdtempSync(path.join(tmpdir(), 'xianyu-real-profile-'));
  mkdirSync(path.join(real, 'Default', 'Network'), { recursive: true });
  writeFileSync(path.join(real, 'Local State'), '{"os_crypt":{}}', 'utf8');
  writeFileSync(path.join(real, 'Default', 'Network', 'Cookies'), 'SQLite format 3', 'utf8');

  let launched = null;
  const context = fakeBrowser([cookie('unb', 'u'), cookie('cookie2', 'c')]);
  const result = await captureFromChromeProfile({
    userDataDir: real,
    chromeRunning: async () => false,
    timeoutSeconds: 5,
    pollIntervalMs: 1,
    launch: async (options) => {
      launched = options.userDataDir;
      assert.notEqual(launched, real, '绝不能把默认 profile 直接交给 Chrome');
      assert.ok(existsSync(path.join(launched, 'Local State')), '解密密钥要跟着副本走');
      assert.ok(existsSync(path.join(launched, 'Default', 'Network', 'Cookies')), 'cookie 库要跟着副本走');
      return context;
    },
    verify: async () => true,
  });
  assert.equal(result.jar.get('unb').value, 'u');
  assert.equal(existsSync(launched), false, '用完把临时副本删掉，别把 cookie 留在临时目录');
});

test('默认 profile 里找不到 cookie 库时，明确报错而不是造一个空 profile 去启动', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'xianyu-empty-profile-'));
  assert.throws(() => prepareProfileCopy(empty), /没在这个目录里找到/);
});
