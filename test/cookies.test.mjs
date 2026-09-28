// cookie 仓库（src/cookies.mjs）：http 模式的登录态就存在这里，所以它的读写边界值得单独钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileCookieStore, defaultCookieFile, parseSetCookie } from '../src/cookies.mjs';

const tempFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'xianyu-cookie-')), 'cookies.json');

test('parseSetCookie 取名字与值，并带上属性', () => {
  const cookie = parseSetCookie('cookie2=abc123; Path=/; Domain=.goofish.com; Max-Age=3600; Secure; HttpOnly; SameSite=Lax');

  assert.equal(cookie.name, 'cookie2');
  assert.equal(cookie.value, 'abc123');
  assert.equal(cookie.domain, '.goofish.com');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.ok(cookie.expires > Math.floor(Date.now() / 1000), 'Max-Age 要换算成绝对过期时间');
});

test('parseSetCookie 属性缺失时回落到旧 cookie，而不是当成别的域', () => {
  const previous = { domain: '.goofish.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' };
  const cookie = parseSetCookie('_m_h5_tk=tok_123; Path=/', previous);

  // mtop 常常只回 `name=value; Path=/`，少个 Domain 不能让它变成另一个域的 cookie。
  assert.equal(cookie.domain, '.goofish.com');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
});

test('parseSetCookie 解析不出名字时返回 null', () => {
  assert.equal(parseSetCookie('=novalue; Path=/'), null);
  assert.equal(parseSetCookie(''), null);
  assert.equal(parseSetCookie(undefined), null);
});

test('FileCookieStore 存盘再读回来是同一份，且不把内部对象暴露出去', async () => {
  const file = tempFile();
  const store = new FileCookieStore({ file });

  assert.equal((await store.load()).size, 0, '文件不存在时是空集合，不是报错');

  await store.save(new Map([['unb', { name: 'unb', value: '1', domain: '.goofish.com', path: '/' }]]));
  const back = await store.load();
  assert.equal(back.get('unb').value, '1');

  back.get('unb').value = 'tampered';
  assert.equal((await store.load()).get('unb').value, '1', '每次读都应是独立副本');
});

test('FileCookieStore 遇到坏文件时抛出，而不是当成「没有登录态」', async () => {
  // 当成空集合的话，请求会以未登录的身份发出去，被报成风控或封号——比直接报错难查得多。
  const file = tempFile();
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  await assert.rejects(() => new FileCookieStore({ file }).load(), /不是合法的 cookie 文件/);
});

test('defaultCookieFile 放在状态文件旁边，缺配置也能回落', () => {
  const file = defaultCookieFile({ storage: { stateFile: path.join('/srv/app/data', 'state.json') } });
  assert.equal(file, path.join(path.resolve('/srv/app/data'), 'cookies.json'));
  assert.ok(defaultCookieFile({}).endsWith('cookies.json'));
});

test('refuse 记的是具体值，换发新值不受牵连，且跨重启仍然生效', async () => {
  // 这是「不重复一次注定失败的请求」与「永久不发某个 cookie」的分界：记名字就等于后者。
  const file = tempFile();
  const store = new FileCookieStore({ file });
  const jar = new Map([['sgcookie', { name: 'sgcookie', value: 'bad-1', domain: '.goofish.com', path: '/' }]]);
  await store.save(jar);

  assert.equal(await store.refuse(jar, 'sgcookie', 'bad-1'), true);
  assert.equal(await store.refuse(jar, 'sgcookie', 'bad-1'), false, '同一个值只记一次');

  const reloaded = new FileCookieStore({ file });
  await reloaded.load();
  assert.equal(reloaded.isRefused('sgcookie', 'bad-1'), true, '必须落盘，否则每次启动都要重新撞一次');
  assert.equal(reloaded.isRefused('sgcookie', 'bad-2'), false, '服务端换发的新值不该被牵连');
});

test('externallyChanged 只认「别人改过」：自己落的盘不算，外部改写才算', async () => {
  // 搜索器用它判断「是不是有人重新扫码登录了」，好把内存里那些续期 cookie 丢掉。
  // 认错方向的两个后果都很糟：把自己写的当成外部的 → 每轮白丢一次续期；
  // 把外部的当成自己的 → 新登录态被老 cookie 盖住，看着像重新登录没用。
  const file = tempFile();
  const store = new FileCookieStore({ file });
  const cookie = (value) => ({ name: 'unb', value, domain: '.goofish.com', path: '/' });

  assert.equal(store.externallyChanged(), false, '还没读过也没写过，不算被外部改过');

  await store.save(new Map([['unb', cookie('1')]]));
  await store.load();
  assert.equal(store.externallyChanged(), false, '自己刚写的那一版不算外部改写');

  await new Promise((resolve) => setTimeout(resolve, 10));
  writeFileSync(file, JSON.stringify({ version: 1, cookies: [cookie('2')], refused: [] }), 'utf8');
  await store.load();
  assert.equal(store.externallyChanged(), true, '别人（重新登录）写进来的必须认出来');

  await store.save(new Map([['unb', cookie('3')]]));
  await store.load();
  assert.equal(store.externallyChanged(), false, '自己再写一次后又回到「自己写的那一版」');
});


