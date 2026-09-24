# 闲鱼监控：反检测浏览器 vs 真机 UI 自动化 —— 开源方案调研

> 调研对象：`D:\stronger\xianyu-monitor`（Playwright 驱动有头 Chrome 抓 `...pc.search`，现被 baxia 风控 `RGV587` + `action=deny` 拦截，无验证码；同账号手机 App 正常）
> 数据采集日：**2026-09-24**（本机日期）。所有版本号/日期/许可证均为当日实测查询，未编造。
> 证据标签：**【已读仓库文档】**源码或官方 README 原文 · **【已读本机源码】**本机 `node_modules/playwright-core@1.63.0` 代码 · **【搜索结果显示】**第三方页面/社区说法，未独立复现 · **【推测】**我的推断
> 配套文档：本仓库已有的 [RGV587-调研简报.md](RGV587-调研简报.md)（RGV587 定义、x5sec、移动端 H5 结论），本文**不重复**其内容。

---

## 0. 结论先行

1. **已排除的只有一个信号，这个判断是对的，而且比想象的更关键。** 本机 Playwright 1.63.0 源码确认：`--enable-automation` / `navigator.webdriver` 与「CDP 泄漏」是**两条完全独立的检测面**。你的 attach 方案只关掉了第一条。第二条（`Runtime.enable` / 输入域坐标 / 世界名）在 attach 模式下**原样存在**——因为 `connectOverCDP` 走的是同一套 `CRPage` 初始化代码。
2. **attach 路线可以叠加 patchright / rebrowser-patches，这是本次调研最有操作价值的结论。** 二者都工作在 **driver（协议客户端）层**，不依赖它们自己的启动器；`connectOverCDP` 依然建立 CDP 会话，patch 逻辑照样生效。**Camoufox 不能叠加**——它是 Firefox/Juggler，与 Chrome attach 物理上互斥。
3. **一条被忽略的、同站点同风控的公开报告**：第三方项目 voltwake/xianyu-monitor 明确记录了在 goofish.com 上的对照实验结果——`page.goto(搜索URL)` ❌ 被 baxia 拦截，而「点击搜索框 + 输入 + 回车」✅ 正常。如果你的代码用 `page.goto()` 打开搜索页，**这是比换浏览器更便宜、更可能立刻见效的一个变量**。
4. **真机路线在「不 root」前提下确实可行且被社区实践**，但代价是：一台常亮常开的安卓机、屏幕必须点亮解锁、App 更新导致选择器失效、以及**账号风控从"网页端被标记"变成"账号本身可能被封"**——后者不可逆，风险等级更高。
5. **优先级建议：先做第 1 类的三项低成本增量验证（约 1–2 人日），同时并行准备第 2 类的方案选型。** 不要现在就投入真机，因为网页链路还有未穷尽的变量；但也不要指望 patchright 单独解决问题。

---

## 第 1 类：反检测浏览器自动化

### 1.1 这些项目分别在「修补什么」

**【已读仓库文档】** 全部来自各项目官方 README 原文：

| 项目 | 修补层次 | 具体修补内容（README 原文要点） | 浏览器 |
|---|---|---|---|
| **patchright** | **Playwright driver**（TS 补丁，改 `packages/playwright-core/src/server/frames.ts`） | ① 避免 `Runtime.enable`，改用 isolated ExecutionContext 执行 JS；② 禁用 Console API 以消除 `Console.enable` 泄漏（副作用：console 不再可用）；③ 调整默认启动参数：**移除** `--enable-automation`、新增 `--disable-blink-features=AutomationControlled`、移除 `--disable-component-update` / `--disable-extensions` / `--disable-popup-blocking`；④ 杂项泄漏；⑤ 支持 Closed Shadow Root | 仅 Chromium（README 明确：Firefox/WebKit **不支持**） |
| **rebrowser-patches** | **Puppeteer / Playwright 库源码**（`patch` 命令改 `node_modules`） | ① `Runtime.enable` 泄漏，三种模式：`addBinding`（默认，主世界）/ `alwaysIsolated`（隔离世界）/ `enableDisable`；② 改 `sourceURL`（Puppeteer 的 `//# sourceURL=pptr:...` → 通用名，**Playwright 侧不适用**）；③ 改 utility world 名（`REBROWSER_PATCHES_UTILITY_WORLD_NAME`）；④ 加 `browser._connection()` 便利方法 | 仅 Chrome（README：WebKit/Firefox 需另开 issue） |
| **nodriver** | **完全不用 WebDriver/Selenium**，直接 CDP | 不"修补"而是**没有 Selenium 层**；无 chromedriver 二进制；可选 `expert=True`；README 明确「disconnect shadow-roots 会造成更易被检测」的取舍 | Chromium 系（chrome/chromium/edge/brave） |
| **undetected-chromedriver** | Selenium + **修改过的 chromedriver 二进制** | 老牌路线，**已被作者定位为 nodriver 的前身** | Chrome |
| **camoufox** | **Firefox 内核（C++/Juggler 层）** | 指纹在 C++ 实现层拦截（非 JS 注入），全部 navigator/屏幕/WebGL/字体/时区/WebRTC 属性；Juggler 打补丁让 Playwright 拿到页面的"隔离副本"；禁用 telemetry/debloat | **Firefox fork**（文档明确：**不能**注入 Chromium 指纹；某些 WAF 检测 Spidermonkey 引擎行为，无法伪装） |
| **playwright-stealth** | **页面内 JS 注入** | 从 `puppeteer-extra-plugin-stealth` 移植，README 自述「**Not perfect**」；做法是 JS 覆写 `navigator.*` 等 | 三引擎通用（但只是 JS 层） |

**关键分层认知【推测，但有文档支撑】**：patchright / rebrowser 修的是**协议层**（CDP 命令），camoufox 修的是**内核层**（浏览器实现），playwright-stealth 修的是**页面层**（JS 覆写）。rebrowser 官方博客明确说：JS 覆写 console 对象「**doesn't work**」——Cloudflare 和 DataDome 不受影响，因为它们能检测 Proxy / `Object.defineProperty` 的副作用。**页面层方案对 baxia 这类成熟风控期望值应当放低。**

---

### 1.2 除了 `navigator.webdriver`，CDP 还会泄漏哪些信号

这是本次调研技术含量最高的部分。**我直接读了本机 `playwright-core@1.63.0` 的打包源码**（`node_modules/playwright-core/lib/coreBundle.js`），以下机制**不是搜索来的说法，而是代码事实**。

#### 1.2.1 泄漏清单

