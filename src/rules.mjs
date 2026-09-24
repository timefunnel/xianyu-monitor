/**
 * 命中判定：纯函数，不碰网络与磁盘，便于单测覆盖。
 *
 * @typedef {object} Item 归一化后的商品。
 * @property {string} id 商品 ID，去重主键。
 * @property {string} title 标题。
 * @property {number|null} price 价格（元）；抓不到时为 null。
 * @property {string|null} area 卖家所在地。
 * @property {string|null} seller 卖家昵称。
 * @property {string|null} picUrl 主图地址。
 * @property {string} url 商品链接（网页版）。
 * @property {string|null} appUrl 闲鱼 App 深链（`fleamarket://item?id=...`）；接口没给时为 null。
 * @property {number|null} publishTime 发布时间（epoch 毫秒）；抓不到时为 null。
 */

/**
 * @typedef {object} Filters 任务过滤条件，字段全部可选。
 * @property {number} [minPrice] 价格下限（含）。
 * @property {number} [maxPrice] 价格上限（含）。
 * @property {string[]} [requireKeywords] 标题必须包含其一。
 * @property {string[]} [excludeKeywords] 标题包含任一即排除。
 * @property {string} [requirePattern] 标题必须匹配的正则（不区分大小写）。用于「144Hz 以上」这类
 *   需要边界的条件——用 requireKeywords 写 "144" 会被 "1440P" 误命中。
 * @property {string} [excludePattern] 标题匹配即排除的正则（不区分大小写）。
 * @property {string[]} [excludeSellers] 卖家昵称精确匹配即排除。
 * @property {string} [requireSellerCredit] 卖家信用至少要达到这个等级（如「极好」）。
 *   服务端只提供「信用排序」没有信用筛选，所以这条只能在客户端判定；商品没有信用标签
 *   表示卖家没到该等级，按不达标处理。
 * @property {number} [maxAgeMinutes] 只接受该时间窗内发布的商品。
 * @property {string} [cityContains] 卖家所在地必须包含该字符串。
 * @property {string[]} [cityAnyOf] 卖家所在地包含其中任一即可（用于「江浙沪」这类多地区条件）。
 */

/**
 * 卖家信用的等级顺序（低 → 高）。闲鱼在商品上以「卖家信用极好」这类标签展示，
 * 没有标签的卖家按最低档处理。服务端只有「信用排序」，没有对应的筛选参数。
 */
export const CREDIT_LEVELS = ['一般', '良好', '优秀', '极好'];

/**
 * @typedef {object} Verdict 判定结果。
 * @property {boolean} ok 是否推送。
 * @property {string[]} rejections 被排除的原因，命中时为待推送原因。
 * @property {string[]} unknown 因字段缺失而跳过判定的字段名。
 */

/**
 * 按过滤条件判定一条商品是否值得推送。
 *
 * 字段缺失（例如接口没给出发布时间）默认按 `onUnknown` 处理：`pass` 时放行并把字段名
 * 记入 `unknown`，让调用方在消息和心跳里显式标注；`reject` 时直接排除。默认选 `pass`，
 * 因为漏报比误报更难被发现。
 *
 * @param {Item} item 归一化商品。
 * @param {Filters} filters 过滤条件。
 * @param {{now?: number, onUnknown?: 'pass'|'reject'}} [options] `now` 注入当前时间便于测试。
 * @returns {Verdict} 判定结果。
 */
