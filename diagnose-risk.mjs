#!/usr/bin/env node
/**
 * 风控诊断：**不加载页面**，只用几次 mtop 请求把「到底被怎么拦了」摊开。
 *
 * 为什么要单独有它：搜索接口被拒时，日志里只有一句 `RGV587_ERROR`，而同一个错误码下有完全不同的
 * 两种形态，处理方式相反。这里一次跑完，把关键事实列出来：
 *
 *   1. **会话是不是真的有效**（`loginuser.get`）——排除"只是没登录"；
 *   2. **同一批请求里别的 mtop 接口成不成功**——只有 search 失败＝搜索接口被单独风控；
 *      全都失败＝会话/凭据问题。这一条是纯 HTTP 之后才看得清的，以前要靠抓页面请求；
 *   3. 搜索失败的归类：`deny`（直接拒绝，无人工出口）还是 `baxia`（要求过验证）；
 *   4. 登录态清单：有哪些 cookie、`cookie2`/`unb` 在不在、有没有被标记为"被拒过"的值。
 *
 * 代价是 4~5 次 mtop 请求（含 1 次真正的搜索）。**不要连续反复跑**——被拒的请求本身就是风控压力。
 *
 * 用法：
 *   node diagnose-risk.mjs                    # 用配置里第一个任务的关键词
 *   node diagnose-risk.mjs --task 任务名
 *   node diagnose-risk.mjs --keyword 显示器
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, withDefaults } from './src/config.mjs';
import { FileCookieStore, defaultCookieFile } from './src/cookies.mjs';
import { MTOP, createSearcher, mtopSign, tokenOf } from './src/mtop.mjs';

/** 用来判断「是不是只有搜索接口被拒」的旁证接口：都是轻量、只读的。 */
const PROBE_APIS = ['mtop.taobao.idlemessage.pc.loginuser.get', 'mtop.idle.web.user.page.nav'];

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true;
    else {
      options[key] = next;
      i += 1;
    }
  }
  return options;
}

const line = (text = '') => process.stdout.write(`${text}\n`);
const rule = (title) => line(`\n=== ${title} ===`);

const options = parseArgs(process.argv.slice(2));
const configPath = options.config ?? process.env.XIANYU_CONFIG ?? './config.json';

loadDotEnv(path.resolve(path.dirname(path.resolve(configPath)), '.env'));
loadDotEnv(path.resolve('.env'));

const { config, configDir } = await loadConfig(configPath);
const resolved = withDefaults(config);
if (!path.isAbsolute(resolved.storage.stateFile)) {
  resolved.storage.stateFile = path.resolve(configDir, resolved.storage.stateFile);
}

const task = options.task ? resolved.tasks.find((entry) => entry.name === options.task) : resolved.tasks[0];
const keyword = options.keyword ?? task?.keyword;
if (!keyword) {
  line(options.task ? `配置里没有名为「${options.task}」的任务。` : '配置里一个任务都没有，无法取关键词。');
  process.exit(1);
}

const cookieFile = resolved.search?.cookieFile ?? defaultCookieFile(resolved);
const logger = { info: line, warn: line, error: line, debug: () => {} };

line(`配置      ：${path.resolve(configPath)}`);
line(`登录态文件：${cookieFile}`);
line(`关键词    ：${keyword}`);
line('说明      ：不加载页面；会发 1 次搜索 + 若干次只读接口请求，不要连续反复跑。');

// ---------- 登录态清单 ----------
rule('登录态');
const store = new FileCookieStore({ file: cookieFile, logger });
let jar = new Map();
try {
  jar = await store.load();
} catch (error) {
  line(`读取失败：${error.message}`);
}
line(`cookie 数量：${jar.size}`);
const names = [...jar.keys()].sort();
line(`包含      ：${names.length > 0 ? names.join(', ') : '（空）'}`);
for (const required of ['cookie2', 'unb', '_m_h5_tk', 'sgcookie']) {
  line(`  ${required.padEnd(11)}：${jar.has(required) ? '有' : '没有'}`);
}
if (store.refused.length > 0) {
  line(`被标记为曾遭拒绝的值：${store.refused.length} 个（这些**具体值**不会再发出去）`);
}

// ---------- 会话 ----------
rule('会话');
const searcher = createSearcher({ config: resolved, logger });
const session = await searcher.checkSession();
line(`loginuser.get：${session}`);
if (session === 'invalid') {
  line('→ 会话无效。先扫码登录（node src/cli.mjs login）再看，后面几条不用看了。');
  process.exit(0);
}

// ---------- 旁证接口 ----------
rule('旁证：别的 mtop 接口成不成功');
const token = tokenOf(jar.get('_m_h5_tk')?.value);
const results = [];
for (const api of PROBE_APIS) {
  const t = String(Date.now());
  const data = '{}';
  const query = new URLSearchParams({
    jsv: MTOP.jsv,
    appKey: MTOP.appKey,
    t,
    sign: mtopSign({ token, t, appKey: MTOP.appKey, data }),
    api,
    v: MTOP.version,
    type: 'originaljson',
    dataType: 'json',
    timeout: '15000',
    sessionOption: 'AutoLoginOnly',
    accountSite: MTOP.accountSite,
  });
  try {
    const response = await fetch(`${MTOP.baseUrl}/${api}/${MTOP.version}/?${query}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: 'https://www.goofish.com/',
        origin: 'https://www.goofish.com',
        cookie: FileCookieStore.header(jar),
      },
      body: `data=${encodeURIComponent(data)}`,
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null);
    const ret = Array.isArray(payload?.ret) ? payload.ret.join(' | ') : '（没有 ret）';
    results.push({ api, ret });
    line(`${api}\n    → ${ret}`);
  } catch (error) {
    results.push({ api, ret: `请求异常：${error.message}` });
    line(`${api}\n    → 请求异常：${error.message}`);
  }
}
const othersOk = results.some((entry) => /SUCCESS/.test(entry.ret));
line(othersOk ? '→ 有接口成功：说明凭据本身能用。' : '→ 全部失败：更像是会话/凭据问题，而不是搜索被单独针对。');

// ---------- 搜索 ----------
rule('搜索接口');
try {
  const { items, requests } = await searcher.search({ ...(task ?? {}), keyword });
  line(`成功：返回 ${items.length} 条（请求 ${requests} 次）`);
  line('→ 当前没有被拦。如果日志里报风控，说明是间歇性的，注意别短时间反复试。');
} catch (error) {
  line(`失败：code=${error.code ?? '(无)'}`);
  line(`      ${error.message}`);
  if (error.code === 'denied') {
    line('→ 直接拒绝（action=deny）：页面上没有可操作的验证项，重试、重登、换客户端都不会好。');
    line('  程序侧会长时间退避；这一条不受去重表影响，等冷却即可。');
  } else if (error.code === 'auth') {
    line('→ 会话/凭据问题：重新扫码登录（node src/cli.mjs login）。');
  } else if (error.code === 'ratelimited') {
    line('→ 被限流：把 intervalSeconds 调大，别重试。');
  } else {
    line('→ 归类不明的失败；结合上面「旁证」一节判断是搜索被单独针对，还是整体不可用。');
  }
}

rule('接下来');
line('· 只有 search 失败、别的接口成功 → 搜索接口被单独风控，程序会长时间退避，等它自己恢复。');
line('· 全都失败 → 先重新扫码登录。');
line('· 不管哪种，**都不要连续反复跑本脚本**：被拒的请求本身就是风控压力。');
