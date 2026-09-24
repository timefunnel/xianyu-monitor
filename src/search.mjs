/**
 * 搜索结果收集。
 *
 * 只监听页面自己发出的请求，不复刻任何签名：闲鱼网页端的 mtop 请求带签名参数，
 * 页面自己会算，我们只驱动界面并读取结果。
 *
 * 原生筛选（价格、区域）由服务端执行，能让 30 个名额全部落在条件内；每个请求体都带签名，
 * 无法自己构造，只能在页面里驱动，因此每轮交互次数直接等于请求次数，需要压：
 *
 *  - 冷路径（首次、或页面状态失效）：重新加载搜索页，依次施加价格和区域，约 4 次请求；
 *  - 热路径（后续每轮）：不重新加载，重开区域面板点一次「查看 N 件宝贝」，
 *    页面会用当前筛选状态重新搜索，**只要 1 次请求**。
 *
 * 热路径的前提是页面状态没丢。因此每次搜索都会解析实际发出的请求体，确认真带上了
 * 配置的筛选条件；对不上就退回冷路径，并明确报错——否则会静默推送范围外的商品。
 */

import { classifyResponse, extractItems, extractFromDom } from './parse.mjs';

const SEARCH_API_PATTERN = /idlemtopsearch|idlesearch/i;
/** 同名前缀的推荐位/热搜位接口，返回的不是商品结果，混进来会污染解析。 */
const NON_ITEM_API_PATTERN = /\.shade|activate|\.item\.search/i;

/**
 * 价格筛选输入框。优先用 placeholder 定位：类名是构建哈希（实测 `search-price-input--p1NQEAuz`），
 * 发版就会变，placeholder `¥` 更稳定。
 */
const PRICE_INPUT_SELECTORS = ['input[placeholder="¥"]', 'input[class*="search-price-input"]'];

/**
 * 区域筛选入口。选过地区之后筛选栏上的文字会从「区域」变成地区名（如「江浙沪」），
 * 因此先按容器类名找，再退回文字。
 */
const REGION_ENTRY_SELECTORS = ['[class*="areaTextContainer"]', 'text=区域'];
const REGION_CONFIRM_SELECTORS = ['.searchBtn--nFwxmAgz', 'text=件宝贝'];
/** 地区条目（省份或预设）。 */
const REGION_ITEM_SELECTOR = '.provItem--gG8I2YJh';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 判断一个 URL 是不是商品搜索接口。请求和响应两侧共用，避免两处判断走偏。
 * @param {string} url 请求地址。
 * @param {string} resourceType 资源类型。
 * @returns {boolean} 是否为商品搜索。
 */
const isSearchRequestUrl = (url, resourceType) =>
  resourceType !== 'document' && SEARCH_API_PATTERN.test(url) && !NON_ITEM_API_PATTERN.test(url);

/**
 * 判断一个响应是不是商品搜索结果。
 *
 * 必须排除两类：
 *  - document 类型：搜索页自身的 HTML 响应 URL 里也带 search，当成结果会导致 JSON 解析失败；
 *  - 同名前缀的 `...pc.search.shade` / `...pc.item.search.activate`，它们是推荐位与热搜位接口。
 *
 * @param {any} response 页面响应（Playwright Response）。
 * @returns {boolean} 是否为搜索结果响应。
 */
export const isSearchApiResponse = (response) => isSearchRequestUrl(response.url(), response.request().resourceType());

/**
 * 按商品 ID 去重，保留先出现的条目（无限滚动的多批结果之间会重叠）。
 * @param {import('./rules.mjs').Item[]} items 商品列表。
 * @returns {import('./rules.mjs').Item[]} 去重后的列表。
 */
export function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * 解析任务要施加的原生筛选，并算出热页面标识。
 * 标识变了（换关键词、改条件）就必须重新加载页面，不能复用热页面。
 * @param {any} task 任务配置。
 * @returns {{priceRange: number[]|null, region: string|null, hasFilters: boolean, key: string|null}} 筛选描述。
 */
