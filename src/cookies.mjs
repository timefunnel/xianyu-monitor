/**
 * 文件版 cookie 仓库：登录态的**唯一真相来源**。
 *
 * 为什么要有它：以前登录态只存在浏览器 profile 里，于是「监控」不得不常驻一个 Chrome
 * 才能读到 cookie——那个窗口既是空白的（搜索不再经过页面），又占资源，服务器上还得为它
 * 准备 Xvfb。落到文件之后，监控侧**一个浏览器都不需要**：浏览器只在「扫码登录」和
 * 「点开看商品」时按需拉起。
 *
 * 还有一个更隐蔽的原因：`cookie2` 是**会话级 cookie**（关掉浏览器即失效），而 mtop 必须带它。
 * 以前没暴露出来，是因为每次加载页面时服务端会顺手把会话 cookie 重新下发；一旦搜索不再
 * 经过页面，这条续期途径就断了。所以这里不仅存，还要**回写**：mtop 每次响应里的 `Set-Cookie`
 * 都会被吸收进来落盘，重启不丢。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** cookie 文件默认放在状态文件旁边（`data/cookies.json`），省掉再引入一套路径解析。 */
export function defaultCookieFile(config) {
  const stateFile = config?.storage?.stateFile ?? './data/state.json';
  return path.join(path.resolve(path.dirname(stateFile)), 'cookies.json');
}

/**
 * 把一条 `Set-Cookie` 解析成 cookie 对象。
 *
 * 属性可能缺失（mtop 常常只回 `name=value; Path=/`），缺失时回落到已有 cookie 的属性，
 * 再回落到一份保守的默认值——不能因为少个 Domain 就把它当成别的域的 cookie。
 *
 * @param {string} raw 原始 Set-Cookie。
 * @param {{domain?: string, path?: string, expires?: number, secure?: boolean, httpOnly?: boolean, sameSite?: string}} [previous] 同名的旧 cookie。
 * @returns {{name: string, value: string, domain: string, path: string, expires: number, secure: boolean, httpOnly: boolean, sameSite: string}|null} cookie 对象；解析不出名字时为 null。
 */
