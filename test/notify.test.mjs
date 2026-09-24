import { test } from 'node:test';
import assert from 'node:assert/strict';
import { condenseTitle, formatAge, formatItem, sendAll, sendToChannel, withLink } from '../src/notify.mjs';

const item = {
  id: '812345678901',
  title: 'MacBook Air M2 13寸',
  price: 2999,
  area: '上海 浦东新区',
  seller: '闲置数码小铺',
  picUrl: null,
  url: 'https://www.goofish.com/item?id=812345678901',
  publishTime: Date.now() - 5 * 60000,
};

const task = { name: 'macbook', filters: { maxPrice: 3200 } };

test('消息压成两行：一行价格加商品名，一行地区卖家新旧', () => {
  const { title, body, url, group } = formatItem(item, task);
  assert.equal(title, '¥2999 · MacBook Air M2 13寸');
  assert.equal(body, '上海 浦东新区 · 闲置数码小铺 · 5 分钟前');
  assert.equal(url, item.url);
  assert.equal(group, 'macbook');
  assert.ok(!body.includes('上限'), '用户自己的价格上限不必回显');
  assert.ok(!title.includes('http'), '支持跳转的渠道正文里不再重复裸链接');
});

test('单任务不带任务名，多任务才带上以便分辨是哪条规则命中', () => {
  assert.ok(!formatItem(item, task).title.includes('macbook'));
  assert.ok(formatItem(item, task, { showTaskName: true }).title.endsWith('· macbook'));
});

test('字段缺失时就地说明是哪一项没判定', () => {
  const { title, body } = formatItem({ ...item, price: null, area: null, publishTime: null }, task);
  assert.ok(title.startsWith('价格未知 · '));
  assert.equal(body, '地区未知 · 闲置数码小铺 · 时间未知');
});

test('condenseTitle 在自然边界截断', () => {
  assert.equal(condenseTitle('MacBook Air M2 13寸 8G+256G 国行 带票'), 'MacBook Air M2 13寸 8G+256G 国行 带票');
  assert.equal(
    condenseTitle('95新 AOC  2k 180电竞游戏27寸显示器 转让AOC 宙斯盾系列，型号Q27G12E，最新四代'),
    '95新 AOC 2k 180电竞游戏27寸显示器 转让AOC 宙斯盾系列',
  );
  assert.equal(condenseTitle('', undefined).length > 0, true);
  assert.ok(condenseTitle('A'.repeat(80)).endsWith('…'));
  assert.equal(condenseTitle('A'.repeat(80)).length, 41, '超出上限时截断并加省略号');
  assert.equal(condenseTitle('型号：X1，其余略', 5).length, 6);
});

test('formatAge 用相对时间', () => {
  const now = Date.now();
  assert.equal(formatAge(now), '刚刚');
  assert.equal(formatAge(now - 8 * 60000), '8 分钟前');
  assert.equal(formatAge(now - 3 * 3600000), '3 小时前');
  assert.equal(formatAge(now - 2 * 86400000), '2 天前');
});

test('withLink 只给没有跳转能力的渠道补网页链接', () => {
  const message = { title: 'T', body: 'B', url: 'fleamarket://item?id=1', webUrl: 'https://x.invalid/1' };
  assert.equal(withLink(message).body, 'B\nhttps://x.invalid/1', 'scheme 在文本消息里点不动，必须补 http 链接');
  assert.equal(withLink({ title: 'T', body: 'B', url: 'https://x.invalid/1' }).body, 'B\nhttps://x.invalid/1');
  assert.equal(withLink({ title: 'T', body: 'B' }).body, 'B');
  assert.equal(withLink({ title: 'T', body: 'B\nhttps://x.invalid/1', webUrl: 'https://x.invalid/1' }).body, 'B\nhttps://x.invalid/1');
});

