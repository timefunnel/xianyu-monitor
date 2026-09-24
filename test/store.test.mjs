import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SeenStore } from '../src/store.mjs';

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-')), 'state.json');

test('未落盘前不产生文件，保存后可重新加载', () => {
  const file = tempFile();
  const store = new SeenStore({ file }).load();
  store.add('1001');
  assert.equal(store.save(), true);
  assert.equal(store.save(), false, '无变更时不重复写盘');

  const reloaded = new SeenStore({ file }).load();
  assert.equal(reloaded.has('1001'), true);
  assert.equal(reloaded.size, 1);
});

test('重复添加返回 false 且保留首次时间', () => {
  const store = new SeenStore({ file: tempFile() }).load();
  assert.equal(store.add('1001', 111), true);
  assert.equal(store.add('1001', 999), false);
  assert.equal(store.seen.get('1001'), 111);
});

test('累计计数跨重启延续（去重表和命中历史本来就是持久的）', () => {
  const file = tempFile();
  const store = new SeenStore({ file }).load();
  store.add('1001');
  store.setTotals('t', { cycles: 12, scanned: 360, matched: 9, notified: 7 });
  store.save();

  // 模拟进程重启
  const reloaded = new SeenStore({ file }).load();
  assert.deepEqual(reloaded.getTotals('t'), { cycles: 12, scanned: 360, matched: 9, notified: 7 });
});

test('没有 totals 的老状态文件照常加载（加字段不改版本）', () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ version: 1, seen: { 1001: 111 } }), 'utf8');
  const store = new SeenStore({ file }).load();
  assert.equal(store.has('1001'), true, '去重表不能因为升级而丢失');
  assert.deepEqual(store.getTotals('t'), { cycles: 0, scanned: 0, matched: 0, notified: 0 });
});

test('累计计数没变化时不标脏，缺字段按 0 补齐', () => {
  const store = new SeenStore({ file: tempFile() }).load();
  assert.equal(store.setTotals('t', { cycles: 1 }), true);
  assert.deepEqual(store.getTotals('t'), { cycles: 1, scanned: 0, matched: 0, notified: 0 });
  assert.equal(store.save(), true);

  assert.equal(store.setTotals('t', { cycles: 1 }), false, '同一份数值不该触发写盘');
  assert.equal(store.setTotals('t', { cycles: 2 }), true);
});

test('去重表按保留天数清理过期记录', () => {
  const store = new SeenStore({ file: tempFile(), retentionDays: 7 }).load();
  const now = 1_700_000_000_000;
  store.add('fresh', now - 86400000);
  store.add('stale', now - 8 * 86400000);
  assert.equal(store.prune(now), 1);
  assert.equal(store.has('fresh'), true);
  assert.equal(store.has('stale'), false);
});

test('超过数量上限时淘汰最早的记录', () => {
  const store = new SeenStore({ file: tempFile(), limit: 2, retentionDays: 0 }).load();
  store.add('a', 1);
  store.add('b', 2);
  store.add('c', 3);
  store.prune();
  assert.equal(store.size, 2);
  assert.equal(store.has('a'), false);
  assert.equal(store.has('c'), true);
});

test('状态文件损坏时备份原文件并从空表启动', () => {
  const file = tempFile();
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const store = new SeenStore({ file }).load();
  assert.equal(store.size, 0);
  assert.ok(readdirSync(path.dirname(file)).some((name) => name.includes('corrupt-')), '应留下备份文件');
});

test('版本不匹配时同样走备份路径', () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ version: 99, seen: { a: 1 } }), 'utf8');
  const store = new SeenStore({ file }).load();
  assert.equal(store.size, 0);
  const backups = readdirSync(path.dirname(file)).filter((name) => name.includes('corrupt-'));
  assert.equal(backups.length, 1);
  assert.match(readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'), /version/);
});
