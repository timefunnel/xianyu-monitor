# xianyu-monitor

> ## ⚠️ 仅供学习与个人研究，**请不要用主号登录**
>
> - 本项目**仅供学习交流**：它的价值在于把「Web 自动化 / 接口协议适配 / 调度与去重 / 风控现象观测」这些问题摊开来讨论，代码和文档里记录了完整的实测过程与踩坑结论。
> - **请勿使用你的主账号。** 它通过程序自动化访问闲鱼，**违反《闲鱼用户协议》**。平台的处置是有梯度的：先用风控把接口拒掉（本项目开发过程中反复撞到 `RGV587` 与 `action=deny`），再严重就可能限制账号功能甚至封号。**请用小号，并接受该小号可能损失。**
> - **不要**用于代拍、代抢、批量倒卖等经营行为，也**不要**对外提供服务——那属于经营行为，风险量级完全不同。
> - **不要**把 `data/` 目录交给任何人、也不要提交到仓库：`data/cookies.json` 就是你的登录凭据（等同账号密码），`data/browser-profile/` 是完整登录态。仓库的 `.gitignore` 已经把整个 `data/` 挡在外面。
> - 本项目不代下单、不代支付、不接触任何资金环节；不实现验证码绕过，也不伪造浏览器指纹。
> - **使用所产生的一切后果由使用者自行承担**，作者不承担任何责任。

闲鱼关键词监控：按关键词定时搜索，命中你设定的条件（价格、成色关键词、地区、发布时间）后，**秒级推送**到 Telegram / 钉钉 / 企业微信 / Bark / Server酱 / 自定义 webhook，你点开链接去 App 下单。

设计目标是「不漏掉好货」，因此默认一切花钱的动作都由你自己完成——本工具不代下单、不代支付。

## 四个必须知道的前置事实

以下都是实测结论，直接决定方案可行性：

1. **搜索接口要求登录**。未登录调用 `mtop.taobao.idlemtopsearch.pc.search` 会返回错误码并带上登录页地址，拿不到任何商品。所以必须先扫码登录。
2. **登录必须用有头浏览器**。`headless: true` 时闲鱼首页直接返回「非法访问」，二维码不会渲染。所以配置默认 `headless: false`，**服务器上扫码那一步要用 `xvfb-run`**。（监控本身不启浏览器，见「请求次数」一节。）
3. **搜索接口有频率限制，做不到「秒级」**。实测短时间内连续 3 次搜索就返回 `RGV587_ERROR::SM::哎哟喂,被挤爆啦`，冷却约 3 分钟。所以现实节奏是**每个任务 60~120 秒一次**，本工具的定位是「捡漏提醒」而不是「抢拍工具」；被限流时主循环会直接进入最长冷却（默认 300 秒）并告警。
4. **网页端不能下单**。goofish.com 支持搜索、比价、一键沟通，但下单要回 App。所以本工具的终点是「推送 + 你点链接去 App 下单」。

## 它做什么，不做什么

| 做 | 不做 |
| --- | --- |
| 定时搜索关键词并按规则筛选 | 不自动下单、不自动支付 |
| 命中后推送到你的 IM | 不逆向 App 端签名、不伪造客户端接口 |
| 记录已推送商品，避免重复刷屏 | 不做反检测规避、不多账号并发 |

工作原理：用 Playwright 打开 `www.goofish.com` 扫码登录（浏览器只做这一件事和「点开看商品」），登录态导出成 `data/cookies.json`。搜索**不经过页面**——拿这份登录态向 `h5api.m.goofish.com` 发一次 mtop 请求，每轮恰好 1 次。接口换参数时只需调整 `src/parse.mjs` 一个文件。

真实接口是 `h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search`；同名前缀的 `.shade`（推荐位）与 `.item.search.activate`（热搜位）不是商品结果，已在采集时排除。

## 图形控制台（推荐日常使用）

不想记命令就用控制台。Windows 双击 `start.cmd`，Linux / NAS 执行 `./start.sh`（首次会自动装依赖），也可以直接：

```bash
npm run web            # 默认 http://127.0.0.1:7788
npm run web -- --port 9000 --no-open
```

它会启动 HTTP 服务并**自动拉起监控**，然后在浏览器里打开。

**服务生命周期归进程，不归页面**：监控随 `npm run web`（或 Docker/systemd）启动、随进程退出，页面上没有启停/重启入口——页面能打开就说明服务在跑。配置里有任务被停用、甚至一个启用的任务都没有时，服务只是**待命**而不会退出，把开关打开就开始抓取。

启动失败会**自愈**：进程起起来时会话已失效是最常见的原因，所以

- 扫码登录成功后**自动拉起监控**，不需要你再点任何东西；
- 启动失败后每 60 秒自动重试一次（只在「没在跑」时触发，成功即停）；
- 页面顶部会明确写出「监控当前没有在运行」以及原因，不会让你只看到一句过期报错。

监控没在跑时，卡片上的累计计数和「已记录 N 条」仍然从 `data/state.json` 里读出来照常显示；日志面板在 SSE 连上时会**补发最近的 300 行**（SSE 自己不回溯，否则刷新后永远空白）。

界面按 **app-shell-ui**（App Mode · 控制台型）组织：顶部标题栏放品牌与全局操作，左侧 240px 导航，右侧内容画布按五个路由分屏——**每个路由在 1280×800 下都是一屏，不出现页面级滚动**（长列表用受限的内部滚动区）。

