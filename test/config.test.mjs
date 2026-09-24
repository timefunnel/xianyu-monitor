import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnv, validateConfig, withDefaults } from '../src/config.mjs';

const validConfig = () => ({
  notify: { channels: [{ type: 'telegram', botToken: 'x', chatId: 'y' }] },
  tasks: [{ name: 't', keyword: 'MacBook', intervalSeconds: 10, filters: {} }],
});

test('resolveEnv 递归展开字符串并记录缺失变量', () => {
  process.env.XIANYU_TEST_TOKEN = 'secret';
  const missing = [];
  const resolved = resolveEnv({ a: '${XIANYU_TEST_TOKEN}', b: ['${XIANYU_TEST_TOKEN}', '${XIANYU_TEST_ABSENT}'], c: 1 }, missing);
  assert.equal(resolved.a, 'secret');
  assert.deepEqual(resolved.b, ['secret', '${XIANYU_TEST_ABSENT}']);
  assert.deepEqual(missing, ['XIANYU_TEST_ABSENT']);
  assert.equal(resolved.c, 1);
  delete process.env.XIANYU_TEST_TOKEN;
});

test('合法配置没有问题', () => {
  assert.deepEqual(validateConfig(validConfig()), []);
});

test('缺少 tasks 与 notify 会一次列出全部问题', () => {
  const problems = validateConfig({});
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => problem.includes('tasks')));
  assert.ok(problems.some((problem) => problem.includes('notify.channels')));
});

test('任务字段错误逐条指出', () => {
  const config = validConfig();
  config.tasks = [{ name: '', keyword: '', intervalSeconds: 0, jitterSeconds: -1, filters: { minPrice: '10' } }];
  const problems = validateConfig(config);
  assert.ok(problems.some((problem) => problem.includes('name 必填')));
  assert.ok(problems.some((problem) => problem.includes('keyword 必填')));
  assert.ok(problems.some((problem) => problem.includes('intervalSeconds')));
  assert.ok(problems.some((problem) => problem.includes('jitterSeconds')));
  assert.ok(problems.some((problem) => problem.includes('minPrice 必须是数字')));
});

test('minPrice 大于 maxPrice 被拒绝', () => {
  const config = validConfig();
  config.tasks[0].filters = { minPrice: 100, maxPrice: 50 };
  assert.ok(validateConfig(config).some((problem) => problem.includes('不能大于')));
});

test('未展开的环境变量占位符会被当作配置错误', () => {
  const config = validConfig();
  config.notify.channels[0].botToken = '${XIANYU_TEST_ABSENT}';
  assert.ok(validateConfig(config).some((problem) => problem.includes('XIANYU_TEST_ABSENT')));
});

test('jumpLink 只接受 web / app', () => {
  const config = validConfig();
  config.tasks[0].jumpLink = 'app-deeplink';
  assert.ok(validateConfig(config).some((problem) => problem.includes('jumpLink 只能是')));
  config.tasks[0].jumpLink = 'app';
  assert.deepEqual(validateConfig(config), []);
});

test('非法正则被拒绝', () => {
  const config = validConfig();
  config.tasks[0].filters = { requirePattern: '(144' };
  assert.ok(validateConfig(config).some((problem) => problem.includes('不是合法正则')));
});

test('cityAnyOf 必须是数组', () => {
  const config = validConfig();
  config.tasks[0].filters = { cityAnyOf: '上海' };
  assert.ok(validateConfig(config).some((problem) => problem.includes('cityAnyOf 必须是字符串数组')));
});

test('onUnknownField 只接受 pass / reject', () => {
  const config = validConfig();
  config.monitor = { onUnknownField: 'maybe' };
  assert.ok(validateConfig(config).some((problem) => problem.includes('onUnknownField')));
});

test('withDefaults 补齐缺省值且不覆盖显式配置', () => {
  const resolved = withDefaults({ ...validConfig(), monitor: { heartbeatHours: 1 } });
  assert.equal(resolved.monitor.heartbeatHours, 1);
  assert.equal(resolved.monitor.onUnknownField, 'pass');
  assert.equal(resolved.monitor.failureAlertThreshold, 3);
  assert.equal(resolved.notify.maxPerCycle, 8);
  assert.equal(resolved.browser.headless, false, '闲鱼会识别无头浏览器，默认必须有头');
  assert.equal(resolved.linkTemplate, 'https://www.goofish.com/item?id={id}');
  assert.equal(resolved.tasks[0].enabled, true, '未写 enabled 视为启用');
  assert.equal(resolved.tasks[0].scrollRounds, 0);
  assert.deepEqual(resolved.tasks[0].filters.excludeKeywords, []);
});
