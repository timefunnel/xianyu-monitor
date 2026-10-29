/**
 * 浏览器登录助手：用真实 Chrome 完成一次登录（手机号+验证码 / 扫码 / 密码都行），
 * 然后把登录态抓出来写成 data/cookies.json。
 *
 * 为什么需要它：短信验证码这条纯 HTTP 路**走不通**——平台在发码之前就要求人机验证。
 * 实测 `POST /newlogin/sms/send.do` 还没校验手机号，就直接回了一段
 * `.../_____tmd_____/punish?x5secdata=...&x5step=1`，`action=captcha`。
 * 也就是说：没有真实浏览器，连验证码短信都发不出去；就算发出去了，登录本身还要再过一次。
 *
 * 所以这里的分工是：**人能做的部分留给人**（在打开的窗口里输手机号、收码、过滑块），
 * 程序只做机械的部分——等你登录成功，把 cookie 抓下来、校验一次、落盘。
 *
 * 这不是"绕过验证码"：验证是人自己在普通 Chrome 里完成的，和扫码登录时用手机点一下确认
 * 是同一性质。区别只是不再需要那台手机上登着目标账号。
 *
 * 约束：必须有图形界面。服务器上的容器跑不了它（镜像里也没有 playwright），
 * 这是给"本机登录完再把 cookies.json 拷到服务器"这条既有路径用的。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** `tasklist` / `pgrep` 的 promisify 版：只用来判断"Chrome 还在不在"。 */
const execFileAsync = promisify(execFile);

/** 登录页。带上 appName/fromSite 才是闲鱼自己的登录页，而不是淘宝主站。 */
const LOGIN_URL =
  'https://passport.goofish.com/mini_login.htm?lang=zh_cn&appName=xianyu&appEntrance=web&styleType=vertical' +
  '&bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false&qrCodeFirst=false&site=77';

/** 登录完成后停一下的站点：让页面自己发几次 mtop 请求，把 `_m_h5_tk` 等 cookie 带回来。 */
const HOME_URL = 'https://www.goofish.com/';

