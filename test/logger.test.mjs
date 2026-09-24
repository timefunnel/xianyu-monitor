import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.mjs';

test('日志按级别过滤并带任务标签', () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const logger = createLogger({ level: 'warn' });
    logger.info('被过滤');
    logger.warn('保留下来', 'task-a');
  } finally {
    process.stdout.write = original;
  }
  const output = written.join('');
  assert.ok(!output.includes('被过滤'));
  assert.ok(output.includes('[task-a]'));
  assert.ok(output.includes('WARN'));
});

test('附加对象被序列化到同一行', () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    createLogger({ level: 'debug' }).debug('详情', 'task-b', { id: 1 });
  } finally {
    process.stdout.write = original;
  }
  assert.ok(written.join('').includes('{"id":1}'));
});