| 路由 | 内容 |
| --- | --- |
| 概览 | 统计卡（运行中任务 / 累计轮询 / 扫描 / 命中 / 推送 / 去重）+ 操作结果 + 最近命中 |
| 任务 | 任务卡片：监控开关、推送开关、三态标签、统计、编辑/复制/删除、新建 |
| 命中 | 完整命中历史，点任意一条直接跳转商品 |
| 日志 | 实时日志（SSE 推送，可按级别过滤）|
| 配置 | config.json 原文，改通知渠道、控制台端口这些非任务配置 |

控制台里能做：

- 看登录会话状态、每个任务的轮询/扫描/命中/失败计数；
- **立即检查**（只看不推的干跑，用来调关键词）；
- **任务增删改即时生效**：新建、编辑（关键词/过滤条件/间隔）、删除、启用停用，全都保存即生效，不需要重启任何东西；
- **推送开关（两级）**：标题栏一个总开关一键静默全部推送；每张任务卡上还有各自的「推送」开关。两级是「与」的关系，**静默时监控照常跑、命中照常记入历史，只是不发通知**——所以调关键词时不会再被刷屏，重新打开开关也不会把静默期间的积压一次性补推。登录失效、筛选没生效这类**告警不受静默影响**；
- 任务表单是结构化的，分「基本」和「高级筛选」两组，保存前做客户端校验（重名、空关键词、价格只填一边、非法正则等），服务端校验失败会逐条列出问题；
- 测试通知渠道；**重新登录**（二维码直接显示在页面上，不用去翻文件）；
- **亮色 / 暗色主题**切换（记住选择；没选过时跟随系统偏好，首屏不闪）。两套主题共用一份令牌，颜色只在令牌层定义一处。

累计计数（轮询 / 扫描 / 命中 / 推送）持久化在 `data/state.json` 里，**重启不清零**：去重表和命中历史本来就是持久的，计数若只留在内存里，界面会出现「已推送 0 条」而命中历史一大堆的自相矛盾组合。

任务卡片上的状态标签由「配置意图」和「此刻是否真在跑」两个维度决定：

| 标签 | 含义 |
| --- | --- |
| 绿色「运行中」 | 已启用，且抓取循环正在跑 |
| 黄色「已启用 · 未运行」 | 配置里是启用的，但循环没跑起来（启动失败等）|
| 灰色「已停用」 | 配置里停用了 |

### 远程访问

默认只监听 `127.0.0.1`，只有本机能访问。要让 NAS / 手机访问，必须同时设置令牌：

```json
"web": { "port": 7788, "host": "0.0.0.0", "token": "自己编一串随机字符", "open": false }
```

启动日志会打印带令牌的完整地址，打开一次就会记住（种 Cookie）。**没设令牌时程序会拒绝监听 `0.0.0.0`**——这个控制台能启停抓取、改配置、看推送历史，等同于账号的操作面板，不能裸奔在局域网上。

Docker 部署时把端口发布出来即可：

```yaml
ports:
  - "7788:7788"
```

## 快速开始（本机）

```bash
npm install
cp config.example.json config.json     # 改成你自己的关键词
cp .env.example .env                   # 填通知渠道密钥
npm run login                          # 扫码登录：登录态存进 data/browser-profile，并自动写入 data/cookies.json（监控用它）
npm run check                          # 校验配置，不联网
npm run test:notify                    # 给所有渠道发一条测试消息
npm start                              # 开始监控
```

本机有桌面时用内置 Chromium 即可；也可以把 `browser.channel` 设成 `chrome` 或 `msedge` 复用系统已装的浏览器，省掉内核下载：

```bash
npx playwright install chromium        # 或者跳过这步，改用系统浏览器
```

先跑一轮看不推送的结果，用来调关键词和过滤条件：

```bash
node src/cli.mjs once --task macbook-air-m2
node src/cli.mjs once --task macbook-air-m2 --notify   # 确认无误后再真推
```

## 部署到云服务器 / NAS

服务器没有图形界面，而扫码登录需要真实的有头浏览器，因此**登录那一步要跑在 `xvfb-run` 下**（Compose 镜像的 entrypoint 已经自动包了一层）。监控本身不启浏览器，长时间运行不需要图形界面。

### 方式一：Docker Compose（推荐）

```bash
mkdir -p data && sudo chown -R 1000:1000 data    # 容器内以 uid 1000 运行
docker compose run --rm xianyu-monitor node src/cli.mjs login   # 见下方「登录态」
docker compose run --rm xianyu-monitor node src/cli.mjs check
docker compose up -d
docker compose logs -f
```

`config.json` 与 `data/` 通过 volume 挂载，容器重建不丢登录态；登录二维码会写到宿主机 `./data/login-qr.png`。

### 方式二：systemd

```bash
sudo cp -r . /opt/xianyu-monitor && cd /opt/xianyu-monitor
npm install --omit=dev
npx playwright install --with-deps chromium
sudo apt-get install -y xvfb xauth          # 提供虚拟显示
sudo cp deploy/xianyu-monitor.service /etc/systemd/system/
sudo systemctl enable --now xianyu-monitor
journalctl -u xianyu-monitor -f
```

### 方式三：群晖等 NAS

用 Container Manager 导入 `docker-compose.yml`（entrypoint 自带 xvfb），把 `config.json` 与 `data` 目录映射到共享文件夹。

<details>
<summary>不用 Docker 直接在 NAS 上跑</summary>

需要自行安装 Node 20+、Chromium、`xvfb`，然后用「任务计划」或 `nohup` 执行：

