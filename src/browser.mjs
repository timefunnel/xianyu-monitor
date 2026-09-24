/**
 * 浏览器会话层：用持久化 Chromium profile 保持闲鱼网页登录态，搜索时直接复用页面自己发出的
 * 搜索请求，不做协议签名。
 *
 * 之所以监听页面响应而不是自己拼接口调用：闲鱼网页端的 mtop 请求带签名参数，页面自己会算，
 * 我们只读取它已有的结果，因此不需要复刻任何签名算法，接口换参数时也只需调整适配层。
 *
 * 本模块不实现任何反检测规避；请按正常人的频率使用（见 README 的风险说明）。
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { collectSearch } from './search.mjs';

/** 同时保留几个「点开看商品」的标签页，超出的关掉最旧的。 */
const MAX_ITEM_TABS = 5;

/** 登录后才会出现的 cookie 名，任一存在即视为已登录。 */
const LOGIN_COOKIE_NAMES = ['unb', '_nk_', 'tracknick'];

/** 会话确认最多等多久，用来覆盖 mtop 换 token 后的重试。 */
const SESSION_CHECK_WINDOW_MS = 8000;

/**
 * 会被风控「标记」的设备状态 cookie：值一旦变脏，带着它的搜索请求会被直接拒绝。
 *
 * `sgcookie` 是阿里 SecurityGuard 下发的风控状态令牌（`.goofish.com`，有效期一年）。
 * 实测（同一账号、同一出口 IP、同一个 `mtop.taobao.idlemtopsearch.pc.search` 接口）：
 *
 * | 请求里带的 cookie | 结果 |
 * | --- | --- |
 * | 全部 | `RGV587_ERROR` + 处罚链接 `action=deny`，页面「访问被拒绝」 |
 * | 只摘掉 `sgcookie` | `SUCCESS`，正常返回 30 条商品 |
 * | 只摘掉 `cbc` / `_samesite_flag_` | 照样被拒绝（所以就是它） |
 *
 * 而且**与客户端形态完全无关**：不启浏览器的纯 HTTP 请求会复现同样的拒绝，
 * 去掉自动化标记的 attach 模式也一样。浏览器、CDP、指纹都不是原因——
 * 唯一要做的事是这个值脏了以后别带着它发请求。
 */
const RISK_STATE_COOKIES = ['sgcookie'];

