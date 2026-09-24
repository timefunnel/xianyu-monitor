// 一次性清理：把验收脚本建的 ui-test-* 测试任务留在命中历史与去重表里的垃圾记录删掉。
//
// 那些任务是 check-console-tasks.mjs 建的。它们现在不会再推送到手机（脚本会取消勾选「推送」），
// 但仍会往共享的命中历史里记一批无关商品（¥88000 老纸币、自行车之类），让历史变得没法看。
//
// 运行中的控制台内存里也持有这份历史，直接改文件会被它下次推送时覆写，所以这里先把监控停掉、
// 改完再启动（--no-restart 可跳过）。
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';

const TEST_PREFIX = 'ui-test-';
const DRY_RUN = process.argv.includes('--dry-run');
const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:7788';

// 额外前缀：临时探测脚本用的任务名也可以一并清掉，例如 --prefix=即时生效探测
const extraPrefixes = process.argv
  .filter((arg) => arg.startsWith('--prefix='))
  .map((arg) => arg.slice('--prefix='.length))
  .filter(Boolean);
const prefixes = [TEST_PREFIX, ...extraPrefixes];

const historyPath = 'data/hits.json';
const statePath = 'data/state.json';

/**
 * 检查控制台是否在跑。它内存里持有整份命中历史，下次推送会把文件整份重写，
 * 所以脚本运行时必须先停掉进程（服务启停已不归页面管，这里也没法让它停下来）。
 * @returns {Promise<boolean>} 是否在跑。
 */
async function consoleIsUp() {
  try {
    const response = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!DRY_RUN && !process.argv.includes('--force') && (await consoleIsUp())) {
  console.log('控制台正在运行，它会用内存里的旧数据覆盖文件，改完等于没改。');
  console.log('请先停掉进程（Ctrl+C，或 docker compose stop），再运行本脚本；');
  console.log('确实要带着进程一起改，加 --force。');
  process.exit(1);
}

const hits = JSON.parse(readFileSync(historyPath, 'utf8'));
const state = JSON.parse(readFileSync(statePath, 'utf8'));

const isTestTask = (name) => typeof name === 'string' && prefixes.some((prefix) => name.startsWith(prefix));
const junk = hits.filter((hit) => isTestTask(hit.task));
const kept = hits.filter((hit) => !isTestTask(hit.task));
const junkIds = new Set(junk.map((hit) => hit.id));

// 去重表里只删「确实由测试任务产生的」那些 id，避免误删真实任务的记录。
const seenJunk = Object.keys(state.seen ?? {}).filter((id) => junkIds.has(id));

console.log(`命中历史：${hits.length} 条 → 保留 ${kept.length} 条（删除测试任务 ${junk.length} 条）`);
console.log(`去重表  ：${Object.keys(state.seen ?? {}).length} 条 → 删除 ${seenJunk.length} 条`);
const byTask = {};
for (const hit of junk) byTask[hit.task] = (byTask[hit.task] ?? 0) + 1;
if (junk.length > 0) console.log('  涉及任务：', JSON.stringify(byTask));

if (DRY_RUN) {
  console.log('\n（--dry-run，未写入）');
  process.exit(0);
}

if (junk.length > 0 || seenJunk.length > 0) {
  const stamp = Date.now();
  copyFileSync(historyPath, `${historyPath}.bak-${stamp}`);
  copyFileSync(statePath, `${statePath}.bak-${stamp}`);

  writeFileSync(historyPath, `${JSON.stringify(kept)}\n`, 'utf8');
  for (const id of seenJunk) delete state.seen[id];
  // 测试任务的累计计数也一并删掉
  for (const task of Object.keys(state.totals ?? {})) {
    if (isTestTask(task)) delete state.totals[task];
  }
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, 'utf8');

  console.log(`\n已清理，备份在 *.bak-${stamp}`);
} else {
  console.log('\n没有需要清理的记录');
}