```bash
xvfb-run -a node src/cli.mjs run
```
</details>

## 登录态怎么维护（关键一步）

**登录态有两个落点，职责不同**：

| 位置 | 谁在用 | 说明 |
| --- | --- | --- |
| `data/browser-profile/` | 扫码登录、点开看商品 | 完整浏览器 profile；**浏览器只在需要时才启动** |
| `data/cookies.json` | **监控搜索**（http 模式） | 从 profile 导出；mtop 响应里的 `Set-Cookie` 会回写到这里，所以它是持续更新的 |

`npm run login` 扫码成功后会**自动**写第二份，不用额外操作。如果 profile 里本来就有有效登录态（比如你一直用浏览器模式跑），**不必重新扫码**，一条命令就能切换到直连：

```bash
node src/cli.mjs export-cookies
```

它不导航、不请求，只是把 profile 里已有的 cookie 读出来落盘。**会话失效时**（日志报「服务端会话已失效」或搜索要求登录）重新扫码即可，同样会自动落盘。

> `cookie2` 是**会话级 cookie**（关掉浏览器即失效），而 mtop 必须带它。以前这条续期是靠每次加载页面被动拿到的；搜索改走直连之后，只剩 mtop 响应里的 `Set-Cookie` 这一条途径——所以 cookie 文件会被持续回写，别把它改成只读。

闲鱼网页端是**扫码登录**，二维码几分钟就失效，所以服务器上没法「打开浏览器扫一下」。三种可行做法：

1. **二维码截图模式（默认，两种环境通用）**
   ```bash
   npm run login                                  # 本机：弹出窗口，扫窗口里的码即可
   docker compose run --rm xianyu-monitor node src/cli.mjs login   # 服务器：写图片
   ```
   首页加载后登录弹窗会**自动弹出**（实测 `passport.goofish.com/mini_login.htm` 的 iframe 就在视口内，856×454），命令一边保持有头渲染，一边把整页截图写到 `data/login-qr.png` 并每 5 秒刷新。服务器上你从 NAS 文件管理器 / SFTP / 共享目录打开这张图，用闲鱼 App 扫码；扫码成功后命令会自动检测到并退出。

   ```bash
   node src/cli.mjs login --out /volume1/share/login-qr.png --timeout 600
   ```

   注意：登录命令**必须**在有头模式下运行（闲鱼对无头请求直接返回「非法访问」页，二维码不会渲染），服务器上请用 `xvfb-run -a node src/cli.mjs login`。

2. **本机登录后拷贝 profile**：在有桌面的机器上 `npm run login`，然后停止所有进程，把整个 `data/browser-profile` 目录拷到服务器的同路径下（要求同为 x64/arm64 且 Chromium 版本接近）。这条最稳，适合二维码刷新太麻烦的场景。

3. **服务器上有桌面或 VNC**：直接在 VNC 里看浏览器窗口扫码。

登录态通常能维持数周；失效后搜索接口会返回 `RGV587_ERROR`，日志与推送里会直接提示重新登录。

## 配置说明

相对路径以**配置文件所在目录**为基准（systemd / Docker 下更可预期）。`${VAR}` 会从环境变量或同目录 `.env` 读取；变量缺失会直接报错退出，不会静默用空值跑。

```jsonc
{
  "browser": {
    "baseUrl": "https://www.goofish.com",
    "userDataDir": "./data/browser-profile",  // 登录态存这里
    "headless": false,                        // 扫码登录必须 false；监控不启浏览器，这一项只影响登录
    "channel": "",                            // 例如 "chrome" / "msedge"，复用系统浏览器
    "executablePath": "",                     // 非标准安装路径时指定
    "locale": "zh-CN",
    "timezoneId": "Asia/Shanghai",
    "navigationTimeoutMs": 30000,
    "responseTimeoutMs": 20000
  },
  "search": {
    "mode": "http",                           // http=直连 mtop，每轮恒 1 次请求（默认）；browser=驱动页面
    "timeoutMs": 20000,
    "riskCookies": "omit"                     // omit=不发这类风控状态 cookie（默认）；remembered=带但剔掉已知会被拒的值
  },
  "monitor": {
    "maxBackoffSeconds": 300,        // 连续失败时单任务最长退避
    "minRequestGapSeconds": 30,      // 两次搜索之间的全局最小间隔（跨任务，防多任务叠加触发风控）
    "onUnknownField": "pass",        // 字段抓不到时：pass=照推并标注 / reject=丢弃
    "heartbeatHours": 6,             // 心跳间隔
    "failureAlertThreshold": 3,      // 连续失败多少次发一次告警
    "notifyOnStart": true
  },
  "storage": {
    "stateFile": "./data/state.json",
    "seenLimit": 20000,
    "seenRetentionDays": 30
  },
  "notify": {
    "timeoutMs": 10000,
    "maxPerCycle": 8,                // 单轮最多发几条即时消息，超出合并成一条汇总
    "channels": [{ "type": "telegram", "botToken": "${TG_BOT_TOKEN}", "chatId": "${TG_CHAT_ID}" }]
  },
  "web": {
    "port": 7788,                    // 控制台端口
    "host": "127.0.0.1",             // 改成 0.0.0.0 时必须同时设 token
    "token": "",
    "open": true                     // 启动后自动打开浏览器
  },
  "tasks": [
    {
      "name": "2k-144hz-monitor",    // 日志与去重用的名字，必填
      "enabled": true,
      "keyword": "2K 显示器",
      "intervalSeconds": 180,        // 基础轮询间隔
      "jitterSeconds": 20,           // 随机抖动，避免固定节奏
      "scrollRounds": 0,             // 向下滚动几次以加载更多结果
      "nativeFilters": {             // 交给闲鱼页面原生执行的筛选（服务端过滤）
        "priceRange": [500, 700],
        "region": "江浙沪"           // 取值要与闲鱼区域面板一致：江浙沪/珠三角/京津冀/东三省/省份名
      },
      "filters": {                   // 客户端过滤：只放服务端做不到的判断
        "requireKeywords": [],       // 标题必须包含其一（可当品牌白名单）
        "excludeKeywords": ["同款", "求购", "仅拆封", "展示机", "代拍", "回收"],
        "excludeSellers": [],        // 卖家昵称精确匹配
        "maxAgeMinutes": 120,        // 只看该时间窗内发布的（注意：见下方说明，本项目里基本不生效）
        "cityContains": ""           // 地区包含匹配；多个地区用 nativeFilters.region
      }
    }
  ]
}
```

