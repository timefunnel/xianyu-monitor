/**
 * 纯 HTTP 扫码登录：不启动浏览器，所以服务器上没有图形界面也能直接登录。
 *
 * 为什么值得单独做一条路：浏览器版的扫码登录依赖登录页的 DOM 结构与 iframe，闲鱼改版一次就失效
 * （开源项目 `fancyboi999/goofish-cli` 的 `auth login --qr` 就是这么挂的）。纯 HTTP 依赖的是接口
 * 契约，改版影响不到它；顺带也省掉了服务器上的 Chromium 与 Xvfb。
 *
 * 协议（三家开源实现交叉验证 + passport 接口实测）：
 *   1. GET  /mini_login.htm                → 下发 XSRF-TOKEN 与基础 cookie
 *   2. GET  /newlogin/qrcode/generate.do   → codeContent（二维码内容）/ t / ck
 *   3. POST /newlogin/qrcode/query.do      → qrCodeStatus，轮询到 CONFIRMED
 *   4. POST /login_token/login.do          → 真正建立会话，Set-Cookie 里才有 unb / cookie2
 *   5. 一次 mtop 调用（sign 为空串）        → 把 _m_h5_tk 刷新到 .goofish.com
 *
 * 已知的脆弱点，都做了兜底：
 *   - `CONFIRMED` 之后拿登录令牌的字段名在各实现之间有漂移（`token` / `lgToken` / `st` / `stEx`），
 *     四个都兜一遍；有的会话甚至只靠 Set-Cookie 就完成登录，所以令牌为空时不当作失败。
 *   - 扫码状态值连拼写都不统一（`SCANNED` / `SCANED`），因此**只认 CONFIRMED 与 EXPIRED**，
 *     其余一律当成"继续等"。
 *
 * 这里**不套用 `search.riskCookies: "omit"`**：那条策略是为了搜索请求不带平台的处罚凭据，
 * 而登录过程恰恰要把服务端下发的凭据照单收下。
 */

import { randomBytes } from 'node:crypto';
import qrcode from 'qrcode-generator';
import { FileCookieStore, REQUIRED_COOKIES, parseSetCookie } from './cookies.mjs';
import { MTOP, USER_AGENT } from './mtop.mjs';

const PASSPORT = 'https://passport.goofish.com';

/** 登录令牌为空时，靠这一步的 Set-Cookie 刷新 `_m_h5_tk`。用最轻的一个 mtop 接口。 */
const TOKEN_REFRESH_API = 'mtop.idle.web.user.page.nav';

const POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_SECONDS = 180;

/** 扫码状态。只依赖 CONFIRMED 与 EXPIRED，其余状态一律当作"继续等"（见文件头注释）。 */
export const QR_STATUS = {
  CONFIRMED: 'CONFIRMED',
  EXPIRED: 'EXPIRED',
  CANCELED: 'CANCELED',
};

/**
 * 生成一个 `cna`（设备标识）：24 位十六进制，16 位随机 + 8 位时间戳。
 * 参考实现里它是轮询时 `deviceId` 参数的来源。
 * @param {number} [now] 当前时间戳（测试用）。
 * @returns {string} cna。
 */
export function makeCna(now = Date.now()) {
  return randomBytes(8).toString('hex') + (now >>> 0).toString(16).padStart(8, '0');
}

/**
 * 取响应里的 Set-Cookie 列表。
 *
 * `getSetCookie()` 是 Node 19.7+ 才有的；老版本退化成按逗号切分——不完美，但比"一条 cookie 都收不到"
 * 好得多，而登录恰恰全靠 Set-Cookie。
 *
 * @param {any} response fetch 响应。
 * @returns {string[]} 原始 Set-Cookie 列表。
 */
export function setCookiesOf(response) {
  if (typeof response.headers?.getSetCookie === 'function') return response.headers.getSetCookie();
  const raw = response.headers?.get?.('set-cookie');
  // 必须 trim：切分后每个片段前面会留一个空格，不处理就会解析出名字带空格的 cookie（`" b"`）。
  return raw ? raw.split(/,(?=[^;=]+=)/).map((part) => part.trim()) : [];
}

