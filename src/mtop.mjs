/**
 * 直连 mtop 的搜索器：登录态仍由浏览器持有，**搜索不再经过页面**。
 *
 * 为什么要有它：浏览器方案下「UI 驱动」等于「交互次数 = 请求次数」——冷启动必然连发
 * 5 次（页面加载自带 1 次 + 价格两个输入框各 1 次 + 区域确认 1 次 + 「新发布」1 次），
 * 而实测「短时间内连续 3 次搜索」就会触发 RGV587。改成直连之后每轮恒为 **1 次请求**，
 * 「冷启动」这个概念直接消失。
 *
 * 代价说清楚：这里复刻了 mtop 的 H5 签名 `md5(token&t&appKey&data)`。它是一行公开算法
 * （不是 App 端依赖 native 库的 `x-sign`/`x-mini-wua`），但确实越过了 README 原先
 * 「不复刻任何签名」那条线——收益是请求数从 5 降到 1，并且不再需要为了搜索而驱动页面。
 *
 * 另一个被削弱的保障：以前是靠「解析页面**实际发出**的请求体」来证明筛选真的生效了，
 * 现在请求体由我们自己构造，这个校验就退化成「检查自己有没有漏拼字段」。因此这里仍然
 * 用同一个 `bodyMatchesFilters` 校验一遍，它挡不住服务端不认筛选，但能挡住拼装回归。
 */

import { createHash } from 'node:crypto';
import { classifyResponse, extractItems } from './parse.mjs';
import { FileCookieStore, defaultCookieFile, parseSetCookie } from './cookies.mjs';
import { bodyMatchesFilters, nativeFilterSpec } from './search.mjs';

/** 闲鱼网页版 mtop 的固定参数（实测，与页面自己发出的请求一致）。 */
export const MTOP = {
  baseUrl: 'https://h5api.m.goofish.com/h5',
  api: 'mtop.taobao.idlemtopsearch.pc.search',
  version: '1.0',
  appKey: '34839810',
  jsv: '2.7.2',
  accountSite: 'xianyu',
  spm: 'a21ybx.undefined.0.0',
};

/** mtop 的 sign 只认 `_m_h5_tk` 里第一个 `_` 之前的那一段。 */
const TOKEN_COOKIE = '_m_h5_tk';

/**
 * mtop 的 token 类错误。它们**都是握手问题**：响应里会通过 Set-Cookie 下发新 token，
 * 拿它重签一次就好，不该当成业务失败去退避。
 *
 * 按 `FAIL_SYS_TOKEN` 前缀匹配，而不是逐个枚举——实测服务端把 EXPIRED 拼成了
 * **EXOIRED**（`FAIL_SYS_TOKEN_EXOIRED::令牌过期`）。按字面枚举会漏掉它，于是本该自动重签的
 * 一次握手被当成「搜索接口返回错误」，白白冷却两分钟，而且看上去像个神秘的新故障。
 */
const TOKEN_ERROR_PATTERN = /FAIL_SYS_TOKEN/i;

/** 登录态探测用的接口：不需要业务参数，只在 `ret` 里回一个结果。 */
const LOGIN_CHECK_API = 'mtop.taobao.idlemessage.pc.loginuser.get';

/** 会被风控标记、需要按需摘掉的状态 cookie（理由见 browser.mjs 里的同名常量）。 */
const RISK_STATE_COOKIES = ['sgcookie'];

/** 闲鱼「区域」筛选里的预设值；不在这张表里的按具体省份处理。 */
export const REGION_PRESETS = new Set(['江浙沪', '珠三角', '京津冀', '东三省', '全国']);

/** 浏览器 UA。搜索走的是网页版的接口，带上与页面一致的 UA。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * mtop 的 H5 签名：`md5(token&t&appKey&data)`。
 * @param {{token: string, t: string, appKey: string, data: string}} input 签名输入。
 * @returns {string} 32 位小写 hex。
 */
export const mtopSign = ({ token, t, appKey, data }) =>
  createHash('md5').update(`${token ?? ''}&${t}&${appKey}&${data}`).digest('hex');

/**
 * 从 `_m_h5_tk` 的 cookie 值里取签名用的 token。值形如 `<token>_<时间戳>`。
 * @param {unknown} value cookie 值。
 * @returns {string} token。
 */
export function tokenOf(value) {
  const text = String(value ?? '');
  const index = text.indexOf('_');
  return index > 0 ? text.slice(0, index) : text;
}

