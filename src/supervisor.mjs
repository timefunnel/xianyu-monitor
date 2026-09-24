/**
 * 运行时管理：把浏览器会话、去重表、主循环和一个可查询的状态快照收拢到一处，
 * 让命令行和 Web 控制台共用同一套生命周期，而不是各写一份。
 *
 * 所有对外方法都保证「不抛到调用方」——Web 层只想知道成功与否和错误原因，
 * 一个失败的启动不该把 HTTP 服务器带崩。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { withDefaults } from './config.mjs';
import { describeFilters, evaluate } from './rules.mjs';
import { SeenStore } from './store.mjs';
import { Monitor } from './monitor.mjs';
import { sendAll } from './notify.mjs';

/** 命中历史最多保留多少条。 */
const MAX_HISTORY = 200;

/** 启动失败后每隔多久自动重试一次（只在监控没在跑时触发）。 */
const START_RETRY_MS = 60000;

/** 内存里保留多少条最近日志，用于新连接的补发。 */
const RECENT_LOG_LIMIT = 300;

/**
 * 稳定的 JSON 序列化：键顺序不影响结果，用来判断任务定义有没有变。
 * @param {any} value 任意值。
 * @returns {string} 规范化后的字符串。
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Supervisor {
  /**
   * @param {object} options
   * @param {any} options.config 已补齐默认值、相对路径已解析的配置。
   * @param {string} options.configPath 配置文件绝对路径。
   * @param {any} options.logger 日志器。
   * @param {(() => Promise<any>) | null} [options.createBrowser] 浏览器工厂；不传则启动真实 Playwright 会话。
   */
  constructor({ config, configPath, logger, createBrowser }) {
    this.config = config;
    this.configPath = configPath;
    this.logger = logger;
    this.createBrowser = createBrowser ?? null;
    this.configDir = path.dirname(configPath);
    this.running = false;
    this.starting = false;
    this.session = 'unchecked';
    this.startedAt = null;
    this.lastError = null;
    this.login = { active: false, qrUrl: '/api/login-qr.png' };
    /** @type {import('./browser.mjs').GoofishBrowser|null} */
    this.browser = null;
    /** @type {Monitor|null} */
    this.monitor = null;
    /** 最近一次运行的统计快照。停止后仍要能在界面上看到，因此不随 monitor 一起清空。 */
    this.stats = null;
    /** @type {Promise<void>|null} run() 的完成信号，停止时等它收尾。 */
    this.runPromise = null;
    /** @type {import('./store.mjs').SeenStore|null} */
    this.store = null;
    /** @type {object[]} 最近日志的环形缓冲，供新 SSE 连接补发（SSE 自己不回溯）。 */
    this.recentLogs = [];
    /** @type {any} 启动失败后的自动重试定时器。 */
    this.startRetryTimer = null;
    /** @type {Array<object>} 命中历史，最新的在最后。 */
    this.hits = this.#loadHistory();
    this.queue = Promise.resolve();
    /** @type {Set<(event: object) => void>} */
    this.subscribers = new Set();
  }

  /**
   * 订阅状态变化，用于 Web 端的 SSE 推送。
   * @param {(event: object) => void} handler 事件回调。
   * @returns {() => void} 取消订阅。
   */
  subscribe(handler) {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** 向所有订阅者广播；订阅者抛错不影响其它订阅者。 */
  #emit(event) {
    for (const handler of [...this.subscribers]) {
      try {
        handler(event);
      } catch {
        // 推送失败只影响这一个订阅者（通常是已断开的 SSE 连接）。
      }
    }
  }

  /**
   * 对外广播事件。日志旁路需要走同一条通道，才能保证界面上看到的顺序和实际发生的一致。
   * @param {object} event 事件对象，需带 `type`。
   */
  publish(event) {
    // 日志留一份环形缓冲，供新连接补发（见 subscribe）。
    if (event?.type === 'log') {
      this.recentLogs.push(event);
      if (this.recentLogs.length > RECENT_LOG_LIMIT) this.recentLogs.shift();
    }
    this.#emit(event);
  }

  /** 通知 Web 端重新拉取状态。 */
  #stateChanged() {
    this.#emit({ type: 'state' });
  }

  /** 浏览器页面是共享资源：监控循环和「立即检查」必须排在同一个队列里。 */
  #queued(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 把命中历史折算进累计计数，让「累计已推送」和用户看得见的历史条数对得上。
   *
   * 累计计数是后加的，之前的推送只留在 hits.json 里，界面于是同时显示「已推送 0 条」和
   * 160 多条历史。这里用**单调取大**而不是「全零才回填」：计数可能已经被新版本写了一部分
   * （cycles 有值但 notified 还是 0），只在全零时回填就永远补不上了。
   *
   * 只统计 `pushed !== false` 的记录——静默期间记的账不算推送。老记录没有这个字段，
   * 那时候还没有静默功能，一律当作已推送。轮询/扫描次数无法回溯，不参与回填。
   */
  #backfillTotals() {
    if (!this.store) return;
    const perTask = new Map();
    for (const hit of this.hits) {
      if (!hit || typeof hit.task !== 'string') continue;
      if (hit.pushed === false) continue;
      perTask.set(hit.task, (perTask.get(hit.task) ?? 0) + 1);
    }
    let changed = false;
    for (const task of this.config.tasks) {
      const historyCount = perTask.get(task.name) ?? 0;
      if (historyCount === 0) continue;
      const totals = this.store.getTotals(task.name);
      const notified = Math.max(totals.notified, historyCount);
      const matched = Math.max(totals.matched, notified);
      if (notified === totals.notified && matched === totals.matched) continue;
      this.store.setTotals(task.name, { ...totals, matched, notified });
      changed = true;
    }
    if (changed) {
      this.store.save();
      this.logger.info('已按命中历史补齐累计计数（轮询/扫描次数无法回溯）', 'web');
    }
  }

  /** @returns {string} 命中历史文件路径。 */
  get historyPath() {
    return path.join(path.dirname(this.config.storage.stateFile), 'hits.json');
  }

  /** @returns {object[]} 最近的命中记录，最新的在前。 */
  #loadHistory() {
    const file = this.historyPath;
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed.slice(-MAX_HISTORY) : [];
    } catch {
      // 历史只是展示用的旁路数据，损坏时从空表开始，不值得为它中断启动。
      return [];
    }
  }

  /**
   * 追加一条命中记录并落盘（先写临时文件再改名，避免被杀进程时留下半截文件）。
   *
   * `pushed` 区分「真发出去了」和「静默期间只记账」：历史列表两种都要显示，但累计已推送
   * 只能算前者。老记录没有这个字段，那时候还没有静默功能，一律当作已推送。
   *
   * @param {any} item 商品。
   * @param {any} task 任务配置。
   * @param {{pushed?: boolean}} [options] `pushed` 为 false 表示这条只是记账，没有推送。
   */
  #recordHit(item, task, options = {}) {
    const record = {
      id: item.id,
      task: task.name,
      title: item.title,
      price: item.price,
      area: item.area,
      seller: item.seller,
      url: item.url,
      appUrl: item.appUrl ?? null,
      pushedAt: Date.now(),
      pushed: options.pushed !== false,
    };
    this.hits.push(record);
    if (this.hits.length > MAX_HISTORY) this.hits = this.hits.slice(-MAX_HISTORY);
    try {
      mkdirSync(path.dirname(this.historyPath), { recursive: true });
      const temp = `${this.historyPath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(this.hits)}\n`, 'utf8');
      renameSync(temp, this.historyPath);
    } catch (error) {
      this.logger.warn(`命中历史写入失败：${error.message}`, 'web');
    }
    this.#emit({ type: 'hit', hit: record });
  }

  /** @returns {object} 供 Web 控制台渲染的状态快照。 */
  snapshot() {
    return {
      running: this.running,
      starting: this.starting,
      session: this.session,
      startedAt: this.startedAt,
      seenCount: this.#ensureStore().size,
      lastError: this.lastError,
      hits: [...this.hits].reverse(),
      login: { ...this.login },
      // 推送总开关；实际是否推送还要看每个任务自己的 notify（两者是「与」）。
      notifyEnabled: this.config.notify.enabled !== false,
      tasks: this.config.tasks.map((task) => {
        // 运行中的循环有内存统计；没在跑（任务被停用、或还没启动过）就回退到状态文件里的
        // 累计计数——否则卡片会显示全 0，和「累计值重启不清零」的说法自相矛盾。
        const stats = this.stats?.get(task.name) ?? this.#ensureStore().getTotals(task.name);
        return {
          name: task.name,
          keyword: task.keyword,
          // enabled 是配置里的意图，running 是此刻真的在不在跑；两者可以不一致
          // （监控整体已停止、或刚改动还没重启），界面靠这两个字段区分状态。
          enabled: task.enabled !== false,
          running: this.monitor?.isTaskRunning(task.name) ?? false,
          notify: task.notify !== false,
          intervalSeconds: task.intervalSeconds,
          jumpLink: task.jumpLink ?? 'app',
          filtersSummary: describeFilters(task.filters, task.nativeFilters),
          stats: {
            cycles: stats?.cycles ?? 0,
            scanned: stats?.scanned ?? 0,
            matched: stats?.matched ?? 0,
            notified: stats?.notified ?? 0,
            failures: stats?.failures ?? 0,
            unknownSkips: stats?.unknownSkips ?? 0,
            lastSuccessAt: stats?.lastSuccessAt ?? 0,
          },
        };
      }),
    };
  }

  /** 确保浏览器已启动；不会重复启动。 */
  async #ensureBrowser() {
    if (this.browser) return this.browser;
    if (this.createBrowser) {
      this.browser = await this.createBrowser();
      return this.browser;
    }
    const { GoofishBrowser } = await import('./browser.mjs');
    mkdirSync(this.config.browser.userDataDir, { recursive: true });
    const browser = new GoofishBrowser(this.config.browser, this.logger);
    try {
      await browser.open();
    } catch (error) {
      throw new Error(
        `浏览器启动失败：${error.message}\n` +
          `可能原因：① profile 被另一个实例占用（${this.config.browser.userDataDir}）` +
          ' ② 环境没有图形界面，服务器上需要用 xvfb-run 启动',
      );
    }
    this.browser = browser;
    await this.#hydrateFromCookieFile(browser);
    return browser;
  }

  /**
   * 拉起浏览器时，把 cookie 文件里的登录态灌回去。
   *
   * 方向是「文件 → 浏览器」：搜索不再经过页面，续期只发生在文件那一侧
   * （mtop 响应里的 Set-Cookie），所以文件比浏览器新。「点开看商品」要靠这个才是登录状态。
   *
   * @param {any} browser 刚拉起的浏览器。
   * @returns {Promise<void>} 完成后 resolve；失败只告警。
   */
  async #hydrateFromCookieFile(browser) {
    try {
      const { FileCookieStore, hydrateContext, defaultCookieFile } = await import('./cookies.mjs');
      const file = this.config.search?.cookieFile ?? defaultCookieFile(this.config);
      const jar = await new FileCookieStore({ file, logger: this.logger }).load();
      if (jar.size === 0) return;
      const { ok, failed } = await hydrateContext(browser.context, jar);
      this.logger.info(`已把 cookie 文件里的 ${ok} 个登录态灌回浏览器${failed > 0 ? `（${failed} 个被拒绝）` : ''}`, 'web');
    } catch (error) {
      this.logger.warn(`把 cookie 灌回浏览器失败：${error.message}`, 'web');
    }
  }

  /** 把浏览器里的登录态落盘到 cookie 文件（http 模式靠它工作）。 */
  async #exportCookieFile(browser) {
    try {
      const { FileCookieStore, defaultCookieFile } = await import('./cookies.mjs');
      const file = this.config.search?.cookieFile ?? defaultCookieFile(this.config);
      const { count, missing } = await browser.exportCookies(new FileCookieStore({ file, logger: this.logger }));
      this.logger.info(`登录态已写入 ${file}（${count} 个 cookie），监控侧不再需要浏览器`, 'web');
      if (missing.length > 0) {
        this.logger.warn(`导出的登录态缺少 ${missing.join('、')}（会话级 cookie，浏览器一关就丢），监控会报会话失效`, 'web');
      }
    } catch (error) {
      this.logger.warn(`登录态落盘失败（http 模式会因此没有 cookie）：${error.message}`, 'web');
    }
  }

  /**
   * 造一个「谁去搜」。
   *
   * - `http`（默认）：文件版 cookie + 直连 mtop，每轮恰好 1 次请求，**不需要浏览器**。
   * - `browser`：驱动页面那套，这时才需要把浏览器拉起来。
   *
   * @returns {Promise<any>} 带 `search(task)` 与 `checkSession()` 的对象。
   */
  async #makeSearcher() {
    const { createSearcher } = await import('./mtop.mjs');
    const browser = this.config.search?.mode === 'browser' ? await this.#ensureBrowser() : undefined;
    return createSearcher({ config: this.config, logger: this.logger, browser });
  }

  /** 启动监控。已经在跑或正在启动时直接返回成功。 */
  async start() {
    if (this.running || this.starting) return { ok: true };
    this.starting = true;
    this.lastError = null;
    this.#stateChanged();
    try {
      // 先把配置文件读进来：界面上「保存配置 → 停止 → 启动」是用户心里的一次重启，
      // 不重新加载的话他会以为保存没生效。
      await this.reloadConfig();
      // http 模式**不拉起浏览器**：登录态来自 cookie 文件，浏览器只在扫码登录和
      // 「点开看商品」时按需启动——那个空白窗口和服务器上的 Xvfb 需求一起消失了。
      const searcher = await this.#makeSearcher();
      this.session = await searcher.checkSession();
      if (this.session === 'invalid') {
        throw new Error(
          this.config.search?.mode === 'browser'
            ? '服务端会话已失效，请点「重新登录」扫码。'
            : '登录态不可用：没有 cookie 文件，或会话已失效。点「重新登录」扫码即可；' +
              '若 profile 里本来就有有效登录态，在终端执行 node src/cli.mjs export-cookies 更省事。',
        );
      }

      this.#ensureStore();
      this.#backfillTotals();

      this.monitor = new Monitor({
        config: this.config,
        store: this.store,
        browser: this.browser,
        searcher,
        logger: this.logger,
        // 与「立即检查」共用同一个页面队列。
        serialize: (operation) => this.#queued(operation),
        onNotified: (item, task, options) => this.#recordHit(item, task, options),
      });

      this.running = true;
      this.startedAt = Date.now();
      this.stats = this.monitor.stats;
      // run() 会一直等到 stop()，因此不能 await，只把它当后台任务看待。
      this.runPromise = this.monitor.run().catch((error) => {
        this.running = false;
        this.lastError = error.message;
        this.logger.error(`监控主循环退出：${error.message}`, 'web');
        this.#stateChanged();
      });
      this.logger.info('监控已启动', 'web');
      this.#clearStartRetry();
      return { ok: true };
    } catch (error) {
      this.running = false;
      this.lastError = error.message;
      this.logger.error(error.message, 'web');
      // 会话失效、浏览器起不来这类问题，人工处理完（重新扫码、修好环境）就该自动接上。
      // 页面上没有启停入口，不自动重试的话服务会一直躺在「没在跑」。
      this.#scheduleStartRetry();
      return { ok: false, error: error.message };
    } finally {
      this.starting = false;
      this.#stateChanged();
    }
  }

  /** 停止监控并关闭浏览器，释放 profile 锁。 */
  async stop() {
    const monitor = this.monitor;
    const runPromise = this.runPromise;
    this.monitor = null;
    this.runPromise = null;
    monitor?.stop();
    // stop() 会立刻唤醒等待中的任务，正常情况下几十毫秒内就收尾；这里只是兜底。
    if (runPromise) await Promise.race([runPromise, sleep(10000)]);
    if (this.store) {
      this.store.prune();
      this.store.save();
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.running = false;
    this.startedAt = null;
    this.logger.info('监控已停止', 'web');
    this.#stateChanged();
    return { ok: true };
  }

  /**
   * 跑一轮只看不推的检查，用于调关键词和过滤条件。
   *
   * 返回值里 `hits` **同时包含命中项和被过滤项**，被过滤项带 `reasons` 数组；
   * 这样前端既能列出命中，也能在折叠区里逐条解释「为什么这条没推」——
   * 调过滤条件时，被排除的原因比命中的结果更有信息量。
   *
   * @returns {Promise<{ok: boolean, results?: object[], error?: string}>} 每个任务的扫描与逐条判定结果。
   */
  async check() {
    try {
      const searcher = await this.#makeSearcher();
      const store = this.store ?? new SeenStore({ file: this.config.storage.stateFile }).load();
      const results = [];
      for (const task of this.config.tasks.filter((entry) => entry.enabled !== false)) {
        const { items, source } = await this.#queued(() => searcher.search(task));
        const evaluated = [];
        let matched = 0;
        for (const item of items) {
          const verdict = evaluate(item, task.filters, { onUnknown: this.config.monitor.onUnknownField });
          const entry = {
            id: item.id,
            title: item.title,
            price: item.price,
            area: item.area,
            seller: item.seller,
            url: item.url,
            appUrl: item.appUrl ?? null,
            alreadyPushed: store.has(item.id),
          };
          if (verdict.ok) matched += 1;
          else entry.reasons = verdict.rejections;
          evaluated.push(entry);
        }
        results.push({ task: task.name, keyword: task.keyword, scanned: items.length, source, hits: evaluated });
        this.logger.info(`检查「${task.keyword}」：扫描 ${items.length} 条，命中 ${matched} 条`, 'web');
      }
      return { ok: true, results };
    } catch (error) {
      this.lastError = error.message;
      this.logger.error(`检查失败：${error.message}`, 'web');
      return { ok: false, error: error.message };
    }
  }

  /** 给所有通知渠道发一条测试消息。 */
  async testNotify() {
    try {
      const results = await sendAll(
        this.config.notify.channels,
        { title: '闲鱼监控测试消息', body: `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}` },
        { timeoutMs: this.config.notify.timeoutMs, logger: this.logger },
      );
      return { ok: results.some((result) => result.ok), results };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * 开始扫码登录：清掉失效 Cookie、打开首页、定时把二维码截图写到磁盘。
   * 登录成功后自动结束并把会话状态置为 valid。
   * @param {number} [timeoutSeconds] 等待扫码的秒数。
   * @returns {Promise<{ok: boolean, error?: string}>} 是否已开始（结果通过状态轮询获知）。
   */
  async loginWithQr(timeoutSeconds = 300) {
    if (this.login.active) return { ok: true };
    if (this.running) await this.stop();
    try {
      const browser = await this.#ensureBrowser();
      const existing = await browser.checkSession();
      if (existing === 'valid') {
        this.session = 'valid';
        // 会话有效 ≠ cookie 文件存在。http 模式的监控只认那个文件，所以这条提前返回
        // 也必须导出，否则界面会一直停在「会话已失效 / 还没导出 cookie 文件」。
        await this.#exportCookieFile(browser);
        // 没有开始新流程时必须说清楚：`active:false` 供程序判断，`error`/`message` 供界面显示文案。
        const notice = '当前会话仍然有效，无需重新登录';
        return { ok: true, active: false, error: notice, message: notice };
      }
      if (existing === 'invalid') await browser.clearSession();

      this.login.active = true;
      this.login.qrUrl = '/api/login-qr.png';
      this.#stateChanged();
      this.logger.info('已开始扫码登录，二维码每 5 秒刷新', 'web');

      const qrPath = this.qrPath;
      const deadline = Date.now() + timeoutSeconds * 1000;
      const poll = async () => {
        let lastShotAt = 0;
        await browser.openForLogin();
        while (this.login.active && Date.now() < deadline) {
          if (await browser.isLoggedIn()) break;
          if (Date.now() - lastShotAt >= 5000) {
            await browser.screenshotTo(qrPath).catch(() => {});
            lastShotAt = Date.now();
          }
          await sleep(2000);
        }
        // Cookie 出现不等于会话有效，必须等服务端确认。
        let session = 'unknown';
        for (let attempt = 0; attempt < 3 && session !== 'valid'; attempt += 1) {
          await sleep(3000);
          session = await browser.checkSession();
        }
        this.session = session;
        if (session === 'valid') await this.#exportCookieFile(browser);
        this.login.active = false;
        this.logger.info(
          session === 'valid' ? '扫码登录成功' : `扫码登录未完成（会话状态：${session}）`,
          'web',
        );
        // 登录成功就把监控接上：服务生命周期归进程，页面上没有「启动」按钮，
        // 不在这里自动拉起的话，启动时会话失效的用户扫码后就一直停在「没在跑」。
        if (session === 'valid' && !this.running && !this.starting) {
          await this.start().catch((error) => this.logger.warn(`登录后自动启动失败：${error.message}`, 'web'));
        }
        this.#stateChanged();
      };
      poll().catch((error) => {
        this.login.active = false;
        this.lastError = error.message;
        this.logger.error(`扫码登录失败：${error.message}`, 'web');
        this.#stateChanged();
      });
      return { ok: true };
    } catch (error) {
      this.login.active = false;
      this.lastError = error.message;
      return { ok: false, error: error.message };
    }
  }

  /** @returns {string} 二维码图片的绝对路径。 */
  get qrPath() {
    return path.join(path.dirname(this.config.storage.stateFile), 'login-qr.png');
  }

  /**
   * 保存新配置。只做校验与落盘，不热重启——改变任务集合需要重建主循环，
   * 让用户显式点一次「重启」比悄悄换掉运行中的循环更可控。
   * @param {object} rawConfig 新配置对象。
   * @returns {Promise<{ok: boolean, problems?: string[]}>} 校验结果。
   */
  async saveConfig(rawConfig) {
    const { validateConfig, resolveEnv } = await import('./config.mjs');
    let resolved;
    try {
      resolved = withDefaults(resolveEnv(rawConfig));
    } catch (error) {
      return { ok: false, problems: [`配置结构不合法：${error.message}`] };
    }
    const problems = validateConfig(resolved);
    if (problems.length > 0) return { ok: false, problems };
    try {
      const temp = `${this.configPath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(rawConfig, null, 2)}\n`, 'utf8');
      renameSync(temp, this.configPath);
    } catch (error) {
      return { ok: false, problems: [error.message] };
    }
    // 写盘成功才动运行时：任务的新增/修改/删除即时生效，不必重启进程。
    const previous = this.config;
    this.config = resolved;
    // Monitor 持有的是 config 的引用，这里换了对象就必须同步过去，
    // 否则总开关（notify.enabled）之类的读取还停在旧对象上。
    if (this.monitor) this.monitor.config = resolved;
    this.#applyTaskDiff(resolved.tasks, previous?.tasks ?? []);
    this.#stateChanged();
    return { ok: true };
  }

  /**
   * 把任务列表的变化应用到运行中的循环上。
   *
   * 三种情况：新任务启动循环、删掉的任务停掉循环、定义变了的任务用新定义重启循环。
   * 只有 `notify`（推送开关）不触发重启——它是运行期动态读取的，换掉任务对象即可。
   *
   * @param {any[]} nextTasks 新的任务列表。
   * @param {any[]} previousTasks 变化前的任务列表。
   */
  #applyTaskDiff(nextTasks, previousTasks) {
    const monitor = this.monitor;
    if (!monitor) return; // 循环没在跑（启动失败等），下次启动会直接读新配置

    const previousByName = new Map(previousTasks.map((task) => [task.name, task]));
    const nextByName = new Map(nextTasks.map((task) => [task.name, task]));

    // 已经从配置里删掉的任务：停掉它的循环
    for (const name of [...monitor.controls.keys()]) {
      if (!nextByName.has(name)) monitor.stopTask(name);
    }

    for (const task of nextTasks) {
      const control = monitor.controls.get(task.name);
      if (task.enabled === false) {
        if (control) monitor.stopTask(task.name);
        continue;
      }
      if (!control) {
        monitor.startTask(task);
        continue;
      }
      if (this.#loopSignature(previousByName.get(task.name)) !== this.#loopSignature(task)) {
        monitor.restartTask(task);
      } else {
        // 定义没变（可能只是改了 notify）：换掉循环手里的对象，别白重启一轮。
        control.task = task;
      }
    }
    monitor.showTaskName = monitor.controls.size > 1;
  }

  /**
   * 决定「要不要重启循环」的任务指纹。`notify` 是运行期动态读取的开关，排除在外。
   * @param {any} task 任务配置。
   * @returns {string} 指纹。
   */
  #loopSignature(task) {
    if (!task || typeof task !== 'object') return 'null';
    const { notify, ...rest } = task;
    return stableStringify(rest);
  }

  /**
   * 只替换 tasks 段并保存，其余配置（通知渠道、控制台、浏览器）原样保留。
   *
   * 界面上的任务增删改走这里而不是整份配置覆盖：整份覆盖时，界面手里的副本一旦
   * 过期就会把别处的改动回滚掉；这里每次从磁盘重读，只动 tasks 一个键。
   *
   * @param {object[]} tasks 新的任务数组。
   * @returns {Promise<{ok: boolean, problems?: string[]}>} 校验结果。
   */
  async saveTasks(tasks) {
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      return { ok: false, problems: [`读取配置文件失败：${error.message}`] };
    }
    return this.saveConfig({ ...raw, tasks });
  }

  /**
   * 启用或停用单个任务：立刻生效并写回配置，不需要重启整个监控。
   *
   * 与 `saveTasks` 一样从磁盘重读配置再改，避免界面手里的副本过期时覆盖别处的改动。
   * 写盘成功才动运行中的循环，保证「界面显示的」和「文件里存的」不会分叉。
   *
   * @param {string} name 任务名。
   * @param {boolean} enabled 目标状态。
   * @returns {Promise<{ok: boolean, running?: boolean, error?: string}>} 结果与生效后的运行状态。
   */
  async setTaskEnabled(name, enabled) {
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'name 必填' };
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };

    let raw;
    try {
      raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      return { ok: false, error: `读取配置文件失败：${error.message}` };
    }
    const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
    const target = tasks.find((task) => task.name === name);
    if (!target) return { ok: false, error: `配置里没有这个任务：${name}` };

    const saved = await this.saveConfig({ ...raw, tasks: tasks.map((task) => (task.name === name ? { ...task, enabled } : task)) });
    if (!saved.ok) return { ok: false, error: (saved.problems ?? []).join('；') };

    // 运行中的循环由 saveConfig → #applyTaskDiff 按差异启停，这里不用再单独处理。
    this.logger.info(`任务「${name}」已${enabled ? '启用' : '停用'}`, 'web');
    return { ok: true, running: this.monitor?.isTaskRunning(name) ?? false };
  }

  /**
   * 切换推送开关。不传 `name` 时切总开关，传了则只切该任务的开关。
   *
   * 两级是「与」的关系，各自独立存放：总开关在 `notify.enabled`，单任务在 `task.notify`。
   * 监控持有的是同一个 config 对象，所以改完内存里的值当前循环立刻生效，不用重启。
   * 与任务启停一样先从磁盘重读再改，写盘成功才动内存，保证界面显示与文件内容不分叉。
   *
   * @param {{name?: string, enabled: boolean}} request 目标状态；`name` 为空表示总开关。
   * @returns {Promise<{ok: boolean, enabled?: boolean, error?: string}>} 结果。
   */
  async setNotify({ name, enabled } = {}) {
    if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled 必须是布尔值' };

    let raw;
    try {
      raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
    } catch (error) {
      return { ok: false, error: `读取配置文件失败：${error.message}` };
    }

    const isMaster = name === undefined || name === null || name === '';
    let next;
    if (isMaster) {
      next = { ...raw, notify: { ...(raw.notify ?? {}), enabled } };
    } else {
      const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
      if (!tasks.some((task) => task.name === name)) return { ok: false, error: `配置里没有这个任务：${name}` };
      next = { ...raw, tasks: tasks.map((task) => (task.name === name ? { ...task, notify: enabled } : task)) };
    }

    const saved = await this.saveConfig(next);
    if (!saved.ok) return { ok: false, error: (saved.problems ?? []).join('；') };

    // 总开关与单任务开关都在 saveConfig 里已同步进 this.config（以及 Monitor 的引用），
    // 循环每次判断都会读到新值，这里不需要再做别的。
    this.logger.info(
      isMaster ? `商品推送已${enabled ? '开启' : '静默'}` : `任务「${name}」的推送已${enabled ? '开启' : '静默'}`,
      'web',
    );
    return { ok: true, enabled };
  }

  /**
   * 取得去重表 + 累计计数，必要时读盘。
   *
   * 不能只在 `start()` 里创建：监控没跑起来（会话失效、浏览器起不来）时界面照样要显示
   * 累计计数和已记录条数，那时候 store 若是 null，卡片就会显示全 0，而状态文件里明明有数。
   *
   * @returns {import('./store.mjs').SeenStore} 去重表实例。
   */
  #ensureStore() {
    if (this.store) return this.store;
    this.store = new SeenStore({
      file: this.config.storage.stateFile,
      limit: this.config.storage.seenLimit,
      retentionDays: this.config.storage.seenRetentionDays,
    }).load();
    this.store.prune();
    return this.store;
  }

  /**
   * 启动失败后定时重试。
   *
   * 服务生命周期归进程、页面上没有启停入口，所以「启动失败」必须能自愈：最常见的原因是
   * 进程启动时会话已失效，用户扫码登录后应当自动接上（登录流程里也会立即拉起一次，
   * 这里只是兜底，覆盖浏览器起不来等其它情况）。只在「没在跑」时重试，成功即停。
   */
  #scheduleStartRetry() {
    if (this.startRetryTimer) return;
    this.startRetryTimer = setInterval(() => {
      if (this.running || this.starting) return;
      this.logger.info('监控尚未运行，自动重试启动', 'web');
      this.start().catch((error) => this.logger.warn(`自动重试启动失败：${error.message}`, 'web'));
    }, START_RETRY_MS);
    // 不要因为这个定时器把进程吊住（CLI 一次性命令要能正常退出）。
    this.startRetryTimer.unref?.();
  }

  /** 启动成功后取消重试。 */
  #clearStartRetry() {
    if (!this.startRetryTimer) return;
    clearInterval(this.startRetryTimer);
    this.startRetryTimer = null;
  }

  /**
   * 在监控自己那个已登录的浏览器窗口里打开某个商品的网页。
   *
   * 桌面浏览器直接开闲鱼网页是未登录的（登录态在监控的 profile 里），所以这条路径让
   * 「点一下看商品」带上登录态。只接受商品 id，网址由 linkTemplate 现拼，避免变成一个
   * 能被外部用来跳任意地址的接口。
   *
   * @param {string} id 商品 id。
   * @returns {Promise<{ok: boolean, url?: string, error?: string}>} 结果。
   */
  async openItem(id) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) return { ok: false, error: '商品 id 不合法' };
    const url = this.config.linkTemplate.replace('{id}', id);
    // 按需拉起：http 模式下监控不启浏览器，但「点开看商品」仍然要在带登录态的窗口里打开，
    // 所以这里不能因为 this.browser 为空就拒掉（拉起时会自动灌回 cookie 文件里的登录态）。
    let browser;
    try {
      browser = await this.#ensureBrowser();
    } catch (error) {
      return { ok: false, error: `浏览器启动失败：${error.message}` };
    }
    const result = await browser.openItem(url);
    return result.ok ? { ok: true, url } : { ok: false, error: result.error };
  }

  /** 按新的配置文件重新加载进程级配置（浏览器、存储路径等）。 */
  async reloadConfig() {
    const { loadConfig } = await import('./config.mjs');
    const { config } = await loadConfig(this.configPath);
    const resolved = withDefaults(config);
    if (!path.isAbsolute(resolved.browser.userDataDir)) {
      resolved.browser.userDataDir = path.resolve(this.configDir, resolved.browser.userDataDir);
    }
    if (!path.isAbsolute(resolved.storage.stateFile)) {
      resolved.storage.stateFile = path.resolve(this.configDir, resolved.storage.stateFile);
    }
    resolved.browser.linkTemplate = resolved.linkTemplate;
    this.config = resolved;
    if (this.browser) this.browser.config = resolved.browser;
    // Monitor 持有 config 的引用，换了对象要同步过去。
    if (this.monitor) this.monitor.config = resolved;
    return { ok: true };
  }

  /** 进程退出前的清理。 */
  async shutdown() {
    this.login.active = false;
    await this.stop();
  }
}