| 信号 | 机制（为什么会泄漏 / 怎么被检测） | 本机源码位置（【已读本机源码】`coreBundle.js`） | 谁能修 |
|---|---|---|---|
| **`Runtime.enable` 泄漏**（最重要） | Playwright 依赖 `Runtime.enable` 拿到每个 frame 的 `ExecutionContextId`。一旦执行，浏览器开始向 CDP 客户端发送 `Runtime.consoleAPICalled`；页面侧只需几行 JS，就能通过"自己被 CDP 读取"的副作用（对象 getter 被触发 / 时序差异）判断自动化存在。DataDome 2024-06 公开此技术，rebrowser 称「**all major anti-bot software**」都在用 | **`CRPage` / `FrameSession._initialize` 在每个 frame session 上发送**：`coreBundle.js:37625` `this._client.send("Runtime.enable", {})` | patchright（默认）、rebrowser-patches（`addBinding` 默认模式） |
| **`Page.addScriptToEvaluateOnNewDocument`（带 `worldName`）** | 用于创建 **命名隔离世界**并注入 init script。它本身不算"泄漏字符串"，但 ① 它建立了可被探测的隔离世界；② 注入时机可被 **Timing Attack** 探测（patchright 自述 InitScript 走 Playwright Routes 注入，**可被 timing attack 检测**，但认为目前无风控在查） | `coreBundle.js:37626-37629`：`worldName: this._crPage.utilityWorldName` | patchright（改为 Route 注入）；rebrowser-patches（改 world 名） |
| **utility world 名带 Playwright 指纹** | Chromium 路径下世界名是 **`__playwright_utility_world_` + 每页 guid**，字符串里直接含 `playwright`。另有 WebKit 路径常量 `__playwright_utility_world__` | `coreBundle.js:37280` `this.utilityWorldName = \`__playwright_utility_world_${this._page.guid}\``；常量见 `41582` / `45031` / `46749` | rebrowser-patches（`REBROWSER_PATCHES_UTILITY_WORLD_NAME`，README 属 Puppeteer 侧，Playwright 侧 README 也列为支持项） |
| **`Console.enable` / `Log.enable`** | `Console.enable` 让 CDP 收到 `Console.messageAdded`。**对 Chromium 页面初始化路径，Playwright 发的是 `Log.enable` 而不是 `Console.enable`**；`Console.enable` 出现在 **WebKit / WebView 的 worker session** 上。所以对"Chromium 有头 Chrome"场景，**这一条的优先级低于 `Runtime.enable`** | Chromium 页面 init：`37623` `this._client.send("Log.enable", {})`。`Console.enable` 的调用点（`46631`、`49071`）经上下文核实属于 `WKExecutionContext` / `WVExecutionContext` worker | patchright（README 声称禁用 Console API 以消 `Console.enable`） |
| **`Page.createIsolatedWorld`** | 同上，创建隔离世界；Playwright 还会对每个 frame 调用一次 | `coreBundle.js:37606-37610` | patchright（改为按需懒创建） |
| **`Target.setAutoAttach`（`waitForDebuggerOnStart: true`）** | 自动附加到所有新 target（iframe / worker），并且**让它们等待调试器**。`waitForDebuggerOnStart` 会改变 worker/子 frame 的启动时序 | `coreBundle.js:37631` | 无现成补丁（【推测】需自行改 driver） |
| **`Runtime.runIfWaitingForDebugger`** | 与上一条配对，进一步暴露"有调试器在等待" | `coreBundle.js:37670` | 无现成补丁 |
| **输入域坐标泄漏（Input Domain Leak）** | CDP 派发的鼠标事件默认把 **`pageX/pageY` 设成与 `screenX/screenY` 相同**——只有全屏时才可能相等。检测代码：`is_bot = (e.pageY == e.screenY && e.pageX == e.screenX)`。另外 CDP **无法派发 `CoalescedEvents`** | 不在 Playwright 内，在 Chromium 侧（crbug#1477537） | **CDP-Patches**（Vinyzu）——改为 OS 级事件派发。**注意**：该 repo 声明 crbug 已在 Chrome 142+ 修复，届时此包仅剩 Select Elements 用途 |
| **`navigator.webdriver` / `--enable-automation`** | 你**已经排除**的那一条 | — | 你已排除；patchright 也顺手处理 |

#### 1.2.2 关于「`Runtime.evaluate` 的序列化特征」和「堆栈里的 CDP 痕迹」

- **`Runtime.evaluate` 序列化**【已读仓库文档】：rebrowser-patches 里有对 Puppeteer `//# sourceURL=pptr:...` 的修补，但**这是 Puppeteer 专有**，Playwright 的 `evaluate` 走 utility script + `InjectedScript`，**没有对应的 `pptr:` 泄漏**。搜索材料里常见的"sourceURL 泄漏"结论**不能直接套到 Playwright 上**。
- **堆栈痕迹**【推测 + 文档】：Playwright 的页面内执行主要发生在 **隔离世界**（utility world）中，主世界只保留 binding。理论上主世界堆栈里不应出现 Playwright 函数名；但 `Runtime.evaluate` 拿主世界 `globalThis` 的 `objectId` 来**反推 context id**（见下）——patchright 正是用这个手法绕开 `Runtime.enable`，这本身就说明"通过 `Runtime.evaluate` 探测主世界"是一条可行且**必然产生 CDP 流量**的路径。
- **`Runtime.addBinding` / `__playwright__binding__`**【已读本机源码】：常量 `kBindingName = "__playwright__binding__"`（`coreBundle.js:23011`），在 `this._crPage._browserContext.needsPlaywrightBinding()` 条件下注入（`37635-37636`）。**注意这是条件性的**，不是每次都注入——不要当作必然泄漏。

#### 1.2.3 「attach 到普通 Chrome」到底绕过了什么、没绕过什么

**【已读本机源码】——这是回答你问题 1.2 的核心证据链：**

1. `chromium.connectOverCDP()` 最终调用 **`CRBrowser.connect(...)`**：`coreBundle.js:43146`（在 `_connectOverCDPImpl` 内，`43105` 起）。
2. `CRBrowser` 在收到 target 附加事件时 **`new CRPage(...)`**：`coreBundle.js:38446`。
3. `CRPage` 的每个 frame session 都会跑 **`_initialize()`**，其中**无条件**发送 `Runtime.enable`：`coreBundle.js:37594-37672`。

**结论：attach 模式与 `launch()` 模式在 CDP 命令层面是同一条代码路径。** 你移除了 `--enable-automation`（浏览器侧 flag），但没有、也无法通过"自己启动 Chrome"移除 Playwright driver 发出的 `Runtime.enable`。这**完全解释了**为什么 attach 之后依旧 `deny`——不是你做错了，是这个方向本来就不覆盖第二类信号。

---

### 1.3 这些项目是否支持 `connectOverCDP` 附加模式？

