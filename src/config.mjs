/**
 * 配置加载：读取 config.json（或 config.mjs），展开 ${ENV} 占位符，校验后返回。
 * 校验失败直接抛错并列出全部问题，避免带着半截配置启动。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateChannels } from './notify.mjs';

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * 递归展开字符串中的 ${ENV_VAR}。缺失的变量保留原样并记入 missing 列表，由调用方决定是否致命。
 * @param {unknown} value 任意配置值。
 * @param {string[]} missing 收集缺失的环境变量名。
 * @returns {unknown} 展开后的值。
 */
export function resolveEnv(value, missing = []) {
  if (typeof value === 'string') {
    return value.replace(ENV_PATTERN, (whole, name) => {
      const resolved = process.env[name];
      if (resolved === undefined || resolved === '') {
        if (!missing.includes(name)) missing.push(name);
        return whole;
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((entry) => resolveEnv(entry, missing));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveEnv(entry, missing);
    return out;
  }
  return value;
}

const POSITIVE_INT = (value) => Number.isInteger(value) && value > 0;

/**
 * 校验配置对象，返回问题清单。空数组表示可用。
 * @param {any} config 已展开环境变量的配置。
 * @returns {string[]} 人类可读的问题描述。
 */
export function validateConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['配置根节点必须是对象'];

  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    problems.push('tasks 必须是非空数组');
  } else {
    config.tasks.forEach((task, index) => {
      const where = `tasks[${index}]`;
      if (!task || typeof task !== 'object') {
        problems.push(`${where} 必须是对象`);
        return;
      }
      if (!task.name) problems.push(`${where}.name 必填（用于日志与去重）`);
      if (!task.keyword || typeof task.keyword !== 'string') problems.push(`${where}.keyword 必填`);
      if ("intervalSeconds" in task && !POSITIVE_INT(task.intervalSeconds)) {
        problems.push(`${where}.intervalSeconds 必须是正整数秒`);
      }
      if ("jitterSeconds" in task && (!Number.isInteger(task.jitterSeconds) || task.jitterSeconds < 0)) {
        problems.push(`${where}.jitterSeconds 必须是非负整数秒`);
      }
      if ("scrollRounds" in task && (!Number.isInteger(task.scrollRounds) || task.scrollRounds < 0)) {
        problems.push(`${where}.scrollRounds 必须是非负整数`);
      }
      if ("jumpLink" in task && !['web', 'app'].includes(task.jumpLink)) {
        problems.push(`${where}.jumpLink 只能是 web 或 app`);
      }
      const filters = task.filters ?? {};
      for (const key of ['minPrice', 'maxPrice']) {
        if (key in filters && typeof filters[key] !== 'number') {
          problems.push(`${where}.filters.${key} 必须是数字`);
        }
      }
      if (typeof filters.minPrice === 'number' && typeof filters.maxPrice === 'number' && filters.minPrice > filters.maxPrice) {
        problems.push(`${where}.filters.minPrice 不能大于 maxPrice`);
      }
      for (const key of ['requireKeywords', 'excludeKeywords', 'excludeSellers', 'cityAnyOf']) {
        if (key in filters && !Array.isArray(filters[key])) {
          problems.push(`${where}.filters.${key} 必须是字符串数组`);
        }
      }
      for (const key of ['requirePattern', 'excludePattern']) {
        if (!(key in filters)) continue;
        if (typeof filters[key] !== 'string') {
          problems.push(`${where}.filters.${key} 必须是字符串`);
          continue;
        }
        if (filters[key] === '') continue;
        try {
          new RegExp(filters[key], 'i');
        } catch (error) {
          problems.push(`${where}.filters.${key} 不是合法正则：${error.message}`);
        }
      }
      if ('maxAgeMinutes' in filters && !POSITIVE_INT(filters.maxAgeMinutes)) {
        problems.push(`${where}.filters.maxAgeMinutes 必须是正整数分钟`);
      }
      if ('cityContains' in filters && typeof filters.cityContains !== 'string') {
        problems.push(`${where}.filters.cityContains 必须是字符串`);
      }
      const native = task.nativeFilters;
      if (native !== undefined) {
        if (!native || typeof native !== 'object' || Array.isArray(native)) {
          problems.push(`${where}.nativeFilters 必须是对象`);
        } else if ('priceRange' in native || 'region' in native || 'sort' in native || 'publishDays' in native) {
          const range = native.priceRange;
          if ('priceRange' in native && (!Array.isArray(range) || range.length !== 2 || !range.every((bound) => typeof bound === 'number'))) {
            problems.push(`${where}.nativeFilters.priceRange 必须是 [最低价, 最高价] 两个数字`);
          } else if (Array.isArray(range) && range[0] > range[1]) {
            problems.push(`${where}.nativeFilters.priceRange 最低价不能大于最高价`);
          }
          if ('region' in native && (typeof native.region !== 'string' || native.region.trim() === '')) {
            problems.push(`${where}.nativeFilters.region 必须是非空字符串，且要与闲鱼区域面板上的文字一致（如 江浙沪 / 上海）`);
          }
          // 「新发布」下拉里的两项：最新=排序，N天内=发布时间窗
          if ('sort' in native && native.sort !== 'newest') {
            problems.push(`${where}.nativeFilters.sort 目前只支持 "newest"（对应闲鱼「新发布 → 最新」）`);
          }
          if ('publishDays' in native && ![1, 3, 7, 14].includes(native.publishDays)) {
            problems.push(`${where}.nativeFilters.publishDays 只能是 1 / 3 / 7 / 14（对应闲鱼「新发布」里的时间窗）`);
          }
        }
      }
    });
  }

  const monitor = config.monitor ?? {};  if ('onUnknownField' in monitor && !['pass', 'reject'].includes(monitor.onUnknownField)) {
    problems.push('monitor.onUnknownField 只能是 pass 或 reject');
  }
  if ('failureAlertThreshold' in monitor && !POSITIVE_INT(monitor.failureAlertThreshold)) {
    problems.push('monitor.failureAlertThreshold 必须是正整数');
  }

  const web = config.web ?? {};
  if ('port' in web && (!Number.isInteger(web.port) || web.port < 1 || web.port > 65535)) {
    problems.push('web.port 必须是 1~65535 的整数');
  }
  for (const key of ['host', 'password', 'token']) {
    if (key in web && typeof web[key] !== 'string') problems.push(`web.${key} 必须是字符串`);
  }
  if (typeof web.host === 'string' && !['127.0.0.1', 'localhost', '0.0.0.0', '::'].includes(web.host)) {
    problems.push('web.host 只支持 127.0.0.1 / localhost / 0.0.0.0 / ::');
  }
  // token 是旧字段，仍当密码用；两者都没设才拦。
  const password = typeof web.password === 'string' && web.password !== '' ? web.password : web.token;
  if (typeof web.host === 'string' && ['0.0.0.0', '::'].includes(web.host) && !password) {
    problems.push('web.host 对外监听时必须设置 web.password（或旧的 web.token），否则同网段任何人都能启停抓取、改配置');
  }
  if (typeof password === 'string' && password !== '') {
    if (password.length < 8) {
      problems.push(`web.password 太短（${password.length} 位）：这个控制台能改配置、看历史，公网上至少用 12 位随机串`);
    } else if (password.length < 12) {
      problems.push(`提醒：web.password 只有 ${password.length} 位，公网暴露建议至少 12 位随机串`);
    }
  }

  // 渠道结构交给 notify.mjs 的同一份 schema 校验：控制台的表单就是从它生成的，
  // 所以「界面能填」和「能真的发出去」不会分叉。
  problems.push(...validateChannels(config.notify?.channels));

  // 展开后仍残留 ${...} 说明环境变量缺失，这属于配置错误而不是可忽略的默认值。
  const leftovers = JSON.stringify(config).match(ENV_PATTERN);
  if (leftovers) problems.push(`以下环境变量未设置：${[...new Set(leftovers.map((m) => m.slice(2, -1)))].join(', ')}`);

  return problems;
}

/**
 * 加载并校验配置。
 * @param {string} configPath 配置文件路径，支持 .json / .mjs / .js。
 * @returns {Promise<{config: any, configDir: string, configPath: string}>} 配置与其所在目录（用于解析相对路径）。
 */
export async function loadConfig(configPath) {
  const absolute = path.resolve(configPath);
  if (!existsSync(absolute)) {
    throw new Error(`配置文件不存在：${absolute}（可从 config.example.json 复制）`);
  }

  let raw;
  if (absolute.endsWith('.json')) {
    raw = JSON.parse(readFileSync(absolute, 'utf8'));
  } else {
    const module = await import(pathToFileURL(absolute).href);
    raw = module.default;
  }

  const missing = [];
  const config = resolveEnv(raw, missing);
  const problems = validateConfig(config);
  if (problems.length > 0) {
    throw new Error(`配置校验失败：\n  - ${problems.join('\n  - ')}`);
  }
  return { config, configDir: path.dirname(absolute), configPath: absolute };
}

/**
 * 会话级默认值集中在此，业务代码不再散落 `?? 默认值`。
 * @param {any} config 已校验的配置。
 * @returns {any} 补齐默认值后的配置副本。
 */
export function withDefaults(config) {
  return {
    ...config,
    monitor: {
      maxBackoffSeconds: 300,
      // 两次搜索之间至少隔这么久（跨任务生效）。实测连续 3 次搜索就会被风控拦下；
      // 单任务按自己的 intervalSeconds 跑通常远低于这个节奏，但多任务串行时会叠加。
      minRequestGapSeconds: 30,
      // 撞上风控后暂停多久。风控验证在自动化窗口里过不了，重试没有意义还会加重风控，
      // 所以默认给一个很长的退避，等人工处理。
      riskControlCooldownSeconds: 1800,
      onUnknownField: 'pass',
      heartbeatHours: 6,
      failureAlertThreshold: 3,
      notifyOnStart: true,
      ...config.monitor,
    },
    // 搜索：直连 mtop，每轮恰好 1 次请求（可选的 browser 模式已随 Playwright 一起移除）。
    search: {
      timeoutMs: 20000,
      // 风控状态 cookie（sgcookie）怎么处理：
      //  - 'omit'（默认）：一律不发。实测这类 cookie 只是把平台施加的处罚带过来，不带它请求照常成功，
      //    而"先带一次、被拒、再记住"要白白浪费一次注定失败的请求（每次遇到新脏值都要）。
      //  - 'remembered'：带上，但把已知会被拒的**具体值**剔掉；服务端换发的新值照发。
      //    想保留「客户端有机会自己回到正常状态」这条路径时用它。
      riskCookies: 'omit',
      ...config.search,
    },
    storage: {
      stateFile: './data/state.json',
      seenLimit: 20000,
      seenRetentionDays: 30,
      ...config.storage,
    },
    notify: {
      timeoutMs: 10000,
      maxPerCycle: 8,
      // 推送总开关。关掉后监控照常跑、命中照常记录，只是不发商品推送；
      // 登录失效这类告警不受影响（见 monitor.mjs 的 #shouldPush）。
      enabled: true,
      ...config.notify,
    },
    web: {
      port: 7788,
      host: '127.0.0.1',
      // 访问密码。对外监听（0.0.0.0）时必填，见上面的校验。
      password: '',
      // 放在反向代理后面时置 true：限流要按真实来源 IP，Cookie 也要认 X-Forwarded-Proto。
      trustProxy: false,
      // 旧字段：仍当密码用，新配置请用 password。
      token: '',
      open: true,
      ...config.web,
    },
    linkTemplate: config.linkTemplate ?? 'https://www.goofish.com/item?id={id}',
    tasks: config.tasks.map((task) => ({
      enabled: true,
      // 单任务推送开关，与上面的总开关是「与」的关系：两者都为真才推送。
      notify: true,
      intervalSeconds: 10,
      jitterSeconds: 3,
      scrollRounds: 0,
      jumpLink: 'app',
      filters: {},
      ...task,
      filters: {
        requireKeywords: [],
        excludeKeywords: [],
        excludeSellers: [],
        cityAnyOf: [],
        ...task.filters,
      },
    })),
  };
}
