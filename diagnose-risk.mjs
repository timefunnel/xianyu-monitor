// 风控体检：一次页面加载判定「闲鱼到底是怎么拦你的」，并直接打印下一步该做什么。
//
// 为什么需要它：搜索接口报 RGV587 时至少有三类原因，处理方式完全不同，但日志里都只有一句
// RGV587，分不出来——
//
//   1. 只有搜索接口被单独风控（会话本身是好的）→ 过 baxia 验证 / 重建 profile / 换搜索面；
//   2. 整个会话在服务端已经失效（Cookie 齐全、loginuser.get 也还 SUCCESS）→ 重新扫码登录；
//   3. 短时频率限流（冷却几分钟就自己好）→ 什么都不用做，降频即可。
//
// 区分办法是看**同一批请求里别的 mtop 接口成不成功**：只有 search 失败说明是第 1 类，
// 全都失败说明是第 2 类。所以本脚本只导航一次搜索页，把页面加载期间所有 mtop 接口的返回码
// 都记下来，顺带盘点风险相关 Cookie、检查页面上有没有 baxia 验证层。
//
// 成本：一次导航 = 页面自己那批请求，不点筛选、不滚动、不重试。跑完就退出。
//
// 用法：
//   node diagnose-risk.mjs                  # 用 config.json 里第一个任务的关键词
//   node diagnose-risk.mjs --task 任务名
//   node diagnose-risk.mjs --hold 300       # 体检完把窗口留 300 秒，供人工过验证
//
// 必须先停掉监控进程（它占着同一个 profile，浏览器起不来）。
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, withDefaults } from './src/config.mjs';

/** 从 URL 里抠出 mtop 接口名，用来把请求归类。 */
const API_PATTERN = /(mtop\.[A-Za-z0-9.]+)/;

/** 风险相关的 Cookie。没有 `_m_h5_tk` 签名会失败；`x5sec` 是过了 baxia 验证的凭据。 */
const WATCHED_COOKIES = [
  '_m_h5_tk',
  '_m_h5_tk_enc',
  'x5sec',
  'cna',
  'unb',
  '_nk_',
  'tracknick',
  'cookie2',
  '_tb_token_',
  'sgcookie',
  'tfstk',
  '_samesite_flag_',
  'cbc',
  'lgc',
  'uc1',
  'uc3',
  'uc4',
  'csg',
  'skt',
];

const RISK_CONTROL_SELECTOR = '.baxia-dialog-mask, .baxia-dialog, iframe[src*="baxia"]';
/** 页面上出现这些字，说明闲鱼把验证界面推给了你（而不是只回一个错误码）。 */
const VERIFY_HINTS = ['请拖动滑块', '滑块', '验证', '非法访问', '安全验证'];

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

/** 解析 `--key value` / `--flag`。 */
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
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
if (!path.isAbsolute(resolved.browser.userDataDir)) {
  resolved.browser.userDataDir = path.resolve(configDir, resolved.browser.userDataDir);
}
const baseUrl = resolved.browser.baseUrl;
const keyword = options.keyword ?? (options.task ? resolved.tasks.find((task) => task.name === options.task)?.keyword : resolved.tasks[0]?.keyword);
if (!keyword) {
  line(options.task ? `配置里没有名为「${options.task}」的任务。` : '配置里一个任务都没有，无法取关键词。');
  process.exit(1);
}

// 监控在跑时会占着 profile，Playwright 起不来（错误信息也只有一句 Target 已关闭）。
const consoleUrl = `http://127.0.0.1:${resolved.web?.port ?? 7788}/api/state`;
try {
  const probe = await fetch(consoleUrl, { signal: AbortSignal.timeout(1500) });
  if (probe.ok) {
    line(`检测到控制台还在运行（${consoleUrl}）。它会占着同一个 profile，请先停掉再跑本脚本。`);
    process.exit(1);
  }
} catch {
  // 连不上就是没在跑，正是我们要的。
}

line(`配置    ：${path.resolve(configPath)}`);
line(`profile ：${resolved.browser.userDataDir}`);
line(`关键词  ：${keyword}`);
const attach = options.attach === true || resolved.browser.attach === true;
line(`启动方式：${attach ? 'attach（普通 Chrome + CDP 附加）' : 'managed（Playwright 启动）'}`);
line('说明    ：只导航一次搜索页，不点筛选、不滚动、不重试。');

const { GoofishBrowser } = await import('./src/browser.mjs');
const browser = new GoofishBrowser({ ...resolved.browser, attach }, { info: line, warn: line, error: line });

/** @type {Array<{api: string, url: string, status: number, ret: string|null, dataUrl: string|null, hasSign: boolean, signed?: boolean}>} */
const calls = [];
const pending = [];