**这是你最关心的问题。答案是：patchright / rebrowser-patches 可以，且这是你现有路线上唯一还能叠加的补丁；camoufox 不行。**

| 项目 | 能否叠加到「attach 到普通 Chrome」 | 依据 | 置信度 |
|---|---|---|---|
| **patchright** | ✅ **可以，且理论上最对口** | patchright 的补丁改的是 **`server/frames.ts`**，其中 `_context()` 通过 **`this._page.delegate._sessionForFrame(this)._client`** 拿 CDP session，用 `Runtime.evaluate` + `serializationOptions:{serialization:"idOnly"}` 反推 contextId，并用 `Page.createIsolatedWorld` 建隔离世界。**这些操作只依赖"存在一个 CDP session"，与浏览器是谁启动的无关**（【已读仓库文档】`driver_patches/framesPatch.ts`） | 代码层推断**高**；官方文档**未**声明 `connectOverCDP` 是受测路径 → **中** |
| **rebrowser-patches** | ✅ **可以（Node 侧最省事）** | 它不是启动器，而是**对 `node_modules` 打补丁的 patcher**（`npx rebrowser-patches patch --packageName playwright-core`）。drop-in 包 `rebrowser-playwright-core` 用法与原生一致，`connectOverCDP` API 不变 | 机制上**高**；但**版本落后**（见 1.5） |
| **camoufox** | ❌ **不行（物理互斥）** | 它是 **Firefox fork**、走 **Juggler** 协议。你的 Chrome attach 与它没有任何可拼接点；要用 camoufox 必须用它自己的 `Camoufox()` 启动器 + 重写为 Firefox 指纹 | **高** |
| **nodriver** | ⚠️ **可以"attach"，但不是补丁** | README 明确：「**can connect to a running chrome debug session**」，且有工具把 `undetected_chromedriver.Chrome` 转成 nodriver Browser。但它是**另一套 API**（async、不用 Playwright），等于重写浏览器层 | **高** |
| **undetected-chromedriver** | ❌ 不适用 | Selenium 体系，与 Playwright 无关 | **高** |
| **playwright-stealth** | ✅ 可叠加但价值低 | 纯页面 JS 注入，与 attach 无关；rebrowser 博客已说明此类修复对成熟风控**无效** | **中** |
| **CDP-Patches**（附加发现） | ✅ **可叠加，且针对 attach 场景特别有意义** | 它把点击/滑动/输入改为 **OS 级事件派发**，绕过 Input Domain 坐标泄漏。**要求 headful**（你本来就是有头 Chrome），需要 `pid` 或 `browser` 对象 | **高**（README 明确） |

> **⚠️ 需要实证的空白**：上述"patchright 支持 connectOverCDP"是**我从补丁代码结构推断**的，**没有找到官方文档或 issue 明确背书**。若采用，第一件事应当是**用公开检测页（brotector / rebrowser-bot-detector / deviceandbrowserinfo）在 attach 模式下做 A/B 对照**，确认 patch 确实生效（rebrowser 的 patch 有 `REBROWSER_PATCHES_DEBUG=1` 调试输出来验证是否打上）。

---

### 1.4 针对阿里系（淘宝/闲鱼/大麦）baxia 风控的公开实测报告

**先给一个诚实的总体判断：我没有找到任何一份"patchright / camoufox / rebrowser 对 baxia 的量化成功率报告"。** 现有材料是碎片化的，且多数不是针对 baxia。以下按证据强度排列。

**A. 最相关的一条：同站点（goofish.com）、同风控（baxia）的行为对照实验**
【搜索结果显示】`voltwake/xianyu-monitor` 的 README「技术原理」章节给出了一张对照表，原文数据：

| 操作 | 结果 |
|---|---|
| `page.goto(searchURL)` | ❌ 被 baxia 拦截 |
| `page.click(搜索框) + type + Enter` | ✅ 正常 |
| headless Chrome | ❌ "非法访问" |
| 非 headless Chrome | ✅ 正常 |

同文件另称：首次访问闲鱼需用 **AppleScript 在 Chrome 地址栏输入 URL**，因为 `page.goto()` 会被 baxia 拦截；并称 `page.click()` / `page.keyboard.type()` 产生 `isTrusted=true` 事件「与真人点击无差别」；建议扫描间隔 **≥ 30 分钟**；当前仅支持 **macOS**。
> **我的评价【推测】**：这是本次调研**对你最可能有直接帮助的一条**。它把问题定位到**导航方式**而非浏览器指纹。注意它也承认"冷启动首次 scan 可能失败"、"未登录只能看到 6 小时前的商品"。它**没有**用量化成功率，也没有说明是否使用 attach 模式。**"CDP Input 与真人无差别"这个说法与 CDP-Patches 的结论相冲突**（后者指出 CDP 输入有坐标与 CoalescedEvents 泄漏），应当以"可被专业风控区分"为准。

**B. 反检测方案的横向短测（非阿里系）**
【搜索结果显示】一篇 2026-08-31 的个人博客在同一台 Mac、同一出口下对原生 Playwright / patchright / camoufox / nodriver 做了 headless 短测：

| 方案 | `navigator.webdriver` | UA 含 `HeadlessChrome` | Sannysoft | Incolumitas FAIL 数 |
|---|---|---|---|---|
| Playwright | `true` | 是 | 6 通过 / 2 失败 | 5 |
| Patchright | `false` | **是** | 7 / 1 | 4 |
| Camoufox | `false` | 否 | 7 / 1 | 1 |
| Nodriver | `false` | **是** | 7 / 1 | 4 |

作者结论：camoufox 在 headless 下表现最好；patchright / nodriver 仍暴露 `HeadlessChrome` UA；该测试**不是成功率压测、也未接入真实平台账号**；并特别强调「**浏览器能打开页面，不代表**绕过风控，真实风控还看 IP、TLS、账号状态、频率、行为序列」。
> **我的评价【推测】**：对你有两条直接启发：① 该测试是 **headless** 配置——而 patchright 官方最佳实践就是 **headful + 真实 Chrome + 持久化 context**，所以"Patchright UA 仍含 HeadlessChrome"**不构成对你 headful 场景的否定**；② Camoufox 分数最好，但它要求你放弃 Chrome 与 baxia 的网页链路的一切现状——迁移成本最高。

