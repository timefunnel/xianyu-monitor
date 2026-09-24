/**
 * 主循环：每个任务一条独立节奏的轮询协程，共享同一个浏览器页面（因此对页面的操作串行执行）。
 * 单个任务出错只影响自己：指数退避后继续，连续失败到阈值时发一次告警。
 */

import { evaluate, describeFilters } from './rules.mjs';
import { condenseTitle, formatItem, sendAll } from './notify.mjs';
import { MISSING_FIELDS } from './parse.mjs';

/** 连续多少轮扫描到 0 条就告警一次。 */
const EMPTY_STREAK_WARNING = 5;

/** 超过这个搜索频率就提醒用户（实测每分钟 3 次量级会触发风控）。 */
const SAFE_REQUESTS_PER_MINUTE = 2;

/**
 * 把失败的投递结果描述成「渠道（原因）」。同类型的多个渠道带上配置下标，否则日志里分不清是哪一个。
 * @param {{index?: number, type: string, error?: string}} result 投递结果。
 * @returns {string} 可读描述。
 */
function describeFailure(result) {
  const where = Number.isInteger(result.index) ? `${result.type}#${result.index}` : result.type;
  return `${where}${result.error ? `（${result.error}）` : ''}`;
}

/**
 * @typedef {object} TaskStats
 * @property {number} cycles 轮询次数。
 * @property {number} scanned 扫到的商品条数。
 * @property {number} matched 命中过滤条件的条数。
 * @property {number} notified 成功推送的条数。
 * @property {number} failures 连续失败次数。
 * @property {number} emptyStreak 连续扫描到 0 条的轮数。
 * @property {number} lastSuccessAt 最近一次成功抓取的时间。
 * @property {number} unknownSkips 因字段缺失跳过判定的次数。
 */

export class Monitor {
  /**
   * @param {object} options
   * @param {any} options.config 已补齐默认值的配置。
   * @param {import('./store.mjs').SeenStore} options.store 去重表。
   * @param {any} options.searcher 「谁去搜」：带 `search(task)` 与 `checkSession()` 的对象。
   * @param {any} options.logger 日志器。
   * @param {(operation: () => Promise<any>) => Promise<any>} [options.serialize]
   *   请求队列。Web 控制台在监控运行期间也要用同一个搜索器做「立即检查」，
   *   共用同一个队列才能保证请求不会互相插入（全局最小请求间隔也挂在这条链上）。
   * @param {(item: any, task: any) => void} [options.onNotified] 每次推送成功后的回调。
   */
  constructor({ config, store, searcher, logger, serialize, onNotified }) {
    this.config = config;
    this.store = store;
    this.searcher = searcher;
    this.logger = logger;
    this.onNotified = onNotified;
    this.running = false;
    this.startedAt = Date.now();
    this.queue = Promise.resolve();
    /** 多任务时推送标题带上任务名，单任务时省掉这个噪声；由 run() 按启用任务数设置。 */
    this.showTaskName = false;
    /** @type {Map<string, TaskStats>} */
    this.stats = new Map();
    /** 已经就「连续失败」发过告警的任务，避免每轮都刷屏。 */
    this.alerted = new Set();
    /** 上次真正发起搜索的时间，用于跨任务的全局请求间隔闸（见 #respectRequestGap）。 */
    this.lastRequestAt = 0;
    this.serialize = serialize ?? ((operation) => this.#queued(operation));
    /**
     * 每个在跑的任务对应一个控制块：它自己的统计、它自己的「还要不要继续跑」、
     * 以及它自己的唤醒句柄。
     *
     * 唤醒句柄必须**每任务一份**：共用一份时，多个任务同时等待下一轮会互相覆盖，
     * `stop()` 只能唤醒最后一个登记的任务，其余的会一直睡到间隔结束（可能好几分钟）。
     *
     * @type {Map<string, {task: any, state: TaskStats, running: boolean, wake: (() => void)|null, timer: any, loop: Promise<void>|null}>}
     */
    this.controls = new Map();
    /** run() 常驻用的闸门；stop() 释放它。 */
    this.releaseRun = null;
    this.heartbeat = null;
  }

  /**
   * 可被打断的等待。轮询间隔可能长达几分钟，不能让「停止」按钮干等。
   * @param {{wake: (() => void)|null, timer: any}} control 任务控制块。
   * @param {number} ms 等待毫秒数。
   * @returns {Promise<void>} 被唤醒或超时后 resolve。
   */
  #wait(control, ms) {
    return new Promise((resolve) => {
      control.wake = () => {
        control.wake = null;
        control.timer = null;
        resolve();
      };
      control.timer = setTimeout(control.wake, ms);
    });
  }

