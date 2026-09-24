/**
 * 登录密码闸：控制台要放到公网时，这一层是唯一挡住滥用的东西。
 *
 * 设计取舍（都是"公开到互联网"这个前提下才成立的）：
 *
 *  - **会话用随机 id，不把密码本身放进 Cookie**。旧实现是把 token 原样写进 `xy_token` Cookie，
 *    等于每台设备上都存了一份明文口令；现在 Cookie 里只有一个不可反推的随机串。
 *  - **比较用 timingSafeEqual**。`===` 会在第一个不同的字符处提前返回，理论上可以逐字节试探。
 *    这里先各自 SHA-256 再比，长度恒定。
 *  - **失败限流按来源 IP**。没有它，公网上的爆破只是时间问题。锁定是"失败次数越多越久"，
 *    而不是简单封禁——正常用户打错几次不至于被锁很久。
 *  - **密码只在 POST body 里**，不接受 `?token=` 这类查询串（会进访问日志与 Referer）。
 *  - 会话只存在内存里：进程重启即失效。对单实例部署这是可接受的取舍，也省掉一份要落盘的凭据。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 会话默认有效期：30 天。 */
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** 连续失败多少次开始锁定。 */
const DEFAULT_MAX_FAILURES = 5;
/** 首次锁定时长；之后按失败次数线性增长，上限 1 小时。 */
const DEFAULT_LOCKOUT_MS = 5 * 60 * 1000;
const MAX_LOCKOUT_MS = 60 * 60 * 1000;
/** 记录失败状态的 IP 上限，防止被大量伪造来源撑爆内存。 */
const MAX_TRACKED_IPS = 5000;

/** 恒定时间比较两个字符串（长度不同也安全：先哈希成等长摘要）。 */
export function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

/** 取客户端 IP：信任反代时用 X-Forwarded-For 的最后一跳，否则用 socket 地址。 */
export function clientIp(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
      const parts = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return request.socket?.remoteAddress ?? 'unknown';
}

/** 请求是不是走的 https（决定 Cookie 要不要加 Secure）。 */
export function isSecureRequest(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const proto = request.headers['x-forwarded-proto'];
    if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https';
  }
  return Boolean(request.socket?.encrypted);
}

export class AuthGate {
  /**
   * @param {{password?: string, logger?: any, sessionTtlMs?: number, maxFailures?: number, lockoutMs?: number, now?: () => number}} [options] 配置与依赖注入（`now` 供测试）。
   */
  constructor({ password = '', logger, sessionTtlMs = DEFAULT_SESSION_TTL_MS, maxFailures = DEFAULT_MAX_FAILURES, lockoutMs = DEFAULT_LOCKOUT_MS, now = Date.now } = {}) {
    this.password = String(password ?? '');
    this.logger = logger;
    this.sessionTtlMs = sessionTtlMs;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.now = now;
    /** @type {Map<string, number>} 会话 id → 过期时间。 */
    this.sessions = new Map();
    /** @type {Map<string, {failures: number, lockedUntil: number}>} IP → 失败状态。 */
    this.attempts = new Map();
  }

  /** 没设密码就是"不启用"——只有监听在本机时才允许这样。 */
  get enabled() {
    return this.password !== '';
  }

  /** 某个 IP 现在是否处于锁定中。 */
  lockedFor(ip) {
    const state = this.attempts.get(ip);
    if (!state) return 0;
    const remaining = state.lockedUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  #rememberFailure(ip) {
    const state = this.attempts.get(ip) ?? { failures: 0, lockedUntil: 0 };
    state.failures += 1;
    if (state.failures >= this.maxFailures) {
      // 失败越多锁越久，但封顶：否则一次爆破能让这个 IP 永久进不来（也可能是自己被 NAT 挡在外面）。
      const extra = state.failures - this.maxFailures;
      state.lockedUntil = this.now() + Math.min(this.lockoutMs * (extra + 1), MAX_LOCKOUT_MS);
    }
    this.attempts.set(ip, state);
    // 简单淘汰：超量时清掉最早的一批，避免内存被撑爆。
    if (this.attempts.size > MAX_TRACKED_IPS) {
      const excess = this.attempts.size - MAX_TRACKED_IPS;
      let dropped = 0;
      for (const key of this.attempts.keys()) {
        this.attempts.delete(key);
        if (++dropped >= excess) break;
      }
    }
  }

  #forget(ip) {
    this.attempts.delete(ip);
  }

  /** 清掉过期会话。每次校验顺带做一次，不需要定时器。 */
  #sweep() {
    const now = this.now();
    for (const [id, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(id);
    }
  }

  /**
   * 校验请求是否已登录。
   * @param {any} request Node 请求对象。
   * @returns {{ok: boolean, sessionId?: string}} 结果。
   */
  check(request) {
    if (!this.enabled) return { ok: true };
    this.#sweep();
    const cookie = request.headers.cookie ?? '';
    const match = /(?:^|;\s*)xy_session=([^;]+)/.exec(cookie);
    if (!match) return { ok: false };
    const id = decodeURIComponent(match[1]);
    const expiresAt = this.sessions.get(id);
    if (!expiresAt || expiresAt <= this.now()) {
      this.sessions.delete(id);
      return { ok: false };
    }
    // 滑动续期：一直在用就别让它过期。
    this.sessions.set(id, this.now() + this.sessionTtlMs);
    return { ok: true, sessionId: id };
  }

  /**
   * 处理一次登录尝试。
   * @param {any} request Node 请求对象。
   * @param {string} submitted 提交的密码。
   * @param {{trustProxy?: boolean}} [options] 反代设置。
   * @returns {{ok: boolean, sessionId?: string, retryAfterSeconds?: number, error?: string}} 结果。
   */
  login(request, submitted, { trustProxy = false } = {}) {
    if (!this.enabled) return { ok: true };
    const ip = clientIp(request, { trustProxy });
    const locked = this.lockedFor(ip);
    if (locked > 0) {
      return { ok: false, retryAfterSeconds: Math.ceil(locked / 1000), error: '尝试次数过多，请稍后再试' };
    }
    if (typeof submitted !== 'string' || !safeEqual(submitted, this.password)) {
      this.#rememberFailure(ip);
      const nowLocked = this.lockedFor(ip);
      this.logger?.warn?.(`登录失败（来源 ${ip}）${nowLocked > 0 ? `，已锁定 ${Math.ceil(nowLocked / 1000)} 秒` : ''}`, 'web');
      return {
        ok: false,
        ...(nowLocked > 0 ? { retryAfterSeconds: Math.ceil(nowLocked / 1000) } : {}),
        error: '密码不正确',
      };
    }
    this.#forget(ip);
    const sessionId = randomBytes(32).toString('hex');
    this.sessions.set(sessionId, this.now() + this.sessionTtlMs);
    return { ok: true, sessionId };
  }

  /** 退出登录：只删这一个会话。 */
  logout(sessionId) {
    if (sessionId) this.sessions.delete(sessionId);
  }

  /**
   * 生成会话 Cookie 的 Set-Cookie 值。
   * @param {string} sessionId 会话 id。
   * @param {{secure?: boolean, maxAgeSeconds?: number}} [options] Cookie 选项。
   * @returns {string} Set-Cookie 头。
   */
  cookieFor(sessionId, { secure = false, maxAgeSeconds = Math.floor(this.sessionTtlMs / 1000) } = {}) {
    const parts = [
      `xy_session=${encodeURIComponent(sessionId)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  /** 清掉会话 Cookie 的 Set-Cookie 值（退出登录用）。 */
  static clearCookie() {
    return 'xy_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }
}