**C. 阿里系风控/逆向的公开材料（非反检测浏览器实测）**
- 【搜索结果显示】有 CSDN 文章讨论淘宝/闲鱼**抓包与过 root 检测**，提到闲鱼需 hook `SwitchConfig` 特定方法、并涉及 Xposed 框架检测规避 → **说明闲鱼 App 侧存在 root / hook 检测**（与"加固"说法一致）。
- 【搜索结果显示】有文章称 Selenium 修改 chromedriver 二进制 + `ChromeOptions` 隐藏 `navigator.webdriver` 可解决淘宝登录反爬 → **未提供量化数据，且"只改 webdriver"恰好是你已证伪的结论**，参考价值低。
- 【搜索结果显示】`RGV587` 的社区归因（频率过高、缺 `bx-ua`/`bx-umidtoken`、cookie 与页面流程不匹配、环境被识别、同 IP 连坐）已在 [RGV587-调研简报.md](RGV587-调研简报.md) 中整理，此处不重复。

**D. 明确的负面/失败信号**
- 【搜索结果显示】`Automatic_ticket_purchase#27`：大麦下单被拦时 `ret` 含 `RGV587_ERROR` + `FAIL_SYS_USER_VALIDATE`，**换账号无效**。
- 【搜索结果显示】`tickets#45`/`#19`：同类报错维护者的建议是**重新登录/换浏览器登录**，**成功率无量化**。
- 【搜索结果显示】`TSDK#18`：有报告称 Playwright 中「**自动、手动都无法通过**验证，可能环境被识别」——对 Playwright 是明确的负面信号。
- 【搜索结果显示】`xianyuapis#4`：闲鱼 `mtop.taobao.idlemessage.pc.login.token` 被拦时附 `action=captcha`。

> **诚实结论**：**没有任何公开材料能证明 patchright/rebrowser 可以解开 baxia。** 但有**机制性理由**相信它们能消掉你目前唯一确认未处理的 CDP 信号（`Runtime.enable`），这是"值得一试并且能被证伪"的实验，不是"已知有效"的方案。

---

### 1.5 许可证与维护状态

**【已读仓库文档】** 全部为 2026-09-24 实测查询（GitHub API / npm registry / PyPI / LICENSE 文件原文）。

| 项目 | 最新版本 | 最近发布 | 最近提交 | Stars | 许可证 | 维护状态判断 |
|---|---|---|---|---|---|---|
| **patchright**（driver） | — | — | `2026-09-13` | 4,670 | **Apache-2.0** | 🟢 **活跃** |
| **patchright-python** | **1.63.0** | `2026-09-20` | `2026-09-20` | 1,527 | **Apache-2.0** | 🟢 **最活跃，且版本号与 playwright 1.63.0 对齐** |
| **patchright**（npm） | **1.63.0** | `2026-09-08` | — | — | Apache-2.0 | 🟢 活跃 |
| **rebrowser-patches** | **1.0.19** | `2025-05-09` | `2025-05-09` | 1,433 | ⚠️ **npm 声明 MIT，但仓库根目录无 LICENSE 文件**（GitHub 检测为 `none`） | 🟡 **停滞约 16 个月** |
| **rebrowser-playwright-core** | **1.52.0** | `2025-05-09` | — | — | Apache-2.0 | 🟡 **停滞；README 自称"最新完整测试版本 Playwright 1.52.0（2025-04-17）"，落后本机 1.63.0 约 11 个 minor** |
| **nodriver** | **0.50.3** | `2026-05-13` | `2026-05-13` | 4,770 | **AGPL-3.0** ⚠️ | 🟡 半年一次更新；**AGPL 对闭源/商用不友好** |
| **undetected-chromedriver** | **3.5.5** | `2024-02-17` | `2025-07-05` | 12,853 | **GPL-3.0** | 🔴 **pip 包停更约 2 年 7 个月**；作者已把 nodriver 定位为后继者 |
| **camoufox**（Python 包） | **0.5.6** | `2026-09-06` | `2026-09-21` | 12,107 | **MPL-2.0** | 🟠 **README 自述："2026 年当前状态：因个人原因有约一年维护空窗……目前正在积极开发中"**；且明确「项目仍在开发中，可能不适合稳定生产使用」 |
| **AtuboDad/playwright_stealth** | **2.0.3** | `2026-04-04` | `2024-07-29` | 986 | **MIT** | 🟡 有发版但提交停在 2024；README 自述「Not perfect」 |
| **CDP-Patches** | **1.1** | `2025-09-28` | `2025-09-28` | — | **GPL-3.0** | 🟡 基本停止维护；**自述 crbug 已在 Chrome 142+ 修复**，仅剩 Select Elements 用途 |
| **playwright**（基线） | 1.63.0（本机） | — | `2026-09-24` | — | Apache-2.0 | 🟢 活跃 |

**⚠️ 版本兼容风险提示【推测】**：你本机是 **playwright 1.63.0**，而 **rebrowser-playwright-core 停留在 1.52.0**。直接换成 rebrowser 的 drop-in 包意味着**把 Playwright 降级 11 个 minor**——这会引入与你现有代码无关的行为变化，风险不小。相比之下 **patchright 1.63.0 与你的版本号完全对齐**，迁移面更小（改 import / 换 npm 包名即可，API 为 drop-in）。

---

## 第 2 类：真机 / 模拟器 UI 自动化

### 2.1 能力边界（不 root 的普通安卓手机）

| 方案 | 技术原理 | 不 root 可用？ | 需要 ADB？ | 需要 PC 常连？ | 屏幕/后台 | 依据 |
|---|---|---|---|---|---|---|
| **uiautomator2**（openatx） | **设备端一个基于 UiAutomator 的 HTTP 服务（jar）**，Python 客户端经 HTTP 调用 | ✅ **是**（README 未列 root 前置；root 相关匹配全是 XML "root node" 语义） | ✅ 经 `adbutils`，USB 或 TCP/IP | 首次部署需要；之后可脱机（服务在设备上跑） | 见 2.2 | 【已读仓库文档】README 原文：「Device Side: Runs an HTTP service based on UiAutomator」「Python Client: Communicates with the device side via HTTP protocol」；依赖见 `adbutils` |
| **Appium**（UiAutomator2 driver） | **代理到 UiAutomator2 server**，底层是 Google UiAutomator（instrumentation） | ✅ **是** | ✅ 需要 `ANDROID_HOME`/`ANDROID_SDK_ROOT` | 是（driver 跑在 PC） | **可保持唤醒**：设置项 `wakeLockTimeout` 默认持有 wake lock **24 小时**以防止设备休眠 | 【已读仓库文档】README 原文 |
| **Appium 的副作用（重要）** | — | — | — | — | **默认会「抑制其他无障碍服务」**：`disableSuppressAccessibilityService` 设为 `true` 才不抑制 | 【已读仓库文档】README 原文，设置项说明 |
| **AutoJs6**（SuperMonster003） | **Android 无障碍服务（AccessibilityService）+ Rhino 跑 JS** | ✅ **是**；root 为**可选增强** | 不需要 | **不需要 PC**（App 内运行） | 有「后台弹出界面」「所有文件管理权限」开关（**明确针对小米/Vivo**）；通知监听支持 `requestRebind` 自动重连 | 【已读仓库文档】README 原文：`auto.state` 获取无障碍状态、`shizuku.state` 获取 Shizuku 状态；「支持利用 Root 权限扩展功能」 |
| **Auto.js（原版）** | 同上的初代 | ✅ | 不需要 | 不需要 | — | 仓库最后提交 **2023-02-11**，**已废弃** |
| **Airtest** | 图像识别（CV）+ Poco 控件树 | ✅ 是 | ✅ 需要（Android） | 是 | — | PyPI：airtest 1.4.3（2025-12-04）；pocoui 1.0.94（**2023-12-28，已停滞**） |
| **scrcpy** | ADB 镜像 + 键鼠注入（可 `--otg` 走 HID） | ✅ **是**，README 明确「**does not require root access or an app**」 | ✅ 需要 USB 调试（**OTG 模式不需要**） | **是，必须 PC 常连** | 镜像需设备亮屏；**可控但需 PC 侧驱动** | 【已读仓库文档】README 原文 |

