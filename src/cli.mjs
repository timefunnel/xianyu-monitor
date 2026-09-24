#!/usr/bin/env node
/**
 * 命令行入口。子命令：
 *   web           启动图形控制台（HTTP + 浏览器界面），并自动拉起监控
 *   run           启动监控（默认）
 *   login         扫码登录：默认纯 HTTP（二维码打在终端里，不需要浏览器）；--browser 走浏览器路径
 *   check         校验配置与运行环境，不启动浏览器
 *   once          跑一轮搜索并打印结果，不推送（加 --notify 才推送）
 *   dump          保存一轮原始响应，用于字段结构变化后的适配层排查
 *   export-cookies 把 profile 里现有的登录态落到 cookie 文件
 *   test-notify   给所有通知渠道发一条测试消息
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, withDefaults } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createSearcher } from './mtop.mjs';
import { FileCookieStore, defaultCookieFile } from './cookies.mjs';
import { qrLogin } from './qrlogin.mjs';
import { describeFilters, evaluate } from './rules.mjs';
import { SeenStore } from './store.mjs';
import { formatItem, sendAll } from './notify.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取 .env：只在变量尚未设置时赋值，已存在的环境变量优先。 */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

/** 解析 `--key value` / `--flag` 形式的参数。 */
function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) options[key] = true;
      else {
        options[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { options, positional };
}

/** 载入配置并把相对路径解析到配置文件所在目录（systemd / docker 下更可预期）。 */
async function setup(configPath) {
  const { config, configDir } = await loadConfig(configPath);
  const resolved = withDefaults(config);
  if (!path.isAbsolute(resolved.browser.userDataDir)) {
    resolved.browser.userDataDir = path.resolve(configDir, resolved.browser.userDataDir);
  }
  if (!path.isAbsolute(resolved.storage.stateFile)) {
    resolved.storage.stateFile = path.resolve(configDir, resolved.storage.stateFile);
  }
  resolved.browser.linkTemplate = resolved.linkTemplate;
  return { config: resolved, configDir, configPath: path.resolve(configPath) };
}

async function createBrowser(config, logger, overrides = {}) {
  let GoofishBrowser;
  try {
    ({ GoofishBrowser } = await import('./browser.mjs'));
  } catch (error) {
    throw new Error(`无法加载 Playwright：${error.message}\n请先执行 npm install 与 npx playwright install chromium`);
  }
  mkdirSync(config.browser.userDataDir, { recursive: true });
  const browser = new GoofishBrowser({ ...config.browser, ...overrides }, logger);
  try {
    await browser.open();
  } catch (error) {
    throw new Error(
      `浏览器启动失败：${error.message}\n可能的两个原因：\n` +
        `  1. profile 目录正被另一个实例占用（${config.browser.userDataDir}）\n` +
        `  2. 当前环境没有图形界面（$DISPLAY 缺失），需要 xvfb-run 启动，见 README 的部署章节`,
    );
  }
  return browser;
}

/**
 * 按模式造搜索器。**http 模式不拉起浏览器**——登录态来自 cookie 文件；浏览器只在
 * browser 模式（以及扫码登录、点开看商品）才需要。
 *
 * @param {any} config 配置。
 * @param {any} logger 日志器。
 * @param {any} [overrides] 传给 createBrowser 的覆盖项。
 * @returns {Promise<{searcher: any, browser: any}>} 搜索器，以及浏览器（http 模式下为 null）。
 */
async function createSearcherFor(config, logger, overrides = {}) {
  if (config.search?.mode === 'browser') {
    const browser = await createBrowser(config, logger, overrides);
    return { searcher: await createSearcher({ config, logger, browser }), browser };
  }
  return { searcher: await createSearcher({ config, logger }), browser: null };
}

/**
 * 把浏览器里的登录态落盘。http 模式靠这个文件工作，所以**每一条「登录已经好了」的路径都必须调它**：
 * 只挂在扫码成功那条路上是不够的——会话本来就有效时会走提前返回，那就一份文件都不会生成，
 * 而监控会一直说「没有 cookie」。
 *
 * @param {any} config 配置。
 * @param {any} browser 浏览器。
 * @param {any} logger 日志器。
 * @param {string} [tag] 日志标签。
 * @returns {Promise<number>} 写入的 cookie 个数。
 */
async function exportCookieFile(config, browser, logger, tag = 'login') {
  const file = config.search?.cookieFile ?? defaultCookieFile(config);
  const { count, missing } = await browser.exportCookies(new FileCookieStore({ file, logger }));
  logger.info(`登录态已写入 ${file}（${count} 个 cookie），监控侧不再需要浏览器。`, tag);
  if (missing.length > 0) {
    logger.warn(
      `导出的登录态缺少 ${missing.join('、')}：它是会话级 cookie，浏览器一关就没了，而 mtop 必须带它。` +
        '请先扫码登录（npm run login）再导出，否则监控会一直报会话失效。',
      tag,
    );
  }
  return count;
}

/**
 * 纯 HTTP 扫码登录：把二维码直接打在终端里，手机扫屏幕即可。
 *
 * 不需要浏览器、不需要图形界面，所以服务器上（甚至容器里）可以直接登录——这本该是最省事的一条路，
 * 也让登录不再受"闲鱼登录页改版"影响（浏览器版依赖 DOM 与 iframe，改一次版就失效）。
 * HTTP 路径出问题时就加 `--browser` 回到浏览器路径。
 *
 * 这里**不做"会话还有效就跳过"的预检查**：那要多发一次 mtop 请求，而 `login` 本来就是用户主动执行的。
 *
 * @param {any} config 配置。
 * @param {any} logger 日志器。
 * @param {any} options 命令选项（`--timeout` 秒）。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function loginByQr(config, logger, options) {
  const file = config.search?.cookieFile ?? defaultCookieFile(config);
  const timeoutSeconds = Number(options.timeout ?? 180);
  logger.info(`扫码登录（纯 HTTP，不启动浏览器），登录态将写入 ${file}`, 'login');

  let lastStatus = null;
  const result = await qrLogin({
    store: new FileCookieStore({ file, logger }),
    logger,
    timeoutSeconds,
    onQr: ({ terminal }) => {
      // 二维码打在终端里：手机扫屏幕，不需要图片文件，也不需要图形界面。
      process.stdout.write(`\n${terminal}\n请用闲鱼 App 扫描上面的二维码。\n\n`);
    },
    onWait: ({ status, remainingSeconds }) => {
      if (status === lastStatus) return;
      lastStatus = status;
      logger.info(`等待扫码（状态 ${status || '未知'}）…剩余 ${remainingSeconds} 秒`, 'login');
    },
  });

  if (!result.ok) {
    logger.error(
      `登录态缺少 ${result.missing.join('、')}，不算登录成功。可以重试，或加 --browser 走浏览器路径（需要图形界面）。`,
      'login',
    );
    process.exitCode = 1;
    return;
  }
  logger.info(`登录成功，已写入 ${result.cookies} 个 cookie。监控侧不再需要浏览器。`, 'login');
}

const commands = {
  /**
   * 扫码登录。默认走**纯 HTTP**（见 loginByQr），`--browser` 走下面这条浏览器路径。
   *
   * 浏览器路径必须用有头模式：闲鱼对无头请求直接返回「非法访问」页，二维码根本不会渲染。
   * 服务器上也没有显示器，因此本命令一边保持有头渲染，一边把二维码截图写到共享目录，
   * 用户从 NAS/SFTP 打开图片用闲鱼 App 扫码；本机则会直接弹出窗口，扫窗口里的码同样可以。
   * 服务器上请用 xvfb-run 启动本命令。
   */
  async login({ config }, logger, options) {
    // 默认走纯 HTTP：不需要浏览器、不需要图形界面，服务器上直接可用。
    // 想用浏览器（想看窗口里的码，或 HTTP 路径出问题时）加 --browser。
    if (options.browser !== true) {
      await loginByQr(config, logger, options);
      return;
    }
    const out = path.resolve(options.out ?? path.join(path.dirname(config.storage.stateFile), 'login-qr.png'));
    const timeoutMs = Number(options.timeout ?? 300) * 1000;
    const browser = await createBrowser(config, logger, { headless: false });
    try {
      // 会话仍然有效时不必重登；已失效时必须先清 Cookie，否则下面的等待会因为
      // 「旧的登录 Cookie 还在」而立刻通过，用户根本没机会扫新码。
      const existing = await browser.checkSession();
      if (existing === 'valid') {
        logger.info('当前会话仍然有效，无需重新登录。', 'login');
        // 会话有效不等于 cookie 文件存在：从浏览器方案切过来、或上次就在这条分支返回过，
        // 文件都可能是空的。这里补上，否则监控会一直报「没有 cookie」。
        await exportCookieFile(config, browser, logger);
        return;
      }
      if (existing === 'invalid') {
        logger.info('检测到已有登录 Cookie 但会话已失效，清除旧 Cookie 后重新生成二维码。', 'login');
        await browser.clearSession();
      }
      await browser.openForLogin();

      logger.info(`登录弹窗已打开。本机可直接扫窗口里的二维码；服务器请打开 ${out}（每 5 秒刷新）。`, 'login');

      // 第一步：等扫码后写入登录 Cookie。
      const deadline = Date.now() + timeoutMs;
      let lastShotAt = 0;
      while (Date.now() < deadline) {
        if (await browser.isLoggedIn()) break;
        if (Date.now() - lastShotAt >= 5000) {
          await browser.screenshotTo(out);
          lastShotAt = Date.now();
          logger.info(`二维码已更新（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）：${out}`, 'login');
        }
        await sleep(3000);
      }

      if (!(await browser.isLoggedIn())) {
        logger.error('等待扫码超时，没有检测到登录 Cookie。可重新执行本命令。', 'login');
        process.exitCode = 1;
        return;
      }

      // 第二步：Cookie 出现不等于会话有效，必须等站点自己确认。
      logger.info('已检测到登录 Cookie，正在等服务端确认会话（请确认手机上点完「确认登录」）…', 'login');
      let session = 'unknown';
      for (let attempt = 0; attempt < 3 && session !== 'valid'; attempt += 1) {
        await sleep(4000);
        session = await browser.checkSession();
        logger.info(`会话确认第 ${attempt + 1} 次：${session}`, 'login');
      }

      if (session === 'valid') {
        logger.info(`登录成功，登录态已保存到 ${config.browser.userDataDir}`, 'login');
        await exportCookieFile(config, browser, logger);
      } else if (session === 'invalid') {
        logger.error(
          'Cookie 已写入但服务端会话无效（loginuser.get 未返回 SUCCESS）。' +
            '常见原因：手机端没点完「确认登录」、账号被风控、或同一账号在别处重新登录。' +
            '可稍等几分钟后重试，或改用「本机登录后拷贝 profile」的方式。',
          'login',
        );
        process.exitCode = 1;
      } else {
        logger.warn('没能读到 loginuser.get 的返回码，按 Cookie 判定为登录成功；若搜索报错请重新登录。', 'login');
      }
    } finally {
      await browser.close();
    }
  },

  /** 只做静态检查，不联网、不启动浏览器。 */
  async check({ config, configDir, configPath: resolvedConfigPath }) {
    const logger = createLogger();
    logger.info(`配置文件：${resolvedConfigPath}`);
    logger.info(`配置目录：${configDir}`);
    const tasks = config.tasks.filter((task) => task.enabled !== false);
    logger.info(`启用任务 ${tasks.length} 个：`);
    for (const task of tasks) {
      logger.info(`  · ${task.name}：关键词「${task.keyword}」，间隔 ${task.intervalSeconds}s(+${task.jitterSeconds}s)，${describeFilters(task.filters, task.nativeFilters, { verbose: true })}`);
      if (typeof task.filters?.maxAgeMinutes === 'number') {
        logger.warn(`${task.name} 的 maxAgeMinutes 依赖发布时间，而闲鱼 PC 搜索响应基本不返回这个字段，该条件多半不会真正生效。`);
      }
    }
    logger.info(`通知渠道 ${config.notify.channels.length} 个：${config.notify.channels.map((channel) => channel.type).join(', ')}`);

    const profile = config.browser.userDataDir;
    const httpMode = config.search?.mode !== 'browser';
    if (httpMode) {
      // http 模式下监控不启浏览器，登录态就在这个文件里；profile 只是"登录那一步"的落点。
      const cookieFile = config.search?.cookieFile ?? defaultCookieFile(config);
      const hasCookies = existsSync(cookieFile);
      logger.info(`登录态文件：${cookieFile}（${hasCookies ? '已存在' : '不存在'}）`);
      if (!hasCookies) {
        logger.warn(
          '没有登录态文件。最省事的做法：在任意一台有浏览器的机器上跑 npm run login，' +
            `再把生成的 cookies.json 拷到这里（${cookieFile}）——服务器上因此不必装浏览器，也不用 Xvfb。`,
        );
      }
    } else {
      logger.info(`profile 目录：${profile}（${existsSync(profile) ? '已存在' : '不存在，需要先执行 npm run login'}）`);
    }
    logger.info(`状态文件：${config.storage.stateFile}（${existsSync(config.storage.stateFile) ? '已存在' : '首次运行后创建'}）`);

    let playwright = '不可用';
    try {
      await import('playwright');
      playwright = '可用';
    } catch {
      playwright = '不可用（执行 npm install）';
    }
    logger.info(
      httpMode
        ? `Playwright：${playwright} —— 默认登录（纯 HTTP 终端二维码）与监控都用不到它，只有 --browser 登录 / export-cookies / 点开看商品需要`
        : `Playwright：${playwright}`,
    );

    if (config.browser.headless) {
      logger.warn('headless 为 true：扫码登录时闲鱼会返回「非法访问」页、二维码不会渲染。监控本身不启浏览器（http 模式），所以这一项只影响 login。');
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin' && !process.env.DISPLAY && config.search?.mode !== 'browser') {
      logger.info('当前没有 $DISPLAY：监控不需要它（http 模式不启浏览器），只有扫码登录要跑在 xvfb-run 下。');
    }
    logger.info('配置校验通过。');
  },

  /**
   * 把浏览器 profile 里已有的登录态导出到 cookie 文件。
   *
   * 这是 http 模式的「登录」动作：全程**不导航、不请求**，只是把 profile 里的 cookie 读出来
   * 落盘，所以从浏览器方案切过来**不必重新扫码**。扫码登录成功后也会自动落盘。
   */
  async 'export-cookies'({ config }, logger) {
    // 不导航、不渲染，所以强制无头：服务器上没有 $DISPLAY 也能导出，不必为这一步套 xvfb-run。
    const browser = await createBrowser(config, logger, { headless: true });
    try {
      const file = config.search?.cookieFile ?? defaultCookieFile(config);
      const { count, missing } = await browser.exportCookies(new FileCookieStore({ file, logger }));
      if (count === 0) {
        logger.error('profile 里没有任何 cookie。请先执行 node src/cli.mjs login 扫码登录。', 'export');
        process.exitCode = 1;
        return;
      }
      logger.info(`已写入 ${file}（${count} 个 cookie）。之后监控侧不再需要浏览器。`, 'export');
      if (missing.length > 0) {
        // 最常见的坑：浏览器早就关过了，会话级 cookie 已丢，这时导出的是「看起来正常但缺件」的登录态。
        logger.warn(
          `缺少 ${missing.join('、')}：它是会话级 cookie，浏览器一关就被丢弃，而 mtop 必须带它。` +
            '请先扫描登录（node src/cli.mjs login）再导出，否则监控会一直报会话失效。',
          'export',
        );
      }
    } finally {
      await browser.close();
    }
  },

  /** 跑一轮搜索，默认只打印，便于调过滤条件。 */
  async once({ config }, logger, options) {
    const targets = config.tasks.filter((task) => task.enabled !== false && (!options.task || task.name === options.task));
    if (targets.length === 0) throw new Error(`没有匹配的任务：${options.task ?? '(全部)'}`);

    // 搜索器在整条命令里只建一个：它持有 token 续期与被标记 cookie 的记忆，
    // 每个任务各建一个会把这些状态丢掉。
    const { searcher, browser } = await createSearcherFor(config, logger);
    const store = new SeenStore({ file: config.storage.stateFile }).load();
    try {
      for (const task of targets) {
        const { items, source } = await searcher.search(task);
        logger.info(`「${task.keyword}」返回 ${items.length} 条（来源 ${source}）`, task.name);
        for (const item of items) {
          const verdict = evaluate(item, task.filters, { onUnknown: config.monitor.onUnknownField });
          const mark = verdict.ok ? '命中' : '跳过';
          const detail = verdict.ok ? `未判定字段:${verdict.unknown.join(',') || '无'}` : verdict.rejections.join('；');
          logger.info(`  [${mark}] ¥${item.price ?? '?'} ${item.title} | ${item.area ?? '?'} | ${item.seller ?? '?'} | 已推送过:${store.has(item.id)} | ${detail}`, task.name);
          logger.info(`         ${item.url}`, task.name);
          if (verdict.ok && options.notify) {
            const results = await sendAll(config.notify.channels, formatItem(item, task, { showTaskName: targets.length > 1 }), {
              timeoutMs: config.notify.timeoutMs,
              logger,
            });
            if (results.some((result) => result.ok)) store.add(item.id);
          }
        }
      }
      if (options.notify) store.save();
    } finally {
      await browser?.close();
    }
  },

  /** 保存原始响应，字段结构变化时用它重写 src/parse.mjs。 */
  async dump({ config }, logger, options) {
    const { searcher, browser } = await createSearcherFor(config, logger);
    try {
      const targets = config.tasks.filter((task) => task.enabled !== false && (!options.task || task.name === options.task));
      for (const task of targets) {
        const { items, source, raw } = await searcher.search(task);
        const out = path.resolve(options.out ?? path.join(path.dirname(config.storage.stateFile), `dump-${task.name}-${Date.now()}.json`));
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify({ keyword: task.keyword, source, itemCount: items.length, raw }, null, 2), 'utf8');
        logger.info(`已写入 ${out}（来源 ${source}，解析出 ${items.length} 条）`, task.name);
      }
    } finally {
      await browser?.close();
    }
  },

  /** 验证渠道配置是否正确，避免正式运行时才发现 webhook 填错。 */
  async 'test-notify'({ config }, logger) {
    const message = { title: '闲鱼监控测试消息', body: `时间：${new Date().toLocaleString('zh-CN', { hour12: false })}\n如果你看到这条消息，说明渠道配置可用。` };
    const results = await sendAll(config.notify.channels, message, { timeoutMs: config.notify.timeoutMs, logger });
    for (const result of results) {
      logger.info(`${result.ok ? '成功' : '失败'}：${result.type}${result.error ? ` — ${result.error}` : ''}`, 'notify');
    }
    if (!results.some((result) => result.ok)) process.exitCode = 1;
  },

  /** 图形控制台：启动 HTTP 服务并自动拉起监控，浏览器里看状态、日志和命中历史。 */
  async web({ config, configPath }, _logger, options) {
    const { Supervisor } = await import('./supervisor.mjs');
    const { startWebConsole } = await import('./server.mjs');

    // 日志旁路要先于 Supervisor 存在，因此用可变引用回填。
    let supervisor = null;
    const logger = createLogger({
      sink: (record) => supervisor?.publish({ type: 'log', ...record }),
    });
    supervisor = new Supervisor({ config, configPath, logger });

    const port = Number(options.port ?? config.web.port);
    const host = String(options.host ?? config.web.host);
    const token = String(options.token ?? config.web.token);
    const open = options['no-open'] !== true && config.web.open !== false;

    const console_ = await startWebConsole({ supervisor, port, host, token, logger, openBrowser: open });

    const started = await supervisor.start();
    if (!started.ok) logger.warn(`监控未自动启动：${started.error}`, 'web');
    if (token) logger.info(`已启用访问令牌，打开 ${console_.url} 即可（也可只用 ?token=${token}）`, 'web');

    let closing = false;
    const shutdown = async (signal) => {
      if (closing) return;
      closing = true;
      logger.info(`收到 ${signal}，正在退出……`, 'web');
      await console_.close();
      await supervisor.shutdown();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    logger.info('控制台运行中，按 Ctrl+C 退出。', 'web');
    // 常驻：真正的退出走信号处理。
    await new Promise(() => {});
  },

  /** 正式运行。 */
  async run({ config }, logger, options) {
    const { Monitor } = await import('./monitor.mjs');
    const store = new SeenStore({
      file: config.storage.stateFile,
      limit: config.storage.seenLimit,
      retentionDays: config.storage.seenRetentionDays,
    }).load();
    store.prune();
    const { searcher, browser } = await createSearcherFor(config, logger);
    const session = await searcher.checkSession();
    if (session === 'invalid') {
      logger.error('服务端会话已失效，请重新执行 npm run login 扫码（http 模式还需把登录态落盘，见 README）。', 'run');
      await browser?.close();
      process.exitCode = 1;
      return;
    }
    if (session === 'unknown') {
      logger.warn('没能确认会话状态；若搜索报「要求登录」请重新登录。', 'run');
    }
    logger.info('会话正常。', 'run');

    const monitor = new Monitor({ config, store, browser, searcher, logger });
    let stopped = false;
    const shutdown = (signal) => {
      if (stopped) return;
      stopped = true;
      logger.info(`收到 ${signal}，正在退出……`, 'run');
      monitor.stop();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    try {
      await monitor.run();
    } finally {
      store.prune();
      store.save();
      await browser?.close();
      logger.info('已退出。', 'run');
    }
  },
};

let configPath = './config.json';
const { options, positional } = parseArgs(process.argv.slice(2));
const command = positional[0] ?? 'run';
configPath = options.config ?? process.env.XIANYU_CONFIG ?? configPath;

if (command === 'help' || options.help) {
  process.stdout.write(
    '用法：node src/cli.mjs <web|run|login|export-cookies|check|once|dump|test-notify> [--config 路径] [--task 名称]\n' +
      '  web 支持 --port --host --token --no-open\n' +
      '  login 默认纯 HTTP：二维码打在终端里，不需要浏览器/图形界面；--browser 走浏览器路径，--timeout 秒\n',
  );
  process.exit(0);
}
if (!Object.hasOwn(commands, command)) {
  process.stderr.write(`未知命令：${command}\n用法：node src/cli.mjs <web|run|login|check|once|dump|test-notify> [--config 路径]\n`);
  process.exit(1);
}

loadDotEnv(path.resolve(path.dirname(path.resolve(configPath)), '.env'));
loadDotEnv(path.resolve('.env'));

const logger = createLogger();
try {
  const context = await setup(configPath);
  await commands[command](context, logger, options);
} catch (error) {
  logger.error(error.message, command);
  process.exitCode = 1;
}
