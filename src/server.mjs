/**
 * Web 控制台：用 Node 内置 http 提供状态查询、启停控制、实时日志（SSE）和配置编辑。
 *
 * 不引入任何依赖：静态页面是单个 HTML 文件，数据接口就是几段 JSON。默认只监听
 * 127.0.0.1；要放到公网（或 NAS 上给其它设备访问）**必须设置 `web.password`**——
 * 这个控制台能启停抓取、改配置、看推送历史，等同于账号的操作面板。
 *
 * 鉴权见 auth.mjs：独立登录页 + 随机会话 Cookie + 按 IP 的失败限流。密码只在 POST body 里传，
 * 不接受查询串（那会进访问日志与 Referer）。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthGate, clientIp, isSecureRequest } from './auth.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(here, 'web', 'index.html');
const LOGIN_PATH = path.join(here, 'web', 'login.html');

/** 请求体上限：配置 JSON 也就几十 KB。 */
const MAX_BODY_BYTES = 1024 * 1024;

/** SSE 心跳间隔，防止中间的代理掐掉长时间没有数据的连接。 */
const SSE_HEARTBEAT_MS = 20000;

/**
 * 启动一个分离的子进程，并且**保证失败不会带走自己**。
 *
 * `spawn` 对「命令不存在」（ENOENT）不是同步抛错，而是异步 `emit('error')`；没有监听器时
 * Node 会把它当成未捕获异常，直接把整个进程干掉。服务器上（slim 镜像没装 `xdg-utils`）
 * 正好命中这个分支——只是想自动开个页面，却把控制台带崩了。
 *
 * @param {string} command 可执行文件。
 * @param {string[]} args 参数。
 * @returns {import('node:child_process').ChildProcess} 子进程（可能已经出错，但不影响本进程）。
 */
export function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
}

/**
 * 打开系统默认浏览器。失败不影响服务本身——服务器上没有图形界面时这一定失败。
 * @param {string} url 要打开的地址。
 */
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawnDetached(command, args);
  } catch {
    // 本地没有桌面环境时失败是预期行为。
  }
}

/** 读取并解析表单请求体（登录页用 `application/x-www-form-urlencoded`）。 */
async function readFormBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return new URLSearchParams();
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** 读取并解析 JSON 请求体。 */
async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 统一的 JSON 响应。 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

/**
 * 启动 Web 控制台。
 * @param {object} options
 * @param {import('./supervisor.mjs').Supervisor} options.supervisor 运行时。
 * @param {number} [options.port] 监听端口，0 表示由系统分配。
 * @param {string} [options.host] 监听地址。
 * @param {string} [options.password] 访问密码；**非本机监听时必须设置**。
 * @param {boolean} [options.trustProxy] 是否信任 `X-Forwarded-For` / `X-Forwarded-Proto`
 *   （放在反向代理后面时要开，否则限流会把所有访客算成同一个 IP）。
 * @param {any} options.logger 日志器。
 * @param {boolean} [options.openBrowser] 监听成功后是否自动打开浏览器。
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>} 服务句柄。
 */