export function parseSetCookie(raw, previous = {}) {
  const parts = String(raw ?? '').split(';');
  const [pair, ...attributes] = parts;
  const index = pair.indexOf('=');
  if (index <= 0) return null;
  const cookie = {
    name: pair.slice(0, index).trim(),
    value: pair.slice(index + 1).trim(),
    domain: previous.domain ?? '.goofish.com',
    path: previous.path ?? '/',
    expires: previous.expires ?? -1,
    secure: previous.secure ?? true,
    httpOnly: previous.httpOnly ?? false,
    sameSite: previous.sameSite ?? 'Lax',
  };
  for (const attribute of attributes) {
    const [key, value = ''] = attribute.split('=').map((part) => part.trim());
    const lower = key.toLowerCase();
    if (lower === 'domain') cookie.domain = value;
    else if (lower === 'path') cookie.path = value;
    else if (lower === 'expires') {
      const at = Date.parse(value);
      if (!Number.isNaN(at)) cookie.expires = Math.floor(at / 1000);
    } else if (lower === 'max-age') {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (lower === 'secure') cookie.secure = true;
    else if (lower === 'httponly') cookie.httpOnly = true;
    else if (lower === 'samesite') cookie.sameSite = value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }
  return cookie;
}

/** 文件版 cookie 仓库。读失败一律抛出——读不到登录态却继续跑，只会把问题伪装成风控。 */
export class FileCookieStore {
  /**
   * @param {{file: string, logger?: any}} options 文件路径与日志器。
   */
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    /** 被服务端拒绝过的**具体值**（`{name, value}`），见 refuse()。 */
    this.refused = [];
    /** 这份登录态是何时建立的（登录成功时写入）。用来算「它活了多久」，判断是偶发还是越来越短。 */
    this.loginAt = null;
    /** 最近一次读到的文件 mtime（毫秒）；文件不存在时为 0。 */
    this.fileMtimeMs = 0;
    /**
     * 本进程**自己**最后一次落盘后的 mtime。它和 `fileMtimeMs` 不一致，就说明文件是被别人
     * 改的（最典型的是用户点了「重新登录」，另一处的登录流程写了新的一份）——调用方据此
     * 决定要不要丢掉内存里的续期 cookie。
     */
    this.savedMtimeMs = 0;
  }

  /**
   * 文件在本进程最后一次落盘之后，是否被别人改过。
   *
   * 为什么要问这个：搜索器会把服务端每次回发的 `_m_h5_tk` / `cookie2` 记在内存里并优先使用，
   * 而「重新登录」是**另一个入口**写同一个文件。不认外部改写的话，老会话的 cookie 会盖住
   * 刚写进来的新登录态——界面提示「登录成功」，搜索却照旧被风控拦住，看上去像重新登录没用。
   *
   * @returns {boolean} 是否被外部改过。
   */
  externallyChanged() {
    return this.fileMtimeMs !== this.savedMtimeMs;
  }

  /**
   * 读进内存。每轮都重新读，这样「重新扫码登录 → 立刻生效」不需要重启进程。
   * @returns {Promise<Map<string, any>>} cookie 名到 cookie 对象。
   */
  async load() {
    const jar = new Map();
    if (!existsSync(this.file)) {
      this.fileMtimeMs = 0;
      return jar;
    }
    try {
      this.fileMtimeMs = statSync(this.file).mtimeMs;
    } catch {
      // stat 失败的极少数情况（文件刚被换掉）不影响这次读取，下一次 load 再校准。
      this.fileMtimeMs = 0;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`${this.file} 不是合法的 cookie 文件：${error.message}（删掉它重新扫码登录即可）`);
    }
    this.loginAt = typeof raw?.loginAt === 'number' ? raw.loginAt : null;
    this.refused = Array.isArray(raw?.refused) ? raw.refused.filter((entry) => entry?.name && entry?.value) : [];
    for (const cookie of raw?.cookies ?? []) {
      if (cookie?.name) jar.set(cookie.name, { ...cookie });
    }
    return jar;
  }

  /**
   * 这个 cookie 的**这个值**是否已经被服务端拒绝过。
   * @param {string} name cookie 名。
   * @param {string} value cookie 值。
   * @returns {boolean} 是否已被拒。
   */
  isRefused(name, value) {
    return this.refused.some((entry) => entry.name === name && entry.value === value);
  }

  /**
   * 记下一个被服务端拒绝过的值并落盘。
   *
   * 为什么记「值」而不是「名字」：记名字等于永远不发这个 cookie，那是结构性规避平台施加的
   * 处罚。记值的效果只是**不重复一次已知会失败的请求**——服务端换发一个新值，我们照发不误，
   * 新的那个如果是干净的，客户端就自然回到正常状态。
   *
   * @param {Map<string, any>} jar 当前 cookie 集合（用于一并落盘）。
   * @param {string} name cookie 名。
   * @param {string} value cookie 值。
   * @returns {Promise<boolean>} 是否是本次新记下的（已记过则返回 false）。
   */
  async refuse(jar, name, value) {
    if (this.isRefused(name, value)) return false;
    this.refused.push({ name, value });
    // 只留最近若干条，避免长期运行攒成垃圾。
    if (this.refused.length > 50) this.refused = this.refused.slice(-50);
    await this.save(jar);
    return true;
  }

  /**
   * 落盘。先写临时文件再改名，避免读到半个文件；权限尽量收紧（Windows 上会被忽略）。
   * @param {Map<string, any>} jar cookie 名到 cookie 对象。
   * @returns {Promise<void>} 写完后 resolve。
   */
  async save(jar) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = { version: 1, savedAt: Date.now(), loginAt: this.loginAt ?? null, cookies: [...jar.values()], refused: this.refused };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
    try {
      // 记下"这就是我自己写的那一版"，供 externallyChanged() 区分外部改写。
      this.savedMtimeMs = statSync(this.file).mtimeMs;
    } catch {
      this.savedMtimeMs = Date.now();
    }
    this.fileMtimeMs = this.savedMtimeMs;
  }

  /** 把内存里的 cookie 拼成请求头。 */
  static header(jar) {
    return [...jar.values()].map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
}

/**
 * 导出时必须存在的 cookie。
 *
 * `cookie2` 是 mtop 的登录凭据，而它**是会话级 cookie**：浏览器进程一退出，Chrome 就把它丢掉。
 * 所以「等浏览器关掉之后再 export」会得到一份**看起来正常、实际缺件**的登录态——拿去请求只会
 * 得到 SESSION_EXPIRED，看上去像账号被封。导出时检查一下，把这种静默残缺变成明确告警。
 */
export const REQUIRED_COOKIES = ['cookie2'];

/** 带绝对过期时间、过期即等于「没登录」的身份 cookie。 */
const LOGIN_COOKIES = ['unb'];