/** 只收这几个域的 cookie：浏览器 profile 里还有别的站点，发到闲鱼头上没有意义也不安全。 */
const COOKIE_DOMAINS = ['goofish.com', 'taobao.com'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 这个域名是不是本站登录需要的。
 * @param {string} domain cookie 的 domain（可能带前导点）。
 * @returns {boolean} 是否保留。
 */
export function isSiteDomain(domain) {
  const normalized = String(domain ?? '')
    .replace(/^\./, '')
    .toLowerCase();
  return COOKIE_DOMAINS.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

/**
 * 把 Playwright 的 cookie 列表转成仓库用的 Map。
 *
 * 只保留闲鱼/淘宝域，并丢掉空值——空 cookie 发出去会让服务端把请求当成异常。
 * @param {Array<{name: string, value: string, domain: string, path?: string, expires?: number, httpOnly?: boolean, secure?: boolean, sameSite?: string}>} cookies Playwright 的 `context.cookies()`。
 * @returns {Map<string, any>} cookie 名到 cookie 对象。
 */
export function cookiesToJar(cookies) {
  const jar = new Map();
  for (const cookie of cookies ?? []) {
    if (!cookie?.name || !isSiteDomain(cookie.domain)) continue;
    if (typeof cookie.value !== 'string' || cookie.value === '') continue;
    jar.set(cookie.name, {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      // Playwright 用 -1 表示会话级 cookie，和本项目的约定一致。
      expires: Number.isFinite(cookie.expires) ? cookie.expires : -1,
      secure: cookie.secure ?? true,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: cookie.sameSite ?? 'Lax',
    });
  }
  return jar;
}

/**
 * 登录态的"指纹"。登录成功后 `cookie2` 一定会换一个值，用它判断"是不是刚登录过"。
 * @param {Map<string, any>} jar cookie 集合。
 * @returns {string} 指纹串。
 */
export function authFingerprint(jar) {
  const unb = jar?.get?.('unb')?.value ?? '';
  const cookie2 = jar?.get?.('cookie2')?.value ?? '';
  return `${unb}|${cookie2}`;
}

/**
 * 等一次人工登录，成功后返回抓到的登录态。
 *
 * @param {{
 *   userDataDir: string,
 *   logger?: any,
 *   timeoutSeconds?: number,
 *   pollIntervalMs?: number,
 *   verify: (jar: Map<string, any>) => Promise<boolean>,
 *   launch?: (options: {userDataDir: string, headless: boolean}) => Promise<any>,
 *   screenshotPath?: string,
 *   now?: () => number,
 * }} options 配置。
 *   - `verify`：拿这批 cookie 去问一次登录态（实现见 cli.mjs），返回是否有效；
 *   - `launch`：测试注入用，默认拉起真实 Chrome。
 * @returns {Promise<{jar: Map<string, any>, alreadyLoggedIn: boolean}>} 登录态。
 */
export async function browserLogin({
  userDataDir,
  logger,
  timeoutSeconds = 300,
  pollIntervalMs = 2000,
  verify,
  launch,
  screenshotPath,
  now = Date.now,
}) {
  const openContext = launch ?? defaultLaunch;
  const context = await openContext({ userDataDir: userDataDir, headless: false });
  const page = context.pages?.()[0] ?? (await context.newPage());

  try {
    // 先打开首页：profile 里可能本来就有登录态，那样用户什么都不用做。
    await goto(page, HOME_URL);
    const initial = cookiesToJar(await context.cookies());
    if (initial.has('unb') && (await verify(initial))) {
      logger?.info?.('这个浏览器里本来就登录着，直接用它的登录态。', 'login');
      await goto(page, HOME_URL);
      return { jar: await settle(context), alreadyLoggedIn: true };
    }

    // 没有可用的登录态：打开登录页（默认就是短信登录这一栏），交给用户。
    await goto(page, LOGIN_URL);
    logger?.info?.(
      '已打开登录窗口：用手机号 + 验证码登录（也可以扫码/密码）。登录成功后这里会自动收尾，不用点别的。',
      'login',
    );

    const before = authFingerprint(initial);
    const deadline = now() + timeoutSeconds * 1000;
    while (now() < deadline) {
      if (isClosed(context)) throw new Error('登录窗口被关掉了，登录没有完成');
      await sleep(pollIntervalMs);
      const jar = cookiesToJar(await context.cookies());
      // 只在"看起来刚登录过"时多花一次校验请求：cookie2 变了，或者 profile 里原本没有 unb。
      const changed = authFingerprint(jar) !== before;
      const appeared = !initial.has('unb') && jar.has('unb');
      if (!changed && !appeared) continue;

      // 登录页可能自己跳到首页。先让它把 mtop 请求发完，令牌才会落到 .goofish.com。
      await goto(page, HOME_URL);
      const settled = await settle(context);
      if (await verify(settled)) return { jar: settled, alreadyLoggedIn: false };
      // 校验不通过就继续等：可能是刚跳转，令牌还没下发。
    }
    throw new Error(`等待登录超时（${timeoutSeconds} 秒）。${await describePage(page, screenshotPath)}请重新执行一次登录。`);
  } finally {
    await context.close?.().catch?.(() => {});
  }
}

/**
 * 超时时把"窗口里到底是什么"记下来：光说一句超时，根本不知道是没人在、页面打不开，
 * 还是登录成功了但判断条件没命中。截图比日志有用。
 * @param {any} page Playwright 页面。
 * @param {string} [screenshotPath] 截图落盘路径。
 * @returns {Promise<string>} 一句可拼进错误信息的话。
 */
async function describePage(page, screenshotPath) {
  let url = '';
  try {
    url = page.url();
  } catch {
    /* 页面可能已经被关了 */
  }
  if (screenshotPath) {
    try {
      await page.screenshot({ path: screenshotPath });
      url += `（现场截图：${screenshotPath}）`;
    } catch {
      /* 截图失败不影响报错 */
    }
  }
  return url ? `当时页面停在 ${url}。` : '';
}

/**
 * 登录完成后停一会儿再抓 cookie：页面自己会发 mtop 请求，`_m_h5_tk` 就是这时候下发的。
 * @param {any} context Playwright 上下文。
 * @returns {Promise<Map<string, any>>} cookie 集合。
 */
async function settle(context) {
  await sleep(1500);
  return cookiesToJar(await context.cookies());
}

/** 导航失败不该直接判死：首页偶尔慢，但登录页能打开就够了。 */
async function goto(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    /* 导航超时就继续走后面的检查，别把人刚输完的验证码扔掉 */
  }
}

/** 用户把窗口关了就没有后续了，尽早退出而不是干等超时。 */
function isClosed(context) {
  const pages = context.pages?.() ?? [];
  return pages.length === 0;
}

/**
 * 本机是不是还有 chrome.exe 在跑。
 *
 * 只查进程、不启动浏览器：`captureFromChromeProfile` 每 2 秒调一次，必须便宜。
 * 查不到（命令不存在、权限不足）时按"没在跑"处理——那会走后续的启动尝试，
 * 真被占用时 isProfileBusy 还能兜住。
 *
 * @param {Function} [exec] 执行命令的函数（测试注入用）。
 * @returns {Promise<boolean>} 是否在运行。
 */
export async function isChromeRunning(exec = execFileAsync) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { timeout: 5000 });
      return /chrome\.exe/i.test(stdout);
    }
    const binary = process.platform === 'darwin' ? 'Google Chrome' : 'chrome';
    const { stdout } = await exec('pgrep', ['-x', binary], { timeout: 5000 });
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