export function nativeFilterSpec(task) {
  const range = task.nativeFilters?.priceRange;
  const priceRange = Array.isArray(range) && range.length === 2 ? range : null;
  const region = typeof task.nativeFilters?.region === 'string' && task.nativeFilters.region !== '' ? task.nativeFilters.region : null;
  // 「新发布 → 最新」是排序（请求体里的 sortField/sortValue），
  // 「新发布 → N天内」是筛选（和价格共用 propValueStr.searchFilter）。
  const sort = task.nativeFilters?.sort === 'newest' ? 'newest' : null;
  const days = Number(task.nativeFilters?.publishDays);
  const publishDays = PUBLISH_DAY_OPTIONS.includes(days) ? days : null;
  return {
    priceRange,
    region,
    sort,
    publishDays,
    hasFilters: Boolean(priceRange || region || sort || publishDays),
    key:
      priceRange || region || sort || publishDays
        ? JSON.stringify({ keyword: task.keyword, priceRange, region, sort, publishDays })
        : null,
  };
}

/** 「新发布」下拉里提供的时间窗选项（实测）。 */
export const PUBLISH_DAY_OPTIONS = [1, 3, 7, 14];

/**
 * 「新发布」下拉的触发器文案。它会随已选选项变化（新发布 → 最新 / 3天内），
 * 所以按这一组文案来找，而不是死认「新发布」。
 */
const PUBLISH_TRIGGER_LABELS = new Set(['新发布', '最新', '1天内', '3天内', '7天内', '14天内']);

/**
 * 下拉触发器**必须是 span**。
 *
 * 容器 div 的类名里也含 `search-select-title`（`search-select-title-container--PqkTXn91`），
 * 所以只写 `[class*="search-select-title"]` 会先命中容器、把点击落在容器上。点容器不一定能把
 * 下拉展开，而失败现场只剩一句「找不到「最新」选项」，完全看不出是点错了元素。
 * 抓 DOM 实测：4 个筛选器各有「容器 div + 标题 span」两层，按容器匹配会得到 7 个元素
 * （综合/新降价/新发布/价格的容器与 span 都被算上），只取 span 才是干净的 4 个。
 */
const PUBLISH_TRIGGER_SELECTOR = 'span[class*="search-select-title"]';

/** 下拉展开后的选项面板。用它是否可见来判断下拉真的开了。 */
const PUBLISH_ITEMS_SELECTOR = '[class*="search-select-items-container"]';