export function evaluate(item, filters = {}, options = {}) {
  const now = options.now ?? Date.now();
  const onUnknown = options.onUnknown ?? 'pass';
  const rejections = [];
  const unknown = [];

  /** 记录一次无法判定：按策略决定是否排除，并始终记录字段名。 */
  const undecidable = (field, message) => {
    unknown.push(field);
    if (onUnknown === 'reject') rejections.push(message);
  };

  const title = item.title ?? '';
  const lowerTitle = title.toLowerCase();

  // 正则已在配置校验阶段确认可编译，这里直接构造；只在配置里写了非空字符串时才生效。
  const requirePattern = filters.requirePattern ? new RegExp(filters.requirePattern, 'i') : null;
  const excludePattern = filters.excludePattern ? new RegExp(filters.excludePattern, 'i') : null;

  if (typeof filters.minPrice === 'number' || typeof filters.maxPrice === 'number') {
    if (typeof item.price !== 'number') {
      undecidable('price', '价格未知');
    } else if (typeof filters.minPrice === 'number' && item.price < filters.minPrice) {
      rejections.push(`价格 ¥${item.price} 低于下限 ¥${filters.minPrice}`);
    } else if (typeof filters.maxPrice === 'number' && item.price > filters.maxPrice) {
      rejections.push(`价格 ¥${item.price} 高于上限 ¥${filters.maxPrice}`);
    }
  }

  for (const keyword of filters.excludeKeywords ?? []) {
    if (keyword && lowerTitle.includes(keyword.toLowerCase())) {
      rejections.push(`标题命中排除词「${keyword}」`);
    }
  }

  const required = (filters.requireKeywords ?? []).filter(Boolean);
  if (required.length > 0 && !required.some((keyword) => lowerTitle.includes(keyword.toLowerCase()))) {
    rejections.push(`标题未包含必需词 ${required.join(' / ')}`);
  }

  if (requirePattern && !requirePattern.test(title)) {
    rejections.push(`标题不匹配必需正则 /${filters.requirePattern}/`);
  }

  if (excludePattern && excludePattern.test(title)) {
    rejections.push(`标题命中排除正则 /${filters.excludePattern}/`);
  }

  if (filters.excludeSellers?.length) {
    if (!item.seller) {
      undecidable('seller', '卖家未知');
    } else if (filters.excludeSellers.includes(item.seller)) {
      rejections.push(`卖家「${item.seller}」在黑名单`);
    }
  }

  if (typeof filters.cityContains === 'string' && filters.cityContains !== '') {
    if (!item.area) {
      undecidable('area', '所在地未知');
    } else if (!item.area.includes(filters.cityContains)) {
      rejections.push(`所在地「${item.area}」不含「${filters.cityContains}」`);
    }
  }

  if (Array.isArray(filters.cityAnyOf) && filters.cityAnyOf.length > 0) {
    if (!item.area) {
      undecidable('area', '所在地未知');
    } else if (!filters.cityAnyOf.some((city) => city && item.area.includes(city))) {
      rejections.push(`所在地「${item.area}」不在指定地区内`);
    }
  }

  if (filters.requireSellerCredit) {
    // 服务端只有「信用排序」，没有信用筛选，所以这一条只能在客户端做。
    // 商品上没有信用标签 = 卖家没到那个等级，按「不达标」处理。
    const required = CREDIT_LEVELS.indexOf(filters.requireSellerCredit);
    const actual = CREDIT_LEVELS.indexOf(item.sellerCredit ?? '');
    if (actual < required) {
      rejections.push(`卖家信用${item.sellerCredit ? `为「${item.sellerCredit}」` : '未标注'}，未达「${filters.requireSellerCredit}」`);
    }
  }

  if (typeof filters.maxAgeMinutes === 'number') {
    if (typeof item.publishTime !== 'number') {
      undecidable('publishTime', '发布时间未知');
    } else {
      const ageMinutes = (now - item.publishTime) / 60000;
      if (ageMinutes > filters.maxAgeMinutes) {
        rejections.push(`发布于 ${Math.round(ageMinutes)} 分钟前，超出 ${filters.maxAgeMinutes} 分钟窗口`);
      }
    }
  }

  return { ok: rejections.length === 0, rejections, unknown };
}

/**
 * 把过滤条件渲染成人类可读摘要，用于启动日志、心跳和控制台。
 *
 * 默认给**紧凑形式**：列表类条件只报条数（`必需词 28 条`），因为品牌白名单动辄几十项，
 * 全列出来会变成三百多字的文字墙，把日志面板刷满。要看具体内容用 `{ verbose: true }`
 * （`check` 命令用它做配置核对）。
 *
 * @param {Filters} filters 客户端过滤条件。
 * @param {{priceRange?: number[], region?: string}} [nativeFilters] 交给闲鱼页面原生执行的筛选条件。
 * @param {{verbose?: boolean}} [options] `verbose` 为真时列出列表类条件的全部取值。
 * @returns {string} 单行摘要。
 */
export function describeFilters(filters = {}, nativeFilters, options = {}) {
  const verbose = options.verbose === true;
  const parts = [];
  /** 列表类条件：紧凑模式报条数，详细模式列出内容。 */
  const list = (label, values) => {
    if (!Array.isArray(values) || values.length === 0) return;
    parts.push(verbose ? `${label} ${values.join('|')}` : `${label} ${values.length} 条`);
  };

  if (nativeFilters?.priceRange?.length === 2) {
    parts.push(`原生价格筛选 ${nativeFilters.priceRange[0]}~${nativeFilters.priceRange[1]}`);
  }
  if (nativeFilters?.region) parts.push(`原生区域筛选 ${nativeFilters.region}`);
  if (nativeFilters?.sort === 'newest') parts.push('原生按最新发布排序');
  if (nativeFilters?.publishDays) parts.push(`原生只取 ${nativeFilters.publishDays} 天内发布`);
  if (typeof filters.minPrice === 'number' || typeof filters.maxPrice === 'number') {
    parts.push(`价格 ${filters.minPrice ?? '-'}~${filters.maxPrice ?? '-'}`);
  }
  list('必需词', filters.requireKeywords);
  list('排除词', filters.excludeKeywords);
  if (filters.requirePattern) parts.push(`匹配 /${filters.requirePattern}/`);
  if (filters.excludePattern) parts.push(`不匹配 /${filters.excludePattern}/`);
  list('黑名单卖家', filters.excludeSellers);
  if (filters.requireSellerCredit) parts.push(`卖家信用 ≥ ${filters.requireSellerCredit}`);
  if (typeof filters.maxAgeMinutes === 'number') parts.push(`${filters.maxAgeMinutes} 分钟内`);
  if (filters.cityContains) parts.push(`地区含 ${filters.cityContains}`);
  list('地区属于', filters.cityAnyOf);
  return parts.length > 0 ? parts.join('，') : '无过滤（全部推送）';
}