  /** 让某个任务的循环尽快退出下一轮等待。 */
  #wakeControl(control) {
    control.running = false;
    if (control.timer) clearTimeout(control.timer);
    control.wake?.();
  }

  /** 浏览器页面是共享资源，所有页面操作必须排队。 */
  #queued(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 启动单个任务的抓取循环。已经在跑时返回 false。
   * @param {any} task 任务配置。
   * @returns {boolean} 是否新启动了循环。
   */
  startTask(task) {
    const existing = this.controls.get(task.name);
    if (existing?.running) return false;

    /** @type {TaskStats} */
    const state = existing?.state ?? {
      // 累计计数从状态文件续上，只有「连续失败/空轮/最近成功」这类运行期状态才是新的。
      ...this.store.getTotals(task.name),
      failures: 0,
      emptyStreak: 0,
      lastSuccessAt: 0,
      unknownSkips: 0,
    };
    const control = { task, state, running: true, wake: null, timer: null, loop: null };
    this.controls.set(task.name, control);
    this.stats.set(task.name, state);
    this.showTaskName = this.controls.size > 1;
    control.loop = this.#taskLoop(control).catch((error) => {
      this.logger.error(`任务循环异常退出：${error.message}`, task.name);
    });
    return true;
  }

  /**
   * 停止单个任务的抓取循环。互不影响的其它任务继续跑。
   * @param {string} name 任务名。
   * @returns {boolean} 是否真的停掉了一个在跑的任务。
   */
  stopTask(name) {
    const control = this.controls.get(name);
    if (!control) return false;
    this.#wakeControl(control);
    this.controls.delete(name);
    this.showTaskName = this.controls.size > 1;
    return true;
  }

  /**
   * 用新的任务定义重启单个循环（改了关键词、过滤条件、间隔等）。
   * 旧循环会在当前这一轮结束后自行退出；两次循环短暂并存是安全的——页面操作共用一条队列，
   * 去重表也会拦住重复推送。
   *
   * @param {any} task 新定义。
   * @returns {boolean} 是否启动了新循环。
   */
  restartTask(task) {
    this.stopTask(task.name);
    return this.startTask(task);
  }

  /**
   * @param {string} name 任务名。
   * @returns {boolean} 该任务此刻是否在跑。
   */
  isTaskRunning(name) {
    return this.controls.get(name)?.running === true;
  }

  /**
   * 启动所有启用的任务，并常驻到 stop() 被调用。
   * @returns {Promise<void>} 全部任务退出后 resolve。
   */
  async run() {
    if (this.running) return;
    this.running = true;
    const tasks = this.config.tasks.filter((task) => task.enabled !== false);

    // 一个任务都没启用不是致命错误：服务待命即可。界面把某个任务的开关打开时，
    // startTask 会直接把循环拉起来，不需要重启进程。
    if (tasks.length === 0) {
      this.logger.warn('当前没有启用中的任务，监控待命中（在控制台打开任务开关即可开始）', 'monitor');
    } else {
      if (this.config.monitor.notifyOnStart) {
        await this.#notify({
          title: '闲鱼监控已启动',
          body: tasks.map((task) => `· ${task.name}：${task.keyword}\n  ${describeFilters(task.filters, task.nativeFilters)}`).join('\n'),
        });
      }
      for (const task of tasks) this.startTask(task);
      this.#warnAboutCombinedRate(tasks);
    }

    this.heartbeat = setInterval(() => {
      this.#heartbeat().catch((error) => this.logger.error(`心跳发送异常：${error.message}`, 'monitor'));
    }, this.config.monitor.heartbeatHours * 3600000);

    // 常驻：任务可以在运行期间被单独启停，因此不能只等最初那批循环结束。
    await new Promise((resolve) => {
      this.releaseRun = resolve;
    });
    this.releaseRun = null;
    clearInterval(this.heartbeat);
    this.heartbeat = null;

    // 收尾：唤醒仍在等待的任务并等它们真正退出。
    const loops = [...this.controls.values()].map((control) => control.loop);
    for (const control of this.controls.values()) this.#wakeControl(control);
    await Promise.all(loops.map((loop) => loop ?? Promise.resolve()));
    this.controls.clear();
  }

  /** 请求整体停止：唤醒所有任务循环，run() 随之结束。 */
  stop() {
    if (!this.running) return;
    this.running = false;
    for (const control of this.controls.values()) this.#wakeControl(control);
    this.releaseRun?.();
  }

  /**
   * 单个任务的轮询循环。
   * @param {{task: any, state: TaskStats, running: boolean}} control 任务控制块。
   * @returns {Promise<void>} 任务退出后 resolve。
   */
  async #taskLoop(control) {
    const { task, state } = control;
    this.logger.info(`开始监控：${task.keyword}（${describeFilters(task.filters, task.nativeFilters)}）`, task.name);
    if (typeof task.filters?.maxAgeMinutes === 'number' && MISSING_FIELDS.has('publishTime')) {
      this.logger.warn(
        'maxAgeMinutes 依赖发布时间，但闲鱼 PC 搜索响应基本不返回这个字段，因此它多半按「时间未知」放行而没有真正过滤。' +
          '想只盯新货，靠去重表（同一条只推一次）比靠时间窗更可靠。',
        task.name,
      );
    }

    let cooldownSeconds = 0;
    while (this.running && control.running) {
      const cycleStart = Date.now();
      try {
        const hits = await this.#scanOnce(task, state);
        await this.#dispatch(task, hits, state);
        state.failures = 0;
        state.lastSuccessAt = Date.now();
        cooldownSeconds = 0;
        this.alerted.delete(task.name);
      } catch (error) {
        state.failures += 1;
        this.logger.error(`抓取失败（第 ${state.failures} 次）：${error.message}`, task.name);

        // 「直接拒绝」要分两种情况，退避时间差两个数量级：
        //  - 刚刚复位了被标记的 cookie（`droppedCookies` 非空）→ 下一轮是一次**不同的**请求，
        //    实测复位之后立刻就能搜到，所以按正常间隔马上再试，没必要干等半小时；
        //  - 什么都没得复位 → 说明这次拒绝不在 cookie 上，重试没有意义，走长退避等人。
        const resetCookies = Array.isArray(error.droppedCookies) ? error.droppedCookies.length : 0;
        if (error.code === 'throttled') {
          // 被限流时按小步加倍只会一直撞墙，直接进入最长冷却。
          cooldownSeconds = this.config.monitor.maxBackoffSeconds;
        } else if (error.code === 'risk-control') {
          // 风控验证在自动化窗口里**过不了**（baxia 会认出自动化环境），重试多少次都没用，
          // 反而会让风控更严。所以长时间退避，等人工用普通 Chrome 打开这个 profile 处理。
          cooldownSeconds = this.config.monitor.riskControlCooldownSeconds;
        } else if (error.code === 'denied') {
          cooldownSeconds = resetCookies > 0 ? 0 : this.config.monitor.riskControlCooldownSeconds;
        } else {
          cooldownSeconds = Math.min(
            Math.max(cooldownSeconds * 2, task.intervalSeconds),
            this.config.monitor.maxBackoffSeconds,
          );
        }
        const waitMinutes = (cooldownSeconds / 60).toFixed(1);
        const pauseReason =
          error.code === 'risk-control'
            ? `已暂停 ${waitMinutes} 分钟：风控验证在自动化窗口里过不了，重试只会让风控更严。` +
              '请先停掉本进程，再用普通 Chrome 打开同一个 profile 完成验证（见 README 的「风控」一节）'
            : error.code === 'denied' && resetCookies > 0
              ? `本轮被风控直接拒绝，已复位 ${resetCookies} 个被标记的 cookie；` +
                `约 ${Math.round((task.intervalSeconds + Math.random() * task.jitterSeconds) || 0)} 秒后不带它重试`
              : error.code === 'denied'
                ? `已暂停 ${waitMinutes} 分钟：搜索接口被风控直接拒绝（action=deny），且没有可复位的 cookie。` +
                  '这不是频率问题，调大间隔、重新登录、过验证都不会恢复，别去窗口里耗时间。' +
                  '跑 node diagnose-risk.mjs 看处置建议'
                : `冷却 ${waitMinutes} 分钟后重试`;
        this.logger.warn(pauseReason, task.name);

        // 登录失效、筛选没生效、风控弹层都必须立刻告警：这几种自己不会恢复，都要人看一眼
        // （重新登录 / 改选择器 / 用普通 Chrome 处理风控），等阈值只会白等；
        // 其它错误连续失败到阈值再报，避免偶发抖动刷屏。
        const urgent =
          error.code === 'auth' ||
          error.code === 'filters-not-applied' ||
          error.code === 'risk-control' ||
          error.code === 'denied';
        const threshold = urgent ? 1 : this.config.monitor.failureAlertThreshold;
        if (state.failures >= threshold && !this.alerted.has(task.name)) {
          this.alerted.add(task.name);
          await this.#notify({
            title: `闲鱼监控异常：${task.name}`,
            body: `连续 ${state.failures} 次抓取失败。\n最后错误：${error.message}\n\n排查：node src/cli.mjs check，或 node src/cli.mjs once 看单轮结果。`,
          });
        }
      }

      const waitSeconds = task.intervalSeconds + cooldownSeconds + Math.random() * task.jitterSeconds;
      const elapsed = Date.now() - cycleStart;
      // 每轮把累计计数落盘；推送成功时 #dispatch 里已经同步过一次，这里兜住扫描类的增量。
      this.#syncTotals(task, state);
      if (this.running && control.running) await this.#wait(control, Math.max(1000, waitSeconds * 1000 - elapsed));
    }
    this.logger.info('任务已停止', task.name);
  }

  /**
   * 启动时把「多任务加起来的总频率」算给用户看。
   *
   * 每个任务的 `intervalSeconds` 看着都很保守，但它们串行累加，几个 60 秒的任务就能凑到
   * 实测触发风控的量级。这条只在启动时提醒一次，运行期靠 `#respectRequestGap` 兜住。
   *
   * @param {any[]} tasks 本次启动的任务。
   */
  #warnAboutCombinedRate(tasks) {
    const perMinute = tasks.reduce((sum, task) => sum + 60 / Math.max(1, task.intervalSeconds ?? 60), 0);
    if (perMinute <= SAFE_REQUESTS_PER_MINUTE) return;
    this.logger.warn(
      `当前 ${tasks.length} 个任务合计约 ${perMinute.toFixed(1)} 次搜索/分钟，` +
        `已接近实测触发风控的 3 次/分钟量级。程序会按全局最小间隔 ${this.config.monitor.minRequestGapSeconds}s 放慢，` +
        '建议同时调大 intervalSeconds 或减少任务。',
      'monitor',
    );
  }

  /**
   * 全局请求间隔闸：跨任务限制两次搜索之间的最小间隔。
   *
   * 单个任务的 `intervalSeconds` 只约束它自己；多任务串行执行时总频率会叠加，
   * 几个 60 秒的任务就能凑到实测触发风控的「每分钟 3 次」量级。这里在真正发起搜索前
   * 统一等一下，把总节奏压到安全范围。首次请求不用等。
   *
   * @param {{task: any}} control 任务控制块（等待需要可被 stop() 打断）。
   * @returns {Promise<void>} 可以发起请求时 resolve。
   */
  async #respectRequestGap(control) {
    const gapMs = (this.config.monitor.minRequestGapSeconds ?? 0) * 1000;
    if (gapMs <= 0) return;
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && elapsed < gapMs) {
      const waitMs = gapMs - elapsed;
      this.logger.info(
        `距上次搜索仅 ${(elapsed / 1000).toFixed(1)}s，按全局最小间隔再等 ${(waitMs / 1000).toFixed(1)}s（防止多任务叠加触发风控）`,
        control.task.name,
      );
      await this.#wait(control, waitMs);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * 抓取一轮并筛出命中项（此阶段不写去重表，避免推送失败后丢失）。
   * @param {any} task 任务配置。
   * @param {TaskStats} state 任务统计。
   * @returns {Promise<Array<{item: any, unknown: string[]}>>} 命中项。
   */
  async #scanOnce(task, state) {
    const { items, source, requests } = await this.serialize(async () => {
      await this.#respectRequestGap({ task });
      return this.searcher.search(task);
    });
    state.cycles += 1;
    state.scanned += items.length;
    if (source === 'dom') this.logger.warn('本轮结果为 DOM 兜底解析，字段可能不全', task.name);

    const hits = [];
    for (const item of items) {
      if (this.store.has(item.id)) continue;
      const verdict = evaluate(item, task.filters, { onUnknown: this.config.monitor.onUnknownField });
      if (verdict.unknown.length > 0) state.unknownSkips += 1;
      if (!verdict.ok) {
        this.logger.debug(`过滤：${verdict.rejections.join('；')}`, task.name, item.id);
        continue;
      }
      hits.push(item);
    }
    state.matched += hits.length;

    // 每轮都留一行 info：没有输出会让人分不清「在正常工作」和「早就卡死了」。
    // 带上请求次数，热路径省了多少一眼可见。
    const withAppLink = items.filter((item) => item.appUrl).length;
    this.logger.info(
      `第 ${state.cycles} 轮：${requests ?? '?'} 次请求，扫描 ${items.length} 条（${withAppLink} 条带 App 直达链接），命中 ${hits.length} 条`,
      task.name,
    );

    if (items.length === 0) {
      state.emptyStreak += 1;
      if (state.emptyStreak === EMPTY_STREAK_WARNING) {
        this.logger.warn(
          `连续 ${EMPTY_STREAK_WARNING} 轮扫描到 0 条，关键词可能无结果，也可能页面结构或登录态出了问题`,
          task.name,
        );
      }
    } else {
      state.emptyStreak = 0;
    }
    return hits;
  }

  /**
   * 把累计计数写进状态文件。
   *
   * 除了每轮结束时同步，推送成功后也要立刻同步一次：命中历史是推送当下就落盘的，计数若拖到
   * 轮末才写，期间进程被重启（界面上「重启」很常用）就会丢掉这次增量，出现「历史里 88 条
   * 真推送、累计已推送 68」这种对不上的组合。
   *
   * @param {any} task 任务配置。
   * @param {TaskStats} state 任务统计。
   */
  #syncTotals(task, state) {
    this.store.setTotals(task.name, {
      cycles: state.cycles,
      scanned: state.scanned,
      matched: state.matched,
      notified: state.notified,
    });
    this.store.save();
  }

  /**
   * 是否该往外发**商品推送**。总开关与单任务开关是「与」的关系。
   *
   * 只管商品推送：登录失效、筛选没生效、连续失败这类告警不走这里——静默是为了不被商品
   * 刷屏，不是为了把故障也一起瞒掉。
   *
   * @param {any} task 任务配置。
   * @returns {boolean} 为真才推送。
   */
  #shouldPush(task) {
    if (this.config.notify.enabled === false) return false;
    return task.notify !== false;
  }

  /**
   * 推送命中项。超过 `notify.maxPerCycle` 的部分合并成一条摘要，避免刷屏又不丢消息。
   * 推送至少成功一个渠道才写入去重表，因此渠道整体故障时下一轮会重试。
   *
   * 静默模式下仍然写去重表与命中历史——界面照常能看到这批命中，只是不发通知；
   * 否则「关掉推送」会连记录一起丢，重新打开时会一次性补推一堆历史商品。
   *
   * @param {any} task 任务配置。
   * @param {import('./rules.mjs').Item[]} hits 命中商品。
   * @param {TaskStats} state 任务统计。
   * @returns {Promise<void>} 推送完成后 resolve。
   */
  async #dispatch(task, hits, state) {
    if (hits.length === 0) return;

    if (!this.#shouldPush(task)) {
      for (const item of hits) {
        this.store.add(item.id);
        // pushed:false 让命中历史能区分「真发出去了」和「静默期间只记账」，
        // 否则重启后的累计已推送会把静默期间的命中也算进去。
        this.onNotified?.(item, task, { pushed: false });
      }
      this.store.save();
      this.#syncTotals(task, state);
      this.logger.info(`命中 ${hits.length} 条，推送已静默（只记入命中历史）`, task.name);
      return;
    }

    const cap = this.config.notify.maxPerCycle ?? 8;
    const immediate = hits.slice(0, cap);
    const overflow = hits.slice(cap);

    for (const item of immediate) {
      const message = formatItem(item, task, { showTaskName: this.showTaskName });
      const results = await sendAll(this.config.notify.channels, message, {
        timeoutMs: this.config.notify.timeoutMs,
        logger: this.logger,
      });
      const failed = results.filter((result) => !result.ok);
      if (failed.length < results.length) {
        this.store.add(item.id);
        state.notified += 1;
        this.onNotified?.(item, task);
        // 历史已经写了，计数也立刻落盘，两者不会因为一次重启而分叉。
        this.#syncTotals(task, state);
        if (failed.length === 0) {
          this.logger.info(`命中并已推送：¥${item.price ?? '?'} ${item.title}`, task.name, item.url);
        } else {
          // 部分失败必须点名。去重是按**商品**记的，这条一旦记为已处理，失败的渠道就不会再收到它；
          // 以前这里照样打「已推送」，等于把丢推送这件事藏了起来。
          this.logger.warn(
            `命中已推送，但 ${failed.length}/${results.length} 个渠道失败（${failed.map(describeFailure).join('；')}）；` +
              '该商品已记为已处理，这些渠道不会再收到它',
            task.name,
            item.url,
          );
        }
      } else {
        this.logger.error(
          `所有渠道推送失败（${results.map(describeFailure).join('；')}），本条将在下一轮重试`,
          task.name,
          item.id,
        );
      }
    }

    if (overflow.length > 0) {
      const body = overflow.map((item) => `· ${typeof item.price === 'number' ? `¥${item.price}` : '价格未知'} ${condenseTitle(item.title)}`).join('\n');
      const results = await sendAll(
        this.config.notify.channels,
        { title: `还有 ${overflow.length} 条命中 · ${task.name}`, body },
        { timeoutMs: this.config.notify.timeoutMs, logger: this.logger },
      );
      const failed = results.filter((result) => !result.ok);
      if (failed.length < results.length) {
        for (const item of overflow) {
          this.store.add(item.id);
          this.onNotified?.(item, task);
        }
        state.notified += overflow.length;
        this.#syncTotals(task, state);
        if (failed.length > 0) {
          this.logger.warn(
            `汇总推送已发出，但 ${failed.length}/${results.length} 个渠道失败（${failed.map(describeFailure).join('；')}）；` +
              `这 ${overflow.length} 条不会再重发`,
            task.name,
          );
        }
      } else {
        this.logger.error(
          `汇总推送所有渠道都失败（${results.map(describeFailure).join('；')}），这 ${overflow.length} 条将在下一轮重试`,
          task.name,
        );
      }
    }
  }

  /** 发送运行状态摘要：既能确认进程活着，也能及早发现「一直在跑但一条都没匹配」的配置问题。 */
  async #heartbeat() {
    const uptimeHours = ((Date.now() - this.startedAt) / 3600000).toFixed(1);
    const lines = [`运行 ${uptimeHours} 小时，已记录 ${this.store.size} 条。`];
    for (const [name, state] of this.stats) {
      const last = state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString('zh-CN', { hour12: false }) : '从未';
      lines.push(`· ${name}：轮询 ${state.cycles} 次，扫描 ${state.scanned} 条，命中 ${state.matched} 条，已推送 ${state.notified} 条，未判定字段 ${state.unknownSkips} 次，连续失败 ${state.failures} 次，最近成功 ${last}`);
    }
    await this.#notify({ title: '闲鱼监控心跳', body: lines.join('\n') });
  }

  /** 统一出口：所有面向用户的通知都经过这里，便于以后加限流或通道降级。 */
  async #notify(message) {
    const results = await sendAll(this.config.notify.channels, message, {
      timeoutMs: this.config.notify.timeoutMs,
      logger: this.logger,
    });
    if (!results.some((result) => result.ok)) this.logger.warn('本条通知没有任何渠道投递成功', 'monitor');
  }
}