**「uiautomator2」命名歧义澄清**【已读仓库文档】：存在两个同名概念——**Google 官方的 `UiAutomator`**（Java 测试框架，Android 平台自带）与 **openatx 的 Python 包 `uiautomator2`**（把上述能力封装成 HTTP 服务 + Python API）。Appium 的 UiAutomator2 driver 用的是**前者**（Google 的），与 openatx 的包不是同一件事，只是名字撞车。

### 2.2 后台运行 / 熄屏运行 —— 这是真机路线的硬约束

**【已读仓库文档 + 推测】** 结论：**「熄屏运行」对 UI 自动化基本不成立。**

- Appium 提供了 `wakeLockTimeout`（默认 24h wake lock）来**防止设备休眠**——这从反面说明：**框架本身假定屏幕/设备必须保持唤醒**，否则无法工作。
- 无障碍服务（AutoJs6 路线）在国产 ROM（MIUI / EMUI / ColorOS）上被后台限制/杀死是**普遍问题**；AutoJs6 README 专门为小米/Vivo 加了「后台弹出界面」开关，并修复「浮动按钮增强后台启动 Activity 的安全性以避免应用崩溃」——这些都是**在与系统后台限制搏斗的痕迹**。
- **Android 10+ 限制后台启动 Activity**、**Android 11+ 进一步收紧**，会让"从后台把闲鱼拉到前台"这一步变得不可靠。
- 我可以确定的机制是：**UI 自动化要求目标 App 处于前台且完成渲染**。因此现实做法只能是「**屏幕常亮 + 常充电 + 目标 App 长时间保持前台**」，而不是"熄屏后台跑"。【推测，但有多条文档间接支撑】

### 2.3 社区对「阿里系 App + 自动化」的反馈

| 结论 | 证据 | 强度 |
|---|---|---|
| **闲鱼 App 存在 ADB/自动化输入检测** | 【搜索结果显示】`lingxi7090/xianyu-auto`（灵犀助手）README 原文：「闲鱼使用自定义组件，**检测 ADB 自动化输入（标记 `INJECT_SOURCE_AUTOMATED`）并直接屏蔽**」 | 项目作者声称，**未复现** |
| **无障碍服务被认为更难被 App 检测** | 同一 README 原文：「无障碍服务使用系统级 `performAction()` API，**无法被 App 检测和屏蔽**」 | ⚠️ **这是作者的单方面断言，我认为不可全信**。Android 上 `AccessibilityService` 是系统可见状态（`Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`），App 完全可以通过系统 API 判断**是否存在无障碍服务在运行**，只是不一定能归因到具体脚本。**建议按"降低检测面"而非"消除检测面"来期待** |
| **闲鱼 App 有 root / hook 检测** | 【搜索结果显示】CSDN 文章讨论淘宝/闲鱼/淘特抓包时需 hook `SwitchConfig` 绕过 root 检测，并涉及 Xposed 框架检测规避 | 社区文章，**未复现** |
| **闲鱼自动化脚本"频繁被封号"** | 【搜索结果显示】CSDN 问答标题即为「闲鱼自动化脚本频繁被封号，如何规避风控识别？」 | 仅有标题，**无具体数据** |
| **有 Appium 驱动真机闲鱼 App 的实践** | 【搜索结果显示】CSDN 文章：「基于 Appium 框架构建，通过与 Android 真机建立连接，直接控制闲鱼 APP」，脚本 `xianyu.py` 含"智能检测机制"识别当前状态 | 社区文章，**未复现** |
| **有 AutoJS 做闲鱼监控/秒拍的分享，但建议 root** | 【搜索结果显示】腾讯云开发者社区文章：闲鱼商品监控/低价筛选捡漏秒拍 AutoJS 脚本，「**需在 AutoJS 4.1.1+ 运行，建议 root 安卓设备**」 | 社区文章，**未复现** |

> **风险分级提醒【推测】**：网页链路被 deny 的后果是**这个浏览器 profile / 出口 IP 被标记**；换成真机 App 自动化，后果可能变成**淘宝/闲鱼账号本身被封**（同一账号体系、可关联实名与设备）。**这是风险等级的跃升，不是等价替换。强烈建议用独立小号，并接受"该号可能损失"的前提。**

### 2.4 专门用 UI 自动化做「商品监控 / 捡漏 / 推送」的开源项目

**先说一个重要的负面发现：目前能找到的闲鱼监控开源项目，绝大多数走的是 Playwright / HTTP API，而不是 UI 自动化。**

