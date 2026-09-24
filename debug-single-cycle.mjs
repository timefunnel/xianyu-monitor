// 受控调试：配好原生筛选后**只跑一轮就停**，用来验证筛选到底有没有生效。
//
// 为什么做成「一轮就跑完并停掉」：闲鱼对短时间内的高频访问很敏感，实测连续几次搜索就会
// 触发风控（先弹 baxia 验证层，严重时直接让登录态失效）。调试时不要反复试探，
// 一次拿够信息再看结果。
//
// 一轮冷启动 = 4 次请求（页面加载 1 次 + 价格 1 次 + 区域 1 次 + 排序 1 次），
// 这是施加原生筛选的最小代价，之后每轮只有 1 次。脚本除此之外不做任何请求。
//
// 用法：node debug-single-cycle.mjs
// 跑完任务保持停用，筛选留在配置里，之后直接打开开关即可。
import { readFileSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:7788';
const CONFIG = 'config.json';
const original = readFileSync(CONFIG, 'utf8');
const parsed = JSON.parse(original);
const task = parsed.tasks[0];

/** 只加这两项：最新发布排序 + 信用门槛。时间窗你没要，先不加。 */
task.nativeFilters = { ...(task.nativeFilters ?? {}), sort: 'newest' };
task.filters = { ...(task.filters ?? {}), requireSellerCredit: '极好' };
task.enabled = true;

const state = async () => (await (await fetch(`${base}/api/state`)).json());
const putTasks = async (tasks) =>
  (await fetch(`${base}/api/tasks`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tasks }) })).json();

try {
  console.log('配置：nativeFilters =', JSON.stringify(task.nativeFilters));
  console.log('      filters.requireSellerCredit =', task.filters.requireSellerCredit);
  console.log('      enabled = true（跑完一轮会停掉，不会持续抓取）\n');

  console.log('PUT /api/tasks:', JSON.stringify(await putTasks(parsed.tasks)));

  const before = (await state()).tasks[0].stats.cycles;
  console.log(`起始轮询次数: ${before}，等待一轮完成（最多 90 秒）…`);

  let snapshot = await state();
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    snapshot = await state();
    const now = snapshot.tasks[0];
    if (now.stats.cycles > before || now.stats.failures > 0) break;
  }

  const after = snapshot.tasks[0];
  console.log('\n=== 一轮之后 ===');
  console.log('轮询/扫描/命中/推送:', after.stats.cycles, after.stats.scanned, after.stats.matched, after.stats.notified);
  console.log('连续失败:', after.stats.failures);
  console.log('仍在运行:', after.running);
  if (snapshot.lastError) console.log('lastError:', snapshot.lastError);

  const newHits = snapshot.hits.filter((h) => h.task === task.name).slice(0, 3);
  console.log('本轮命中样例:', newHits.length ? newHits.map((h) => `¥${h.price} ${String(h.title).slice(0, 30)}`).join(' | ') : '（无）');
} finally {
  // 跑完立刻停掉任务，避免持续抓取
  const stopped = JSON.parse(JSON.stringify(parsed));
  stopped.tasks[0].enabled = false;
  // 把配好的筛选写回配置（之后你想开的时候直接打开开关就行），但保持停用
  writeFileSync(CONFIG, JSON.stringify(stopped, null, 2) + '\n', 'utf8');
  await putTasks(stopped.tasks).catch(() => {});
  const final = await state();
  console.log('\n已停止任务，当前 running =', final.tasks[0].running, '| enabled =', final.tasks[0].enabled);
  console.log('筛选已保留在配置里（下次打开开关即生效）');
}
