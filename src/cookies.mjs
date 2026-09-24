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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  }

  /**
   * 读进内存。每轮都重新读，这样「重新扫码登录 → 立刻生效」不需要重启进程。
   * @returns {Promise<Map<string, any>>} cookie 名到 cookie 对象。
   */
  async load() {
    const jar = new Map();
    if (!existsSync(this.file)) return jar;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (error) {
      throw new Error(`${this.file} 不是合法的 cookie 文件：${error.message}（删掉它重新扫码登录即可）`);
    }
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
    const payload = { version: 1, savedAt: Date.now(), cookies: [...jar.values()], refused: this.refused };
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
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

/**
 * 把浏览器上下文里的 cookie 导出到文件（http 模式的「登录」动作）。
 *
 * **不导航、不请求**：只是把 profile 里已有的 cookie 读出来。所以它既能用在本机
 * 一键切换（不必重新扫码），也能在扫码登录成功后自动调用。
 *
 * @param {any} context Playwright BrowserContext。
 * @param {FileCookieStore} store 目标仓库。
 * @returns {Promise<{count: number, missing: string[]}>} 写入的个数，以及缺失的必需 cookie。
 */
export async function exportContextCookies(context, store) {
  const jar = new Map();
  for (const cookie of await context.cookies()) {
    if (cookie?.name) jar.set(cookie.name, { ...cookie });
  }
  await store.save(jar);
  return { count: jar.size, missing: REQUIRED_COOKIES.filter((name) => !jar.has(name)) };
}

/**
 * 反向：把文件里的 cookie 灌回浏览器上下文。
 *
 * 只有在真的拉起浏览器时才需要（「点开看商品」要在带登录态的窗口里打开），
 * 而文件比浏览器新——因为搜索不再经过页面，续期只发生在文件那一侧。
 *
 * @param {any} context Playwright BrowserContext。
 * @param {Map<string, any>} jar cookie 名到 cookie 对象。
 * @returns {Promise<{ok: number, failed: number}>} 成功与失败的个数。
 */
export async function hydrateContext(context, jar) {
  let ok = 0;
  let failed = 0;
  for (const cookie of jar.values()) {
    // 逐个加：某一个字段不被接受时，不该把整份登录态一起丢掉。
    try {
      await context.addCookies([
        {
          name: cookie.name,
          value: cookie.value ?? '',
          domain: cookie.domain ?? '.goofish.com',
          path: cookie.path ?? '/',
          expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          sameSite: cookie.sameSite ?? 'Lax',
        },
      ]);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}