/**
 * 按任务的 `nativeFilters` 构造搜索请求体。
 *
 * 字段布局对齐页面实际发出的请求（也见开源项目 goofish-client 的同名构造器）：
 *  - 价格与发布时间窗 → `propValueStr.searchFilter`，分号分隔，形如 `priceRange:500,700;publishDays:3;`
 *  - 区域预设 → `extraFilterValue.extraDivision`；具体省份 → `extraFilterValue.divisionList`
 *  - 「最新」是排序 → 顶层的 `sortField`/`sortValue`，不进 searchFilter
 *
 * @param {any} task 任务配置。
 * @returns {{body: any, spec: any}} 请求体与它对应的筛选描述（供校验）。
 */
export function buildSearchBody(task) {
  const spec = nativeFilterSpec(task);

  const filters = [];
  if (spec.priceRange) filters.push(`priceRange:${spec.priceRange[0]},${spec.priceRange[1]}`);
  if (spec.publishDays) filters.push(`publishDays:${spec.publishDays}`);

  /** @type {Record<string, unknown>} */
  const extra = {};
  if (spec.region) {
    if (REGION_PRESETS.has(spec.region)) extra.extraDivision = spec.region;
    else extra.divisionList = [{ province: spec.region }];
  }

  const body = {
    pageNumber: 1,
    keyword: task.keyword,
    fromFilter: spec.hasFilters,
    rowsPerPage: task.rowsPerPage ?? 30,
    searchReqFromPage: 'pcSearch',
    customDistance: '',
    sortValue: spec.sort === 'newest' ? 'desc' : '',
    sortField: spec.sort === 'newest' ? 'create' : '',
    gps: '',
    customGps: '',
    propValueStr: { searchFilter: filters.length > 0 ? `${filters.join(';')};` : '' },
    extraFilterValue: JSON.stringify(extra),
    userPositionJson: '{}',
  };
  return { body, spec };
}

/**
 * 把任务的一个搜索周期，直接用一次 mtop 请求完成。
 *
 * `cookieSource` 由调用方注入（通常是浏览器上下文），这样这里不关心登录态怎么来的。
 */
export class MtopSearcher {
  /**
   * @param {{config: any, logger?: any, cookies: any, fetchImpl?: typeof fetch}} options 依赖。
   *   `cookies` 是 cookie 仓库（见 cookies.mjs），登录态的唯一来源——它可以是文件，也可以是
   *   浏览器上下文导出的东西，搜索器本身不关心。**它不再是浏览器**：http 模式下监控侧
   *   一个浏览器都不需要。
   */
  constructor({ config, logger, cookies, fetchImpl }) {
    this.config = config;
    this.logger = logger;
    this.cookies = cookies;
    this.fetch = fetchImpl ?? fetch;
    /** 本次响应里更新的 cookie（含 mtop 每次回发的 `_m_h5_tk`），比文件里的新。 */
    this.fresh = new Map();
    /** 上一次**预约**的请求时刻，见 #reserveSlot。 */
    this.lastRequestAt = 0;
  }

  /**
   * 发请求前先预约一个时间槽。
   *
   * 这一处同时解决两件事，而且不需要额外的锁：
   *  - **不短时高频**：与上一次请求至少隔 `monitor.minRequestGapSeconds`；
   *  - **不并发**：槽位是「先预约再等」的，所以同时发起的多个调用会被自动拉开
   *    （后到者看到的是前者已经预约走的时刻），不会两个请求一起飞出去。
   *
   * 调试脚本、多任务「立即检查」、`once` 多任务都共用这一个闸，避免又靠"记得别手快"。
   *
   * @param {string} [taskName] 任务名，用于日志。
   * @returns {Promise<void>} 轮到本次请求时 resolve。
   */
  async #reserveSlot(taskName) {
    const gapMs = Math.max(0, Number(this.config.monitor?.minRequestGapSeconds ?? 0)) * 1000;
    const now = Date.now();
    const earliest = this.lastRequestAt + gapMs;
    const waitMs = Math.max(0, earliest - now);
    this.lastRequestAt = Math.max(now, earliest);
    if (waitMs <= 0) return;
    this.logger?.info?.(
      `按全局最小间隔等待 ${(waitMs / 1000).toFixed(1)}s 再发下一次搜索（防止并发或短时高频）`,
      taskName,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  /** 已经被服务端拒绝过、不再重发的 cookie 名（供测试与日志用）。 */
  get refusedCookies() {
    return [...new Set((this.cookies.refused ?? []).map((entry) => entry.name))];
  }

  /**
   * 文件 + 本次响应里更新的值。**不做"被拒过滤"**——这个集合是要落盘的，
   * 落盘时若把被拒的 cookie 删掉，下次连它的值都认不出来，就没法判断"还是那个值吗"。
   * @returns {Promise<Map<string, any>>} cookie 名到 cookie 对象。
   */
  async #storedJar() {
    const jar = await this.cookies.load();
    for (const [name, cookie] of this.fresh) jar.set(name, cookie);
    return jar;
  }