### 两层过滤怎么分工

**价格和区域都优先用 `nativeFilters`，它们由服务端执行。** 原因很实在：服务端一页只给 30 个名额。只做客户端过滤时，这 30 条是全国综合排序的结果——实测某轮 30 条全部落在价格区间之外（工厂店用 ¥161 之类的诱导价），等于整轮空转。

| 条件 | 原生筛选 | 实测效果 |
| --- | --- | --- |
| 价格 | `nativeFilters.priceRange` | 筛选批 30 条全部落在区间内 |
| 区域 | `nativeFilters.region` | 筛选批 30 条全部在指定地区 |
| 最新发布 | `nativeFilters.sort: "newest"` | 请求体带 `sortField=create&sortValue=desc` |
| 发布时间窗 | `nativeFilters.publishDays` | `propValueStr.searchFilter` 带 `publishDays:3;` |
| 卖家信用 | `filters.requireSellerCredit`（**只能本地**）| 见下方说明 |

```json
"nativeFilters": {
  "priceRange": [500, 700],
  "region": "江浙沪",
  "sort": "newest",
  "publishDays": 3
}
```

`sort`（最新）与 `publishDays`（1/3/7/14 天内）互相独立：前者是**排序**，走请求体顶层的 `sortField`/`sortValue`；后者是**筛选**，和价格同处 `propValueStr.searchFilter`（分号分隔，可叠加，如 `priceRange:500,700;publishDays:3;`）。

请求体由 `src/mtop.mjs` 的 `buildSearchBody()` 拼装，字段布局都在那个函数里。`region` 的取值要和闲鱼区域面板一致：预设 `江浙沪` / `珠三角` / `京津冀` / `东三省` / `全国`，或省份名（`上海` / `江苏` / `浙江` …）；不在预设里的按具体省份处理，填城市名可能不生效，用 `filters.cityContains` 兜底。

`publishDays` 比 `maxAgeMinutes` 可靠得多：搜索响应里基本没有发布时间的结构化字段，`maxAgeMinutes` 长期处于「按未知放行」的状态。想只盯新货就用 `publishDays`。

### 卖家信用只能用本地过滤

闲鱼**没有**「卖家信用」这个筛选参数，顶部只有「综合 → 信用排序」（是排序，不是过滤）。所以 `filters.requireSellerCredit` 走客户端判定：从商品的 `exContent.fishTags` 里读「卖家信用极好 / 优秀」标签，按等级比较。

要注意它的代价：**实测 30 条搜索结果里只有 6 条挂了信用标签**，没挂标签的按不达标处理，所以配 `极好` 会筛掉九成左右的结果。嫌太狠可以放宽到 `优秀`。

```json
"filters": { "requireSellerCredit": "极好" }
```

### 筛选没生效就不推送

请求体是自己拼的，所以「条件有没有带上」在构造处就校验一遍（`bodyMatchesFilters`）：对不上就抛 `filters-not-applied`、**本轮不推送任何商品**，而不是退回用一批不带条件的全国结果。

宁可这一轮不出结果并告警，也不推垃圾：推送里混进无关商品会让人开始忽略通知，那比漏报更糟。

### 请求次数：每轮恒为 1 次

默认 `search.mode: "http"`：搜索**不经过页面**，直接向 `h5api.m.goofish.com` 发一次签名请求，所以每轮恒为 1 次，不存在「冷启动」这回事。

| 模式 | 每轮请求次数 | 说明 |
| --- | --- | --- |
| `http`（默认） | **恒为 1** | 直接调 mtop，1 次请求拿到 30 条 |
| `browser` | 冷启动 4~6，之后 1 | 驱动页面；**已弃用，不再维护**，留着只为回退 |

改直连的原因是**请求密度**：驱动页面时每次冷启动都会在几秒内连发 4~6 次，而突发正是风控的触发条件。直连之后这个连发从根上没有了。

每轮日志会打印实际请求次数，省没省一眼可见：

```
第 1 轮：1 次请求，扫描 30 条（30 条带 App 直达链接），命中 0 条
第 2 轮：1 次请求，扫描 30 条（30 条带 App 直达链接），命中 0 条
```

启动时还有一次登录态探测（也是直连 `loginuser.get`，1 次请求，不加载页面）。所以 http 模式下**浏览器完全不访问闲鱼**——它只负责持有登录态，成为纯粹的 cookie 容器；`checkSession` 原先那次「加载首页再看返回码」已经去掉，因为那既要驱动页面，又恰好是唯一还把浏览器拉进搜索链路的动作。