/**
 * 本机 Chrome 的 user data 目录（真正在用的那份 profile）。
 *
 * @param {Record<string, string|undefined>} [env] 环境变量（测试用）。
 * @param {string} [platform] 平台标识（测试用）。
 * @returns {string} 目录路径；找不到时为空串。
 */
export function chromeUserDataDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Google\\Chrome\\User Data` : '';
  }
  if (platform === 'darwin') {
    return env.HOME ? `${env.HOME}/Library/Application Support/Google/Chrome` : '';
  }
  return env.HOME ? `${env.HOME}/.config/google-chrome` : '';
}

/**
 * 这个启动错误是不是「Chrome 正开着，profile 被独占锁住了」。
 *
 * Chrome 对 `Network/Cookies` 是独占打开的（连复制都不行），所以只能等它退出。
 * 这不是故障，是正常的第一步——调用方据此继续等，而不是直接失败。
 *
 * @param {any} error 启动时抛出的错误。
 * @returns {boolean} 是否是"被占用"。
 */
export function isProfileBusy(error) {
  const text = String(error?.message ?? '');
  // Chrome 发现已经有实例在用同一个 profile 时，会**立刻退出**（把参数转交给已有的窗口），
  // Playwright 看到的就是 "Target page, context or browser has been closed"，退出码 21。
  // 这和"浏览器崩了"在日志上几乎一样，但在"读本机 profile"这个场景里只可能是前者。
  return /ProcessSingleton|SingletonLock|Singleton|profile.*(in use|正在使用)|already (running|in use)|另一个.*Chrome|Target page, context or browser has been closed|exitCode=21/i.test(
    text,
  );
}

/**
 * 从**本机正在用的那份 Chrome profile** 里取登录态，不需要用户做任何登录操作。
 *
 * 前提是这份 Chrome 里已经登录着闲鱼（网页端能正常搜索就够了）。流程：
 *   1. 等 Chrome 完全退出（cookie 库是独占锁，运行中读不了）；
 *   2. 用同一份 profile 起一个**无头** Chrome，打开闲鱼首页；
 *   3. 通过 CDP 读 cookie（解密由 Chrome 自己做，不碰 DPAPI/ABE）；
 *   4. 校验一次 loginuser.get，通过才返回。
 *
 * 为什么不是"复制 profile"：实测这台机器的 Chrome 目录 22 GB，而且 `Network/Cookies`
 * 在 Chrome 运行时连复制都会被拒绝（独占锁）。等它退出 10 秒，比复制几分钟更划算。
 *
 * @param {{
 *   userDataDir: string,
 *   logger?: any,
 *   timeoutSeconds?: number,
 *   pollIntervalMs?: number,
 *   verify: (jar: Map<string, any>) => Promise<boolean>,
 *   launch?: (options: {userDataDir: string, headless: boolean}) => Promise<any>,
 *   chromeRunning?: () => Promise<boolean>,
 *   now?: () => number,
 * }} options 配置。
 * @returns {Promise<{jar: Map<string, any>}>} 登录态。
 */
export async function captureFromChromeProfile({
  userDataDir,
  logger,
  timeoutSeconds = 600,
  pollIntervalMs = 2000,
  verify,
  launch,
  chromeRunning = isChromeRunning,
  now = Date.now,
}) {
  const openContext = launch ?? defaultLaunch;
  const deadline = now() + timeoutSeconds * 1000;
  let context = null;
  let lastNotice = 0;
  while (!context) {
    if (now() > deadline) {
      throw new Error(`等了 ${timeoutSeconds} 秒，Chrome 还没有完全退出，没能读到它的登录态。`);
    }
    // **先看进程，再决定要不要启动。** 以前的写法是每 2 秒直接试着启动一次，
    // 被占用时再靠报错判断——那等于每 2 秒拉起一个 chrome.exe 又立刻退出，
    // 白白折腾几个小时。查一下进程列表便宜得多。
    if (await chromeRunning()) {
      if (now() - lastNotice > 30000) {
        lastNotice = now();
        logger?.info?.('Chrome 还开着，等它退出后自动继续…', 'login');
      }
      await sleep(pollIntervalMs);
      continue;
    }
    try {
      context = await openContext({ userDataDir, headless: true });
    } catch (error) {
      if (!isProfileBusy(error)) throw error;
      logger?.info?.('登录态数据库仍被占用，稍后再试…', 'login');
      await sleep(pollIntervalMs);
    }
  }

  try {
    const page = context.pages?.()[0] ?? (await context.newPage());
    await goto(page, HOME_URL);
    const jar = await settle(context);
    if (!jar.has('unb')) {
      throw new Error('这个 Chrome 里没有登录态的痕迹（没有 unb）。先在 Chrome 里登录闲鱼，再执行一次。');
    }
    if (!(await verify(jar))) {
      throw new Error('读到了 cookie，但服务端不认——这份 Chrome 会话可能已经失效，请重新在 Chrome 里登录闲鱼。');
    }
    return { jar };
  } finally {
    await context.close?.().catch?.(() => {});
  }
}

/**
 * 默认用本机安装的 Chrome（`channel: 'chrome'`）拉起一个**有头**窗口。
 *
 * 不用无头：滑块是给人过的，无头窗口既看不见也过不了；而且无头浏览器本身就是风控信号。
 * @param {{userDataDir: string, headless: boolean}} options 启动选项。
 * @returns {Promise<any>} Playwright 的 BrowserContext。
 */
async function defaultLaunch({ userDataDir, headless }) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    const error = new Error(
      '没有找到 playwright（这个登录方式需要真实浏览器）。请在有图形界面的机器上安装：npm i -D playwright，' +
        '然后重新执行 node src/cli.mjs login --browser',
    );
    error.code = 'no-browser';
    throw error;
  }
  const base = {
    headless,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: null,
    args: ['--start-maximized'],
  };
  try {
    return await chromium.launchPersistentContext(userDataDir, { ...base, channel: 'chrome' });
  } catch (error) {
    // **profile 被占用必须原样抛给调用方**，让它等 Chrome 退出。
    // 以前这里先按关键字判断要不要回退，而报错信息里带着 profile 路径（…\Chrome\User Data），
    // 里面就有 "Chrome" —— 于是被误判成"没装 Chrome"，回退去拉 Playwright 自带的 Chromium，
    // 又因为没装 headless shell 报了个完全不相干的错。
    if (isProfileBusy(error)) throw error;
    // 本机没装 Chrome 时退回 Playwright 自带的 Chromium。
    if (!/channel|executable|not found/i.test(String(error?.message))) throw error;
    return await chromium.launchPersistentContext(userDataDir, base);
  }
}