  /**
   * 这一次实际要发出去的集合。按 `search.riskCookies` 决定怎么处理风控状态 cookie：
   *
   *  - `omit`（默认）：这类 cookie 一律不发。实测它们只是把平台施加的处罚带过来，不带它请求
   *    照常成功；而"先带一次被拒、再记住"要白白浪费一次注定失败的请求（且每遇到一个新脏值都要）。
   *  - `remembered`：带上，但剔掉**已知会被拒的具体值**；服务端换发的新值照发，
   *    客户端因此保留"自己回到正常状态"的路径。
   *
   * @returns {Promise<Map<string, any>>} cookie 名到 cookie 对象。
   */
  async #cookies() {
    const jar = await this.#storedJar();
    const omit = (this.config.search?.riskCookies ?? 'omit') === 'omit';
    for (const [name, cookie] of [...jar]) {
      if (omit && RISK_STATE_COOKIES.includes(name)) {
        jar.delete(name);
        continue;
      }
      if (this.cookies.isRefused?.(name, cookie.value)) jar.delete(name);
    }
    return jar;
  }

  /**
   * 发一次 mtop 请求。
   * @param {{api?: string, t: string, sign: string, data: string, jar: Map<string,string>}} input 请求参数。
   * @returns {Promise<any>} fetch 响应。
   */
  async #post({ api = MTOP.api, t, sign, data, jar }) {
    const query = new URLSearchParams({
      jsv: MTOP.jsv,
      appKey: MTOP.appKey,
      t,
      sign,
      api,
      v: MTOP.version,
      type: 'originaljson',
      dataType: 'json',
      timeout: String(this.config.search?.timeoutMs ?? 20000),
      sessionOption: 'AutoLoginOnly',
      accountSite: MTOP.accountSite,
      spm_cnt: MTOP.spm,
      spm_pre: MTOP.spm,
    });
    return this.fetch(`${MTOP.baseUrl}/${api}/${MTOP.version}/?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
        referer: `${this.config.browser?.baseUrl ?? 'https://www.goofish.com'}/`,
        origin: this.config.browser?.baseUrl ?? 'https://www.goofish.com',
        cookie: FileCookieStore.header(jar),
      },
      body: `data=${encodeURIComponent(data)}`,
      signal: AbortSignal.timeout(this.config.search?.timeoutMs ?? 20000),
    });
  }

  /**
   * 收下响应里的 `Set-Cookie` 并回写文件。
   *
   * 必须收**全部** cookie，不能只管 `_m_h5_tk`：`cookie2` 是会话级 cookie（关掉浏览器即失效），
   * 而 mtop 必须带它。以前这条续期是靠加载页面被动拿到的，现在搜索不经过页面，就只剩这里了。
   *
   * @param {any} response fetch 响应。
   * @returns {Promise<void>} 回写完成后 resolve（回写失败只告警，不影响本次搜索）。
   */
  async #absorb(response) {
    const changed = [];
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const name = /^([A-Za-z0-9_]+)=/.exec(raw)?.[1];
      const cookie = parseSetCookie(raw, name ? this.fresh.get(name) : undefined);
      if (!cookie) continue;
      if (this.fresh.get(cookie.name)?.value === cookie.value) continue;
      this.fresh.set(cookie.name, cookie);
      changed.push(cookie.name);
    }
    if (changed.length === 0) return;
    try {
      await this.cookies.save(await this.#storedJar());
    } catch (error) {
      this.logger?.warn?.(`cookie 回写失败（登录态可能无法跨重启保持）：${error.message}`);
    }
  }

  /**
   * 执行一次关键词搜索。
   *
   * **正常路径恒为 1 次请求**。唯一的例外是 token 过期：mtop 会回
   * `FAIL_SYS_TOKEN_EMPTY`/`FAIL_SYS_TOKEN_ILLEGAL` 并通过 Set-Cookie 下发新 token，
   * 这时必须拿新 token 重签一次，否则整个链路就是坏的。它只在长时间闲置后出现，
   * 而且每次成功响应都会顺带续期，所以属于罕见情况。
   *
   * @param {{keyword: string, name?: string}} task 任务配置。
   * @returns {Promise<{items: import('./rules.mjs').Item[], source: 'api', raw: unknown[], requests: number}>} 搜索结果。
   */
  async search(task) {
    const { body, spec } = buildSearchBody(task);
    const data = JSON.stringify(body);

    // 自己拼的请求体也要过一遍同一套校验：它挡不住「服务端不认筛选」，
    // 但能挡住拼装回归（比如哪天 publishDays 忘了拼进去）。
    if (!bodyMatchesFilters(body, spec)) {
      const error = new Error('构造出来的搜索请求体没有带上配置的全部筛选条件，本轮不推送任何商品。');
      error.code = 'filters-not-applied';
      throw error;
    }

    await this.#reserveSlot(task.name);

    let requests = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let jar;
      try {
        jar = await this.#cookies();
      } catch (error) {
        // 读不到 cookie 绝不能"就这样发出去"：空 cookie 的请求在服务端看来是未登录，
        // 会被报成 RGV587 或要求登录，看上去像风控或封号，实际只是 cookie 文件没了。
        const wrapped = new Error(`读不到登录 cookie（${this.cookies.file ?? 'cookie 来源'} 不可读）：${error.message}`);
        wrapped.code = 'auth';
        throw wrapped;
      }
      if (jar.size === 0) {
        const error = new Error(
          `没有任何 cookie（${this.cookies.file ?? 'cookie 来源'} 不存在或为空）。` +
            '请先执行 node src/cli.mjs export-cookies（把 profile 里现有的登录态落盘），' +
            '或 node src/cli.mjs login 扫码登录。',
        );
        error.code = 'auth';
        throw error;
      }
      const t = Date.now().toString();
      const sign = mtopSign({ token: tokenOf(jar.get(TOKEN_COOKIE)?.value), t, appKey: MTOP.appKey, data });
      requests += 1;

      let response;
      try {
        response = await this.#post({ t, sign, data, jar });
      } catch (error) {
        const wrapped = new Error(`搜索请求发不出去：${error.message}`);
        wrapped.code = 'api';
        throw wrapped;
      }
      await this.#absorb(response);

      const payload = await response.json().catch(() => null);
      const verdict = classifyResponse(payload);

      if (verdict.kind === 'success') {
        const linkTemplate = this.config.linkTemplate ?? this.config.browser?.linkTemplate ?? 'https://www.goofish.com/item?id={id}';
        return { items: extractItems(payload, { linkTemplate }), source: 'api', raw: [payload], requests };
      }

      // token 过期是握手问题，不是业务失败——换上新 token 重签再试一次。
      if (TOKEN_ERROR_PATTERN.test(verdict.message ?? '') && attempt < 2) {
        this.logger?.info?.('mtop token 已过期，用新下发的 token 重新签名', task.name);
        continue;
      }
      // 重签之后还是 token 错误，说明响应里压根没下发新 token：服务端不认这个会话了。
      // 这时别报成含糊的「搜索接口返回错误」，直接告诉人去重新登录。
      if (TOKEN_ERROR_PATTERN.test(verdict.message ?? '')) {
        const error = new Error(
          `mtop 的登录票据失效且无法自动续期（${verdict.message}）。响应里没有下发新 token，` +
            '说明服务端已经不认这个会话——请重新扫码登录（node src/cli.mjs login）。',
        );
        error.code = 'auth';
        throw error;
      }

      if (verdict.kind === 'denied') {
        // 记下**被拒的那个值**，不再重发。只在本进程内摘是不够的：那样每次启动都要先带着
        // 一个已知会被拒的 cookie 撞一次——既浪费一次请求，又给风控再加一次压力。
        // 记值不记名字：服务端换发新值时我们照发，客户端才有机会自己回到正常状态。
        const sent = await this.#cookies();
        const stored = await this.#storedJar();
        const dropped = [];
        for (const name of RISK_STATE_COOKIES) {
          // 只有**真的发出去了**才谈得上「这个值被拒」。omit 模式下它根本没发，
          // 那就不是它造成的，不该往"被拒名单"里塞。
          const cookie = sent.get(name);
          if (!cookie) continue;
          if (await this.cookies.refuse?.(stored, name, cookie.value)) dropped.push(name);
        }
        if (dropped.length > 0) {
          this.logger?.warn?.(
            `搜索被风控直接拒绝，已记下 ${dropped.join('、')} 的这个值不再重发（服务端换发新值时会照常尝试）`,
            task.name,
          );
        }
        const error = new Error(
          `搜索接口被闲鱼直接拒绝（${verdict.message}）。这不是频率问题：处罚页是「访问被拒绝」（action=deny），` +
            '调大间隔、重新登录、过验证都不会恢复。实测它由被标记的 sgcookie 携带，' +
            '已记下这个值不再重发（服务端换发新值时会照常尝试）。本轮不推送任何商品。',
        );
        error.code = 'denied';
        // 让主循环知道「这次拒绝有没有可修的东西」：有的话下一轮就是一次不同的请求，值得马上试。
        error.droppedCookies = dropped;
        throw error;
      }

      if (verdict.kind === 'throttle') {
        const error = new Error(
          `请求被闲鱼拦截（${verdict.message}）。该错误码在「访问频率过高」和「登录态失效」两种情况下都会出现：` +
            '请先调大 intervalSeconds（建议 60 秒以上）重试；若仍然如此，再重新执行 node src/cli.mjs login。',
        );
        error.code = 'throttled';
        throw error;
      }
      if (verdict.kind === 'auth') {
        const error = new Error(`搜索接口要求登录（${verdict.message}）。请重新执行 node src/cli.mjs login 扫码登录。`);
        error.code = 'auth';
        throw error;
      }
      const error = new Error(`搜索接口返回错误：${verdict.message}`);
      error.code = 'api';
      throw error;
    }

    // 循环只有两条出口：成功返回，或抛错。走到这里说明 token 重试也没成。
    const error = new Error('mtop 的 token 握手连续失败，请重新执行 node src/cli.mjs login。');
    error.code = 'auth';
    throw error;
  }

  /**
   * 确认登录态，**不加载任何页面**。
   *
   * 以前这是靠加载首页、再读页面上 `loginuser.get` 的返回码判断的——那要驱动一次页面，
   * 是 http 模式下唯一还会碰页面的动作，等于把刚摆脱的形态又请回来。这里直接问同一个接口：
   * 一次请求，不渲染任何东西，浏览器也不需要导航。
   *
   * `_m_h5_tk` 冷启动时可能已过期（mtop 会回 TOKEN_EMPTY），这时按和搜索一样的办法换新 token
   * 重签一次。除此之外判不准的一律返回 'unknown'——调用方只在明确 invalid 时才拦人，
   * 剩下的交给第一次搜索去定，因为「RGV587 既可能是限流也可能是会话失效」本来就得靠后续请求分清。
   *
   * @returns {Promise<'valid'|'invalid'|'unknown'>} 会话状态。
   */
  async checkSession() {
    const data = '{}';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const jar = await this.#cookies();
        // 一个 cookie 都没有就别问了：那必然是「还没登录过」，而不是服务端的问题。
        if (jar.size === 0) return 'invalid';
        const t = Date.now().toString();
        const sign = mtopSign({ token: tokenOf(jar.get(TOKEN_COOKIE)?.value), t, appKey: MTOP.appKey, data });
        const response = await this.#post({ api: LOGIN_CHECK_API, t, sign, data, jar });
        await this.#absorb(response);

        const payload = await response.json().catch(() => null);
        const ret = Array.isArray(payload?.ret) ? String(payload.ret[0]) : '';
        if (ret.startsWith('SUCCESS')) return 'valid';
        if (TOKEN_ERROR_PATTERN.test(ret) && attempt < 2) continue;
        if (/SESSION_EXPIRED|SESSION_INVALID|未登录|请先登录/i.test(ret)) return 'invalid';
        return 'unknown';
      } catch {
        // 探测失败不该拦住启动：连不上、超时、返回不可解析，都当成「不知道」。
        return 'unknown';
      }
    }
    return 'unknown';
  }
}

/**
 * 按配置挑一个「谁去搜」。
 *
 * - `http`（默认）：文件版 cookie + 直连 mtop，每轮恰好 1 次请求，**监控侧不需要浏览器**。
 * - `browser`：退回驱动页面那套（能拿到服务端对筛选的真实确认，代价是冷启动 4~6 次请求）。
 *
 * @param {{config: any, logger: any, browser?: any}} options 依赖；browser 只有 browser 模式才用得到。
 * @returns {Promise<any>} 带 `search(task)` 与 `checkSession()` 的对象。
 */
export async function createSearcher({ config, logger, browser }) {
  if (config.search?.mode === 'browser') {
    if (!browser) throw new Error('search.mode 为 "browser" 时必须传入浏览器。');
    return browser;
  }
  const file = config.search?.cookieFile ?? defaultCookieFile(config);
  return new MtopSearcher({ config, logger, cookies: new FileCookieStore({ file, logger }) });
}