| 项目 | 技术路线 | 架构要点 | 是否 UI 自动化 | 借鉴价值 |
|---|---|---|---|---|
| **`voltwake/xianyu-monitor`** | **Playwright + 有头 Chrome** | 自建 Chrome debug 实例；Cookie 存 `~/.chrome-debug-xianyu`（约 7 天有效）；**AppleScript 地址栏导航**；CDP click+type 搜索；两步排序（点"新发布"→点"最新"）；**DOM 被动读取**（`a[class*="feeds-item-wrap"]`）；**SQLite 去重**；建议间隔 ≥30min；仅 macOS；MIT | ❌ 网页 | ⭐⭐⭐⭐⭐ **和你同路线、同风控，对照实验最有价值** |
| **`ChaosTechDev/xianyu-hunter`** | **Playwright + AI** | Playwright 抓搜索结果；关键词规则 + AI 多模态筛选；降价/售罄/下架监控；**7 类推送渠道**；Vue 3 控制台；多账号登录态 JSON + **定时保活（默认 4h）**、失效通知；**按任务/失败轮换账号与代理**；Docker 部署；MIT（版权 2025 dingyufei615） | ❌ 网页 | ⭐⭐⭐⭐ **"账号轮换 + 保活 + 失败退避"的工程化做得比大多数项目好**，值得抄架构 |
| **`dingyufei615/ai-goofish-monitor`** | **Playwright + AI**（xianyu-hunter 的上游基线） | 同上体系（xianyu-hunter 自述把上游基线内化到仓库） | ❌ 网页 | ⭐⭐⭐ 同上 |
| **`bixipeng/Xianyu-Auto`** | **Node.js + MTOP API + ACCS WebSocket** | **不是浏览器**：直连 `h5api.m.goofish.com`，ACCS WebSocket 收消息；Express 5 + React 18 + Cron | ❌ HTTP/协议 | ⭐⭐⭐ **思路完全不同**：自动上架/回复/擦亮/发货。属于"协议逆向"而非"UI 自动化"，与你的目标（只读监控）重叠度低 |
| **`lingxi7090/xianyu-auto`（灵犀助手）** | ✅ **Android 无障碍服务 + HTTP API** | `AutoService.kt` = 无障碍服务 + 内嵌 **HTTP 服务器（端口 8848）**；手机端提供 `/status` `/tree` `/click?text=` `/click?x=&y=` `/input` `/scroll` `/back` `/find` `/gesture`；**PC/Termux 端 Python 控制器**（`xianyu_controller.py`）经 HTTP 远程控制；默认只监控 `com.taobao.idlefish`，改 `accessibility_config.xml` 的 `packageNames` 可扩展；最后提交 **2026-04-01**；**未找到 LICENSE 文件** | ✅ **是** | ⭐⭐⭐⭐⭐ **这正是"第 2 类"最该借鉴的架构**：把手机变成"被控端 HTTP 服务"，业务逻辑全在 PC 侧——与你现在 Playwright 的"PC 侧写逻辑"心智模型几乎一致，迁移成本最低 |
| **`overspread/xianyu-Auto`**（咸鱼自动检索商品） | 未能取得 README（404） | — | — | 未评估 |
| 得物/转转/京东类 | 【搜索结果显示】`DoubleZ7/dewu-spider-and-analysis`、`zas023/JdBuyer`、`ShuaiLeiLu/JDPanicBuying` 等 | 多为**协议/抢购**类，非通用商品监控推送 | 部分是 | ⭐⭐ 参考价值一般 |

**值得借鉴的架构模式（跨项目共性）**：
1. **去重是核心，不是抓取**：`voltwake` 用 SQLite 比对、`xianyu-hunter` 用商品 ID 游标 + 增量。抓取只是入口，**"哪些是新的"才是业务**。
2. **账号/登录态是消耗品**：Cookie 约 7 天过期（voltwake）、登录态 JSON + 4h 保活 + 失效通知（xianyu-hunter）。**要把"登录态失效"当成常态事件设计，而不是异常。**
3. **失败退避 + 人工兜底**（voltwake 的社区评测文明确总结这一模式）：遇到 429 / 登录失效 / 验证码就**停下来交人工**，而不是并发重试——重试正是触发 baxia 的常见原因。
4. **手机当被控端、PC 当大脑**（lingxi 的 HTTP-API 模型）：让真机方案和现有 Playwright 代码共享同一套调度/去重/推送层。

### 2.5 iOS 侧：不越狱有没有可行方案？

| 方案 | 不越狱可用？ | 硬前置 | 能否驱动闲鱼 App 的 UI | 评价 |
|---|---|---|---|---|
| **快捷指令 + 个人自动化** | ✅ 可用 | 无 | ❌ **不能** | 【搜索结果显示】Apple 官方文档描述个人自动化的触发条件类别为**事件（时间/到达位置/打开某个 App 等）、行程、通信、设置**。「打开某个 App」触发是存在的，但**快捷指令没有任何"读取其他 App 界面内容"的能力**——它只能做系统级动作、网络请求、读写文件/剪贴板。**因此快捷指令无法用来监控闲鱼的商品列表**，只能做"打开闲鱼"这类动作触发。 |
| **通知监听** | ⚠️ 部分 | 无 | ❌ 不能用于抓商品 | 【推测】"收到信息"一类的通信触发面向 **信息/邮件**，**不能监听任意第三方 App 的通知**。要在 iOS 上读别人的通知，需要越狱或用私有 API。
| **iPhone 镜像（macOS）** | ✅ 可用 | **Mac**（Apple Silicon）+ 同一 Apple ID | ⚠️ 理论可行、实践脆弱 | 【推测】把 iPhone 镜像到 Mac 后，用 macOS 侧自动化（AppleScript / 辅助功能 API / 屏幕截图 + OCR）去驱动。**本质是"看屏幕点坐标"，与 2.4 的 AutoJS 思路等价，但依赖系统级镜像功能的稳定性与可达性**，且需要一台 Mac。**未找到可靠的公开实践报告** |
| **idb（facebook/idb）** | ✅ 不越狱 | **macOS 15+ 与 Xcode 26.0+**（README 要求）；companion 跑在 macOS | ⚠️ 需确认 | 【已读仓库文档】README 原文：idb 由 macOS 上的 **companion** + 任意平台可跑的 Python 客户端组成；基于 `FBSimulatorControl` / `FBDeviceControl`；正在迁移到纯 Swift。**主力场景是 Simulator 和远程 Device Lab**。README 未把"驱动任意第三方 App 的 UI 自动化"列为主用途 |
| **Appium + XCUITest / WebDriverAgent** | ✅ 不越狱（但需签名） | **Mac + Xcode + Apple 开发者账号**；真机需 **USB 连接** | ✅ **理论可行** | 【搜索结果显示】免费开发者账号签名后 **7 天到期需重新信任**；付费账号可延长；需配置 `xcodeOrgId` / `xcodeSigningId` 让 Appium 自动重签。社区有大量"签名失败/版本兼容"踩坑文章 → **维护成本高、脆弱** |
| **越狱** | ❌ 不适用（你要求不越狱） | — | — | 排除 |

**iOS 结论【推测】**：**「不越狱 + 不买 Mac」在 iOS 上做闲鱼商品监控 UI 自动化，实际上做不到。** 最低可行配置是 **Mac + Xcode + 付费开发者账号 + Appium/XCUITest + 一台 iPhone 常连**，其成本与脆弱度都**高于**安卓无障碍方案。**如果你现在没有 Mac，安卓路线是唯一现实选择。**

### 2.6 真机方案的诚实工程评估