/** 从表单编码的请求体里取出 mtop 的 data 参数。 */
function readSearchBody(postData) {
  if (typeof postData !== 'string') return null;
  const match = /(?:^|&)data=([^&]*)/.exec(postData);
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

/**
 * 判断一次搜索请求是否真的带上了要求的筛选条件。
 *
 * 价格在 `propValueStr.searchFilter`（形如 `priceRange:500,700;`）。
 * 区域有两个位置，取决于用户选的是预设还是具体省份（实测）：
 *   - 预设（江浙沪/珠三角/京津冀/东三省）：`extraFilterValue.extraDivision`
 *   - 具体省份/城市：`extraFilterValue.divisionList`，形如 `[{"province":"上海"}]`
 * 只看 `extraDivision` 会把省份选择误判成「筛选没生效」。
 *
 * @param {any} body 解析后的请求体。
 * @param {{priceRange: number[]|null, region: string|null}} spec 期望的筛选条件。
 * @returns {boolean} 是否全部带上。
 */
export function bodyMatchesFilters(body, spec) {
  if (!body) return false;
  const filter = typeof body.propValueStr?.searchFilter === 'string' ? body.propValueStr.searchFilter : '';
  if (spec.priceRange && !filter.includes(`priceRange:${spec.priceRange[0]},${spec.priceRange[1]}`)) return false;
  // 发布时间窗与价格同处 searchFilter，分号分隔（形如 "priceRange:500,700;publishDays:3;"）
  if (spec.publishDays && !filter.includes(`publishDays:${spec.publishDays}`)) return false;
  // 「最新」是排序，不进 searchFilter，而是请求体顶层的 sortField/sortValue
  if (spec.sort === 'newest' && !(body.sortField === 'create' && body.sortValue === 'desc')) return false;
  if (!spec.region) return true;

  let extra = {};
  try {
    extra = JSON.parse(body.extraFilterValue ?? '{}');
  } catch {
    extra = {};
  }
  if (extra.extraDivision === spec.region) return true;
  if (!Array.isArray(extra.divisionList)) return false;
  return extra.divisionList.some((entry) => entry && (entry.province === spec.region || entry.city === spec.region));
}

/**
 * 展开「新发布」下拉，并把它的选项面板交给调用方。
 *
 * 触发器的文案会随已选项变化，所以按候选文案集合来找。点完必须确认面板真的可见：
 * 下拉是 toggle，前一次误点可能正好把已经开着的下拉关掉，不校验就会在下一步变成
 * 「找不到选项」——那种日志定位不到真正的原因。
 *
 * @param {any} page 页面。
 * @returns {Promise<any|null>} 展开后的选项面板 locator；没展开返回 null。
 */
async function openPublishDropdown(page) {
  const titles = page.locator(PUBLISH_TRIGGER_SELECTOR);
  const count = await titles.count();
  for (let index = 0; index < count; index += 1) {
    const title = titles.nth(index);
    const text = (await title.innerText().catch(() => '')).trim();
    if (!PUBLISH_TRIGGER_LABELS.has(text)) continue;

    await title.click({ timeout: 5000 });
    const opened = await panelOf(title);
    if (opened) return opened;
    // 面板没开：可能前一次点击正好把它关掉了，再点一次就够，不必继续试别的筛选器。
    await title.click({ timeout: 5000 }).catch(() => {});
    return (await panelOf(title)) ?? null;
  }
  return null;
}

/**
 * 取某个下拉触发器的选项面板，并确认它已经展开。
 * @param {any} title 标题 span 的 locator。
 * @returns {Promise<any|null>} 可见的面板 locator；没展开返回 null。
 */
async function panelOf(title) {
  // span → 标题容器 → search-select-container，选项面板是同一个 container 内的兄弟节点。
  const panel = title.locator('xpath=../..').locator(PUBLISH_ITEMS_SELECTOR).first();
  try {
    await panel.waitFor({ state: 'visible', timeout: 3000 });
    return panel;
  } catch {
    return null;
  }
}

/**
 * 在展开的面板里点中某个选项。
 *
 * 用精确文本定位，不认类名哈希（`search-select-item--H_AJBURX` 是构建产物，发版就变），
 * 也不用 `hasText` 这种子串匹配——`最新` 会命中 `最新发布` 这类别的选项。
 *
 * @param {any} panel 选项面板。
 * @param {string} label 选项文案。
 * @returns {Promise<boolean>} 是否点到。
 */
async function clickPublishOption(panel, label) {
  const option = panel.getByText(label, { exact: true }).first();
  try {
    await option.waitFor({ state: 'visible', timeout: 4000 });
    await option.click({ timeout: 5000 });
    return { ok: true };
  } catch (error) {
    // 把 Playwright 的原话带出去。到底是「找不到这个元素」「元素不可见」还是「被别的东西
    // 挡住点不到」，对应三种完全不同的修法——只报一句「找不到选项」等于把线索扔了。
    const panelVisible = await panel.isVisible().catch(() => false);
    return { ok: false, panelVisible, reason: error.message.split('\n')[0] };
  }
}

/**
 * 施加「新发布」里的排序与时间窗。
 *
 * 同一个下拉里两项互相独立：`最新` 走请求体的 sortField/sortValue（排序），
 * `N天内` 走 propValueStr.searchFilter 的 publishDays（筛选）。因此要分别选一次，
 * 每次选择都会触发一次搜索，最终那次请求会同时带上两者。
 *
 * @param {any} page 页面。
 * @param {{sort: string|null, publishDays: number|null}} spec 期望条件。
 * @param {any} logger 日志器。
 * @param {string} taskName 任务名。
 * @returns {Promise<boolean>} 是否全部点中。
 */
export async function applyPublishOptions(page, spec, logger, taskName) {
  const wanted = [];
  if (spec.sort === 'newest') wanted.push('最新');
  if (spec.publishDays) wanted.push(`${spec.publishDays}天内`);
  if (wanted.length === 0) return true;

  for (const label of wanted) {
    const panel = await openPublishDropdown(page);
    if (!panel) {
      logger?.warn('找不到「新发布」筛选入口，闲鱼页面可能改版了', taskName);
      return false;
    }
    const picked = await clickPublishOption(panel, label);
    if (!picked.ok) {
      // 把面板里实际有什么、点击那一刻面板还在不在、以及 Playwright 的原话都打出来。
      // 只报「找不到某选项」定位不到是闲鱼改版、点错了下拉、还是被浮层挡住了。
      const available = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      logger?.warn(
        `「新发布」里找不到「${label}」选项（面板里实际有：${available || '<空>'}；` +
          `点击时面板可见=${picked.panelVisible}；原因：${picked.reason}）`,
        taskName,
      );
      return false;
    }
    // 给这次搜索留出发出的时间，否则紧接着的下一次点击会把它打断。
    await page.waitForTimeout(800);
  }
  return true;
}

/**
 * 闲鱼的风控弹层。它铺满页面后所有点击都会被它拦截并超时，日志里只有一句
 * 「locator.click Timeout」，完全看不出要人工处理，所以单独识别出来。
 *
 * 处罚页本身装在 iframe 里（`bixi.alicdn.com/punish/...`），主框架看不到它，
 * 所以选择器里也带上这个特征，免得只认 baxia 自己的类名。
 */
const RISK_CONTROL_SELECTOR = '.baxia-dialog-mask, .baxia-dialog, iframe[src*="/punish/"]';

/**
 * 判断页面此刻被哪种风控界面挡住。
 *
 * 两种界面都盖满页面、都让点击超时，但处理方式相反，必须分开：
 *  - `verify`：滑块一类的验证，人工过掉就恢复；
 *  - `deny`：处罚页写着「访问被拒绝」，**没有可操作的验证项**，等和过都没用。
 *
 * 判据在弹层的 iframe 地址里（`&action=deny`）。看不了框架时按 `verify` 处理，
 * 维持原来「有验证层就报风控」的行为。
 *
 * @param {any} page 页面。
 * @returns {Promise<'deny'|'verify'|null>} 风控界面种类；没有则为 null。
 */
async function baxiaVerdict(page) {
  let blocking = false;
  try {
    blocking = (await page.locator(RISK_CONTROL_SELECTOR).count()) > 0;
  } catch {
    return null;
  }
  if (!blocking) return null;

  try {
    const frames = typeof page.frames === 'function' ? page.frames() : [];
    const punish = frames.map((frame) => frame.url()).find((url) => url.includes('/punish/'));
    if (punish && /[?&]action=deny(?:&|$)/i.test(punish)) return 'deny';
  } catch {
    // 拿不到框架列表就退回到「只知道有验证层」。
  }
  return 'verify';
}

/**
 * 被风控直接拒绝。
 *
 * 这个错误是**可以在本地自愈**的：实测根因是 profile 里被标记的 `sgcookie`，
 * 清掉它之后同一个账号、同一个出口 IP、同一个接口立刻恢复 SUCCESS。
 * 清 cookie 的动作在 GoofishBrowser.search 里做（那里才拿得到 context），
 * 所以这条错误第二次出现才说明清完仍然被拒，需要人工介入。
 * @returns {never} 一定抛出。
 */
function throwDenied() {
  const error = new Error(
    '搜索被闲鱼风控直接拒绝（处罚页 action=deny，页面上是「访问被拒绝」，没有可操作的验证项）。' +
      '这不是频率问题，也不是登录问题——实测根因是 profile 里被标记的 sgcookie，清掉就能恢复。' +
      '工具会自动清一次并重试；这条信息二次出现说明清完仍被拒，请跑 node diagnose-risk.mjs 定位。',
  );
  error.code = 'denied';
  throw error;
}

/**
 * 抛出风控错误。这种情况不会自己恢复，必须人工在监控窗口里完成验证。
 * @returns {never} 一定抛出。
 */
function throwRiskControl() {
  const error = new Error(
    '闲鱼弹出了风控验证（baxia 弹层），页面被遮住、点击无法进行。' +
      '注意：这个验证在自动化控制的窗口里**过不了**（会被判定为失败），所以别在当前窗口反复试。' +
      '正确做法是停掉本进程，用**普通 Chrome** 打开同一个 profile（见 README 的「风控」一节）完成验证，再启动。' +
      '本轮不推送任何商品。',
  );
  error.code = 'risk-control';
  throw error;
}

/**
 * 页面被风控界面挡住时抛出对应的错误。
 * @param {any} page 页面。
 * @returns {Promise<void>} 没被挡住就正常返回。
 */
async function throwIfBlocked(page) {
  const verdict = await baxiaVerdict(page);
  if (verdict === 'deny') throwDenied();
  if (verdict === 'verify') throwRiskControl();
}

/**
 * 依次尝试多个选择器，点中第一个出现且可点的元素。
 *
 * 必须先等待元素出现再点：价格筛选每次填入都会触发搜索，筛选栏会重渲染，
 * 紧接着用瞬时的 `count()` 判断会查到 0 并误判成「入口不存在」——实测就是这样丢掉了区域筛选。
 * 类名是构建哈希，因此每个交互都准备语义化兜底选择器。
 *
 * @param {any} page 页面。
 * @param {Array<string|(() => any)>} selectors 选择器或返回 locator 的函数。
 * @param {number} [waitMs] 每个选择器最多等多久。
 * @returns {Promise<boolean>} 是否点到。
 */
async function clickFirst(page, selectors, waitMs = 4000) {
  for (const selector of selectors) {
    const locator = typeof selector === 'function' ? selector() : page.locator(selector);
    const target = locator.first();
    try {
      await target.waitFor({ state: 'visible', timeout: waitMs });
      await target.click({ timeout: 5000 });
      return true;
    } catch {
      // 这个选择器没出现或点不动（被遮挡、已消失），换下一个。
      // 但如果页面是被风控弹层盖住的，逐个试下去只会一路超时，直接说清原因。
      await throwIfBlocked(page);
    }
  }
  return false;
}

/**
 * 地区条目的定位方式。优先用弹层里的省份条目类名限定范围，避免 `text=` 命中页面别处的同名文字。
 * @param {any} page 页面。
 * @param {string} region 地区名。
 * @returns {Array<() => any>} 依次尝试的 locator 工厂。
 */
const regionItemLocators = (page, region) => [
  () => page.locator(REGION_ITEM_SELECTOR, { hasText: region }),
  () => page.locator(`text=${region}`),
];

/**
 * 用页面原生的「价格」筛选。实测每次填入输入框都会触发一次搜索，因此先填下限再填上限，
 * 最后一次才是同时带上下限的结果。
 * @param {any} page 页面。
 * @param {number[]} range 价格区间。
 * @param {any} logger 日志器。
 * @param {string} [taskName] 任务名。
 * @returns {Promise<boolean>} 是否成功填入了输入框。
 */
export async function applyPriceRange(page, range, logger, taskName) {
  let inputs = [];
  for (const selector of PRICE_INPUT_SELECTORS) {
    inputs = await page.$$(selector);
    if (inputs.length >= 2) break;
  }
  if (inputs.length < 2) {
    logger?.warn('没找到价格筛选输入框，本轮退回客户端价格过滤（服务端可能返回区间外的商品）', taskName);
    return false;
  }
  await inputs[0].fill(String(range[0]));
  await sleep(600);
  await inputs[1].fill(String(range[1]));
  await sleep(600);
  return true;
}

/**
 * 在区域面板里选中地区并点确认。
 *
 * 交互分三步：点开区域面板 → 选地区 → 点「查看 N 件宝贝」。**最后一步才会发起搜索**，
 * 前两步只改页面状态。
 *
 * @param {any} page 页面。
 * @param {string|null} region 地区名；为 null 表示只借用确认按钮触发一次重搜（热路径用）。
 * @param {any} logger 日志器。
 * @param {string} [taskName] 任务名。
 * @returns {Promise<boolean>} 是否完成了确认点击。
 */
export async function applyRegion(page, region, logger, taskName) {
  if (!(await clickFirst(page, REGION_ENTRY_SELECTORS))) {
    logger?.warn('没找到区域筛选入口，本轮跳过原生区域筛选', taskName);
    return false;
  }
  await sleep(1200);

  if (region) {
    const picked = await clickFirst(page, regionItemLocators(page, region));
    if (!picked) {
      logger?.warn(`区域面板里没找到「${region}」，可用值如：江浙沪 / 珠三角 / 京津冀 / 东三省 / 省份名`, taskName);
      return false;
    }
    await sleep(1200);
  }

  if (!(await clickFirst(page, REGION_CONFIRM_SELECTORS))) {
    logger?.warn('没找到区域面板的「查看 N 件宝贝」确认按钮，本轮筛选可能未生效', taskName);
    return false;
  }
  await sleep(1500);
  return true;
}

/** 开始收集本轮发出的搜索请求体与收到的响应；`stop()` 时必须摘掉监听器，否则会跨轮泄漏。 */
function startCapture(page) {
  /** @type {any[]} */
  const bodies = [];
  /** @type {Array<Promise<unknown>>} */
  const pending = [];

  const onRequest = (request) => {
    if (!isSearchRequestUrl(request.url(), request.resourceType())) return;
    bodies.push(readSearchBody(request.postData()));
  };
  const onResponse = (response) => {
    if (isSearchApiResponse(response)) pending.push(response.json().catch(() => null));
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  return {
    bodies,
    pending,
    lastBodyMatches: (spec) => bodyMatchesFilters(bodies.at(-1), spec),
    /**
     * 把最近几次请求体的关键字段摘出来，用于失败时定位到底哪一项没带上。
     * 用的是已经发出的请求，不额外抓取。
     * @param {number} [count] 取最近几次。
     * @returns {string} 一行摘要。
     */
    describeRecent: (count = 3) =>
      bodies
        .slice(-count)
        .map((body, index) => {
          if (!body) return `#${index + 1} <无法解析>`;
          let division = '-';
          try {
            const extra = JSON.parse(body.extraFilterValue ?? '{}');
            division = extra.extraDivision ?? (Array.isArray(extra.divisionList) ? JSON.stringify(extra.divisionList) : '-');
          } catch {
            division = '<extraFilterValue 不是 JSON>';
          }
          const filter = body.propValueStr?.searchFilter ?? '';
          const sort = body.sortField ? `${body.sortField}:${body.sortValue}` : '无排序';
          return `#${index + 1}{searchFilter="${filter}" 区域=${division} ${sort}}`;
        })
        .join(' '),
    /** 在触发交互**之前**记下当前响应数；交互后再用 waitFor 等新增的那批。 */
    mark: () => pending.length,
    /**
     * 等到 `mark` 之后有新响应，或超时。
     * @param {number} mark 交互前记录的响应数。
     * @param {number} timeoutMs 最长等待毫秒数。
     * @returns {Promise<boolean>} 是否等到了新响应。
     */
    async waitFor(mark, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (pending.length <= mark && Date.now() < deadline && !page.isClosed()) {
        await page.waitForTimeout(200);
      }
      return pending.length > mark;
    },
    stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
    },
  };
}

/**
 * 打开搜索页并收集本轮搜索结果。
 *
 * 无限滚动会把结果分批返回，因此收集全部响应再合并，而不是只取第一条。
 * 一条都拿不到时回退到 DOM 解析：只有商品 ID 可靠，标题和价格是启发式结果。
 *
 * 接口返回登录失效或错误码时抛异常而不是返回空列表，让主循环走退避与告警路径。
 *
 * @param {any} page Playwright Page 或结构相同的测试替身。
 * @param {{baseUrl: string, linkTemplate: string, responseTimeoutMs: number}} config 浏览器配置。
 * @param {{keyword: string, scrollRounds?: number, name?: string, nativeFilters?: object}} task 任务配置。
 * @param {{warn: Function, error: Function}} [logger] 日志器。
 * @param {{warmKey: string|null}} [session] 页面状态；由浏览器会话按任务持有，
 *   记录当前页面已经施加了哪套筛选条件，用来决定走热路径还是重新加载。
 * @returns {Promise<{items: import('./rules.mjs').Item[], source: 'api'|'dom', raw: unknown[]|null, requests: number}>}
 *   搜索结果；`requests` 是本轮实际发出的搜索请求数，用于核对热路径有没有生效。
 */
export async function collectSearch(page, config, task, logger, session = { warmKey: null }) {
  const spec = nativeFilterSpec(task);

  // 页面可能已经被风控弹层盖住（上一次遗留、或闲鱼刚弹的）。先看一眼，别等点击一路超时
  // 才发现——那种日志只有「locator.click Timeout」，看不出要人工处理。
  await throwIfBlocked(page);

  const target = new URL('/search', config.baseUrl);
  target.searchParams.set('q', task.keyword);

  const capture = startCapture(page);
  try {
    // ---- 热路径：页面已经带着这套筛选条件，只需触发一次重搜 ----
    if (spec.key && session.warmKey === spec.key && !page.isClosed()) {
      const mark = capture.mark();
      await applyRegion(page, spec.region, logger, task.name);
      const gotResponse = await capture.waitFor(mark, config.responseTimeoutMs);
      if (gotResponse && capture.lastBodyMatches(spec)) {
        return finish(capture, page, config, task, logger, session, mark);
      }
      logger?.warn('热刷新没拿到带完整筛选条件的搜索结果，退回重新加载', task.name);
      session.warmKey = null;
    }

    // ---- 冷路径：重新加载并逐项施加筛选 ----
    const loadMark = capture.mark();
    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await capture.waitFor(loadMark, config.responseTimeoutMs);

    // 从哪一批响应开始算结果。默认全部；原生筛选生效时只看最后那次带全部条件的搜索——
    // 页面加载时那批未筛选的、以及填价格中间态那批，都是全国范围的结果，混进来会推送范围外的商品。
    let parseFrom = 0;
    if (spec.hasFilters) {
      const filterMark = capture.mark();
      if (spec.priceRange) await applyPriceRange(page, spec.priceRange, logger, task.name);
      if (spec.region) await applyRegion(page, spec.region, logger, task.name);
      if (spec.sort || spec.publishDays) await applyPublishOptions(page, spec, logger, task.name);
      await capture.waitFor(filterMark, config.responseTimeoutMs);

      const applied = capture.lastBodyMatches(spec);
      if (!applied) {
        // 光说「没生效」定位不到是哪一项丢的，把最近几次请求体的关键字段一并报出来。
        // 用的是已经发出去的请求，不额外抓取。
        const expected = [
          spec.priceRange ? `价格 ${spec.priceRange[0]}~${spec.priceRange[1]}` : null,
          spec.region ? `区域 ${spec.region}` : null,
          spec.sort ? '排序 最新' : null,
          spec.publishDays ? `发布 ${spec.publishDays} 天内` : null,
        ]
          .filter(Boolean)
          .join('，');
        logger?.error(`期望条件：${expected}；实际最近几次请求：${capture.describeRecent(3)}`, task.name);
        // 筛选没生效时必须停下来。退回用全部批次会把「页面加载时的未筛选结果」一起推出去——
        // 实测就是这样推了 31 条和关键词无关的商品。宁可这一轮不出结果并告警，也不要推垃圾。
        const error = new Error(
          '原生筛选没有生效：实际发出的搜索请求里没有带上配置的全部条件（详见上一行日志里的实际请求体），本轮不推送任何商品。' +
            '通常是闲鱼页面改版导致选择器失配，请检查 src/search.mjs 里的选择器，或先用 filters 里的客户端条件兜底。',
        );
        error.code = 'filters-not-applied';
        session.warmKey = null;
        throw error;
      }
      parseFrom = Math.max(filterMark, capture.pending.length - 1);
      session.warmKey = spec.key;
    }

    const rounds = task.scrollRounds ?? 0;
    for (let i = 0; i < rounds; i += 1) {
      const scrollMark = capture.mark();
      await page.mouse.wheel(0, 4000);
      await capture.waitFor(scrollMark, config.responseTimeoutMs);
    }

    return finish(capture, page, config, task, logger, session, parseFrom);
  } finally {
    capture.stop();
  }
}

/** 把收集到的响应分类、解析成商品列表；顺带处理滚动兜底。 */
async function finish(capture, page, config, task, logger, session, parseFrom) {
  const payloads = (await Promise.all(capture.pending.slice(parseFrom))).filter((payload) => payload !== null);

  // 闲鱼搜索必须登录，且对自动化访问有频率限制；两种情况都会返回错误码，
  // 这里必须抛出，否则会被当成「本轮 0 条结果」静默吞掉。
  const verdicts = payloads.map(classifyResponse);
  // 「直接拒绝」要排在限流前面：两者的 ret 一模一样，只有处罚链接里的 action 不同。
  // 认成限流会让主循环走「小步退避后重试」这条路，而 deny 是等多久都不会自己好的。
  const denied = verdicts.find((verdict) => verdict.kind === 'denied');
  if (denied) {
    const error = new Error(
      `搜索接口被闲鱼直接拒绝（${denied.message}）。这不是访问频率问题：响应里的风控处罚页是` +
        '「访问被拒绝」（action=deny），页面上没有可拖动、可点击的验证项，所以调大 intervalSeconds、' +
        '重新登录、用普通 Chrome 过验证都不会恢复。实测这个拒绝由 profile 里被标记的 sgcookie 携带，' +
        '复位它就能恢复（工具会自动做一次并重试）。本轮不推送任何商品。' +
        '排查与处置见 node diagnose-risk.mjs。',
    );
    error.code = 'denied';
    throw error;
  }
  const throttle = verdicts.find((verdict) => verdict.kind === 'throttle');
  if (throttle) {
    // code 让主循环能识别「这轮是被限流」并直接跳到最长冷却，而不是慢慢加倍重试。
    const error = new Error(
      `请求被闲鱼拦截（${throttle.message}）。该错误码在「访问频率过高」和「登录态失效」两种情况下都会出现：` +
        '请先调大 intervalSeconds（建议 60 秒以上）重试；若仍然如此，再重新执行 node src/cli.mjs login。',
    );
    error.code = 'throttled';
    throw error;
  }
  const auth = verdicts.find((verdict) => verdict.kind === 'auth');
  if (auth) {
    const error = new Error(`搜索接口要求登录（${auth.message}）。请重新执行 node src/cli.mjs login 扫码登录。`);
    error.code = 'auth';
    session.warmKey = null;
    throw error;
  }
  const failure = verdicts.find((verdict) => verdict.kind === 'error');
  if (failure) {
    const error = new Error(`搜索接口返回错误：${failure.message}`);
    error.code = 'api';
    throw error;
  }

  const items = dedupeById(payloads.flatMap((payload) => extractItems(payload, { linkTemplate: config.linkTemplate })));
  if (items.length > 0) return { items, source: 'api', raw: payloads, requests: capture.bodies.length };
  if (payloads.length > 0) logger?.warn('搜索响应解析出 0 条，回退到 DOM 解析', task.name);

  const entries = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="item?id="]')).map((anchor) => ({
      href: anchor.href,
      text: anchor.textContent ?? '',
    })),
  );
  return { items: extractFromDom(entries, { linkTemplate: config.linkTemplate }), source: 'dom', raw: null, requests: capture.bodies.length };
}

