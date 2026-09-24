// 纯 HTTP 扫码登录：整个流程用假 fetch 跑通，**一个真实请求都不发**。
//
// 这里能验的是协议接线（参数有没有带对、Set-Cookie 有没有吸收、状态机有没有走对）；
// 「服务端到底认不认」只有真人扫一次码才知道——那一步留给使用者自己跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import jsQR from 'jsqr';
import { FileCookieStore } from '../src/cookies.mjs';
import { QrLoginSession, qrLogin, renderQrSvg, renderQrTerminal, makeCna, absorbSetCookies, setCookiesOf } from '../src/qrlogin.mjs';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'xianyu-qr-'));
  return new FileCookieStore({ file: path.join(dir, 'cookies.json'), logger: silentLogger });
}

function jsonResponse(body, setCookies = [], { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (String(name).toLowerCase() === 'set-cookie' ? setCookies.join(', ') : null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * 假的服务端：按 URL 路由，并记录收到的请求。
 * @param {{statuses?: string[], tokenField?: string, token?: string, loginCookies?: string[], setCookieOnConfirm?: string[]}} [options]
 */
function fakePassport({ statuses = ['NEW', 'SCANNED', 'CONFIRMED'], tokenField = 'token', token = 'tok-1', loginCookies = ['unb=12345; Path=/', '_tb_token_=abc; Path=/', 'cookie2=fresh; Path=/'], landingCookies = ['XSRF-TOKEN=csrf-1; Path=/', 'cookie2=base-2; Path=/', '_samesite_flag_=true; Path=/'], setCookieOnConfirm = [] } = {}) {
  const requests = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    requests.push({ url: href, method: init.method ?? 'GET', body: String(init.body ?? ''), cookie: init.headers?.cookie ?? '' });
    if (href.includes('/mini_login.htm')) {
      return jsonResponse({}, landingCookies);
    }
    if (href.includes('/newlogin/qrcode/generate.do')) {
      return jsonResponse({
        content: { success: true, data: { t: 1790237764126, ck: 'ck-1', codeContent: 'https://passport.goofish.com/qrcodeCheck.htm?lgToken=lg-1&_from=havana' } },
      });
    }
    if (href.includes('/newlogin/qrcode/query.do')) {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      const data = { qrCodeStatus: status, resultCode: 100 };
      if (status === 'CONFIRMED') data[tokenField] = token;
      return jsonResponse({ content: { success: true, data } }, status === 'CONFIRMED' ? setCookieOnConfirm : []);
    }
    if (href.includes('/login_token/login.do')) {
      return jsonResponse({ content: { success: true } }, loginCookies);
    }
    if (href.includes('idle.web.user.page.nav')) {
      return jsonResponse({ ret: ['SUCCESS::调用成功'] }, ['_m_h5_tk=tk-9_1790000000000; Path=/; Domain=.goofish.com']);
    }
    throw new Error(`假服务端没实现这个地址：${href}`);
  };
  return { fetchImpl, requests, get polls() { return polls; } };
}

test('完整走通：登录页 → 二维码 → 轮询 → 完成登录 → 刷新令牌 → 落盘', async () => {
  const store = makeStore();
  const passport = fakePassport();
  const qr = { terminal: '', svg: '' };
  const waits = [];

  const result = await qrLogin({
    store,
    logger: silentLogger,
    fetchImpl: passport.fetchImpl,
    pollIntervalMs: 1,
    onQr: (info) => Object.assign(qr, info),
    onWait: (info) => waits.push(info.status),
  });

  assert.equal(result.ok, true, `缺件：${result.missing.join(',')}`);
  assert.deepEqual(result.missing, []);

  // 二维码真的渲染出来了：终端那份要能被手机扫，SVG 那份要给控制台
  assert.match(qr.codeContent, /^https:\/\/passport\.goofish\.com\/qrcodeCheck\.htm\?lgToken=/);
  assert.ok(qr.terminal.length > 100, '终端二维码不该是空的');
  assert.ok(qr.terminal.includes('█'), '终端二维码应该用半块字符画出来');
  assert.match(qr.svg, /^<svg[\s>]/, 'SVG 二维码应以 <svg 开头');

  // 状态机：NEW、SCANNED 各等一次
  assert.deepEqual(waits, ['NEW', 'SCANNED']);

  // 落盘内容：登录凭据 + 刷新到的 mtop 令牌
  const saved = JSON.parse(readFileSync(store.file, 'utf8'));
  const names = saved.cookies.map((cookie) => cookie.name).sort();
  for (const name of ['unb', '_tb_token_', 'cookie2', '_m_h5_tk']) {
    assert.ok(names.includes(name), `落盘的 cookie 里应该有 ${name}，实际：${names.join(',')}`);
  }
  assert.equal(saved.cookies.find((cookie) => cookie.name === 'cookie2').value, 'fresh', '同名的 cookie2 应被新值覆盖');

  // 参数接线：轮询与完成登录都要带 deviceId，且登录页拿到的 XSRF-TOKEN 要带进 generate
  const generate = passport.requests.find((entry) => entry.url.includes('generate.do'));
  assert.match(generate.url, /_csrf_token=csrf-1/, 'generate 应带上登录页给的 XSRF-TOKEN');
  assert.match(generate.url, /hsiz=base-2/, 'generate 应带上登录页给的 cookie2');
  const query = passport.requests.find((entry) => entry.url.includes('query.do'));
  assert.match(query.body, /deviceId=[0-9a-f]{24}/, '轮询要带 deviceId');
  assert.match(query.body, /t=1790237764126/);
  assert.match(query.body, /ck=ck-1/);
  const login = passport.requests.find((entry) => entry.url.includes('login_token'));
  assert.match(login.url, /token=tok-1/);
  assert.match(login.url, /bizScene=qrcode/);
  assert.match(login.body, /deviceId=[0-9a-f]{24}/);
});

test('登录令牌字段名漂移：token / lgToken / st / stEx 都要能兜住', async () => {
  for (const field of ['token', 'lgToken', 'st', 'stEx']) {
    const store = makeStore();
    const passport = fakePassport({ statuses: ['CONFIRMED'], tokenField: field, token: 'tok-drift' });
    await qrLogin({ store, logger: silentLogger, fetchImpl: passport.fetchImpl, pollIntervalMs: 1 });
    const login = passport.requests.find((entry) => entry.url.includes('login_token'));
    assert.ok(login, `${field} 也要能走完完成登录`);
    assert.match(login.url, /token=tok-drift/);
  }
});

test('扫码状态拼写不统一也不受影响：只认 CONFIRMED 与 EXPIRED', async () => {
  const store = makeStore();
  // SCANED 是某实现的拼写，SCANNED 是另一家的；两个都不该被当成异常
  const passport = fakePassport({ statuses: ['NEW', 'SCANED', 'SCANNED', 'CONFIRMED'] });
  const waits = [];
  const result = await qrLogin({
    store,
    logger: silentLogger,
    fetchImpl: passport.fetchImpl,
    pollIntervalMs: 1,
    onWait: (info) => waits.push(info.status),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(waits, ['NEW', 'SCANED', 'SCANNED'], '认不出来的状态一律继续等');
});

test('二维码过期时给出人话，而不是干等', async () => {
  const store = makeStore();
  const passport = fakePassport({ statuses: ['EXPIRED'] });
  await assert.rejects(
    () => qrLogin({ store, logger: silentLogger, fetchImpl: passport.fetchImpl, pollIntervalMs: 1 }),
    /二维码已过期/,
  );
});

test('缺凭据时 ok 为 false 并报出缺件，而且**不覆盖**原有的登录态', async () => {
  // cookie2 在登录页那步就会下发，所以真正要盯的是「登录页给了 cookie2、但登录没拿到 unb」这种
  // 看起来正常、实际没登录的情况。
  const noUnbStore = makeStore();
  // 先放一份"能用"的登录态进去，然后跑一次注定失败的登录
  const good = new Map([['unb', { name: 'unb', value: 'old-good', domain: '.goofish.com', path: '/' }]]);
  await noUnbStore.save(good);
  const before = readFileSync(noUnbStore.file, 'utf8');

  const noUnb = fakePassport({ loginCookies: ['_tb_token_=abc; Path=/', 'cookie2=fresh; Path=/'] });
  const noUnbResult = await qrLogin({ store: noUnbStore, logger: silentLogger, fetchImpl: noUnb.fetchImpl, pollIntervalMs: 1 });
  assert.equal(noUnbResult.ok, false);
  assert.deepEqual(noUnbResult.missing, ['unb'], 'unb 才是登录成功的证据');
  assert.equal(readFileSync(noUnbStore.file, 'utf8'), before, '登录失败绝不能把原来那份能用的登录态覆盖掉');

  const noCookie2Store = makeStore();
  const noCookie2 = fakePassport({ landingCookies: ['XSRF-TOKEN=csrf-1; Path=/'], loginCookies: ['unb=12345; Path=/'] });
  const noCookie2Result = await qrLogin({ store: noCookie2Store, logger: silentLogger, fetchImpl: noCookie2.fetchImpl, pollIntervalMs: 1 });
  assert.equal(noCookie2Result.ok, false);
  assert.deepEqual(noCookie2Result.missing, ['cookie2']);
});

test('令牌为空但已经拿到 unb：按服务端已完成登录处理，不再调 login_token', async () => {
  const store = makeStore();
  const passport = fakePassport({ statuses: ['CONFIRMED'], tokenField: 'token', token: '', setCookieOnConfirm: ['unb=999; Path=/', 'cookie2=via-confirm; Path=/'] });
  const result = await qrLogin({ store, logger: silentLogger, fetchImpl: passport.fetchImpl, pollIntervalMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(passport.requests.filter((entry) => entry.url.includes('login_token')).length, 0, '没有令牌就不该去调完成登录');
  const saved = JSON.parse(readFileSync(store.file, 'utf8'));
  assert.ok(saved.cookies.some((cookie) => cookie.name === 'unb'));
});

test('刷新 mtop 令牌失败不致命：登录态照常落盘', async () => {
  const store = makeStore();
  const passport = fakePassport();
  const original = passport.fetchImpl;
  const failing = async (url, init) => {
    if (String(url).includes('idle.web.user.page.nav')) throw new Error('网络抖动');
    return original(url, init);
  };
  const result = await qrLogin({ store, logger: silentLogger, fetchImpl: failing, pollIntervalMs: 1 });
  assert.equal(result.ok, true, '刷新令牌失败不该让整个登录失败');
  const saved = JSON.parse(readFileSync(store.file, 'utf8'));
  assert.ok(saved.cookies.some((cookie) => cookie.name === 'unb'), '登录凭据仍然要落盘');
});

test('makeCna 是 24 位十六进制', () => {
  assert.match(makeCna(0), /^[0-9a-f]{24}$/);
  assert.notEqual(makeCna(0), makeCna(0), '两次调用应不同（随机部分）');
});

test('absorbSetCookies：同名覆盖、属性缺失沿用旧值、坏行忽略', () => {
  const jar = new Map();
  absorbSetCookies(jar, ['a=1; Path=/; Domain=.goofish.com; Secure']);
  assert.equal(jar.get('a').value, '1');
  assert.equal(jar.get('a').domain, '.goofish.com');
  assert.equal(jar.get('a').secure, true);

  // 属性不全时沿用旧值，不能因为少个 Domain 就把它当成别的域
  absorbSetCookies(jar, ['a=2']);
  assert.equal(jar.get('a').value, '2');
  assert.equal(jar.get('a').domain, '.goofish.com');
  assert.equal(jar.get('a').secure, true);

  absorbSetCookies(jar, ['', 'garbage', 'b=3']);
  assert.equal(jar.size, 2);
});

test('setCookiesOf 在没有 getSetCookie 的老 Node 上退化切分', () => {
  const legacy = { headers: { get: () => 'a=1; Path=/, b=2; Path=/' } };
  assert.deepEqual(setCookiesOf(legacy), ['a=1; Path=/', 'b=2; Path=/']);
  const modern = { headers: { getSetCookie: () => ['a=1'], get: () => null } };
  assert.deepEqual(setCookiesOf(modern), ['a=1']);
});

test('渲染函数对空/超长内容都不抛，且二维码尺寸随内容增长', () => {
  assert.match(renderQrSvg('x'), /^<svg/);
  assert.ok(renderQrTerminal('x').length > 0);
  const short = renderQrSvg('https://a.example');
  const long = renderQrSvg(`https://passport.goofish.com/qrcodeCheck.htm?lgToken=${'f'.repeat(200)}`);
  assert.ok(long.length > short.length, '内容越长二维码越密');
});

/**
 * 把终端二维码还原成 RGBA 点阵：每个字符是一列的上下两个模块
 * （`█`=11、`▀`=10、`▄`=01、空格=00）。留白不裁剪也没关系，解码器会自己找定位图案。
 */
function asciiToRgba(ascii, scale = 4) {
  const halves = { '█': [1, 1], '▀': [1, 0], '▄': [0, 1], ' ': [0, 0] };
  const lines = ascii.split('\n').filter((line) => line.length > 0);
  const cols = Math.max(...lines.map((line) => line.length));
  const size = cols * scale;
  const height = lines.length * 2 * scale;
  const data = new Uint8ClampedArray(size * height * 4).fill(255);
  const paint = (x, y) => {
    const index = (y * size + x) * 4;
    data[index] = 0;
    data[index + 1] = 0;
    data[index + 2] = 0;
    data[index + 3] = 255;
  };
  lines.forEach((line, row) => {
    [...line].forEach((char, col) => {
      const half = halves[char];
      if (!half) return;
      half.forEach((dark, offset) => {
        if (!dark) return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            paint(col * scale + dx, (row * 2 + offset) * scale + dy);
          }
        }
      });
    });
  });
  return { data, width: size, height };
}

test('终端二维码真的能扫：把 ASCII 还原成点阵后，解码器能解出原文', () => {
  // 这条是这个功能最大的风险点：二维码画错了就是扫码失败，而"看起来像二维码"完全说明不了问题。
  // 所以真的解码一次——用的是纯 JS 解码器，不联网、不依赖摄像头。
  const payload = 'https://passport.goofish.com/qrcodeCheck.htm?lgToken=lg-abc123&_from=havana';
  const ascii = renderQrTerminal(payload);
  const { data, width, height } = asciiToRgba(ascii);
  const found = jsQR(data, width, height);
  assert.ok(found, '终端二维码应该能被解码');
  assert.equal(found.data, payload, '解出来的内容必须和二维码原文一致');
});

test('长链接（真实 lgToken 长度）也扫得出来', () => {
  const payload = `https://passport.goofish.com/qrcodeCheck.htm?lgToken=${'a1b2c3d4e5'.repeat(5)}&_from=havana&_from=havana`;
  const { data, width, height } = asciiToRgba(renderQrTerminal(payload));
  const found = jsQR(data, width, height);
  assert.ok(found, '长链接也应该能被解码');
  assert.equal(found.data, payload);
});

test('QrLoginSession 未 start 就 poll 会明确报错', async () => {
  const session = new QrLoginSession({ logger: silentLogger });
  await assert.rejects(() => session.poll(), /还没调用 start\(\)/);
});
