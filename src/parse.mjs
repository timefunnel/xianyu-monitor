/**
 * 闲鱼搜索结果的字段适配层。
 *
 * 闲鱼网页端用的 mtop 搜索接口没有公开文档、字段随时可能变，因此这里不做「精确 schema
 * 解析」，而是先按已知结构定位候选节点，再对每个字段做容错取值；定位策略失效时用
 * `node src/cli.mjs dump` 保存原始响应，只改本文件即可。
 *
 * 本文件不依赖网络，全部函数可直接单测。
 */

/**
 * 判断一次 mtop 响应是成功、被限流、被直接拒绝、要求登录还是报错。
 *
 * 实测四种情况：
 *  - 未登录或登录态失效：`ret: ["FAIL_SYS_SESSION_EXPIRED::Session过期"]`；
 *  - 请求频率过高：`ret: ["RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试!"]`，且 `data.url` 会带上
 *    登录页地址，所以**不能**只看登录页地址就判定为登录失效；
 *  - 被风控直接拒绝：同样是 RGV587，但 `data.url` 指向 baxia 的处罚模板
 *    （`bixi.alicdn.com/punish/...&action=deny`），页面上写的是「访问被拒绝」，**没有任何可操作的
 *    验证项**。这种和限流必须分开：限流等几分钟就好，deny 等多久都不会自己好，而且重试、
 *    重新登录、过验证都无效，混在一起会让主循环在一条死路上反复空转并给出错误建议；
 *  - 其它错误码按原样上报。
 *
 * 这些响应必须显式分类，否则会被当成「本轮 0 条结果」静默吞掉。
 *
 * @param {unknown} payload 原始响应体。
 * @returns {{kind: 'success'|'throttle'|'denied'|'auth'|'error', message: string}} 分类结果。
 */
export function classifyResponse(payload) {
  const ret = Array.isArray(payload?.ret) ? payload.ret : [];
  const first = typeof ret[0] === 'string' ? ret[0] : '';
  const loginUrl = typeof payload?.data?.url === 'string' ? payload.data.url : '';

  if (first.startsWith('SUCCESS')) return { kind: 'success', message: first };
  // punish 链接里的 action 决定这次拦截有没有人工出口：deny=直接拒绝，verify=还有滑块可过。
  // 判据取 URL 而不是错误码，因为两种情况的 ret 完全一样。
  if (/\/punish\//i.test(loginUrl) && /[?&]action=deny(?:&|$)/i.test(loginUrl)) {
    return { kind: 'denied', message: first || '风控直接拒绝（action=deny）' };
  }
  if (/RGV587|被挤爆|TRAFFIC_LIMIT|访问过于频繁|请求过于频繁|FAIL_SYS_TRAFFIC/i.test(first)) {
    return { kind: 'throttle', message: first };
  }
  if (/SESSION_EXPIRED|SESSION_INVALID|未登录|请先登录|FAIL_SYS_USER_VALIDATE/i.test(first)) {
    return { kind: 'auth', message: first };
  }
  if (/passport\.|mini_login/i.test(loginUrl)) return { kind: 'auth', message: first || '接口返回登录页地址' };
  return { kind: 'error', message: first || '接口返回了无法识别的结果' };
}

/**
 * @typedef {import('./rules.mjs').Item} Item
 */

const ID_KEY = /^(id|item_?id|idle_?item_?id)$/i;
const MAX_DEPTH = 12;

/**
 * PC 搜索响应里拿不到的字段。
 *
 * 实测 `exContent` 根本没有发布时间键（59 条结果里 57 条缺），所以
 * `filters.maxAgeMinutes` 绝大多数商品会落在「时间未知」上、按 `onUnknownField` 放行，
 * 等于这个条件没在过滤。启动时会就此告警，避免配置看着生效其实空转。
 */
export const MISSING_FIELDS = new Set(['publishTime']);

/** 逐层遍历对象/数组，遇到过深或非对象即停。 */
function* walk(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return;
  yield value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) yield* walk(child, depth + 1);
}

/**
 * mtop 响应有时把业务数据塞在 JSON 字符串里，这里做一次展开。
 * @param {unknown} payload 原始响应体。
 * @returns {unknown} 展开后的数据。
 */
export function unwrapPayload(payload) {
  let current = payload;
  for (let i = 0; i < 3; i += 1) {
    if (typeof current === 'string') {
      try {
        current = JSON.parse(current);
        continue;
      } catch {
        return payload;
      }
    }
    if (current && typeof current === 'object' && !Array.isArray(current) && 'data' in current && typeof current.data === 'string') {
      try {
        current = JSON.parse(current.data);
        continue;
      } catch {
        return current;
      }
    }
    break;
  }
  return current;
}