/**
 * 把一批 Set-Cookie 吸收进 jar。同名覆盖，属性缺失时沿用旧值。
 * @param {Map<string, any>} jar cookie 集合（原地修改）。
 * @param {string[]} rawList 原始 Set-Cookie 列表。
 * @returns {string[]} 本次更新的 cookie 名。
 */
export function absorbSetCookies(jar, rawList) {
  const updated = [];
  for (const raw of rawList) {
    const name = String(raw ?? '').split('=')[0]?.trim();
    const cookie = parseSetCookie(raw, (name && jar.get(name)) || {});
    if (cookie) {
      jar.set(cookie.name, cookie);
      updated.push(cookie.name);
    }
  }
  return updated;
}

/**
 * 把二维码内容渲染成终端可直接打印的文本（半块字符，手机可扫）。
 * @param {string} text 二维码内容。
 * @returns {string} 终端文本。
 */
export function renderQrTerminal(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createASCII(1, 1);
}

/**
 * 把二维码内容渲染成 SVG（给 Web 控制台用，不依赖 canvas）。
 * @param {string} text 二维码内容。
 * @returns {string} SVG 文本。
 */
export function renderQrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 8, scalable: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 一次扫码登录会话。
 *
 * 生命周期：`start()` 拿二维码 → 反复 `poll()` 直到 CONFIRMED → `complete(token)` → `refreshToken()`。
 * 一般不用直接用它，用下面的 {@link qrLogin} 更省事。
 */
export class QrLoginSession {
  /**
   * @param {{logger?: any, fetchImpl?: typeof fetch, timeoutMs?: number, pollIntervalMs?: number, cna?: string}} [options] 依赖注入（测试用）。
   */
  constructor({ logger, fetchImpl = fetch, timeoutMs = 20000, pollIntervalMs = POLL_INTERVAL_MS, cna } = {}) {
    this.logger = logger;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.cna = cna ?? makeCna();
    /** 本次会话的 cookie 集合。登录期间照单全收，不做 riskCookies 过滤。 */
    this.jar = new Map();
    /** `{codeContent, t, ck}`。 */
    this.qr = null;
  }