| 代价项 | 具体表现 | 严重度 |
|---|---|---|
| **必须一台常开手机** | 专用设备，不能是主力机（自动化会抢占前台、消耗电量、影响使用） | 高（一次性硬件成本） |
| **必须屏幕常亮 + 常充电** | Appium 靠 wake lock 防休眠；UI 自动化要求目标 App 前台渲染。**"熄屏运行"不成立** | 高（耗电、发热、烧屏风险） |
| **电池与发热** | 24h 常亮 + 前台 App + 定时轮询 → 长期插电导致电池鼓包风险；建议移除电池或使用带旁路供电的设备【推测】 | 中 |
| **App 更新导致选择器失效** | 闲鱼是高频迭代的商业 App，**加固 + 自定义组件**（lingxi README 明确说闲鱼用自定义组件）意味着 UI 树不稳定。**这是长期维护成本的主要来源** | **高（持续性成本）** |
| **无障碍服务被系统杀死** | MIUI/EMUI/ColorOS 后台限制普遍；需自启动 + 后台无限制 + 电池优化白名单，仍可能被锁屏后终止 | 高（稳定性风险） |
| **账号风险** | 从"网页 profile 被标记"升级为"**账号可能被封**"（可关联实名/设备）。社区已有"闲鱼自动化脚本频繁被封号"的说法 | **最高（不可逆）** |
| **iOS 额外成本** | Mac + Xcode + 开发者账号 + 每 7 天重签（免费账号） | 高 |
| **迁移成本** | 你现在是 Playwright/DOM 心智模型，改真机要重写：抓取层（UI 树遍历）、去重键（商品 ID 从 UI 文本提取）、登录态（App 内扫码）。**调度/去重/推送层可复用** | 中（若选 lingxi 式 HTTP-API 架构可降低） |

---

## 3. 明确建议

### 3.1 优先级：**先补第 1 类的 CDP 漏洞（1–2 人日），同时并行启动第 2 类选型（不写代码，只决策硬件）**

**理由：你目前只排除了 1 个信号中的第 1 类，而第 2 类（CDP 协议层）在 attach 模式下确认存在且未处理。** 网页链路还有**至少三个未被穷尽的变量**（`Runtime.enable`、导航方式、输入方式），而真机是一次性的架构级重写 + 不可逆的账号风险。**先用最便宜的手段把网页链路的变量清干净，再决定是否重写，是期望成本最低的顺序。**

### 3.2 第 1 类：按成本从低到高的三个实验（建议全部串行做完再下结论）

| 顺序 | 实验 | 改什么 | 成本 | 可证伪的判据 |
|---|---|---|---|---|
| **①** | **停止用 `page.goto()` 打开搜索页** | 改为：先导航到 goofish 首页（或复用现有已登录 tab），再用 `click + type + Enter` 触发搜索 | **极低（数小时）** | `voltwake` 同站点报告的直接对应项；若 deny 消失即命中 |
| **②** | **换 patchright 1.63.0（与你版本对齐）** | Node：把 `playwright` 换成 `patchright`（drop-in，改包名/import）；**保留你的 attach 模式**；先跑公开检测页 A/B 确认 patch 生效 | **低（0.5–1 人日）** | 用 `brotector` / `rebrowser-bot-detector` / `deviceandbrowserinfo` 对比 patch 前后；**若 attach 下 patch 未生效，说明此路不通，应立即止损** |
| **③** | **输入改走 OS 级派发** | 若 ② 之后仍 deny：用 **CDP-Patches**（`SyncInput.click/move/type`，需 `pid` 或 `browser`，**要求 headful——你本来就是**）替代 `page.click()`；或在你已有 Windows 环境下用 SendInput/AutoHotkey 做"地址栏导航 + 键盘输入"（`voltwake` 的 AppleScript 方案等价物） | **中（1–2 人日）** | 若 ① ② ③ 全做完仍 deny，则**网页链路的 CDP 变量已基本穷尽**，可以据此迁移真机 |

> **不建议做的事**：不要把 `rebrowser-playwright-core`（1.52.0）直接换进来——它会让你的 Playwright 从 1.63.0 **降级 11 个 minor**，引入与风控无关的回归风险。若要试 rebrowser 的补丁，应使用 **`rebrowser-patches` 对现有 1.63.0 打 patch** 的方式（但该包已停滞 16 个月，对 1.63.0 的兼容性未知【推测】）。**patchright 是版本对齐且维护活跃的那个。**

### 3.3 第 2 类：现在就做的决策（不写代码）

1. **确认你是否有 Mac**：没有 → **iOS 路线直接排除**，只考虑安卓。
2. **准备一台专用安卓机**（不要用主力机），并接受**账号可能损失**（用独立小号）。
3. **首选架构：`lingxi7090/xianyu-auto` 式「无障碍服务 + 设备端 HTTP API + PC 侧 Python 控制器」**——理由：与你现有"PC 侧写业务逻辑"的心智模型一致，**调度/去重/推送层可 100% 复用**，只有"取数据"这一层从 DOM 换成 UI 树。
4. **次选：Appium + UiAutomator2**——更标准化、生态成熟、有 `wakeLockTimeout` 保活和 `getPageSource` 的 XML 控件树，但更重（PC 必须常连）、且**默认会抑制其他无障碍服务**。
5. **不推荐**：Airtest（pocoui 停更于 2023-12）、scrcpy（必须 PC 常连，且它本身不是自动化框架）、AutoX.js（`kkevsekk1/AutoX` 仓库连通性异常，未能核实维护状态——**建议用 AutoJs6 而非 AutoX**）。

### 3.4 工作量估算汇总

| 路线 | 预估工作量 | 主要风险 |
|---|---|---|
| **第 1 类 ① 导航方式** | **0.5 人日** | 几乎无 |
| **第 1 类 ② patchright** | **0.5–1 人日** | attach 模式下 patch 是否生效（**未经验证**）；若无效需止损 |
| **第 1 类 ③ OS 级输入** | **1–2 人日** | 需要 OS 级输入方案（Windows 下可自研，参考 CDP-Patches / AutoHotkey） |
| **第 1 类 合计** | **2–3.5 人日** | 全部失败也是**有价值的确定性结论** |
| **第 2 类（安卓无障碍 + HTTP API）** | **5–10 人日** + 一台专用机 | 选择器维护、无障碍被系统杀、**账号封禁** |
| **第 2 类（Appium）** | **8–15 人日** + 一台专用机 | 同上 + 环境/版本脆弱 |
| **第 2 类（iOS）** | **15 人日+** + Mac + 开发者账号 + iPhone | 签名 7 天到期、成本最高 |

### 3.5 一句话建议