http 模式下**监控侧完全不启动浏览器**：登录态存在 `data/cookies.json` 里，浏览器只在扫码登录和「点开看商品」时按需拉起。所以既没有那个空白窗口，服务器上跑监控也不再需要 Xvfb（只有 `login` / `export-cookies` 这两步仍然要图形界面）。这个文件就是你的登录凭据，权限默认收到 0600，别提交到仓库。

所以 `intervalSeconds` 可以设得比以前更放心：120 秒一轮约合每分钟 0.5 次，远低于之前实测触发风控的每分钟 3 次量级。

另外还有一道**全局请求闸**（`monitor.minRequestGapSeconds`，默认 30 秒）现在也管住了直连路径：它在每次真正发请求前**预约一个时间槽**，所以「立即检查」多任务、`once` 多任务、以及任何同时发起的调用都会被自动拉开，既不会并发打出去，也不会叠成短时高频。调试脚本走的是同一个闸。

**直连换掉了什么**，得说清楚：

- 复刻了 mtop 的 H5 签名 `md5(token&t&appKey&data)`。它是一行公开算法（不是 App 端依赖 native 库的 `x-sign`/`x-mini-wua`），但确实越过了本项目原先「不复刻任何签名」那条线；换来的是请求数从 5 降到 1。
- 筛选条件改成**由我们自己拼进请求体**。以前是靠解析页面**实际发出**的请求体来证明「筛选真的生效了」，现在这个校验退化成「检查自己有没有漏拼字段」——它仍能挡住拼装回归，但**挡不住服务端不认筛选**。想要那份服务端级别的确认，把 `search.mode` 设回 `"browser"`。
- 区域筛选的两种形态（预设 → `extraDivision`，具体省份 → `divisionList`）以前是页面自己决定的，现在由 `src/mtop.mjs` 的 `REGION_PRESETS` 判断；填了没在表里的城市名可能不生效，此时用 `filters.cityContains` 兜底。

### 客户端过滤的定位

**价格和地区都只在服务端过滤，不再配一遍客户端条件。** 请求体级别已经有校验（见上一节），再加一层客户端条件只会让人以为有两道防线，而它掩盖的正是"筛选压根没生效"这种真问题。

`filters` 里保留的是**服务端做不到的判断**：

| 条件 | 作用 |
| --- | --- |
| `requireKeywords` | 品牌白名单，实现「不要杂牌」 |
| `requirePattern` | 带边界的正则，如「144Hz 以上」（`requireKeywords` 写 "144" 会被 "1440P" 误命中）|
| `excludeKeywords` / `excludePattern` | 排掉「同款」「求购」「展示机」这类 |
| `excludeSellers` | 卖家黑名单 |

`minPrice` / `maxPrice` / `cityAnyOf` 这几个字段仍然保留在程序里（有用例覆盖），如果哪天原生筛选失效又不想被打扰，可以临时配上它们兜底。

### 关于 `onUnknownField`

接口不一定每轮都给出价格或发布时间。默认 `pass`：仍然推送，但在消息里标注 `⚠️ 未判定字段：publishTime`，心跳里也会累计计数——因为**漏报比误报更难被发现**。若你的关键词很宽、宁可少推也不要误推，改成 `reject`。

### 关于去重

只有**推送成功**的商品才会写入 `data/state.json`。因此：

- 被过滤掉的商品每轮都会重新判定，**降价后仍然会通知你**；
- 所有渠道都投递失败时不会标记为已推送，下一轮会重试。

## 通知渠道

| type | 必填字段 | 说明 |
| --- | --- | --- |
| `telegram` | `botToken`, `chatId` | 找 @BotFather 建机器人，chatId 可用 @userinfobot 查；命中消息带「打开商品」内联按钮 |
| `dingtalk` | `webhook`，可选 `secret` | 钉钉群机器人；填了 `secret` 会自动加签 |
| `wecom` | `webhook` | 企业微信群机器人 |
| `bark` | `key`，可选 `server` / `sound` | iOS 推送；命中消息带 `url` 参数，**点通知即可跳转商品页**，并按任务名分组；内容过长时自动改用 POST 接口（GET 会撞 HTTP 431 请求头上限） |
| `serverchan` | `sendKey` | Server酱 |
| `webhook` | `url`，可选 `headers` | POST JSON：`{title, body, url, group}` |

可以配多个渠道，任何一个成功即视为推送成功。

### 通知文案

命中消息固定压成两行，价格和商品名在最显眼的位置：

```
¥568 · 95新 AOC 2k 180电竞游戏27寸显示器 转让AOC 宙斯盾系列
上海 · 数码小铺 · 3 分钟前
```

- 商品名会先按句读在第一个自然边界截断、再按 40 字兜底截断——闲鱼标题常把整段描述、参数和客服话术塞进来。
- 字段抓不到时就地写成「价格未知 / 地区未知 / 时间未知」，不再另起一行堆诊断信息。
- 单任务不带任务名；**多个任务时**标题末尾会附上任务名，便于分辨是哪条规则命中。
- 钉钉/企业微信这类纯文本渠道不吃 scheme，因此正文里补的始终是网页链接。

### 关于点击跳转

Bark 和 Telegram 的正文都是纯文本，光把链接写进正文是**点不动**的，因此这两个渠道会额外带上跳转目标：

- Bark：`url` 查询参数 → 点整条通知直接跳转，并按任务名 `group` 分组；
- Telegram：内联按钮「打开商品」。