/**
 * attach 模式下要自己找 Chrome 可执行文件：`channel` 只在 Playwright 亲自启动浏览器时才会被解析，
 * 我们这里是自己 spawn，拿不到那个解析结果。查找顺序与 open-profile-in-chrome.mjs 保持一致。
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** 找到 Chrome 可执行文件；找不到返回 null（由调用方给出可读的错误）。 */
function findChrome(explicit) {
  const candidates = [explicit, ...CHROME_CANDIDATES].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** 让系统分配一个空闲端口，避免写死调试端口时和别的程序撞上。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 等 CDP 端口开始服务。Chrome 冷启动要几秒，端口没起来就 connectOverCDP 会直接连不上。
 * @param {number} port 调试端口。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Chrome 的调试端口 ${port} 在 ${Math.round(timeoutMs / 1000)} 秒内没有就绪`);
}

export class GoofishBrowser {
  /**
   * @param {any} browserConfig browser 段配置。
   * @param {any} logger 日志器。
   */
  constructor(browserConfig, logger) {
    this.config = browserConfig;
    this.logger = logger;
    /** @type {import('playwright').BrowserContext|null} */
    this.context = null;
    /** attach 模式下由我们自己 spawn 的 Chrome 进程，退出时要显式结束它。 */
    this.chrome = null;
  }

  /**
   * 启动浏览器。
   *
   * 两种模式：
   *  - 默认（`browser.attach` 不为 true）：Playwright 亲自启动持久化上下文。方便，但
   *    Playwright 会给 Chrome 加一组自动化开关，其中 `--enable-automation` 会让页面里的
   *    `navigator.webdriver` 变成 true——这在 baxia 眼里就是「被程序控制的浏览器」。
   *  - `browser.attach: true`：自己按用户双击打开的方式 spawn 一个普通 Chrome，只多给一个
   *    调试端口，然后 Playwright 用 CDP 附加上去。**不做任何指纹伪造**（UA、Canvas、WebGL
   *    全是这台机器的真值），只是不再让浏览器自报家门，等价于 README 里「用普通 Chrome 打开
   *    这个 profile」那条人工步骤，区别只是把控制权接了回来。
   *
   * 遇到 RGV587 + action=deny（页面上是「访问被拒绝」）时值得切到 attach 试一次：那条路
   * 没有人工出口，而自动化特征正是最可能让它成立的判据。
   */
  async open() {
    if (this.config.attach) {
      await this.#openAttached();
      return this;
    }

    const options = {
      headless: this.config.headless,
      locale: this.config.locale,
      timezoneId: this.config.timezoneId,
      viewport: { width: 1440, height: 900 },
    };
    // channel 用于复用系统安装的浏览器（如服务器上的 chromium、Windows 上的 msedge），
    // 可以省掉 150MB 的内核下载；executablePath 用于非标准安装路径。
    if (this.config.channel) options.channel = this.config.channel;
    if (this.config.executablePath) options.executablePath = this.config.executablePath;

    this.context = await chromium.launchPersistentContext(this.config.userDataDir, options);
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    /** @type {import('playwright').Page} */
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    // 任务各自的页面与筛选状态，由 #pageFor 惰性创建。
    this.taskPages = new Map();
    return this;
  }

  /**
   * attach 模式的启动过程：spawn 普通 Chrome → 等调试端口 → CDP 附加。
   * @returns {Promise<void>} 就绪后 resolve。
   */
  async #openAttached() {
    // 上下文被用户关掉后 #ensureContext 会再调一次 open()，这里要先清掉上一轮的进程。
    this.chrome?.kill();
    this.chrome = null;

    const chromePath = findChrome(this.config.executablePath);
    if (!chromePath) {
      throw new Error('attach 模式需要本机已安装 Chrome，且路径能被自动找到；请用 browser.executablePath 指定可执行文件。');
    }
    const userDataDir = path.resolve(this.config.userDataDir);
    mkdirSync(userDataDir, { recursive: true });
    const port = await freePort();

    this.logger?.info?.(`attach 模式：用普通 Chrome 打开 ${userDataDir}（调试端口 ${port}）`, 'browser');
    this.chrome = spawn(
      chromePath,
      [
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        this.config.baseUrl ?? 'https://www.goofish.com',
      ],
      { stdio: 'ignore' },
    );
    this.chrome.on('error', (error) => this.logger?.error?.(`Chrome 启动失败：${error.message}`, 'browser'));

    await waitForCdp(port, Math.max(10000, this.config.navigationTimeoutMs));
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    // 附加到用户自己的 Chrome：默认上下文就是平时那个 profile，登录态、扩展、书签都在里面。
    this.context = browser.contexts()[0] ?? (await browser.newContext());
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    /** @type {import('playwright').Page} */
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.taskPages = new Map();
  }

  /**
   * 通过 Cookie 判断本地是否存有登录痕迹：登录后会写入 `unb`（用户 ID），
   * 同时认 `_nk_` / `tracknick` 两个只在登录后出现的名字。
   *
   * 注意：这只是「有没有登录过」的廉价判据。实测出现过 Cookie 齐全但服务端会话已失效的情况
   * （`loginuser.get` 返回 SESSION_EXPIRED），因此作为最终依据请用 `checkSession()`。
   * @returns {Promise<boolean>} 是否存在登录 Cookie。
   */
  async isLoggedIn() {
    if (!this.context) return false;
    const cookies = await this.context.cookies(this.config.baseUrl);
    return LOGIN_COOKIE_NAMES.some((name) => {
      const found = cookies.find((cookie) => cookie.name === name);
      return Boolean(found && found.value);
    });
  }

  /**
   * 清空当前 profile 的所有 Cookie。
   *
   * 重新登录前必须调用：失效的 `unb` 会让「有没有登录 Cookie」的判断立刻成立，
   * 于是登录命令不会去等新二维码，用户也没有机会重新扫码。
   * @returns {Promise<void>} 清空完成。
   */
  async clearSession() {
    await this.context?.clearCookies();
  }

  /**
   * 向服务端确认会话是否真的有效：加载首页并读取 `loginuser.get` 的返回码。
   *
   * 这是唯一可信的登录判据——Cookie 存在只说明登录过，服务端可能已经让会话过期
   * （实测 `FAIL_SYS_SESSION_EXPIRED` 就发生在 Cookie 齐全的情况下）。
   *
   * 注意必须收集一段时间内的**全部**返回：mtop 在 `_m_h5_tk` 冷启动时第一次调用会返回
   * 会话过期，SDK 换完 token 会重试并成功。只看第一条会把有效会话误判为失效。
   *
   * @returns {Promise<'valid'|'invalid'|'unknown'>} 会话状态；`unknown` 表示没等到该请求，
   *   例如页面改版把它去掉了，此时不应据此判定登录失败。
   */
  async checkSession() {
    /** @type {Array<Promise<string|null>>} */
    const seen = [];
    const onResponse = (response) => {
      if (!/loginuser\.get/.test(response.url())) return;
      seen.push(
        response
          .json()
          .then((payload) => (Array.isArray(payload?.ret) ? String(payload.ret[0]) : null))
          .catch(() => null),
      );
    };

    this.page.on('response', onResponse);
    try {
      await this.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
      const window = Math.min(this.config.responseTimeoutMs, SESSION_CHECK_WINDOW_MS);
      const deadline = Date.now() + window;
      while (Date.now() < deadline) {
        const results = (await Promise.all(seen)).filter((result) => result !== null);
        if (results.some((result) => result.startsWith('SUCCESS'))) return 'valid';
        await this.page.waitForTimeout(500);
      }
      const results = (await Promise.all(seen)).filter((result) => result !== null);
      if (results.length === 0) return 'unknown';
      return results.some((result) => result.startsWith('SUCCESS')) ? 'valid' : 'invalid';
    } finally {
      this.page.off('response', onResponse);
    }
  }

  /** 打开首页，供人工扫码登录使用。 */
  async openForLogin() {
    await this.page.goto(this.config.baseUrl, { waitUntil: 'domcontentloaded' });
  }

  /**
   * 读当前 profile 的全部 cookie。
   *
   * 搜索改走直连（`search.mode: "http"`）之后，登录态就是从浏览器这里取的——纯本地读，
   * 不产生任何网络请求，所以浏览器退化成「登录态持有者」，不再需要为了搜索去驱动页面。
   *
   * 两点和 search() 保持一致：
   *  - 上下文被关掉时**重新拉起**。http 模式下浏览器窗口是空白的、看着像没用的东西，
   *    用户很可能顺手关掉它；不重新拉起的话登录态会静默变空。
   *  - 读失败就抛出，**不吞成空数组**。空 cookie 发出去的请求会变成「未登录」，
   *    那会被误判成风控或封号——比直接报错难查得多。
   *
   * @returns {Promise<Array<{name: string, value: string}>>} cookie 列表。
   */
  async cookies() {
    const context = await this.#ensureContext();
    return context.cookies();
  }

  /**
   * 把当前 profile 的登录态导出到 cookie 仓库（http 模式的「登录」动作）。
   *
   * 不导航、不请求：只是把 profile 里已有的 cookie 读出来落盘，所以从浏览器方案切到直连
   * 时不必重新扫码。
   *
   * @param {any} store cookie 仓库（见 cookies.mjs）。
   * @returns {Promise<{count: number, missing: string[]}>} 写入的个数，以及缺失的必需 cookie。
   */
  async exportCookies(store) {
    const { exportContextCookies } = await import('./cookies.mjs');
    const context = await this.#ensureContext();
    return exportContextCookies(context, store);
  }

  /**
   * 把当前页面整页截图写到指定路径（先写临时文件再改名，避免对方读到半张图）。
   * 无图形界面的服务器上，登录二维码就靠这个文件传给用户扫。
   *
   * Playwright 从扩展名推断图片格式，因此临时文件名必须保留原扩展名，不能简单加 `.tmp`。
   * @param {string} filePath 目标图片路径。
   */
  async screenshotTo(filePath) {
    const target = path.resolve(filePath);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp${path.extname(target)}`);
    mkdirSync(path.dirname(target), { recursive: true });
    await this.page.screenshot({ path: temp, fullPage: true });
    renameSync(temp, target);
  }

  /**
   * 取任务自己的页面。每个任务一个标签页，各自记住「当前页面已经施加了哪套筛选条件」。
   *
   * 共用一个页面时，两个任务会互相把对方的筛选状态冲掉，导致每轮都只能走冷路径（4 次请求）；
   * 每个任务一个页面后，各自都能走热路径（稳态每轮 1 次请求）。
   *
   * @param {string} taskName 任务名。
   * @returns {Promise<{page: import('playwright').Page, state: {warmKey: string|null}}>} 页面与其筛选状态。
   */
  async #pageFor(taskName) {
    this.taskPages ??= new Map();
    let entry = this.taskPages.get(taskName);
    if (!entry || entry.page.isClosed()) {
      const page = await this.context.newPage();
      entry = { page, state: { warmKey: null } };
      this.taskPages.set(taskName, entry);
    }
    return entry;
  }

  /**
   * 确保浏览器上下文可用，被关掉就重新拉起。
   *
   * 监控窗口是可见的，用户可能顺手把它关掉（比如为了清掉风控弹层）。上下文一旦关闭，
   * 之后每次 `newPage` 都会失败，而错误信息只有一句 `Target page, context or browser
   * has been closed`——不重建的话监控就永久卡死在这个状态里。
   *
   * @returns {Promise<any>} 可用的上下文。
   */
  async #ensureContext() {
    if (this.context) {
      try {
        this.context.pages(); // 已关闭的上下文调用任何方法都会抛
        return this.context;
      } catch {
        this.logger?.warn('浏览器窗口已关闭，重新拉起', 'browser');
        this.context = null;
        this.taskPages = null;
        this.itemPages = null;
      }
    }
    await this.open();
    return this.context;
  }

  /**
   * 复位被风控标记的设备状态 cookie。纯本地操作，不产生任何网络请求。
   *
   * 只按名字清，不碰登录 cookie（`unb` / `cookie2` / `_tb_token_` …），所以登录态不受影响。
   * 服务端在后续响应里会重新下发一个（实测重新下发的那个是干净的，搜索立刻恢复正常），
   * 所以这是一次性的复位，不是每轮都要做的常规操作——因此在 search() 里只在真被拒绝时才调用。
   *
   * @returns {Promise<string[]>} 实际清掉的 cookie 名；没有可清的就返回空数组。
   */
  async dropRiskCookies() {
    if (!this.context) return [];
    const present = await this.context.cookies(this.config.baseUrl).catch(() => []);
    const dropped = RISK_STATE_COOKIES.filter((name) => present.some((cookie) => cookie.name === name));
    for (const name of dropped) await this.context.clearCookies({ name });
    return dropped;
  }

  /**
   * 执行一次关键词搜索。
   * @param {{keyword: string, scrollRounds?: number, name?: string}} task 任务配置。
   * @returns {Promise<{items: import('./rules.mjs').Item[], source: 'api'|'dom', raw: unknown[]|null, requests: number}>} 搜索结果；`raw` 为本轮收集到的原始响应，供 dump 排查字段变化。
   */
  async search(task) {
    await this.#ensureContext();
    const { page, state } = await this.#pageFor(task.name ?? task.keyword);
    try {
      return await collectSearch(page, this.config, task, this.logger, state);
    } catch (error) {
      if (error.code !== 'denied') throw error;
      // 「直接拒绝」不是频率问题也不是登录问题：实测它由 profile 里那个被标记的 sgcookie 携带，
      // 复位之后同一账号、同一出口 IP、同一接口立刻恢复（清完浏览器路径也恢复了，能正常出商品）。
      // 所以这里做一次有界自愈：清掉 → 换一张干净页面 → 重试**一次**；
      // 第二次仍被拒就交给主循环长时间退避，绝不在这里反复撞。
      const dropped = await this.dropRiskCookies();
      if (dropped.length === 0) throw error;
      this.logger?.warn(`搜索被风控直接拒绝，已复位 ${dropped.join('、')} 后重试一次`, task.name);
      // 页面必须换掉，不能复用：被拒的那张页面上还盖着处罚弹层，复用会在 collectSearch 入口处
      // 再判一次「被挡住」，根本走不到发起新请求那一步（实测就是这么二次失败的）。
      await page.close().catch(() => {});
      const fresh = await this.#pageFor(task.name ?? task.keyword);
      fresh.state.warmKey = null;
      return await collectSearch(fresh.page, this.config, task, this.logger, fresh.state);
    }
  }

  /**
   * 在**这个已经登录的浏览器窗口**里新开一个标签打开网页。
   *
   * 桌面浏览器直接打开闲鱼网页是未登录状态（登录态在监控自己的 profile 里），所以
   * 「点一下看商品」要真的带上登录态，只能借这个窗口开。各任务的搜索页不动，不会被顶掉。
   *
   * 无头运行时看不到窗口，直接返回失败，让界面回退到自己浏览器里打开。
   *
   * @param {string} url 要打开的网址。
   * @returns {Promise<{ok: boolean, error?: string}>} 结果。
   */
  async openItem(url) {
    if (!this.context) return { ok: false, error: '浏览器还没启动' };
    if (this.config.headless) {
      return { ok: false, error: '监控跑在无头模式，看不到新标签页；请在本地浏览器里打开' };
    }
    try {
      const page = await this.context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.navigationTimeoutMs });
      await page.bringToFront();
      // 只保留最近几个商品标签，避免一个个点下去把窗口塞满。
      this.itemPages ??= [];
      this.itemPages.push(page);
      while (this.itemPages.length > MAX_ITEM_TABS) {
        await this.itemPages.shift()?.close().catch(() => {});
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: `打开失败：${error.message}` };
    }
  }

  /** 关闭浏览器并释放 profile 锁（上下文关闭会一并关掉各任务的页面）。 */
  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    // attach 模式下的 Chrome 是我们自己 spawn 的，但 Playwright 只是「附加」上去，断开连接
    // 并不会结束它。不显式 kill 就会留一个占着 profile 的 Chrome，下次启动直接失败。
    this.chrome?.kill();
    this.chrome = null;
    this.taskPages = new Map();
  }
}