test('jumpLink 决定跳转目标：默认走 App 深链，可切回网页链接', () => {
  const withApp = { ...item, appUrl: 'fleamarket://item?id=812345678901&gulSource=search' };
  assert.equal(formatItem(withApp, task).url, withApp.appUrl, '默认跳到闲鱼 App');
  assert.equal(formatItem(withApp, { ...task, jumpLink: 'web' }).url, withApp.url, 'web 模式用网页链接');
  assert.equal(formatItem({ ...withApp, appUrl: null }, task).url, withApp.url, '没有深链时回退网页链接');
});

test('企业微信与钉钉这类纯文本渠道，链接补进正文', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body).text.content);
    return { ok: true, status: 200, text: async () => '' };
  };
  const message = formatItem({ ...item, appUrl: 'fleamarket://item?id=812345678901' }, task);
  await sendToChannel({ type: 'wecom', webhook: 'https://x.invalid' }, message, { fetchImpl });
  assert.ok(sent[0].includes(item.url), '文本渠道要拿到 http 链接，而不是点不动的 scheme');
  assert.ok(!sent[0].includes('fleamarket://'));
  assert.ok(sent[0].startsWith(message.title));

  await sendToChannel({ type: 'dingtalk', webhook: 'https://x.invalid' }, message, { fetchImpl });
  assert.ok(sent[1].includes(item.url));
});

test('Bark 把链接放进 url 查询参数，并按任务分组', async () => {
  let captured;
  const fetchImpl = async (target) => {
    captured = String(target);
    return { ok: true, status: 200, text: async () => '' };
  };
  const result = await sendToChannel(
    { type: 'bark', key: 'KEY' },
    { title: '闲鱼命中：t', body: '正文', url: 'https://www.goofish.com/item?id=1', group: 't' },
    { fetchImpl },
  );
  assert.equal(result.ok, true);
  const parsed = new URL(captured);
  assert.equal(parsed.searchParams.get('url'), 'https://www.goofish.com/item?id=1');
  assert.equal(parsed.searchParams.get('group'), 't');
  assert.ok(parsed.pathname.startsWith('/KEY/'), '仍然走 /key/title/body 路径');
});

test('Bark 没有链接时不带 url 参数', async () => {
  let captured;
  const fetchImpl = async (target) => {
    captured = String(target);
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel({ type: 'bark', key: 'KEY' }, { title: '心跳', body: '正文' }, { fetchImpl });
  assert.equal(new URL(captured).searchParams.has('url'), false);
});

test('Bark 内容过长时改用 POST /push，不再撞请求头上限', async () => {
  // 实测：标题和正文都塞在 URL 路径里，长内容会返回 HTTP 431 Request Header Fields Too Large。
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null };
    return { ok: true, status: 200, text: async () => '' };
  };
  const longBody = '这是一条很长的推送正文。'.repeat(40);
  await sendToChannel(
    { type: 'bark', key: 'KEY', sound: 'bell' },
    { title: '闲鱼命中：t', body: longBody, url: 'fleamarket://item?id=1', group: 't' },
    { fetchImpl },
  );
  assert.equal(captured.method, 'POST');
  assert.match(captured.url, /\/push$/);
  assert.equal(captured.body.device_key, 'KEY');
  assert.equal(captured.body.url, 'fleamarket://item?id=1');
  assert.equal(captured.body.group, 't');
  assert.equal(captured.body.sound, 'bell');
  assert.ok(captured.body.body.length > 0);
});

test('Bark 短内容仍然走 GET，保持可点击跳转的既有行为', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), method: init?.method };
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel({ type: 'bark', key: 'KEY' }, { title: '闲鱼命中：t', body: '上海 · 数码小铺 · 3 分钟前', url: 'fleamarket://item?id=1' }, { fetchImpl });
  assert.equal(captured.method, 'GET');
  assert.match(captured.url, /^https:\/\/api\.day\.app\/KEY\//);
});

