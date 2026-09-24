/**
 * 筛选条件与请求体的对应关系。
 *
 * 两个函数分别管两头：
 *   - nativeFilterSpec(task)：把任务配置翻译成价格区间 / 区域 / 排序 / 发布时间窗；
 *   - bodyMatchesFilters(body, spec)：判断真正发出去的请求体有没有把条件全带上。
 *
 * 后者是「筛选没生效就不推送」的判据。以前驱动页面时它用来确认热页面状态还在；直连之后它守的是
 * 另一件事——**拼出来的请求体真的带上了全部条件**，对不上就宁可报错也不推，避免静默推送范围外的商品。
 */

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