  /**
   * 发一次请求，并把响应里的 Set-Cookie 吸收进 jar。
   * @param {string} url 完整地址。
   * @param {{method?: string, body?: any, headers?: Record<string,string>, referer?: string}} [options] 请求选项。
   * @returns {Promise<any>} fetch 响应。
   */
  async #call(url, { method = 'GET', body, headers = {}, referer } = {}) {
    const response = await this.fetch(url, {
      method,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        referer: referer ?? `${PASSPORT}/mini_login.htm`,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        cookie: FileCookieStore.header(this.jar),
        ...headers,
      },
      ...(body ? { body: String(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    absorbSetCookies(this.jar, setCookiesOf(response));
    return response;
  }

  /** 登录页与二维码接口共用的公共参数。 */
  #commonParams() {
    return {
      appName: 'xianyu',
      fromSite: '77',
      appEntrance: 'web',
      mainPage: 'false',
      isMobile: 'false',
      lang: 'zh_CN',
      returnUrl: '',
      umidTag: 'SERVER',
    };
  }

  /**
   * 第 1、2 步：打开登录页拿基础 cookie，再取二维码。
   * @returns {Promise<{codeContent: string, t: string, ck: string}>} 二维码信息。
   */
  async start() {
    // 第 1 步：登录页会下发 XSRF-TOKEN 等基础 cookie（顺带给出 cookie2）。
    const landing = new URLSearchParams({
      lang: 'zh_cn',
      appName: 'xianyu',
      appEntrance: 'web',
      styleType: 'vertical',
      bizParams: '',
      notLoadSsoView: 'false',
      notKeepLogin: 'false',
      isMobile: 'false',
      qrCodeFirst: 'false',
      site: '77',
      rnd: String(Math.random()),
    });
    const page = await this.#call(`${PASSPORT}/mini_login.htm?${landing}`, { referer: 'https://www.goofish.com/' });
    // 只是想把这个响应体读掉（让连接可复用），内容本身没用。
    try {
      await page.text();
    } catch {
      /* 读不出来也无所谓 */
    }
    if (!page.ok) throw new Error(`打开登录页失败：HTTP ${page.status}`);

    // 第 2 步：取二维码。实测这一步连 _csrf_token / hsiz / bizParams 都可以不传，
    // 但按浏览器的真实请求带上，免得服务端以后收紧。
    const csrf = this.jar.get('XSRF-TOKEN')?.value;
    const cookie2 = this.jar.get('cookie2')?.value;
    const query = new URLSearchParams({
      ...this.#commonParams(),
      ...(csrf ? { _csrf_token: csrf } : {}),
      ...(cookie2 ? { hsiz: cookie2 } : {}),
      umidToken: '',
      bizParams: '',
    });
    const response = await this.#call(`${PASSPORT}/newlogin/qrcode/generate.do?${query}`);
    const payload = await response.json().catch(() => null);
    const data = payload?.content?.data;
    if (!response.ok || !data?.codeContent || !data?.t || !data?.ck) {
      throw new Error(`生成二维码失败：${JSON.stringify(payload ?? { status: response.status }).slice(0, 200)}`);
    }
    this.qr = { codeContent: String(data.codeContent), t: String(data.t), ck: String(data.ck) };
    return this.qr;
  }

  /**
   * 第 3 步：轮询一次扫码状态。
   * @returns {Promise<{status: string, token: string, payload: any}>} 状态与登录令牌（未确认时为空串）。
   */
  async poll() {
    if (!this.qr) throw new Error('还没调用 start()，没有可轮询的二维码');
    const body = new URLSearchParams({
      ...this.#commonParams(),
      t: this.qr.t,
      ck: this.qr.ck,
      deviceId: this.cna,
      navlanguage: 'zh-CN',
      navUserAgent: USER_AGENT,
      navPlatform: 'Win32',
      isIframe: 'true',
      documentReferer: 'https://www.goofish.com/',
      defaultView: 'sms',
    });
    const response = await this.#call(`${PASSPORT}/newlogin/qrcode/query.do?appName=xianyu&fromSite=77`, { method: 'POST', body });
    const payload = await response.json().catch(() => null);
    const data = payload?.content?.data;
    const status = String(data?.qrCodeStatus ?? '');
    // 字段名在各实现之间有漂移，四个都兜一遍。
    const token = String(data?.token || data?.lgToken || data?.st || data?.stEx || '');
    return { status, token, payload };
  }

  /**
   * 第 4 步：用登录令牌真正建立会话。令牌为空时跳过——有的会话靠轮询那步的 Set-Cookie 就成了。
   * @param {string} token 登录令牌。
   * @returns {Promise<void>} 完成后 resolve。
   */
  async complete(token) {
    if (!token) {
      this.logger?.debug?.('扫码确认但没给登录令牌，按"服务端已通过 Set-Cookie 完成登录"处理', 'login');
      return;
    }
    const query = new URLSearchParams({
      token,
      subFlow: 'DIALOG_CHECK_LOGIN_RPC',
      nextCode: '0018',
      bizScene: 'qrcode',
      confirm: 'true',
    });
    const body = new URLSearchParams({ deviceId: this.cna });
    const response = await this.#call(`${PASSPORT}/login_token/login.do?${query}`, { method: 'POST', body });
    const text = await response.text().catch(() => '');
    if (!response.ok) throw new Error(`完成登录失败：HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  /**
   * 第 5 步：一次空签名的 mtop 调用，把 `_m_h5_tk` / `cookie2` 刷新到 `.goofish.com`。
   *
   * 失败不算致命：监控侧的 searcher 自己会用响应里的 Set-Cookie 重建令牌（见 mtop.mjs 的令牌重试），
   * 只是要多花一次请求。所以这里只告警，不抛。
   * @returns {Promise<{ok: boolean, error?: string}>} 是否刷新成功。
   */
  async refreshToken() {
    const query = new URLSearchParams({
      jsv: MTOP.jsv,
      appKey: MTOP.appKey,
      t: String(Date.now()),
      sign: '',
      api: TOKEN_REFRESH_API,
      v: MTOP.version,
      type: 'originaljson',
      dataType: 'json',
      timeout: String(this.timeoutMs),
      sessionOption: 'AutoLoginOnly',
      accountSite: MTOP.accountSite,
    });
    try {
      const response = await this.fetch(`${MTOP.baseUrl}/${TOKEN_REFRESH_API}/${MTOP.version}/?${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': USER_AGENT,
          referer: 'https://www.goofish.com/',
          origin: 'https://www.goofish.com',
          cookie: FileCookieStore.header(this.jar),
        },
        body: 'data=%7B%7D',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      absorbSetCookies(this.jar, setCookiesOf(response));
      try {
        await response.text();
      } catch {
        /* 读不出来也无所谓：令牌已经在 Set-Cookie 里了 */
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}

/**
 * 走完整个扫码登录，并把登录态写进 cookie 文件。
 *
 * @param {{store: FileCookieStore, logger?: any, timeoutSeconds?: number, onQr?: (qr: {codeContent: string, terminal: string, svg: string}) => void, onWait?: (info: {status: string, remainingSeconds: number}) => void, fetchImpl?: typeof fetch, pollIntervalMs?: number, session?: QrLoginSession}} options 依赖与回调。
 * @returns {Promise<{ok: boolean, cookies: number, missing: string[]}>} 结果；缺失必需 cookie 时 ok 为 false。
 */
export async function qrLogin({
  store,
  logger,
  timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  onQr,
  onWait,
  fetchImpl,
  pollIntervalMs,
  session,
}) {
  const qr = session ?? new QrLoginSession({ logger, fetchImpl, pollIntervalMs });
  const { codeContent } = await qr.start();
  onQr?.({ codeContent, terminal: renderQrTerminal(codeContent), svg: renderQrSvg(codeContent) });

  // 轮询到确认或超时。
  const deadline = Date.now() + timeoutSeconds * 1000;
  let token = '';
  let confirmed = false;
  while (Date.now() < deadline) {
    const { status, token: found } = await qr.poll();
    if (status === QR_STATUS.CONFIRMED) {
      token = found;
      confirmed = true;
      break;
    }
    if (status === QR_STATUS.EXPIRED || status === QR_STATUS.CANCELED) {
      throw new Error(`二维码已${status === QR_STATUS.EXPIRED ? '过期' : '被取消'}，请重新执行登录`);
    }
    onWait?.({ status, remainingSeconds: Math.max(0, Math.round((deadline - Date.now()) / 1000)) });
    await sleep(pollIntervalMs ?? POLL_INTERVAL_MS);
  }

  // 超时兜底：服务端可能已经在轮询过程中通过 Set-Cookie 完成了登录。
  if (!confirmed && !qr.jar.has('unb')) throw new Error('等待扫码超时，没有检测到登录');
  if (!confirmed) logger?.warn?.('轮询超时，但已拿到登录 cookie——按服务端已完成登录处理', 'login');

  await qr.complete(token);
  const refreshed = await qr.refreshToken();
  if (!refreshed.ok) logger?.warn?.(`刷新 mtop 令牌失败（不致命，首次搜索会自己重建）：${refreshed.error}`, 'login');

  // `unb` 才是"登录成功"的证据（三家参考实现都硬校验它）；cookie2 登录页那步就会给，
  // 所以两个都要查：只有 cookie2 而没 unb，等于拿到一份看起来正常、实际没登录的凭据。
  const missing = [...REQUIRED_COOKIES, 'unb'].filter((name) => !qr.jar.has(name));
  if (missing.length > 0) {
    // **绝不能落盘**：写进去就把磁盘上那份还能用的登录态覆盖掉了，而这次登录其实没成功。
    // 登录命令跑失败却顺手毁掉可用凭据，是最不该有的失败方式。
    logger?.error?.(`登录没拿到 ${missing.join('、')}，保留原有 cookie 文件不动`, 'login');
    return { ok: false, cookies: 0, missing };
  }
  await store.save(qr.jar);
  return { ok: true, cookies: qr.jar.size, missing: [] };
}