> **别急着换赛道。** 先用 2–3 人日把 `page.goto()` 导航、patchright 的 CDP 补丁、OS 级输入这三件事做完——它们都作用在你**已经投入过的 attach 路线上**，成本极低且结论确定。**只有当这三件事全部失败**，才说明"网页链路的 CDP 面已被穷尽"，此时再投入 5–10 人日 + 一台专用安卓机走「无障碍服务 + 设备端 HTTP API」路线，并且**必须用小号、必须接受账号可能被封**。

---

## 附录 A：证据分级与未决问题

**已确证（读了源码或官方文档原文）**
- Playwright 1.63.0 的 Chromium 页面初始化路径会发送 `Runtime.enable`（`coreBundle.js:37625`）、`Log.enable`（`37623`）、`Page.addScriptToEvaluateOnNewDocument` + `worldName`（`37626`）、`Page.createIsolatedWorld`（`37606`）、`Target.setAutoAttach`（`37631`）、`Runtime.runIfWaitingForDebugger`（`37670`）。
- `connectOverCDP` → `CRBrowser.connect`（`43146`）→ `new CRPage`（`38446`）→ 同一套 `_initialize()`。**attach 不改变 CDP 命令面。**
- Chromium utility world 名含 `playwright` 字样 + 每页 guid（`37280`）。
- 各项目的许可证、版本、发布/提交日期（见 1.5，均为 2026-09-24 实测查询）。
- camoufox = Firefox/Juggler（与 Chrome attach 互斥）；patchright 补丁作用于 Playwright driver 的 `frames.ts`，通过 CDP session 操作。

**搜索结果显示、未独立复现**
- `voltwake/xianyu-monitor` 的 `page.goto` ❌ / `click+type` ✅ 对照表。
- patchright / nodriver / camoufox 的 headless 检测分数横向短测（2026-08-31，第三方博客）。
- `lingxi7090/xianyu-auto` 关于"闲鱼检测 `INJECT_SOURCE_AUTOMATED`"与"无障碍无法被检测"的断言。
- 闲鱼 App 存在 root/hook 检测、自动化脚本被封号、Appium 驱动闲鱼真机的社区文章。

**未找到可靠公开资料（诚实列出）**
- patchright 或 rebrowser-patches **官方声明**支持/测试过 `connectOverCDP` 附加模式。
- **任何**针对 baxia 的 patchright / camoufox / rebrowser 量化成功率报告。
- 闲鱼 App 是否检测 AccessibilityService（仅有作者断言，无独立验证）。
- iPhone 镜像 + macOS 自动化驱动 iOS App 的公开实践报告。
- `kkevsekk1/AutoX`（AutoX.js）的当前维护状态（仓库请求多次失败）。
- rebrowser-patches 是否有 LICENSE 文件（npm 声明 MIT，仓库根目录未找到 LICENSE）。

---

## 附录 B：主要参考链接

**第 1 类**
- [rebrowser-patches README（已读原文）](https://github.com/rebrowser/rebrowser-patches) · [rebrowser 官方文档：Patches for Puppeteer and Playwright](https://rebrowser.net/docs/patches-for-puppeteer-and-playwright)
- [rebrowser 博客：How to fix Runtime.Enable CDP detection（已读原文）](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries)
- [DataDome：How New Headless Chrome & the CDP Signal Are Impacting Bot Detection](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/)
- [patchright driver（已读原文）](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) · [patchright-python（已读原文）](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-python) · [patchright `framesPatch.ts`（已读原文）](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/blob/main/driver_patches/framesPatch.ts)
- [CDP-Patches（Input Domain 泄漏，已读原文）](https://github.com/Kaliiiiiiiiii-Vinyzu/CDP-Patches) · [crbug#1477537](https://bugs.chromium.org/p/chromium/issues/detail?id=1477537)
- [nodriver（已读原文）](https://github.com/ultrafunkamsterdam/nodriver) · [undetected-chromedriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
- [camoufox（已读原文）](https://github.com/daijro/camoufox) · [camoufox 检测状态跟踪 issue #686](https://github.com/daijro/camoufox/issues/686) · [camoufox.com](https://camoufox.com/)
- [AtuboDad/playwright_stealth（已读原文）](https://github.com/AtuboDad/playwright_stealth)
- [检测页：brotector](https://kaliiiiiiiiii.github.io/brotector/) · [rebrowser-bot-detector](https://bot-detector.rebrowser.net/) · [Sannysoft](https://bot.sannysoft.com/) · [Incolumitas](https://bot.incolumitas.com/) · [deviceandbrowserinfo](https://deviceandbrowserinfo.com/are_you_a_bot)
- [Camoufox/Patchright/Nodriver 本地实测（2026-08-31，第三方博客）](https://blog.anluoying.com/posts/camoufoxpatchrightnodriver-%E6%9C%AC%E5%9C%B0%E5%AE%9E%E6%B5%8B/)

**第 2 类**
- [openatx/uiautomator2（已读原文）](https://github.com/openatx/uiautomator2) · [appium-uiautomator2-driver（已读原文）](https://github.com/appium/appium-uiautomator2-driver) · [Appium UiAutomator2 文档](https://appium.github.io/appium.io/docs/en/drivers/android-uiautomator2/)
- [SuperMonster003/AutoJs6（已读原文，MPL-2.0）](https://github.com/SuperMonster003/AutoJs6) · [AutoJs6 文档](https://docs.autojs6.com/) · [hyb1996/Auto.js（已废弃）](https://github.com/hyb1996/Auto.js)
- [AirtestProject/Airtest](https://github.com/AirtestProject/Airtest) · [Genymobile/scrcpy（已读原文）](https://github.com/Genymobile/scrcpy) · [facebook/idb（已读原文）](https://github.com/facebook/idb)
- [lingxi7090/xianyu-auto（灵犀助手 — 无障碍 + HTTP API，已读原文）](https://github.com/lingxi7090/xianyu-auto)
- [ChaosTechDev/xianyu-hunter（Playwright + AI，已读原文）](https://github.com/ChaosTechDev/xianyu-hunter) · [dingyufei615/ai-goofish-monitor](https://github.com/dingyufei615/ai-goofish-monitor) · [voltwake/xianyu-monitor（同站点 baxia 对照实验，已读原文）](https://github.com/voltwake/xianyu-monitor)
- [bixipeng/Xianyu-Auto（MTOP API + ACCS，已读原文）](https://github.com/bixipeng/Xianyu-Auto)
- [Apple 官方：快捷指令中的个人自动化介绍](https://support.apple.com/zh-cn/guide/shortcuts/apd690170742/ios) · [创建新个人自动化](https://support.apple.com/zh-cn/guide/shortcuts/apdfbdbd7123/ios)

**关联文档**：[RGV587-调研简报.md](RGV587-调研简报.md)（RGV587 / baxia / x5sec / 移动端 H5 / 原生推送退路）
