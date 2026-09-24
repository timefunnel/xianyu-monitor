// `spawnDetached`：一个只在服务器上才会踩到的崩溃。
//
// 服务器（或 slim 容器）里没有 xdg-open，`spawn` 会因为 ENOENT 失败。关键在于失败方式：
// 它不是同步抛错，而是异步 emit('error')——没有监听器时 Node 会把它当未捕获异常，
// **直接把整个进程干掉**。所以「用 try/catch 包住 spawn」是无效的防护。
//
// 这个用例的价值就在"进程还活着"：如果真的没挂监听器，测试进程会在 200ms 处消失。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnDetached } from '../src/server.mjs';

test('子进程命令不存在时，不会把当前进程带走', async () => {
  const child = spawnDetached('definitely-not-a-command-xyz', ['x']);
  assert.ok(child, '同步就应该拿到 ChildProcess 句柄');

  // 给它一拍让 ENOENT 的 error 事件派发出去。没挂监听器的话，这行之后就没有任何代码会执行。
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(child.exitCode === null || typeof child.exitCode === 'number', true, '能走到这里 = 没被未捕获异常干掉');
});

test('正常命令也能用：句柄可直接 unref，不阻塞事件循环', async () => {
  const command = process.platform === 'win32' ? 'cmd' : 'true';
  const args = process.platform === 'win32' ? ['/c', 'exit'] : [];
  const child = spawnDetached(command, args);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(child.pid !== undefined || child.exitCode !== null, '拿到了句柄或已经退出');
});
