/**
 * 已推送商品的持久化去重表 + 各任务的累计计数。单文件 JSON，写入走「临时文件 + rename」，
 * 避免进程被杀时留下半截文件。
 *
 * 累计计数放在这里是为了**跨重启延续**：去重表和命中历史都是持久的，只有计数是进程内的，
 * 一重启就出现「已推送 0 条、命中历史 164 条」这种自相矛盾的界面。
 *
 * @typedef {object} TaskTotals
 * @property {number} cycles 累计轮询次数。
 * @property {number} scanned 累计扫描条数（含各轮重复）。
 * @property {number} matched 累计命中条数（各轮新出现且通过筛选的）。
 * @property {number} notified 累计推送条数。
 *
 * @typedef {object} SeenState
 * @property {number} version 文件格式版本。
 * @property {Record<string, number>} seen itemId -> 首次见到的时间戳（epoch 毫秒）。
 * @property {Record<string, TaskTotals>} [totals] 任务名 -> 累计计数（可选，老文件没有）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const STATE_VERSION = 1;

/** @returns {TaskTotals} 一份全零计数。 */
function emptyTotals() {
  return { cycles: 0, scanned: 0, matched: 0, notified: 0 };
}

export class SeenStore {
  /**
   * @param {object} options
   * @param {string} options.file 状态文件路径。
   * @param {number} [options.limit] 最多保留多少条记录。
   * @param {number} [options.retentionDays] 超过该天数的记录会被清理；0 表示不按时间清理。
   */
  constructor({ file, limit = 20000, retentionDays = 30 }) {
    this.file = path.resolve(file);
    this.limit = limit;
    this.retentionDays = retentionDays;
    /** @type {Map<string, number>} */
    this.seen = new Map();
    /** @type {Map<string, TaskTotals>} */
    this.totals = new Map();
    this.dirty = false;
  }

  /**
   * 从磁盘加载状态；文件不存在或损坏时按空表启动并保留原文件备份。
   * @returns {SeenStore} this。
   */
  load() {
    if (!existsSync(this.file)) return this;
    try {
      /** @type {SeenState} */
      const state = JSON.parse(readFileSync(this.file, 'utf8'));
      if (state?.version !== STATE_VERSION || typeof state.seen !== 'object' || state.seen === null) {
        throw new Error(`状态文件版本不受支持：${state?.version}`);
      }
      for (const [id, timestamp] of Object.entries(state.seen)) {
        if (typeof timestamp === 'number') this.seen.set(id, timestamp);
      }
      // totals 是后加的字段，老文件没有是正常的。
      for (const [name, totals] of Object.entries(state.totals ?? {})) {
        if (totals && typeof totals === 'object') this.totals.set(name, { ...emptyTotals(), ...totals });
      }
    } catch (error) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      renameSync(this.file, backup);
      process.stderr.write(`状态文件解析失败，已备份到 ${backup}：${error.message}\n`);
    }
    return this;
  }

  /**
   * @param {string} id 商品 ID。
   * @returns {boolean} 是否已经处理过。
   */
  has(id) {
    return this.seen.has(id);
  }

  /**
   * 记录一次命中。已存在时不改变首次见到的时间。
   * @param {string} id 商品 ID。
   * @param {number} [timestamp] 记录时间，默认当前时间。
   * @returns {boolean} 是否为新增记录。
   */
  add(id, timestamp = Date.now()) {
    if (this.seen.has(id)) return false;
    this.seen.set(id, timestamp);
    this.dirty = true;
    return true;
  }

  /**
   * 按保留天数与数量上限裁剪，避免状态文件无限增长。
   * @param {number} [now] 当前时间，便于测试注入。
   * @returns {number} 被清理的条数。
   */
  prune(now = Date.now()) {
    const before = this.seen.size;
    if (this.retentionDays > 0) {
      const cutoff = now - this.retentionDays * 86400000;
      for (const [id, timestamp] of this.seen) {
        if (timestamp < cutoff) this.seen.delete(id);
      }
    }
    if (this.limit > 0 && this.seen.size > this.limit) {
      const ordered = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [id] of ordered.slice(0, this.seen.size - this.limit)) this.seen.delete(id);
    }
    const removed = before - this.seen.size;
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /**
   * @param {string} task 任务名。
   * @returns {TaskTotals} 该任务的累计计数（没有记录时返回全零副本）。
   */
  getTotals(task) {
    return { ...emptyTotals(), ...(this.totals.get(task) ?? {}) };
  }

  /**
   * 覆盖写入某个任务的累计计数。值没变时不标脏，避免每轮都重写文件。
   * @param {string} task 任务名。
   * @param {TaskTotals} totals 新的计数。
   * @returns {boolean} 是否发生了变化。
   */
  setTotals(task, totals) {
    const next = { ...emptyTotals(), ...totals };
    const current = this.totals.get(task);
    if (current && Object.keys(next).every((key) => current[key] === next[key])) return false;
    this.totals.set(task, next);
    this.dirty = true;
    return true;
  }

  /**
   * 落盘。无变更时直接返回，避免每分钟重写文件。
   * @returns {boolean} 是否真的写入。
   */
  save() {
    if (!this.dirty) return false;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = { version: STATE_VERSION, seen: Object.fromEntries(this.seen) };
    if (this.totals.size > 0) payload.totals = Object.fromEntries(this.totals);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(temp, this.file);
    this.dirty = false;
    return true;
  }

  /** @returns {number} 已记录条数。 */
  get size() {
    return this.seen.size;
  }
}