/**
 * 在**本地**判断这份 cookie 文件是不是已经彻底过期，不发任何请求。
 *
 * 为什么值得单独做：`unb` 是有明确过期时间的登录身份 cookie（扫码登录后通常给 3 天，之后靠
 * 每次响应的 `Set-Cookie` 续期）。它一旦过期，服务端对任何接口都只会回 `SESSION_EXPIRED`，
 * 而搜索接口还会先回一个 `RGV587`「被挤爆啦」+ `x5secdata`——看上去像要求人机验证，于是程序
 * 让用户去「等冷却 / 过滑块」，而不是重新登录，人就一直卡在那儿。
 *
 * 会话级 cookie（`expires <= 0`，如 `cookie2`）不在此列：它们本就没有过期时间，判断不了。
 *
 * @param {Map<string, any>} jar cookie 集合。
 * @param {number} [now] 当前时间戳（测试用）。
 * @returns {{name: string, expiresAt: number}|null} 已过期的身份 cookie；没有则返回 null。
 */
export function staleLoginCookie(jar, now = Date.now()) {
  for (const name of LOGIN_COOKIES) {
    const cookie = jar?.get?.(name);
    const seconds = Number(cookie?.expires);
    if (!cookie || !Number.isFinite(seconds) || seconds <= 0) continue;
    const expiresAt = seconds * 1000;
    if (expiresAt <= now) return { name, expiresAt };
  }
  return null;
}

/** 登录态只可能来自这几个域。粘贴整段浏览器 cookie 时，别的站点会被丢掉。 */
const LOGIN_DOMAINS = ['goofish.com', 'taobao.com', 'tmall.com', 'alipay.com'];

/** 这个 domain 是不是登录态可能用到的域（空前缀按本站处理）。 */
function isLoginDomain(domain) {
  const normalized = String(domain ?? '')
    .replace(/^\./, '')
    .toLowerCase();
  if (normalized === '') return true;
  return LOGIN_DOMAINS.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

/**
 * 解析用户粘贴的登录态。接受两种格式：
 *
 *   1. `data/cookies.json` 的全文（`{"cookies":[...]}`，或直接就是一个数组）；
 *   2. 浏览器里复制的 Cookie 请求头（`a=b; c=d`）。
 *
 * 为什么需要它：服务器上没有图形界面，扫码要求手机 App 处在目标账号；而手机号验证码登录
 * 又必须在真实浏览器里过滑块（见 browserlogin.mjs）。允许把别处登录好的登录态粘进来，
 * 就不必为了换账号去动手机。
 *
 * 校验只做本地能做的（条数、必备项、域名），服务端是否认账交给调用方发一次 loginuser.get：
 * 本地永远判断不了"这份 cookie 是不是已经被平台作废"。
 *
 * @param {string} text 粘贴的内容。
 * @returns {Map<string, any>} cookie 名到 cookie 对象。
 */
export function parseCookieImport(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') throw new Error('没有内容：请粘贴 cookies.json 全文，或 `a=b; c=d` 形式的 Cookie 请求头');

  let list;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`不是合法的 cookies.json：${error.message}`);
    }
    list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : null;
    if (!list) throw new Error('这个 JSON 里没有 cookies 数组，也不是 cookie 数组');
  } else {
    list = [];
    for (const part of raw.split(';')) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      list.push({ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() });
    }
  }

  const jar = new Map();
  for (const entry of list) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const value = typeof entry?.value === 'string' ? entry.value : '';
    if (name === '' || value === '') continue;
    const domain = typeof entry.domain === 'string' && entry.domain !== '' ? entry.domain : '.goofish.com';
    // 整段导出里常混着别的站点，发到闲鱼头上既没用也等于泄露，直接丢掉。
    if (!isLoginDomain(domain)) continue;
    const expires = Number(entry.expires);
    jar.set(name, {
      name,
      value,
      domain,
      path: typeof entry.path === 'string' && entry.path !== '' ? entry.path : '/',
      expires: Number.isFinite(expires) ? expires : -1,
      secure: entry.secure ?? true,
      httpOnly: entry.httpOnly ?? false,
      sameSite: entry.sameSite ?? 'Lax',
    });
  }

  if (jar.size === 0) throw new Error('没有解析出任何本站 cookie（闲鱼/淘宝域）');
  const missing = ['cookie2', 'unb'].filter((name) => !jar.has(name));
  if (missing.length > 0) {
    throw new Error(`缺少 ${missing.join('、')}：这份内容不完整，多半是没登录成功时导出的`);
  }
  return jar;
}