try {
  await browser.open();
  const page = browser.page;

  const onRequest = (request) => {
    const api = API_PATTERN.exec(request.url())?.[1];
    if (!api) return;
    const post = request.postData() ?? '';
    calls.push({
      api,
      url: request.url(),
      status: 0,
      ret: null,
      dataUrl: null,
      hasSign: /(?:^|&)sign=/.test(post),
    });
  };
  const onResponse = (response) => {
    const api = API_PATTERN.exec(response.url())?.[1];
    if (!api) return;
    const record = calls.filter((entry) => entry.api === api && entry.status === 0).at(-1);
    if (!record) return;
    record.status = response.status();
    pending.push(
      response
        .json()
        .then((payload) => {
          record.ret = Array.isArray(payload?.ret) ? String(payload.ret[0]) : null;
          record.dataUrl = typeof payload?.data?.url === 'string' ? payload.data.url : null;
        })
        .catch(() => {
          record.ret = '<响应不是 JSON>';
        }),
    );
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  // ---- 会话与 Cookie ----
  rule('登录态');
  const session = await browser.checkSession();
  line(
    {
      valid: 'loginuser.get 返回 SUCCESS —— 服务端认这个会话',
      invalid: 'loginuser.get 未返回 SUCCESS —— 会话在服务端已失效',
      unknown: '没读到 loginuser.get —— 无法据此判断',
    }[session],
  );

  const allCookies = await browser.context.cookies();
  const now = Date.now();
  line(`\n风险相关 Cookie（共 ${allCookies.length} 个）：`);
  for (const name of WATCHED_COOKIES) {
    const found = allCookies.filter((cookie) => cookie.name === name);
    if (found.length === 0) {
      line(`  ${name.padEnd(18)} 不存在`);
      continue;
    }
    for (const cookie of found) {
      const left = cookie.expires === -1 ? '会话级（关掉浏览器即失效）' : `${Math.round((cookie.expires * 1000 - now) / 86400000)} 天后过期`;
      const value = cookie.value.length > 24 ? `${cookie.value.slice(0, 12)}…(${cookie.value.length} 字符)` : cookie.value;
      line(`  ${name.padEnd(18)} ${cookie.domain.padEnd(20)} ${left.padEnd(24)} ${value}`);
    }
  }

  // ---- 一次搜索页加载 ----
  rule('一次搜索页加载（页面自己发出的请求）');
  const before = calls.length;
  const target = new URL('/search', baseUrl);
  target.searchParams.set('q', keyword);
  await page.goto(target.href, { waitUntil: 'domcontentloaded' }).catch((error) => line(`导航失败：${error.message}`));
  const deadline = Date.now() + Math.max(8000, resolved.browser.responseTimeoutMs);
  while (Date.now() < deadline) await page.waitForTimeout(300);
  await Promise.all(pending);
  page.off('request', onRequest);
  page.off('response', onResponse);

  const thisLoad = calls.slice(before);
  if (thisLoad.length === 0) {
    line('这次加载没有发出任何 mtop 请求——页面可能被拦在更早的一层（见下方页面状态）。');
  }
  for (const call of thisLoad) {
    const ok = call.ret?.startsWith('SUCCESS');
    line(`  [${ok ? '成功' : '失败'}] ${call.api}`);
    line(`         ret=${call.ret ?? '<没有响应体>'} status=${call.status} 带签名=${call.hasSign}`);
    if (call.dataUrl) line(`         data.url=${call.dataUrl}`);
  }

  // ---- 页面状态 ----
  rule('页面状态');
  const baxia = await page.locator(RISK_CONTROL_SELECTOR).count().catch(() => 0);
  line(`baxia 验证层：${baxia > 0 ? `存在（${baxia} 个节点）——闲鱼把验证界面推过来了` : '不存在'}`);

  // 验证界面通常整个装在 iframe 里（bixi / sec.taobao.com），主框架的 innerText 看不到它，
  // 所以逐个框架都要看：弹的到底是「可拖动的滑块」还是「没有出口的处罚页」，决定下一步完全不同。
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const text = await frame.evaluate(() => document.body?.innerText ?? '').catch(() => '');
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    line(`  子框架：${frame.url().slice(0, 160)}`);
    if (clean) line(`          文字：${clean}`);
  }
  for (const selector of [RISK_CONTROL_SELECTOR, '.baxia-dialog-content', '[class*="baxia"]']) {
    const node = page.locator(selector).first();
    if ((await node.count().catch(() => 0)) === 0) continue;
    const text = (await node.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    if (text) line(`  弹层文字（${selector}）：${text}`);
  }

  const body = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const hints = VERIFY_HINTS.filter((hint) => body.includes(hint));
  line(`主框架文字里的验证线索：${hints.length ? hints.join(' / ') : '无'}`);
  const itemCount = await page.evaluate(() => document.querySelectorAll('a[href*="item?id="]').length).catch(() => 0);
  line(`页面上渲染出的商品链接数：${itemCount}`);
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (snippet) line(`主框架正文开头：${snippet}`);

  // 截一张整页图。风控的判定依据里最说不清的就是「页面上到底显示了什么」，
  // 留一张图比反复重跑脚本有用得多。
  const shot = path.resolve('data/diagnose-risk.png');
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  line(`整页截图：${shot}`);

  // ---- 结论 ----
  const search = thisLoad.filter((call) => /idlemtopsearch|idlesearch/i.test(call.api) && !/\.shade|activate|item\.search/i.test(call.api));
  const others = thisLoad.filter((call) => !search.includes(call));
  const searchThrottled = search.filter((call) => /RGV587|被挤爆|TRAFFIC_LIMIT|过于频繁/i.test(call.ret ?? ''));
  const searchOk = search.filter((call) => call.ret?.startsWith('SUCCESS'));
  const othersOk = others.filter((call) => call.ret?.startsWith('SUCCESS'));

  // punish 链接里的 action 决定这次拦截有没有人工出口：
  //   action=verify → 有滑块/验证，用普通 Chrome 过掉就能恢复；
  //   action=deny   → 直接拒绝，没有可操作项，只能等它过期或换设备标识。
  const punish = search.map((call) => call.dataUrl ?? '').find((url) => url.includes('punish'));
  const action = punish ? /[?&]action=([a-z]+)/i.exec(punish)?.[1] ?? null : null;
  const denyWait = punish ? /[?&]pureDenyWait=([^&]*)/i.exec(punish)?.[1] ?? null : null;

  rule('结论');
  if (session === 'invalid') {
    line('会话在服务端已失效。先重新扫码登录，其他都不用查。');
    line('  node src/cli.mjs login');
  } else if (searchThrottled.length > 0 && (othersOk.length > 0 || searchOk.length === 0)) {
    if (othersOk.length > 0) {
      line(`只有搜索接口被拦（同一批里另有 ${othersOk.length} 个 mtop 接口返回 SUCCESS，会话本身是好的）。`);
      line('这是搜索接口被单独风控，重新登录通常没用——它认的是设备指纹与行为，不是登录票据。');
    } else {
      line('搜索接口被 RGV587 拦下，同一批里也没有别的成功接口可以对照。');
    }
    if (action) line(`闲鱼给的处置动作：action=${action}${denyWait ? `，pureDenyWait=${denyWait || '(空)'}` : ''}`);
    line('');
    if (action === 'deny') {
      line('action=deny 表示「直接拒绝」，页面上没有可拖动、可点击的验证项，所以');
      line('过验证这条路对这次拦截无效，别在窗口里耗时间。按代价从低到高：');
      line('  1) 等它自己过期再跑一次本脚本。deny 通常是按设备+接口限时的，先给它几小时到一天。');
      line('  2) 仍然 deny 就换设备标识：把 data/browser-profile 改名备份，重新 node src/cli.mjs login。');
      line('     注意这会连带清掉登录态，且新 profile 同样会被它认出来——所以重建后必须保持低频');
      line('     （intervalSeconds ≥ 180），否则新指纹会以同样速度被标记。');
      line('  3) 重建也无效说明拦的是出口 IP 或这个接口面，别再重建。改用手机 H5 搜索面，或降低使用强度。');
    } else {
      line('按代价从低到高依次试：');
      line('  1) 先确认是不是短时限流：等 10 分钟再跑一次本脚本，ret 变 SUCCESS 就只是限流，把');
      line('     intervalSeconds 调大即可。');
      line('  2) 用普通 Chrome 打开同一个 profile，在里面正常搜两次、把验证过掉（自动化窗口里过不了）：');
      line('     node open-profile-in-chrome.mjs');
      line('  3) 上面两步都无效，说明这个 profile 的设备指纹已经被标记。重建 profile 换一套设备标识');
      line('     再扫码登录：把 data/browser-profile 改名备份，然后 node src/cli.mjs login。');
      line('  4) 重建后仍然被拦，说明拦的是这个出口 IP 或这个搜索接口面，别再重建了——改用手机 H5');
      line('     搜索面或等人流低谷，继续重建只会把新 profile 也一起烧掉。');
    }
  } else if (baxia > 0) {
    line('搜索没直接报错，但页面上有 baxia 验证层——闲鱼要求先过验证。');
    line('  用普通 Chrome 打开同一个 profile 过验证：node open-profile-in-chrome.mjs');
  } else if (searchOk.length > 0) {
    line('搜索接口返回 SUCCESS：当前没有被拦。');
    line('之前那次 RGV587 属于短时限流，已自行恢复；把 intervalSeconds 保持在 120 秒以上即可。');
  } else {
    line('没抓到搜索请求，无法判定。看上面「页面状态」里正文开头那句话。');
  }

  if (options.hold) {
    const seconds = Number(options.hold);
    line(`\n窗口保留 ${seconds} 秒，你可以直接在里面看验证层。`);
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(seconds * 1000);
  }
} finally {
  await browser.close();
}