/** 取第一个非空字符串。 */
function pickString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (Array.isArray(candidate)) {
      const nested = pickString(...candidate);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 从富文本片段里取出文本。闲鱼把价格拆成片段数组，例如
 * `[{text:"¥",...},{text:"161",...}]`，只取第一段会拿到 "¥" 而解析不出数字。
 * @param {unknown} value 片段。
 * @returns {string|null} 片段文本。
 */
function segmentText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const text = value.text ?? value.price ?? value.value ?? value.priceText;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

/**
 * 从一段文本里解析价格。支持 `¥1,299`、`1299 元`、`1.2万`。
 * 先认货币符号后的数字，再退化为「两侧不紧邻字母数字的至少两位数」——
 * 否则标题里的「M2」「1440P」会被当成价格。
 * @param {string} text 待解析文本。
 * @returns {number|null} 价格（元）；无法解析时为 null。
 */
function parsePriceText(text) {
  const compact = text.replace(/[,，\s]/g, '');
  const wan = compact.match(/(\d+(?:\.\d+)?)万/);
  if (wan) return Math.round(Number.parseFloat(wan[1]) * 10000 * 100) / 100;
  const anchored = compact.match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  if (anchored) return Number.parseFloat(anchored[1]);
  const bare = compact.match(/(?:^|[^\dA-Za-z])(\d{2,}(?:\.\d+)?)(?![A-Za-z\d])/);
  return bare ? Number.parseFloat(bare[1]) : null;
}

/**
 * 把价格的各种表示归一化成元。支持数字、`¥1,299`、`1299 元`、`1.2万`、
 * `[{price:'2999'}]`，以及闲鱼实际返回的富文本片段数组 `[{text:'¥'},{text:'161'}]`。
 * @param {unknown} value 原始价格字段。
 * @returns {number|null} 价格（元）；无法解析时为 null。
 */
export function toPrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const joined = value.map(segmentText).filter((text) => text !== null).join('');
    const fromJoined = joined === '' ? null : parsePriceText(joined);
    if (fromJoined !== null) return fromJoined;
    for (const entry of value) {
      const single = toPrice(entry);
      if (single !== null) return single;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    return toPrice(value.price ?? value.value ?? value.priceText ?? value.text ?? null);
  }
  if (typeof value !== 'string') return null;
  return parsePriceText(value);
}

/**
 * 把发布时间归一化成 epoch 毫秒。支持秒/毫秒时间戳与「3分钟前」「昨天」这类相对文案。
 * @param {unknown} value 原始时间字段。
 * @param {number} [now] 当前时间，便于测试注入。
 * @returns {number|null} epoch 毫秒；无法解析时为 null。
 */
