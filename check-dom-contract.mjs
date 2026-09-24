// 静态核对：前端 JS 引用的每个元素 id 都必须在 HTML 里存在。
//
// 重构布局最容易犯的错就是改掉/漏掉某个 id，而这类错误在页面上未必立刻可见
// （事件绑不上只是「点了没反应」）。这个脚本不需要浏览器，几毫秒就能跑完。
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'src/web/index.html';
const html = readFileSync(file, 'utf8');

/** 收集 HTML 里定义的所有 id。 */
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));

/** 收集 JS 里引用的 id：$('x')、getElementById('x')、querySelector('#x')。 */
const referenced = new Map();
const patterns = [
  /\$\('([A-Za-z0-9_-]+)'\)/g,
  /getElementById\('([A-Za-z0-9_-]+)'\)/g,
  /querySelector\('#([A-Za-z0-9_-]+)'\)/g,
];
for (const pattern of patterns) {
  for (const match of html.matchAll(pattern)) {
    if (!referenced.has(match[1])) referenced.set(match[1], 0);
    referenced.set(match[1], referenced.get(match[1]) + 1);
  }
}

const missing = [...referenced.entries()].filter(([id]) => !defined.has(id)).sort();
const unused = [...defined].filter((id) => !referenced.has(id));

console.log(`${file}`);
console.log(`  HTML 定义 id: ${defined.size} 个 | JS 引用 id: ${referenced.size} 个`);
if (missing.length > 0) {
  console.log(`\n  ✖ JS 引用了但 HTML 里不存在的 id（${missing.length} 个）：`);
  for (const [id, count] of missing) console.log(`      ${id}  （被引用 ${count} 次）`);
} else {
  console.log('  ✔ JS 引用的 id 全部存在');
}
// 只在 HTML 里、JS 没引用的 id 通常没问题（纯结构或样式钩子），仅作提示。
if (unused.length > 0) console.log(`\n  提示：仅 HTML 使用、JS 未引用的 id：${unused.join(', ')}`);

process.exitCode = missing.length > 0 ? 1 : 0;