跳转目标由每个任务的 `jumpLink` 决定：

| 取值 | 跳转目标 | 说明 |
| --- | --- | --- |
| `app`（默认） | 接口返回的 `fleamarket://item?id=...` | 点一下**直接进闲鱼 App**（iOS + Bark 实测可用）；接口没给深链时自动回退网页链接 |
| `web` | `linkTemplate`（默认 `https://www.goofish.com/item?id={id}`） | 一定能打开，落到网页版商品页 |

正文里固定保留一份网页链接，方便复制粘贴。

**控制台里点命中行**按设备选链接（与上面的通知跳转是两件事）：

| 打开控制台的设备 | 点一行会打开 | 为什么 |
| --- | --- | --- |
| 电脑浏览器 | 在带着登录态的浏览器里新开标签打开 | 「点开看商品」会按需拉起浏览器，并把 `data/cookies.json` 里的登录态灌回去；拉不起来时自动回退到本地浏览器打开，不让点击落空 |
| 手机浏览器 | App 深链 `fleamarket://item?id=...` | 手机上闲鱼能接管这个 scheme，直接进 App；接口没给深链时回退网页链接 |

「点一下看商品」按需拉起浏览器打开，最多同时保留 5 个这样的标签页，超出的关掉最旧的。

**关于商品分享码 / 二维码**：PC 网页商品页**没有**分享入口（实测对全页所有元素的 `title`/`aria-label`/`alt`/`href`/`class` 穷举匹配 `分享|二维码|share|qrcode|复制|口令`，全部无命中），分享码是 App 端功能。但**不需要去解码二维码**——搜索接口给每个商品都返回了 App 深链 `targetUrl`（实测 30/30 条都有，且逐商品不同），扫码得到的跳转目标就是同一族地址：

```
fleamarket://item?id=1084546564468&referPageArgs=2K+显示器&gulSource=search&...
```

所以本工具直接用接口给的深链，既不用截图也不用解码。另外商品页 DOM 里还能拿到两个直达链接，需要的话可以自行拼：

```
https://www.goofish.com/create-order?itemId=<id>   # 直达下单页
https://www.goofish.com/im?itemId=<id>&peerUserId=<uid>   # 直达聊天
```

钉钉/企业微信是文本消息，客户端会自动识别正文里的 http 链接。

## 命令一览

```bash
node src/cli.mjs web          # 图形控制台（等价于 npm run web）
node src/cli.mjs run          # 纯命令行启动监控（默认命令）
node src/cli.mjs login        # 扫码登录；成功后自动把登录态写入 data/cookies.json
node src/cli.mjs export-cookies  # 把 profile 里已有的登录态导出到 cookie 文件（不导航、不请求、不用重新扫码）
node src/cli.mjs check        # 静态校验配置与运行环境
node src/cli.mjs once         # 跑一轮只打印，不推送；--notify 才推送
node src/cli.mjs dump         # 保存原始响应，用于接口字段变化时改适配层
node src/cli.mjs test-notify  # 测试所有通知渠道
```

通用参数：`--config 路径`、`--task 名称`。`web` 额外支持 `--port`、`--host`、`--token`、`--no-open`。也可用环境变量 `XIANYU_CONFIG` 指定配置。

## 调参建议