test('Telegram 带内联按钮跳转，无链接时不加按钮', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel(
    { type: 'telegram', botToken: 'T', chatId: '1' },
    { title: 'T', body: 'B', url: 'https://www.goofish.com/item?id=1' },
    { fetchImpl },
  );
  assert.deepEqual(sent[0].reply_markup, { inline_keyboard: [[{ text: '打开商品', url: 'https://www.goofish.com/item?id=1' }]] });

  await sendToChannel({ type: 'telegram', botToken: 'T', chatId: '1' }, { title: 'T', body: 'B' }, { fetchImpl });
  assert.equal('reply_markup' in sent[1], false);
});

test('自定义 webhook 透出 url 字段', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel(
    { type: 'webhook', url: 'https://hook.invalid' },
    { title: 'T', body: 'B', url: 'https://www.goofish.com/item?id=1', group: 'g' },
    { fetchImpl },
  );
  assert.equal(captured.url, 'https://www.goofish.com/item?id=1');
  assert.equal(captured.group, 'g');
});

test('超长标题被压缩进通知标题，不留整段商品描述', () => {
  const long = `${'A'.repeat(200)}，${'B'.repeat(200)}`;
  const { title } = formatItem({ ...item, title: long }, task);
  assert.ok(title.length <= 50, `通知标题应保持短，实际 ${title.length} 字`);
  assert.ok(title.endsWith('…'));
  assert.ok(!title.includes('B'), '逗号后的描述不该进通知');
});

test('telegram 渠道按官方接口拼装请求', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => '' };
  };
  const result = await sendToChannel(
    { type: 'telegram', botToken: 'TOKEN', chatId: '42' },
    { title: 'T', body: 'B' },
    { fetchImpl },
  );
  assert.deepEqual(result, { type: 'telegram', ok: true });
  assert.equal(captured.url, 'https://api.telegram.org/botTOKEN/sendMessage');
  assert.deepEqual(JSON.parse(captured.init.body), { chat_id: '42', text: 'T\nB', disable_web_page_preview: false });
});

test('钉钉加签会带上 timestamp 与 sign', async () => {
  let url;
  const fetchImpl = async (target) => {
    url = target;
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel(
    { type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=a', secret: 'SEC' },
    { title: 'T', body: 'B' },
    { fetchImpl },
  );
  assert.ok(url.startsWith('https://oapi.dingtalk.com/robot/send?access_token=a&timestamp='));
  assert.ok(url.includes('&sign='));
});

test('HTTP 非 2xx 视为失败并带上响应片段', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const result = await sendToChannel({ type: 'wecom', webhook: 'https://example.invalid' }, { title: 'T', body: 'B' }, { fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 500 boom/);
});

test('网络异常被捕获成失败结果而不是抛出', async () => {
  const fetchImpl = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await sendToChannel({ type: 'bark', key: 'k' }, { title: 'T', body: 'B' }, { fetchImpl });
  assert.deepEqual(result, { type: 'bark', ok: false, error: 'ECONNREFUSED' });
});

test('未知渠道类型明确失败', async () => {
  const result = await sendToChannel({ type: 'carrier-pigeon' }, { title: 'T', body: 'B' }, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /未知渠道类型/);
});

test('sendAll 并发投递且单渠道失败不影响其它渠道', async () => {
  const fetchImpl = async (url) => (String(url).includes('bad') ? { ok: false, status: 403, text: async () => 'no' } : { ok: true, status: 200, text: async () => '' });
  const results = await sendAll(
    [
      { type: 'wecom', webhook: 'https://good.invalid' },
      { type: 'wecom', webhook: 'https://bad.invalid' },
    ],
    { title: 'T', body: 'B' },
    { fetchImpl },
  );
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false],
  );
});

test('超长正文被截断到平台上限内', async () => {
  let body;
  const fetchImpl = async (url, init) => {
    body = init.body;
    return { ok: true, status: 200, text: async () => '' };
  };
  await sendToChannel({ type: 'wecom', webhook: 'https://example.invalid' }, { title: 'T', body: 'x'.repeat(9000) }, { fetchImpl });
  assert.ok(JSON.parse(body).text.content.length < 4000);
});