export async function startWebConsole({
  supervisor,
  port = 7788,
  host = '127.0.0.1',
  password = '',
  trustProxy = false,
  logger,
  openBrowser: shouldOpen = false,
}) {
  const gate = new AuthGate({ password, logger });
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  // 配置校验里已经拦了一道，这里再拦一次：直接调这个函数的人也该被拦住。
  if (!loopback && !gate.enabled) {
    throw new Error('监听非本机地址时必须设置 web.password，否则同网段（或公网）任何人都能启停抓取、改配置。');
  }
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();

  const unsubscribe = supervisor.subscribe((event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      try {
        stream.write(payload);
      } catch {
        streams.delete(stream);
      }
    }
  });

  /** 路由表：键是 `方法 路径`。 */
  const routes = {
    'GET /api/state': () => ({ body: supervisor.snapshot() }),
    'GET /api/config': async () => {
      const text = await readFile(supervisor.configPath, 'utf8');
      return { body: { config: JSON.parse(text), path: supervisor.configPath } };
    },
    'PUT /api/config': async (request) => {
      const { config } = await readJsonBody(request);
      if (!config || typeof config !== 'object') return { status: 400, body: { ok: false, problems: ['config 必须是对象'] } };
      return { body: await supervisor.saveConfig(config) };
    },
    'PUT /api/tasks': async (request) => {
      const { tasks } = await readJsonBody(request);
      if (!Array.isArray(tasks)) return { status: 400, body: { ok: false, problems: ['tasks 必须是数组'] } };
      return { body: await supervisor.saveTasks(tasks) };
    },
    // 通知渠道走独立路由而不是整份配置覆盖：界面只改一个段，别处的改动不会被回滚。
    'PUT /api/notify': async (request) => {
      const { channels, enabled } = await readJsonBody(request);
      if (channels !== undefined && !Array.isArray(channels)) {
        return { status: 400, body: { ok: false, problems: ['channels 必须是数组'] } };
      }
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        return { status: 400, body: { ok: false, problems: ['enabled 必须是布尔值'] } };
      }
      return { body: await supervisor.saveNotify({ channels, enabled }) };
    },
    'POST /api/toggle-task': async (request) => {
      const { name, enabled } = await readJsonBody(request);
      if (typeof name !== 'string' || name === '') return { status: 400, body: { ok: false, error: 'name 必填' } };
      if (typeof enabled !== 'boolean') return { status: 400, body: { ok: false, error: 'enabled 必须是布尔值' } };
      return { body: await supervisor.setTaskEnabled(name, enabled) };
    },
    'POST /api/toggle-notify': async (request) => {
      const { name, enabled } = await readJsonBody(request);
      if (typeof enabled !== 'boolean') return { status: 400, body: { ok: false, error: 'enabled 必须是布尔值' } };
      if (name !== undefined && typeof name !== 'string') {
        return { status: 400, body: { ok: false, error: 'name 必须是字符串' } };
      }
      return { body: await supervisor.setNotify({ name, enabled }) };
    },
    // 服务生命周期不在这里控制：监控随进程启动、随进程退出。
    // 页面能打开就说明服务在跑，所以没有 start / stop / restart 这类接口。
    'POST /api/check': () => supervisor.check(),
    // 传 channel 就只测那一条（可以是界面上还没保存的配置），不传则测配置里所有渠道。
    'POST /api/test-notify': async (request) => {
      const { channel } = await readJsonBody(request);
      if (channel !== undefined && (typeof channel !== 'object' || channel === null)) {
        return { status: 400, body: { ok: false, error: 'channel 必须是对象' } };
      }
      return { body: await supervisor.testNotify(channel) };
    },
    // 手动重推一条命中记录：翻历史时看到还不错的，不必再去手机通知里翻。
    'POST /api/repush': async (request) => {
      const { id } = await readJsonBody(request);
      if (typeof id !== 'string' || id === '') return { status: 400, body: { ok: false, error: 'id 必填' } };
      return { body: await supervisor.repushHit(id) };
    },
    'POST /api/login': () => supervisor.loginWithQr(),
    // 关掉登录弹层时调它：中止后台轮询，而不是让它干等到超时。
    'POST /api/login-cancel': () => supervisor.cancelLogin(),
  };

  /** 渲染登录页。`error` 为空时不显示错误块。 */
  const sendLoginPage = async (response, status = 200, error = '') => {
    let html;
    try {
      html = await readFile(LOGIN_PATH, 'utf8');
    } catch {
      html = '<!doctype html><meta charset="utf-8"><title>登录</title><p>登录页缺失，请检查安装。</p>';
    }
    const block = error ? `<p class="error">${error}</p>` : '';
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(html.replace('{{ERROR}}', block));
  };

  /** 处理登录提交。密码只从 body 取，不接受查询串。 */
  const handleLogin = async (request, response) => {
    let submitted = '';
    try {
      submitted = (await readFormBody(request)).get('password') ?? '';
    } catch {
      await sendLoginPage(response, 400, '请求格式不正确');
      return;
    }
    const result = gate.login(request, submitted, { trustProxy });
    if (!result.ok) {
      if (result.retryAfterSeconds) response.setHeader('retry-after', String(result.retryAfterSeconds));
      await sendLoginPage(response, result.retryAfterSeconds ? 429 : 401, result.error);
      return;
    }
    const secure = isSecureRequest(request, { trustProxy });
    response.writeHead(302, { location: '/', 'set-cookie': gate.cookieFor(result.sessionId, { secure }), 'cache-control': 'no-store' });
    response.end();
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    // 登录页与登录提交必须在鉴权之前。
    if (url.pathname === '/login') {
      if (request.method === 'POST') {
        await handleLogin(request, response);
        return;
      }
      await sendLoginPage(response, 200);
      return;
    }
    if (url.pathname === '/logout' && request.method === 'POST') {
      gate.logout(gate.check(request).sessionId);
      response.writeHead(302, { location: '/login', 'set-cookie': AuthGate.clearCookie(), 'cache-control': 'no-store' });
      response.end();
      return;
    }

    // 鉴权：没过就送去登录页（接口返回 401，让前端能给出可读提示而不是一坨 HTML）。
    if (!gate.check(request).ok) {
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 401, { ok: false, error: '未登录或会话已过期，请重新登录' });
      } else {
        response.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
        response.end();
      }
      return;
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      response.write('retry: 3000\n\n');
      // SSE 自己不回溯：不补发的话，页面刷新或服务重启后日志面板会一直空着，
      // 看起来像坏了——监控没在跑的时候更是永远等不到新日志。
      for (const event of supervisor.recentLogs ?? []) {
        try {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          break;
        }
      }
      streams.add(response);
      const heartbeat = setInterval(() => {
        try {
          response.write(': ping\n\n');
        } catch {
          clearInterval(heartbeat);
        }
      }, SSE_HEARTBEAT_MS);
      request.on('close', () => {
        clearInterval(heartbeat);
        streams.delete(response);
      });
      return;
    }

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const html = await readFile(INDEX_PATH, 'utf8');
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html);
        return;
      }

      if (url.pathname === '/api/login-qr.svg') {
        // 二维码由登录会话生成后一直放在内存里，前端靠 ?t= 时间戳绕过缓存。
        const svg = supervisor.login?.qrSvg;
        if (!svg) {
          sendJson(response, 404, { ok: false, error: '二维码尚未生成' });
          return;
        }
        response.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
        response.end(svg);
        return;
      }

      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) {
        sendJson(response, 404, { ok: false, error: `没有这个接口：${request.method} ${url.pathname}` });
        return;
      }

      const result = (await handler(request)) ?? { body: { ok: true } };
      sendJson(response, result.status ?? 200, result.body ?? result);
    } catch (error) {
      logger?.error(`接口出错：${error.message}`, 'web');
      sendJson(response, 500, { ok: false, error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  // 监听 0.0.0.0 时给出本机可用的地址，方便直接粘贴到浏览器。
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}/`;

  logger?.info(`Web 控制台已就绪：${url}`, 'web');
  if (gate.enabled) logger?.info('已启用访问密码：首次打开会跳到登录页', 'web');
  if (shouldOpen) openBrowser(url);

  return {
    url,
    port: actualPort,
    async close() {
      unsubscribe();
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
