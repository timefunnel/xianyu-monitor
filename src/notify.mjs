/**
 * 通知渠道。每个渠道返回 `{type, ok, error}`，单渠道失败不影响其它渠道，也不抛出异常——
 * 通知失败会让主循环中断，而这正是最不该发生的连锁反应。
 */

import { createHmac } from 'node:crypto';

const MAX_BODY = 3500;

/** Bark 走 GET 时的 URL 长度上限；超过就改用 POST，否则服务端会返回 HTTP 431。 */
const BARK_MAX_GET_URL = 1500;

/** 通知标题里商品名的上限：闲鱼标题常把整段描述塞进来，取前段即可判断是什么货。 */
const MAX_TITLE = 40;

/**
 * 渠道字段的唯一事实来源：控制台据此渲染表单，校验据此判断必填。
 *
 * 放在服务端而不是前端各写一份，是为了避免"界面能填但发不出去"或反过来的分叉——
 * 界面上那份表单就是从这个表生成的。
 *
 * - `required`：缺了就不能保存
 * - `secret`：界面按密码框处理并脱敏显示
 * - `options`：枚举字段（目前只有 Bark 的提示音）
 */
export const CHANNEL_SCHEMA = [
  {
    type: 'telegram',
    label: 'Telegram',
    hint: '找 @BotFather 发 /newbot 拿 botToken，再找 @userinfobot 拿 chatId（群聊是负数）',
    fields: [
      { key: 'botToken', label: 'Bot Token', required: true, secret: true, placeholder: '123456:ABC-DEF…' },
      { key: 'chatId', label: 'Chat ID', required: true, placeholder: '123456789' },
    ],
  },
  {
    type: 'dingtalk',
    label: '钉钉群机器人',
    hint: '群 → 群设置 → 智能群助手 → 添加机器人 → 自定义；安全设置选「加签」时把密钥填进 secret',
    fields: [
      { key: 'webhook', label: 'Webhook', required: true, secret: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
      { key: 'secret', label: '加签密钥（可选）', secret: true, placeholder: 'SEC…' },
    ],
  },
  {
    type: 'wecom',
    label: '企业微信群机器人',
    hint: '群 → 群机器人 → 添加，复制 webhook 地址',
    fields: [
      { key: 'webhook', label: 'Webhook', required: true, secret: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
    ],
  },
  {
    type: 'bark',
    label: 'Bark（iOS）',
    hint: 'App 首页那串 key；自建服务把 server 改成自己的地址',
    fields: [
      { key: 'key', label: 'Device Key', required: true, secret: true, placeholder: 'abc123…' },
      { key: 'server', label: '服务器（可选）', placeholder: 'https://api.day.app' },
      { key: 'sound', label: '提示音（可选）', placeholder: '例如 alarm' },
    ],
  },
  {
    type: 'serverchan',
    label: 'Server酱',
    hint: 'sct.ftqq.com 登录后拿 SendKey（SCT 开头）',
    fields: [{ key: 'sendKey', label: 'SendKey', required: true, secret: true, placeholder: 'SCT…' }],
  },
  {
    type: 'webhook',
    label: '自定义 Webhook',
    hint: '你自己的接收端，会收到 POST JSON：{title, body, url, webUrl, group}',
    fields: [
      { key: 'url', label: 'URL', required: true, placeholder: 'https://example.com/hook' },
      { key: 'headers', label: '额外请求头（可选，JSON）', kind: 'json', placeholder: '{"Authorization":"Bearer …"}' },
    ],
  },
];

/** 按 type 取字段定义；未知类型返回 null。 */
export const channelSchemaOf = (type) => CHANNEL_SCHEMA.find((entry) => entry.type === type) ?? null;

/**
 * 校验一组通知渠道。
 *
 * 只检查**结构**（类型已知、必填字段非空、类型对）——不校验密钥是否真的有效，
 * 那要靠「测试」按钮去发一条才知道。
 *
 * @param {unknown} channels 渠道数组。
 * @returns {string[]} 问题列表；空数组表示通过。
 */
export function validateChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return ['notify.channels 必须是非空数组（至少一个通知渠道）'];
  const problems = [];
  channels.forEach((channel, index) => {
    const where = `notify.channels[${index}]`;
    if (!channel || typeof channel !== 'object' || !channel.type) {
      problems.push(`${where}.type 必填`);
      return;
    }
    const schema = channelSchemaOf(channel.type);
    if (!schema) {
      problems.push(`${where}.type 不支持：${channel.type}（可用：${CHANNEL_SCHEMA.map((entry) => entry.type).join(' / ')}）`);
      return;
    }
    for (const field of schema.fields) {
      const value = channel[field.key];
      if (value === undefined || value === null || value === '') {
        if (field.required) problems.push(`${where}.${field.key} 必填（${schema.label}）`);
        continue;
      }
      if (field.kind === 'json' && typeof value !== 'object') {
        problems.push(`${where}.${field.key} 必须是对象`);
      }
    }
  });
  return problems;
}

/**
 * 把闲鱼的超长标题压成一段可读短句。
 *
 * 标题里往往混着型号、成色、参数、客服话术和免责声明，因此先按句读/括号在第一个
 * 自然边界截断，再按长度兜底截断；连续空白会被压成单个空格。
 *
 * @param {string} raw 原始标题。
 * @param {number} [max] 最大长度。
 * @returns {string} 压缩后的标题。
 */
export function condenseTitle(raw, max = MAX_TITLE) {
  const flattened = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (flattened === '') return '（无标题）';
  const boundary = flattened.split(/[，,。！!？?；;【\[]/)[0].trim().replace(/[，,。！!？?；;、\-—]+$/, '');
  const base = boundary.length >= 8 ? boundary : flattened;
  return base.length > max ? `${base.slice(0, max)}…` : base;
}

/**
 * 把发布时间压成相对时间。通知里看「多久之前」比看绝对时间更有用。
 * @param {number} timestamp epoch 毫秒。
 * @returns {string} 相对时间描述。
 */
export function formatAge(timestamp) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

/**
 * 渲染单条命中消息：一行标题（价格 + 商品名）+ 一行元信息（地区 · 卖家 · 新旧）。
 *
 * 字段缺失时用「价格未知 / 地区未知 / 时间未知」就地说明，而不是另起一行堆诊断信息——
 * 这些字段本来就参与命中判定，读的人需要知道哪一项没判定。
 *
 * `url` 是给渠道做点击跳转用的（Bark 的 url 参数、Telegram 的按钮）；支持跳转的渠道
 * 正文里不再重复裸链接，不支持跳转的渠道由 {@link withLink} 补上。
 *
 * 跳转目标由 `task.jumpLink` 决定：`app`（默认）优先用接口给的 `fleamarket://`
 * 深链，点一下直接进闲鱼 App；`web` 则用网页链接，保证一定能打开。
 *
 * @param {import('./rules.mjs').Item} item 商品。
 * @param {{name: string, jumpLink?: 'web'|'app'}} task 命中的任务。
 * @param {{showTaskName?: boolean}} [options] 多任务时在标题里带上任务名，便于分辨是哪条规则命中。
 * @returns {{title: string, body: string, url: string, webUrl: string, group: string}} 标题、正文、跳转链接、网页链接与分组。
 */
export function formatItem(item, task, options = {}) {
  const price = typeof item.price === 'number' ? `¥${item.price}` : '价格未知';
  const meta = [item.area ?? '地区未知'];
  if (item.seller) meta.push(item.seller);
  meta.push(item.publishTime ? formatAge(item.publishTime) : '时间未知');

  const taskSuffix = options.showTaskName ? ` · ${task.name}` : '';
  const jump = task.jumpLink === 'web' ? item.url : item.appUrl ?? item.url;

  return {
    title: `${price} · ${condenseTitle(item.title)}${taskSuffix}`,
    body: meta.join(' · '),
    url: jump,
    // 文本类渠道（钉钉/企业微信/Server酱）点不动 scheme，必须给 http 链接。
    webUrl: item.url,
    group: task.name,
  };
}

/**
 * 给不支持点击跳转的渠道把链接补进正文。钉钉/企业微信这类文本消息客户端会自动识别 http 链接，
 * 因此这里固定用网页链接，而不是可能为 `fleamarket://` 的跳转目标。
 * @param {{title: string, body: string, url?: string, webUrl?: string}} message 消息。
 * @returns {{title: string, body: string, url?: string, webUrl?: string}} 正文带链接的消息。
 */
export function withLink(message) {
  const target = message.webUrl ?? message.url;
  if (!target || message.body.includes(target)) return message;
  return { ...message, body: `${message.body}\n${target}` };
}

const truncate = (text) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text);

/**
 * 向单个渠道投递。未知渠道类型按配置错误返回失败，而不是静默跳过。
 *
 * `message.url` 是点击跳转目标：Bark 走 `url` 查询参数，Telegram 走内联按钮。
 * 这两个渠道的正文都是纯文本，光把链接写进正文是点不动的。
 *
 * @param {any} channel 渠道配置，`type` 决定其余字段。
 * @param {{title: string, body: string, url?: string, group?: string}} message 消息。
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options] 超时与 fetch 实现（测试注入）。
 * @returns {Promise<{type: string, ok: boolean, error?: string}>} 投递结果。
 */
export async function sendToChannel(channel, message, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = truncate(message.body);
  // 钉钉、企业微信、Server酱 是纯文本消息，没有独立的跳转字段，只能把链接写进正文；
  // Bark 与 Telegram 各自有可点的跳转入口，正文里就不再重复裸链接。
  const linkedBody = truncate(withLink(message).body);
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    switch (channel.type) {
      case 'telegram': {
        const payload = {
          chat_id: channel.chatId,
          text: `${message.title}\n${body}`,
          disable_web_page_preview: false,
        };
        // 纯文本里的链接点不动，用内联按钮给出明确的跳转入口。
        if (message.url) payload.reply_markup = { inline_keyboard: [[{ text: '打开商品', url: message.url }]] };
        const response = await fetchImpl(`https://api.telegram.org/bot${channel.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
        return await toResult(channel.type, response);
      }
      case 'dingtalk': {
        let url = channel.webhook;
        if (channel.secret) {
          const timestamp = Date.now();
          const sign = createHmac('sha256', channel.secret).update(`${timestamp}\n${channel.secret}`).digest('base64');
          url += `${url.includes('?') ? '&' : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
        }
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: `${message.title}\n${linkedBody}` } }),
          signal,
        });
        return await toResult(channel.type, response);
      }
      case 'wecom': {
        const response = await fetchImpl(channel.webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ msgtype: 'text', text: { content: `${message.title}\n${linkedBody}` } }),
          signal,
        });
        return await toResult(channel.type, response);
      }
      case 'bark': {
        const server = (channel.server ?? 'https://api.day.app').replace(/\/$/, '');
        // Bark 的正文是纯文本，链接要单独放进 url 参数才能在点通知时跳转。
        const target = new URL(`${server}/${channel.key}/${encodeURIComponent(message.title)}/${encodeURIComponent(body)}`);
        if (message.url) target.searchParams.set('url', message.url);
        if (message.group) target.searchParams.set('group', message.group);
        if (channel.sound) target.searchParams.set('sound', channel.sound);

        // 标题和正文都塞在 URL 路径里，内容一长就会撞上服务端的请求头上限（实测 HTTP 431）。
        // 超过阈值就改用 Bark 的 POST /push 接口，把内容放进请求体。
        const response =
          target.href.length > BARK_MAX_GET_URL
            ? await fetchImpl(`${server}/push`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  device_key: channel.key,
                  title: message.title,
                  body,
                  ...(message.url ? { url: message.url } : {}),
                  ...(message.group ? { group: message.group } : {}),
                  ...(channel.sound ? { sound: channel.sound } : {}),
                }),
                signal,
              })
            : await fetchImpl(target.href, { method: 'GET', signal });
        return await toResult(channel.type, response);
      }
      case 'serverchan': {
        const response = await fetchImpl(`https://sctapi.ftqq.com/${channel.sendKey}.send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: message.title, desp: linkedBody }),
          signal,
        });
        return await toResult(channel.type, response);
      }
      case 'webhook': {
        const response = await fetchImpl(channel.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(channel.headers ?? {}) },
          body: JSON.stringify({ title: message.title, body, url: message.url, webUrl: message.webUrl, group: message.group, ...(message.extra ?? {}) }),
          signal,
        });
        return await toResult(channel.type, response);
      }
      default:
        return { type: String(channel.type), ok: false, error: `未知渠道类型：${channel.type}` };
    }
  } catch (error) {
    return { type: String(channel.type), ok: false, error: error.message };
  }
}

/** 把 HTTP 响应折算成投递结果；非 2xx 一律视为失败并把响应体前 200 字带回。 */
async function toResult(type, response) {
  if (response.ok) return { type, ok: true };
  const text = await response.text().catch(() => '');
  return { type, ok: false, error: `HTTP ${response.status} ${text.slice(0, 200)}` };
}

/**
 * 并发投递到所有渠道。
 * @param {any[]} channels 渠道配置列表。
 * @param {{title: string, body: string, url?: string, group?: string}} message 消息。
 * @param {{timeoutMs?: number, logger?: any, fetchImpl?: typeof fetch}} [options] 超时、日志与 fetch 实现。
 * @returns {Promise<Array<{index: number, type: string, ok: boolean, error?: string}>>} 每个渠道的结果；`index` 是它在配置里的下标，同类型多渠道时用来分辨是哪一个。
 */
export async function sendAll(channels, message, options = {}) {
  const results = await Promise.all(
    channels.map((channel, index) =>
      sendToChannel(channel, message, { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl }).then((result) => ({ ...result, index })),
    ),
  );
  for (const result of results) {
    if (result.ok) options.logger?.debug?.(`通知已送达 ${result.type}`, 'notify');
    else options.logger?.warn?.(`通知失败 ${result.type}：${result.error}`, 'notify');
  }
  return results;
}