- **间隔可以设到 120 秒左右**。默认每轮恒为 1 次请求，120 秒一轮约合每分钟 0.5 次，远低于实测触发风控的每分钟 3 次量级。多任务会串行执行，总请求量按 `1/间隔` 累加。
- **多任务时注意总频率，程序也有一道全局闸**。`monitor.minRequestGapSeconds`（默认 30 秒）在真正发起搜索前统一等待，跨任务限制两次搜索的最小间隔——单个任务的 `intervalSeconds` 只约束它自己，几个 60 秒的任务叠加就可能踩线。启动时如果算出来合计超过 2 次/分钟，日志会直接提醒你调大间隔或减少任务。
- **调参和排查都不要短时间反复试探**。实测连续几次搜索就会触发风控，严重时直接让登录态失效、需要重新扫码。验证关键词或筛选条件用 `node src/cli.mjs once`（跑一轮就停，1 次请求）。
- **价格和区域都用 `nativeFilters`**（服务端过滤，30 个名额全落在条件内），不要再配一遍客户端条件。每轮 1 次请求，所以 `intervalSeconds` 可以设到 120 秒左右。
- **关键词越精确越好**。"2K 显示器" 比 "显示器" 少几十倍无效结果，也少几十倍被限流的概率。
- **`maxAgeMinutes` 在本项目里基本不生效**。闲鱼 PC 搜索响应通常不返回发布时间（实测 59 条里 57 条缺失），该条件会落到「时间未知」并按策略放行。真正防止重复推送的是去重表——同一条商品只会推一次。留这个字段是为了接口哪天补上发布时间后能直接用，启动时程序会就此告警。
- **用 `requirePattern` 表达带边界的条件**。"144Hz 以上" 写成 `requireKeywords: ["144"]` 会被 "1440P" 误命中，写成 `requirePattern: "(144|165|240)\\s*hz"` 才准。
- **`requireKeywords` 可以当品牌白名单**。填一组品牌名即可实现「不要杂牌」，比用排除词穷举杂牌可靠。
- **别把 `excludeKeywords` 写太窄**。"求购/仅拆封/展示机/代拍/回收" 这几类基本必排。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 日志出现「闲鱼弹出了风控验证（baxia 弹层）」 | 见下面「风控」一节。程序会立刻告警并按 `monitor.riskControlCooldownSeconds`（默认 30 分钟）长时间退避，不再反复撞 |
| 日志出现「筛选没生效 / 请求体没带全部条件」 | 拼装请求体时漏了字段（`buildSearchBody`）。按提示检查 `nativeFilters` 的取值是否是支持的形态 |
| 日志出现「请求被闲鱼拦截（RGV587_ERROR…被挤爆啦）」 | 分两种，先看处罚链接里的 `action`：`deny` 是直接拒绝（见下面「被『访问被拒绝』拦住」），其余按频率过高处理——调大 `intervalSeconds`（≥60）后再试；该错误码在登录失效时也会出现，若降速后依旧如此再重新 `login` |
| 日志出现「搜索接口被闲鱼直接拒绝（action=deny）」 | 不是频率问题，调间隔、重新登录、过验证都无效。跑 `node diagnose-risk.mjs` 看结论 |
| 日志出现「搜索接口要求登录」 | 会话失效，重新执行 `login` |
| 启动就报「登录态不可用 / 会话已失效」 | `data/cookies.json` 不存在或已过期。在终端跑 `node src/cli.mjs export-cookies`（把 profile 里现有的登录态落盘），或 `npm run login` 重新扫码 |
| 启动就报「服务端会话已失效」 | 同上，或 profile 未同步到本机 |
| 日志出现「回退到 DOM 解析」 | 搜索接口结构变了。`once` 仍能拿到商品则能用，但字段会缺；执行 `dump` 保存响应后按需改 `src/parse.mjs` |
| 命中数长期为 0 | 看心跳里的「扫描 N 条」。扫描为 0 是抓取问题，扫描很多但命中 0 是过滤太严 —— 用 `once` 看每条被跳过的原因 |
| 推送里出现「价格未知」 | 接口没返回价格。先跑 `dump` 保存原始响应，再看 `src/parse.mjs` 的取价字段是否需要调整 |
| 推送不出去 | `test-notify` 逐个渠道看报错，key 或 webhook 填错最常见 |
| 浏览器启动失败并提示 `Missing X server or $DISPLAY` | 服务器缺图形界面，用 `xvfb-run -a` 启动 |

## 风险与合规

- **违反《闲鱼用户协议》。** 本工具通过程序自动化访问闲鱼并抓取搜索接口，平台对这类行为有明确处置手段。处置是**有梯度**的，本项目实测到的顺序是：接口返回 `RGV587` → 处罚链接 `action=deny`（页面显示「访问被拒绝」）→ 登录态失效。再严重就是限制功能甚至封号。
- **只用小号，主号请勿使用。** 这不是客套话：本项目开发过程中同一个账号在几小时内被反复风控，最后直接导致登录态失效、必须重新扫码。
- **保持低频。** 默认每轮恰好 1 次请求、轮询 120 秒；全局闸 `monitor.minRequestGapSeconds` 保证「立即检查」多任务与调试脚本也不会并发或短时高频。**不要**为了"快一点"把这些值调小——被拒的请求本身就是又一次风控压力。
- **不要**把账号 cookie、`data/cookies.json` 或 `data/browser-profile` 交给任何第三方（含"代拍"服务），已有隐私泄露的公开报道。仓库的 `.gitignore` 已把整个 `data/` 排除在外。
- **本工具做了什么、没做什么**（如实说明，别只看标签）：
  - **没有**实现验证码绕过，**没有**伪造浏览器指纹，也**没有**逆向 App 端签名（`x-sign` / `x-mini-wua` 那一族依赖真机 native 库，本项目不碰）。
  - **复刻了网页端公开的 H5 mtop 签名**（`md5(token&t&appKey&data)`）。这本身也是一条取舍：它把每轮请求数从 5 降到 1，但确实越过了本项目早期「不复刻任何签名」的自我约束。
  - 默认**不携带**平台下发的风控状态 cookie（`search.riskCookies: "omit"`）。实测它只是把平台施加的处罚带过来、并不承担功能，不带它请求照常成功；但这等于让客户端绕开平台施加的这道处罚。默认值如此，是否接受由使用者自行判断。
- **资金安全**：本工具完全不接触支付环节，不代下单、不代支付。

## 风控

闲鱼用阿里系的 **baxia 风控**。撞上之后提示码都是 `RGV587_ERROR`，但有**两种完全不同的形态**，处理方式相反，只能看处罚链接里的 `action` 区分：

| `action` | 现象 | 有无人工作用 |
| --- | --- | --- |
| `captcha` / `verify` | 页面弹滑块 | 有。用**普通 Chrome** 打开同一个 profile 过掉：`node open-profile-in-chrome.mjs`（自动化窗口里过不了，别在里面反复试） |
| `deny` | 页面显示「访问被拒绝」，没有可点的验证项 | **没有**。调大间隔、重新登录、过验证都无效 |

程序侧的配合：两种都会**立刻告警**并按 `monitor.riskControlCooldownSeconds`（默认 30 分钟）长时间退避——重试没有意义，只会让风控等级更难下来。想确认当前是哪种形态，跑 `node diagnose-risk.mjs`（一次页面加载，顺带打出会话状态与同一批里其它 mtop 接口的结果）。

**最省事的办法是从源头上不撞它**：`intervalSeconds` 保持 120 秒以上、别为了调试反复手翻搜索页、多任务时留意启动时那条总频率提醒。调试用 `once` 或 `debug-single-cycle.mjs`（跑一轮就停），不要连着跑。

