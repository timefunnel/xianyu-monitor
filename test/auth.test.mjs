// 登录密码闸：公开到互联网时它是唯一挡住滥用的东西，所以每条都要钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthGate, clientIp, isSecureRequest, safeEqual } from '../src/auth.mjs';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 造一个可控时间的闸。 */
function makeGate(options = {}) {
  const clock = { now: 1_000_000 };
  const gate = new AuthGate({ password: 'correct-horse-battery', logger: silentLogger, now: () => clock.now, ...options });
  return { gate, clock };
}

const request = (overrides = {}) => ({
  headers: {},
  socket: { remoteAddress: '203.0.113.7' },
  ...overrides,
});

test('没设密码时视为未启用，一律放行（只允许监听本机时才这样）', () => {
  const gate = new AuthGate({ password: '' });
  assert.equal(gate.enabled, false);
  assert.equal(gate.check(request()).ok, true);
});

test('密码正确才发会话；会话 id 是随机的，且不含密码', () => {
  const { gate } = makeGate();
  const bad = gate.login(request(), 'wrong');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, '密码不正确');

  const good = gate.login(request(), 'correct-horse-battery');
  assert.equal(good.ok, true);
  assert.match(good.sessionId, /^[0-9a-f]{64}$/);
  assert.ok(!good.sessionId.includes('correct'), '会话 id 不能从密码推出来');
  // 两次登录的会话 id 必须不同（随机）
  assert.notEqual(gate.login(request(), 'correct-horse-battery').sessionId, good.sessionId);
});

test('会话校验：带上有效会话才通过，伪造或过期的都不行', () => {
  const { gate, clock } = makeGate({ sessionTtlMs: 1000 });
  const { sessionId } = gate.login(request(), 'correct-horse-battery');

  assert.equal(gate.check(request({ headers: { cookie: `xy_session=${sessionId}` } })).ok, true);
  assert.equal(gate.check(request({ headers: { cookie: 'xy_session=deadbeef' } })).ok, false, '伪造的会话 id 必须被拒');
  assert.equal(gate.check(request()).ok, false, '没有 Cookie 就是没登录');

  clock.now += 1001;
  assert.equal(gate.check(request({ headers: { cookie: `xy_session=${sessionId}` } })).ok, false, '过期会话要失效');
});

test('会话是滑动续期的：一直在用就不会过期', () => {
  const { gate, clock } = makeGate({ sessionTtlMs: 1000 });
  const { sessionId } = gate.login(request(), 'correct-horse-battery');
  const cookie = { headers: { cookie: `xy_session=${sessionId}` } };
  for (let i = 0; i < 5; i += 1) {
    clock.now += 900;
    assert.equal(gate.check(request(cookie)).ok, true, `第 ${i + 1} 次续期失败`);
  }
});

test('失败限流：达到阈值就锁定，锁定期内正确密码也不放行', () => {
  const { gate, clock } = makeGate({ maxFailures: 3, lockoutMs: 60_000 });
  for (let i = 0; i < 3; i += 1) gate.login(request(), 'wrong');
  assert.ok(gate.lockedFor('203.0.113.7') > 0, '达到阈值后应锁定');

  const blocked = gate.login(request(), 'correct-horse-battery');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds > 0, '要给出重试时间');

  clock.now += 60_001;
  assert.equal(gate.lockedFor('203.0.113.7'), 0, '锁定期过后自动解除');
  assert.equal(gate.login(request(), 'correct-horse-battery').ok, true);
});

test('锁定时长随失败次数增长，但有上限（不能把某个 IP 永久关在门外）', () => {
  const { gate, clock } = makeGate({ maxFailures: 2, lockoutMs: 10_000 });
  for (let i = 0; i < 2; i += 1) gate.login(request(), 'wrong');
  const first = gate.lockedFor('203.0.113.7');

  // 解锁后再错两次，锁定应该更久
  clock.now += first + 1;
  gate.login(request(), 'wrong');
  gate.login(request(), 'wrong');
  const second = gate.lockedFor('203.0.113.7');
  assert.ok(second > first, `第二次锁定应该更久：${first} → ${second}`);

  // 但不会超过 1 小时
  for (let round = 0; round < 20; round += 1) {
    clock.now += gate.lockedFor('203.0.113.7') + 1;
    gate.login(request(), 'wrong');
    gate.login(request(), 'wrong');
  }
  assert.ok(gate.lockedFor('203.0.113.7') <= 60 * 60 * 1000, '锁定上限是 1 小时');
});

test('限流按来源 IP 分开：一个 IP 被锁不影响另一个', () => {
  const { gate } = makeGate({ maxFailures: 2, lockoutMs: 60_000 });
  const attacker = request({ socket: { remoteAddress: '198.51.100.9' } });
  for (let i = 0; i < 3; i += 1) gate.login(attacker, 'wrong');
  assert.ok(gate.lockedFor('198.51.100.9') > 0);
  assert.equal(gate.login(request(), 'correct-horse-battery').ok, true, '别的 IP 不该被牵连');
});

test('登录成功会清掉该 IP 的失败计数', () => {
  const { gate } = makeGate({ maxFailures: 5 });
  gate.login(request(), 'wrong');
  gate.login(request(), 'wrong');
  assert.equal(gate.login(request(), 'correct-horse-battery').ok, true);
  // 计数清零后，再错 4 次也不该锁定
  for (let i = 0; i < 4; i += 1) gate.login(request(), 'wrong');
  assert.equal(gate.lockedFor('203.0.113.7'), 0);
});

test('退出登录只作废当前会话，其它设备不受影响', () => {
  const { gate } = makeGate();
  const a = gate.login(request(), 'correct-horse-battery').sessionId;
  const b = gate.login(request(), 'correct-horse-battery').sessionId;
  gate.logout(a);
  assert.equal(gate.check(request({ headers: { cookie: `xy_session=${a}` } })).ok, false);
  assert.equal(gate.check(request({ headers: { cookie: `xy_session=${b}` } })).ok, true);
});

test('Cookie：HttpOnly + SameSite，https 时加 Secure，退出时 Max-Age=0', () => {
  const { gate } = makeGate();
  const plain = gate.cookieFor('abc', { secure: false });
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.ok(!plain.includes('Secure'), 'http 下不能加 Secure，否则本机调试会登录不上');

  const secure = gate.cookieFor('abc', { secure: true });
  assert.match(secure, /Secure/);
  assert.match(AuthGate.clearCookie(), /Max-Age=0/);
});

test('safeEqual：等长/不等长都不抛，且只有完全相同才为真', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, '长度不同也要安全返回 false');
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual('密码', '密码'), true, '非 ASCII 也要能比');
});

test('clientIp：默认不信 XFF，开了 trustProxy 才取最后一跳', () => {
  const withXff = request({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } });
  assert.equal(clientIp(withXff), '203.0.113.7', '默认必须忽略可伪造的 XFF');
  assert.equal(clientIp(withXff, { trustProxy: true }), '10.0.0.1', '信任反代时取最后一跳（反代自己加的那个）');
});

test('isSecureRequest：trustProxy 时看 X-Forwarded-Proto', () => {
  assert.equal(isSecureRequest(request()), false);
  assert.equal(isSecureRequest(request({ headers: { 'x-forwarded-proto': 'https' } }), { trustProxy: true }), true);
  assert.equal(isSecureRequest(request({ headers: { 'x-forwarded-proto': 'http' } }), { trustProxy: true }), false);
  assert.equal(
    isSecureRequest(request({ headers: { 'x-forwarded-proto': 'https' } })),
    false,
    '不信任反代时不能凭这个头就认为走了 https',
  );
});