export function toTimestamp(value, now = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return toTimestamp(Number(text), now);
  if (/^(刚刚|刚才|now)$/i.test(text)) return now;

  const relative = text.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|分|小时|天|个月)前/);
  if (relative) {
    const amount = Number.parseFloat(relative[1]);
    const unit = { 秒: 1000, 分钟: 60000, 分: 60000, 小时: 3600000, 天: 86400000, 个月: 2592000000 }[relative[2]];
    return Math.round(now - amount * unit);
  }
  if (/^昨天/.test(text)) return now - 86400000;
  if (/^前天/.test(text)) return now - 2 * 86400000;

  const parsed = Date.parse(text.replace(/\//g, '-'));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 在节点内（有限深度）查找商品 ID。
 * @param {unknown} node 候选节点。
 * @returns {string|null} 数字型商品 ID。
 */
export function findItemId(node) {
  for (const candidate of walk(node)) {
    if (Array.isArray(candidate)) continue;
    for (const [key, value] of Object.entries(candidate)) {
      if (!ID_KEY.test(key)) continue;
      const id = typeof value === 'number' ? String(value) : value;
      if (typeof id === 'string' && /^\d{6,}$/.test(id)) return id;
    }
  }
  return null;
}

/** 归一化图片地址（闲鱼常返回 `//img...` 协议相对地址）。 */
function toPicUrl(value) {
  const raw = pickString(value, Array.isArray(value) ? value : null);
  if (!raw) return null;
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

/**
 * 归一化 App 深链。闲鱼给每个商品都返回 `targetUrl`，形如
 * `fleamarket://item?id=1084546564468&referPageArgs=...&gulSource=search&...`，
 * 带搜索来源追踪参数——扫商品分享码得到的跳转目标就是它这一族。
 * 只接受带 scheme 的地址，避免把普通字符串当成链接推给用户。
 * @param {unknown} value 原始字段。
 * @returns {string|null} App 深链；不是链接时为 null。
 */
function toAppUrl(value) {
  const raw = pickString(value);
  return raw && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : null;
}

/** 归一化卖家所在地：支持字符串、数组与 {province, city} 对象。 */
function toArea(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (Array.isArray(value)) {
    const joined = value.map((entry) => toArea(entry)).filter(Boolean).join(' ');
    return joined || null;
  }
  if (value && typeof value === 'object') {
    const joined = [value.province, value.city, value.district, value.area]
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .join(' ');
    return joined || null;
  }
  return null;
}

/**
 * 找出所有候选商品节点。优先取带 `exContent` 的节点（闲鱼搜索结果的主结构），
 * 找不到时退化为「同时含标题与商品 ID」的对象。
 * @param {unknown} payload 展开后的响应。
 * @returns {Array<{node: object, content: object}>} 候选节点。
 */
export function findItemNodes(payload) {
  const primary = [];
  for (const candidate of walk(payload)) {
    if (Array.isArray(candidate)) continue;
    if (candidate.exContent && typeof candidate.exContent === 'object' && !Array.isArray(candidate.exContent)) {
      primary.push({ node: candidate, content: candidate.exContent });
    }
  }
  if (primary.length > 0) return primary;

  const fallback = [];
  for (const candidate of walk(payload)) {
    if (Array.isArray(candidate)) continue;
    const hasTitle = typeof candidate.title === 'string' && candidate.title.trim() !== '';
    if (hasTitle && findItemId(candidate)) fallback.push({ node: candidate, content: candidate });
  }
  return fallback;
}

/**
 * 把候选节点归一化成商品对象。缺 ID 或缺标题的一律丢弃，避免把广告位当商品推出去。
 * @param {{node: object, content: object}} entry 候选节点。
 * @param {{linkTemplate: string, now?: number}} ctx 链接模板与当前时间。
 * @returns {Item|null} 归一化商品；字段不足时为 null。
 */
export function normalizeItem(entry, ctx) {
  const { node, content } = entry;
  const detail = content.detailParams ?? {};
  const id = findItemId(node) ?? findItemId(content);
  if (!id) return null;

  const title = pickString(content.title, content.titleSpan?.content, detail.title, node.title, content.desc);
  if (!title) return null;

  // 价格可能出现在多处：exContent.price 是富文本片段，detailParams.soldPrice 与
  // clickParam.args.price 是纯数字串。逐个尝试，取第一个能解析出数字的。
  let price = null;
  for (const candidate of [
    content.price,
    detail.soldPrice,
    content.clickParam?.args?.price,
    content.clickParam?.args?.displayPrice,
    content.soldPrice,
    content.priceText,
  ]) {
    price = toPrice(candidate);
    if (price !== null) break;
  }

  return {
    id,
    title,
    price,
    area: toArea(content.area ?? content.userArea ?? content.location ?? content.city),
    seller: pickString(content.userNickName, detail.userNick, content.nick, content.sellerNick, content.userName),
    sellerCredit: toSellerCredit(content),
    picUrl: toPicUrl(content.picUrl ?? content.image ?? content.pic ?? content.mainPic),
    url: ctx.linkTemplate.replace('{id}', id),
    appUrl: toAppUrl(node.targetUrl ?? content.targetUrl ?? content.jumpUrl),
    publishTime: toTimestamp(content.publishTime ?? content.pubTime ?? content.createTime ?? content.gmtCreate, ctx.now),
  };
}

/**
 * 从标签里取卖家信用等级：「卖家信用极好」→「极好」。
 *
 * 闲鱼只在卖家达到一定信用时才挂这个标签，所以取不到就代表卖家没到那个等级。
 * 这些标签挂在 `exContent.fishTags.<组>.tagList[].data.content`，组号（r1/r2/…）随商品而变，
 * 因此遍历所有组而不是认准某一个。服务端只提供「信用排序」，没有信用筛选参数，
 * 想按信用过滤只能在客户端做。
 *
 * @param {any} content 商品的 exContent。
 * @returns {string|null} 信用等级文案；没有标签时为 null。
 */
function toSellerCredit(content) {
  const groups = content?.fishTags;
  if (!groups || typeof groups !== 'object') return null;
  for (const group of Object.values(groups)) {
    for (const tag of group?.tagList ?? []) {
      const text = tag?.data?.content;
      if (typeof text !== 'string') continue;
      const match = /^卖家信用(.+)$/.exec(text.trim());
      if (match) return match[1];
    }
  }
  return null;
}

/**
 * 从搜索响应里抽取商品列表，按 ID 去重并保持顺序。
 * @param {unknown} payload 原始响应体。
 * @param {{linkTemplate: string, now?: number}} ctx 链接模板与当前时间。
 * @returns {Item[]} 归一化商品列表。
 */
export function extractItems(payload, ctx) {
  const unwrapped = unwrapPayload(payload);
  const seen = new Set();
  const items = [];
  for (const entry of findItemNodes(unwrapped)) {
    const item = normalizeItem(entry, ctx);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/**
 * DOM 兜底解析：接口拦截失败时，从搜索结果页的链接与文本里粗略还原商品。
 * 只有 ID 是可靠的，标题和价格是启发式结果，因此返回的条目会被标记为低保真。
 * @param {Array<{href: string, text: string}>} entries 页面锚点。
 * @param {{linkTemplate: string}} ctx 链接模板。
 * @returns {Item[]} 归一化商品列表。
 */
export function extractFromDom(entries, ctx) {
  const items = [];
  const seen = new Set();
  for (const { href, text } of entries) {
    const match = /[?&]id=(\d{6,})/.exec(href ?? '');
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    const clean = (text ?? '').replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    seen.add(id);
    items.push({
      id,
      title: clean.slice(0, 120),
      price: toPrice(clean),
      area: null,
      seller: null,
      picUrl: null,
      url: ctx.linkTemplate.replace('{id}', id),
      publishTime: null,
    });
  }
  return items;
}