### 这一节是怎么定性的

同一个错误码有两种形态，从日志里看不出区别，所以 `diagnose-risk.mjs` 用一次页面加载把关键事实摊开：会话是否真的有效、**同一批请求里其它 mtop 接口成不成功**（只有 search 失败＝搜索接口被单独判定；全都失败＝会话问题）、处罚链接给的是 `deny` 还是验证。

结论是：`deny` 不是频率问题（停机数小时后**第一个**请求就会被拒）、不是登录问题（同一批里其它接口全 `SUCCESS`）、也**与客户端形态无关**（不启浏览器的纯 HTTP 请求同样会复现）。所以程序不做"换个姿势再试一次"这种事，而是退避 + 告警。

几条已经验证过、不必再花时间的路：

- **换 UA / 手机版网页没用**：`www.goofish.com/search` 在手机 UA 下仍是同一个 PC SPA、同一个接口；也没有可用的 H5 搜索站。
- **只去掉自动化特征没用**：`browser.attach` 让 Chrome 自己启动（页面里 `navigator.webdriver` 为 false）再 CDP 附加，实测对 `deny` 毫无影响——`connectOverCDP` 与 `launch` 在 CDP 层走的是同一条初始化路径。字段留着，别指望它。
- **别改走 App 协议**：移动端那套签名（`x-sign` / `x-mini-wua` / `x-sgext` / `x-umt`）依赖真机 native 库，公开的复刻方案目前仍过不了服务端校验。

## 目录结构

```
src/
  cli.mjs        命令入口与参数解析
  config.mjs     配置加载、${ENV} 展开、校验
  browser.mjs    Playwright 会话：登录态、二维码截图、页面生命周期
  search.mjs     browser 模式的搜索收集（**已弃用**，保留仅为回退）
  mtop.mjs       直连搜索（默认）：构造请求体、H5 签名、每轮 1 次请求、全局请求闸
  cookies.mjs    文件版 cookie 仓库：登录态的唯一来源，mtop 响应里的 Set-Cookie 会回写到这里
  parse.mjs      闲鱼响应字段适配层（接口变化只改这里）
  rules.mjs      命中判定（纯函数）
  store.mjs      已推送去重表
  notify.mjs     通知渠道与文案
  monitor.mjs    主循环：调度、退避、心跳、告警
  supervisor.mjs 运行时管理：生命周期、状态快照、命中历史、扫码登录
  server.mjs     控制台 HTTP 服务：JSON 接口、SSE 实时日志、令牌校验
  web/index.html 控制台前端（单文件，零依赖）
test/            node --test 单测与集成测试（用假 Page / 假 fetch / 假 supervisor）
deploy/          systemd 单元示例、容器 entrypoint（自带 xvfb 包装）
docs/           调研记录：闲鱼开源生态、mtop 签名方案、反检测与真机路线（含证据分级与出处）
start.cmd        Windows 双击启动控制台
start.sh         Linux / NAS 启动控制台（自动包 xvfb-run）
check-console.mjs  控制台验收：真机加载页面、抓 JS 错误、点测试通知与启停
check-console-tasks.mjs  任务增删改验收：走一遍编辑/新建/即时生效/删除，跑完自动还原 config.json 与运行时
check-console-ui.mjs     主题/滚动条/单任务开关验收：含亮色主题对比度与开关失败回滚，跑完自动还原 config.json
check-console-notify.mjs 推送开关（总开关 + 单任务）/命中行跳转链接/弹层关闭按钮验收，跑完自动还原 config.json
check-design-conformance.mjs  设计规范验收：外壳结构、表面梯度、强调色唯一、无 emoji、圆角阶梯、逐路由单屏、卡片行内对齐
check-dom-contract.mjs   静态核对：JS 引用的每个元素 id 在 HTML 里都存在（不需要浏览器）
check-task-form-filters.mjs  任务表单新筛选字段的往返验证（设置→保存→进配置→回填→清空），只走本地接口
clean-test-residue.mjs   清理验收脚本留下的测试任务在命中历史与去重表里的记录（默认只预览，--dry-run）
debug-single-cycle.mjs   受控调试：配好原生筛选后只跑一轮就停，用来确认筛选是否真的生效（不反复试探）
diagnose-risk.mjs        风控体检：一次页面加载判定是限流、会话失效还是「直接拒绝」，并给出下一步
clean-test-residue.mjs   清理验收脚本留下的测试任务在命中历史与去重表里的记录（默认只预览，--dry-run）
check-ui-metrics.mjs     界面度量：页面高度、各区高度、超长文本、偏小按钮、横向溢出
check-publish-dropdown.mjs  browser 模式「新发布」下拉的离线验收（**已弃用路径**，保留备查）
```

跑测试：`npm test`（不需要 Playwright 浏览器内核，也不需要登录）。

## 许可证

[MIT](LICENSE) © 2026 timefunnel。

**但要说清一件事**：MIT 授予的是**代码**的使用、修改、分发权利，它**不会**让「用这个工具去跑闲鱼」这件事变得合规。开源许可解决的是著作权问题，平台服务条款是另一回事——README 开头的免责声明与「风险与合规」一节仍然完全适用。

另外，本仓库的代码没有拷贝任何第三方项目：调研过的最有用的那个闲鱼客户端是 GPL-3.0，只借鉴了「协议长什么样」，实现是独立写的；调研期间下载的第三方 README / 源码一律留在 `.gitignore` 里，不随本仓库分发。
