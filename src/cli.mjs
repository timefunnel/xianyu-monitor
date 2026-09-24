#!/usr/bin/env node
/**
 * 命令行入口。子命令：
 *   web           启动图形控制台（HTTP + 浏览器界面），并自动拉起监控
 *   run           启动监控（默认）
 *   login         扫码登录：纯 HTTP，二维码打在终端里（不需要浏览器/图形界面）
 *   check         校验配置与运行环境，不启动浏览器
 *   once          跑一轮搜索并打印结果，不推送（加 --notify 才推送）
 *   dump          保存一轮原始响应，用于字段结构变化后的适配层排查
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
  if (!path.isAbsolute(resolved.storage.stateFile)) {
    resolved.storage.stateFile = path.resolve(configDir, resolved.storage.stateFile);
  }
  return { config: resolved, configDir, configPath: path.resolve(configPath) };
}

/**
 * 造搜索器：文件版 cookie + 直连 mtop，**不启动浏览器**。
 *
 * @param {any} config 配置。
 * @param {any} logger 日志器。
 * @returns {Promise<any>} 带 `search(task)` 与 `checkSession()` 的搜索器。
 */
async function createSearcherFor(config, logger) {
  return createSearcher({ config, logger });
}

/**
 * 纯 HTTP 扫码登录：把二维码直接打在终端里，手机扫屏幕即可。
 *
 * 不需要浏览器、不需要图形界面，所以服务器上（甚至容器里）可以直接登录——这本该是最省事的一条路，
 * 也让登录不再受"闲鱼登录页改版"影响（浏览器版依赖 DOM 与 iframe，改一次版就失效）。
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
      `登录态缺少 ${result.missing.join('、')}，不算登录成功。可以重试。`,
      'login',
    );
    process.exitCode = 1;
    return;
  }
  logger.info(`登录成功，已写入 ${result.cookies} 个 cookie。监控侧不再需要浏览器。`, 'login');
}

const commands = {
  /** 扫码登录：纯 HTTP，二维码直接打在终端里（实现见文件上方的 loginByQr）。 */
  async login({ config }, logger, options) {
    await loginByQr(config, logger, options);
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

    const cookieFile = config.search?.cookieFile ?? defaultCookieFile(config);
    const hasCookies = existsSync(cookieFile);
    logger.info(`登录态文件：${cookieFile}（${hasCookies ? '已存在' : '不存在'}）`);
    if (!hasCookies) {
      logger.warn(
        '没有登录态文件。执行 node src/cli.mjs login 扫码即可（二维码打在终端里，不需要浏览器）；' +
          '也可以在别的机器上登录后把这个文件拷过来。',
      );
    }
    logger.info(`状态文件：${config.storage.stateFile}（${existsSync(config.storage.stateFile) ? '已存在' : '首次运行后创建'}）`);
    logger.info('配置校验通过。');
  },

  /** 跑一轮搜索，默认只打印，便于调过滤条件。 */
  async once({ config }, logger, options) {
    const targets = config.tasks.filter((task) => task.enabled !== false && (!options.task || task.name === options.task));
    if (targets.length === 0) throw new Error(`没有匹配的任务：${options.task ?? '(全部)'}`);

    // 搜索器在整条命令里只建一个：它持有 token 续期与被标记 cookie 的记忆，
    // 每个任务各建一个会把这些状态丢掉。
    const searcher = await createSearcherFor(config, logger);
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
    }
  },

  /** 保存原始响应，字段结构变化时用它重写 src/parse.mjs。 */
  async dump({ config }, logger, options) {
    const searcher = await createSearcherFor(config, logger);
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
    // password 是正式字段；token 是旧字段，仍然当密码用（老配置不至于连不上）。
    const password = String(config.web.password || config.web.token || '');
    const trustProxy = config.web.trustProxy === true;
    const open = options['no-open'] !== true && config.web.open !== false;

    const console_ = await startWebConsole({ supervisor, port, host, password, trustProxy, logger, openBrowser: open });

    const started = await supervisor.start();
    if (!started.ok) logger.warn(`监控未自动启动：${started.error}`, 'web');
    if (password) logger.info('已启用访问密码，打开地址后会先跳转登录页', 'web');

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
    const searcher = await createSearcherFor(config, logger);
    const session = await searcher.checkSession();
    if (session === 'invalid') {
      logger.error('服务端会话已失效，请重新执行 npm run login 扫码（http 模式还需把登录态落盘，见 README）。', 'run');
      process.exitCode = 1;
      return;
    }
    if (session === 'unknown') {
      logger.warn('没能确认会话状态；若搜索报「要求登录」请重新登录。', 'run');
    }
    logger.info('会话正常。', 'run');

    const monitor = new Monitor({ config, store, searcher, logger });
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
    '用法：node src/cli.mjs <web|run|login|check|once|dump|test-notify> [--config 路径] [--task 名称]\n' +
      '  web 支持 --port --host --token --no-open\n' +
      '  login：二维码打在终端里，不需要浏览器/图形界面；--timeout 秒\n',
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
