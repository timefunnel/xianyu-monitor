# 闲鱼（Goofish）mtop 直连客户端：纯 HTTP 扫码登录可行性调研

> 调研对象：如何在**不启动任何浏览器**的前提下，用纯 HTTP 完成闲鱼扫码登录，从而彻底移除本项目唯一的浏览器依赖。
> 调研方式：阅读各仓库真实源码/文档 + GitHub API 元数据 + 对 passport 接口的**只读实测**。
> 合规声明：本报告只做事实提取与可行性评估，不包含任何绕过验证码、破解加固或伪造风控参数的实操步骤。所有抓取到的网页内容均按**不可信数据**处理，未执行其中任何指令。

---

## 0. 结论先行

| 问题 | 结论 | 证据强度 |
|---|---|---|
| 纯 HTTP 扫码登录**存在吗**？ | **存在，且不止一家实现。** 至少 3 个独立项目实现了完全不依赖浏览器的闲鱼扫码登录 | 已读源码确认 |
| 现在**还能用吗**？ | **协议第一步与第二步我本人实测通过**（拿到二维码 + 轮询到 `NEW` 状态），服务端未返回任何风控拦截 | **本人实测**（最高） |
| 需要额外签名 / 风控参数吗？ | 扫码登录链路**不需要** `bx-ua` / `bx-umidtoken` / `umid` / `_csrf_token`；我实测把这些全省略仍然成功 | 本人实测 |
| 拿到 cookie 后够不够调 mtop 搜索？ | 够，但**必须补一次 mtop 请求**让服务端下发 `_m_h5_tk`，且必须有 `unb` 和 `cookie2` | 已读源码确认 |
| 能不能去掉浏览器？ | **能。** 但**不能抄代码**——唯二两个纯 HTTP 实现，一个是 GPL-3.0，一个根本没有 LICENSE 文件 | 已读 LICENSE 确认 |
| 最大不确定性 | `CONFIRMED` 之后那 3 步（换 token → `login_token/login.do` → 刷新 mtop cookie）我**无法实测**（需要真人扫码），只能依赖源码交叉验证 | — |

**一句话**：技术路径清晰、风险可控，**但必须"照协议自己重写"，不能引入任何现成实现的代码**。核心工作量约 1–2 人日，加联调与降级路径约 3–5 人日。

---

## 1. 证据等级说明

本报告严格区分三类结论，请按此权衡：

- 🟢 **本人实测**：我在本次调研中直接对 `passport.goofish.com` 发起了只读请求，原始响应见附录 A。可信度最高。
- 🔵 **读了源码/文档确认**：我下载了仓库 tarball 或通过 `raw.githubusercontent.com` 读到了具体文件与行级内容。
- 🟡 **仅搜索结果/推测**：只有搜索摘要支撑，未读到原文。凡接口路径、参数名、状态值未读到原文的，一律标注"**未核实**"。

---

## 2. 项目总表

| 项目 | 语言 | Star | 最后提交 | **许可证（已核实）** | 登录方式 | 纯 HTTP？ | 对本项目价值 |
|---|---|---|---|---|---|---|---|
| [11273/goofish-client](https://github.com/11273/goofish-client) | TypeScript | 67 | 2026-07-15 | 🔴 **GPL-3.0** | passport HTTP 扫码 | ✅ **是** | 协议参考价值最高，**但代码不可引入** |
| [cv-cat/XianYuApis](https://github.com/cv-cat/XianYuApis) | Python + JS | 1431 | 2026-08-18 | 🔴 **无 LICENSE 文件** | `qrcode_login()` 纯 requests | ✅ **是** | 流程最完整，**代码不可引入** |
| [yuan71058/XianYuApis-GO](https://github.com/yuan71058/XianYuApis-GO) | Go | 15 | 2026-07-20 | 🔴 **无 LICENSE 文件** | `QrcodeLogin()` | ✅ **是** | 签名算法与本项目**逐字一致**，参考价值极高，**代码不可引入** |
| [fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli) | Python | 283 | 2026-09-17 | 🟢 **Apache-2.0** | 本地浏览器读 cookie / Playwright 扫码 | ❌ 否（用 Playwright） | **Cookie 生命周期管理最值得借鉴** |
| [SearchT-zy/xianyu-search](https://github.com/SearchT-zy/xianyu-search) | Python | 0 | 2026-08-20 | 🟢 **MIT** | Playwright 一次性扫码 → 之后纯 HTTP | ❌ 否（登录用浏览器） | 抓取/风控处理思路可借鉴，MIT 可放心参考 |
| [Usagi-org/ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor) | Python | 14478 | 2026-05-18 | 🟢 **MIT** | Chrome 扩展导出登录态 JSON 粘贴 | ❌ 否（抓取靠 Playwright） | 账号轮换/多账号管理可借鉴 |
| [voltwake/xianyu-monitor](https://github.com/voltwake/xianyu-monitor) | JavaScript | 47 | 2026-02-25 | 🟢 **MIT** | 非 headless Chrome + AppleScript | ❌ 否 | 反检测经验（反面教材），仅 macOS |
| [jeanmoumou/XianYuApis](https://github.com/jeanmoumou/XianYuApis) | Python | 35 | 2025-03-12 | 🔴 **无 LICENSE 文件** | 手工粘贴 cookie | ❌ 否 | 低（已停更一年） |
| [XIE7654/goofish_api](https://github.com/XIE7654/goofish_api) | Python | 未核实 | 未核实 | 🟢 MIT（但文件头写"禁止商用"，自相矛盾） | 手工粘贴 cookie | ❌ 否 | 签名算法与本项目一致，MIT 可参考 |
| [IAMLZY2018/xianyuapis](https://github.com/IAMLZY2018/xianyuapis) | Python | 未核实 | 未核实 | 🟢 **MIT** | 手工粘贴 cookie（聊天机器人） | ❌ 否 | 低（无扫码登录模块） |
| [yuzhiblue/xianyu](https://github.com/yuzhiblue/xianyu) | Python | 未核实 | 未核实 | 🟢 **MIT** | 手工粘贴 cookie | ❌ 否 | 低 |

> 注：本仓库根目录已有的 `_licenses.json` 里 40 多个仓库的许可证全是 `ERR(403)`（当时被 GitHub API 限流）。上表已把最关键的几个**逐个下载 LICENSE 文件核实**，可直接用于更新该文件。

---

## 3. 重点核实：`11273/goofish-client`（本次最重要的一条）

**结论：它确实实现了纯 HTTP 扫码登录，协议细节完整；但许可证是 GPL-3.0，与本项目 MIT 不兼容，代码一行都不能抄。**

### 3.1 元数据（🔵 已核实）

- 语言 TypeScript，Star 67，最后提交 `2026-07-15`
- **许可证 GPL-3.0** —— 我读取了仓库 `LICENSE` 文件原文，首行为 `GNU GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`；`README.md` 结尾也写明 `**GPL-3.0 License** Copyright © 2025 11273`；GitHub API `license.spdx_id = "GPL-3.0"`。三方一致。

### 3.2 接口路径与常量（🔵 读了源码，文件 `src/constants/api.passport.ts`）

```ts
export const PASSPORT_CONFIG = {
  BASE_URL: 'https://passport.goofish.com',   // 注意：不是 passport.taobao.com
  APP_NAME: 'xianyu',
  FROM_SITE: '77',
} as const;

export const PASSPORT_ENDPOINTS = {
  QR: {
    GENERATE: '/newlogin/qrcode/generate.do',  // 生成二维码
    QUERY:    '/newlogin/qrcode/query.do',     // 查询二维码状态
  },
  LOGIN: {
    LOGIN:    '/newlogin/login.do',            // 账号密码登录
  },
} as const;
```

### 3.3 `generate()` 调了什么、要什么参数（🔵 文件 `src/services/passport/qr.service.ts`）

**方法 `GET`**，路径 `/newlogin/qrcode/generate.do`，query 参数（`BasePassportService.request()` 会自动补 `appName=xianyu&fromSite=77`）：

| 参数 | 默认值 | 源码里的地位 |
|---|---|---|
| `appEntrance` | `'web'` | 有默认值 |
| `bx_et` | `'not_loaded'` | 有默认值 |
| `umidTag` | `'SERVER'` | 有默认值 |
| `lang` | `'zh_CN'` | 有默认值 |
| `mainPage` | `false` | 有默认值 |
| `isMobile` | `false` | 有默认值 |
| `_csrf_token` / `umidToken` / `hsiz` / `bizParams` / `returnUrl` / `bx-ua` / `bx-umidtoken` | 无 | **全部可选，透传 `params?.xxx`** |

> 🟢 **重要实测发现**：`_csrf_token`、`hsiz`、`bizParams`、`bx-ua` 在源码里被声明为可选，我实测**全部省略也能成功拿到二维码**（见附录 A）。这大幅降低了实现难度。

### 3.4 `query()` 调了什么（🔵 同一文件）

**方法 `POST`**，路径 `/newlogin/qrcode/query.do`，`Content-Type: application/x-www-form-urlencoded`。

- **必填**：`t`（来自 generate 的响应）、`ck`（来自 generate 的响应）
- 有默认值：`appEntrance='web'`、`umidTag='SERVER'`、`isIframe=true`、`defaultView='password'`、`bx_et='not_loaded'`、`mainPage=false`、`isMobile=false`、`lang='zh_CN'`
- 可选透传：`ua`、`deviceId`、`navlanguage`、`navUserAgent`、`navPlatform`、`documentReferer`、`pageTraceId`、`_csrf_token`、`umidToken`、`hsiz`、`bizParams`、`returnUrl`、`bx-ua`、`bx-umidtoken`

> 注意它把 `t`/`ck` 放在 **body**（`data:`）里，同时 `appName`/`fromSite` 同时出现在 query 与 body 两处。

### 3.5 返回体长什么样（🔵 文件 `src/types/passport/qr.ts`）

```ts
export interface QrGenerateResponse {
  t: number | string;        // 时间戳，轮询时要用
  codeContent: string;       // 二维码内容 URL（注意：是 URL，不是图片！）
  ck: string;                // 轮询校验密钥
  resultCode: number;
  processFinished: boolean;
  lgToken?: string;          // 登录令牌，从 codeContent 中提取
}

export interface QrQueryResponse {
  qrCodeStatus: QRCodeStatus;
  resultCode: number;
  titleMsg?: string;         // 出错时的提示
}
```

🟢 我实测的响应结构与上述类型**完全吻合**，且 `codeContent` 确实是 `https://passport.goofish.com/qrcodeCheck.htm?lgToken=<...>&_from=havana` 形式的 URL——所以文档里"需要用二维码库把 `codeContent` 转成图片"的说法是对的。

### 3.6 状态值（🔵 源码枚举）

```ts
export enum QRCodeStatus {
  NEW = 'NEW',            // 新生成，等待扫描
  SCANED = 'SCANED',      // 已扫描（原文如此，疑似拼写笔误）
  CONFIRMED = 'CONFIRMED',// 已确认 → 登录成功
  CANCELED = 'CANCELED',  // 用户取消
  EXPIRED = 'EXPIRED',    // 已过期
  ERROR = 'ERROR',
}
```

> ⚠️ **发现一处不一致，必须留意**：goofish-client 的枚举写的是 `SCANED`（少一个 N），而另外两个实现（cv-cat 的 Python 版、yuan71058 的 Go 版）用的都是 **`SCANNED`**。
> 🟢 我实测服务端返回的字段名是 `qrCodeStatus`，值为 `"NEW"`。
> `SCANNED` vs `SCANED` 哪个才是服务端真实值，**我没有实测到**（需要真人扫码才能触发该状态）。**建议实现时对两个拼写都做兼容**，只把 `CONFIRMED` / `EXPIRED` 当作关键分支——这样即使拼写判断错了也不影响主流程。

### 3.7 cookie 从哪来（🔵 读了 `src/core/interceptor.ts` + `src/utils/cookie.ts`）

**答案：从 HTTP 响应的 `Set-Cookie` 头自动收集，不存在"某一步换 token"的说法。**

```ts
// src/core/interceptor.ts
response: (response) => {
  const setCookieHeaders = response.headers['set-cookie'];
  if (setCookieHeaders) {
    cookieStore.setFromHeaders(setCookieHeaders);   // 自动吸收
  }
  return response;
}
```

`CookieStore` 是一个 **扁平的 `Map<string, string>`**（`src/utils/cookie.ts`），**不区分 domain / path**——它把 passport 域和 mtop 域的 cookie 混在同一个 map 里，然后无差别地拼成 `Cookie` 请求头。这是一种简化实现；因为 passport 与 mtop 共享 `.goofish.com` 父域，实践中能工作，但**丢了 domain 信息**。

因此文档里那句 `client.updateCookieMtop(cookie)` 实际上是**语义上的空操作**（同一个扁平 jar 复制给自己）。而 README/文档反复强调的 "After successful authentication, cookies must be synchronized to the MTOP domain"，真实含义是：**passport 登录后必须再打一次 mtop 请求，让服务端为 `_m_h5_tk` 下发新值**。

### 3.8 它的 mtop 签名与本项目一致（🔵 `src/utils/sign.ts`）

```ts
export function generateSign({ appKey, t, data, token }) {
  return md5(`${token || ''}&${t}&${appKey}&${data}`).toString();
}
export function getTokenFromCookie(cookieStr: string): string {
  const mH5Tk = parseCookie(cookieStr)['_m_h5_tk'];
  const underscoreIndex = mH5Tk.indexOf('_');
  return underscoreIndex > 0 ? mH5Tk.substring(0, underscoreIndex) : mH5Tk;
}
```

与 `src/constants/api.mtop.ts` 的 `BASE_URL: 'https://h5api.m.goofish.com'`、`APP_KEY: '34839810'`、`SEARCH: 'mtop.taobao.idlemtopsearch.pc.search'` 一起看——**与本项目现有 `src/mtop.mjs` 的做法逐字相同**。这说明本项目的直连架构与 goofish-client 是同一套协议理解。

### 3.9 它自己的 cookie 生命周期处理（🔵 `src/managers/token.manager.ts`）

```ts
export const MTOP_TOKEN = {
  ERROR_CODES: ['FAIL_SYS_TOKEN_EMPTY', 'FAIL_SYS_TOKEN_ILLEGAL', 'FAIL_SYS_SESSION_EXPIRED'],
  COOKIE_NAME: '_m_h5_tk',
  COOKIE_REGEX: /_m_h5_tk=([^_]+)_/,
};
```

`TokenManager` 提供 `updateFromCookie()`（从 cookie 串刷新 token）和 `updateFromHeaders()`（从 `Set-Cookie` 刷新 token），并用 `isTokenError()` 判断是否 token 类错误。**本质就是"每次响应都尝试从 Set-Cookie 里捞新的 `_m_h5_tk`"**——这与本项目已有的做法一致，没有额外增量。

---

## 4. 重点核实：`cv-cat/XianYuApis`（最完整的纯 HTTP 实现，但无许可证）

**结论：这是纯 HTTP 扫码登录的"原始实现"，流程最完整；但仓库里根本没有 LICENSE 文件，不能引入代码。**

### 4.1 许可证核实（🔵 已核实，且这是个坑）

- README 顶部徽章写 `![License](https://img.shields.io/badge/license-MIT-orange)`，并且链接指向 `LICENSE`。
- **但仓库里没有 LICENSE 文件。** 我做了三重核实：
  1. GitHub API：`license.spdx_id` 为空
  2. 对 `LICENSE` / `LICENSE.md` / `LICENSE.txt` / `COPYING` 四个候选名在 `master` 和 `main` 两个分支上全部请求 → **全部 404**
  3. 下载完整 tarball 并解包，文件清单里**没有任何许可证文件**

→ **法律状态 = 无许可证 = 默认保留全部权利（All rights reserved）。** README 里的 MIT 徽章不构成授权，且徽章指向的文件不存在。**任何代码复制都不可接受。**

### 4.2 纯 HTTP 扫码登录实现位置（🔵 读了源码）

文件：**`goofish_apis.py` → 函数 `qrcode_login()`**。它的 docstring 明确列出 7 步：

```
1. build_initial_cookies() 拿基础 cookie
2. 请求 passport 加载 mini_login 页面拿 passport 域 cookie
3. generate.do 获取二维码 URL
4. 终端展示二维码（需 qrcode 库）或打印 URL
5. 轮询 query.do 等待扫码确认
6. login_token/login.do 完成登录
7. 返回 XianyuApis 实例
```

另外 `utils/build_cookies.py` 的文件头注释直接写明了设计目标：

> `# 纯 Python (requests) + node 补环境，无 playwright/无浏览器。`

**这是全生态里对"无浏览器"最明确的声明。**

### 4.3 它调用的完整参数（🔵 读了源码，可直接作为协议规格）

**Step 1 — 构造初始 cookie（`utils/build_cookies.py`）**

1. `GET https://log.mmstat.com/eg.js` → 取 `cna`（来自 `.mmstat.com` 域），再写到 `.goofish.com` 域
2. 依次 `POST` 两个 mtop 接口拿 `_m_h5_tk` / `_m_h5_tk_enc` / `cookie2`：
   - `mtop.taobao.idlehome.home.webpc.feed`
   - `mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get`
   - query：`jsv=2.7.2, appKey=34839810, t=<ms>, sign=''（空串）, v=1.0, type=originaljson, dataType=json, timeout=20000, api=<name>, sessionOption=AutoLoginOnly, spm_cnt=a21ybx.home.0.0`
   - body 必须是**手工拼的字符串** `data=%7B%7D`（源码注释特别强调：用 `PostForm` 会被二次编码成 `%257B%257D`）
3. 用 `node utils/gen_tfstk.js` 生成 `tfstk`（失败则回退为空）

> 🔵 **一个关键洞察**：这两个 mtop 请求的 `sign` 是**空字符串**，服务端仍然下发了 `_m_h5_tk`。也就是说**引导阶段不需要正确签名**。本项目目前每轮算真签名，比这更"干净"，不受影响。

**Step 2 — 拿 XSRF-TOKEN**

`GET https://passport.goofish.com/mini_login.htm`，参数：
`lang=zh_cn, appName=xianyu, appEntrance=web, styleType=vertical, bizParams='', notLoadSsoView=false, notKeepLogin=false, isMobile=false, qrCodeFirst=false, stie=77, rnd=<随机数>`
→ 从 cookie jar 取 `XSRF-TOKEN`（域 `passport.goofish.com`），另取 `_tb_token_`。

**Step 3 — 生成二维码**

`GET https://passport.goofish.com/newlogin/qrcode/generate.do`，参数：

| 参数 | 值 |
|---|---|
| `appName` | `xianyu` |
| `fromSite` | `77` |
| `appEntrance` | `web` |
| `_csrf_token` | 上一步的 `XSRF-TOKEN` |
| `umidToken` | 空串 |
| `hsiz` | `cookie2` 的值 |
| `bizParams` | `taobaoBizLoginFrom=web&renderRefer=<urlencoded https://www.goofish.com/>` |
| `mainPage` / `isMobile` | `false` |
| `lang` | `zh_CN` |
| `returnUrl` | 空串 |
| `umidTag` | `SERVER` |

→ 解析 `gen_resp['content']['data']`，取 `codeContent` / `t` / `ck`。

**Step 4 — 轮询状态**

`POST https://passport.goofish.com/newlogin/qrcode/query.do?appName=xianyu&fromSite=77`
body = Step 3 的全部参数（`_csrf_token`/`hsiz`/`bizParams` 等），**外加**：

| 参数 | 值 |
|---|---|
| `navlanguage` | `en` |
| `navUserAgent` | 浏览器 UA |
| `navPlatform` | `Win32` |
| `isIframe` | `true` |
| `documentReferer` | `https://www.goofish.com/` |
| `defaultView` | `sms` |
| `deviceId` | **`cna`**（不是 unb！） |
| `t` | generate 返回的 `t` |
| `ck` | generate 返回的 `ck` |

状态映射（源码 `status_map`）：

```python
{'NEW': 'Waiting for scan',
 'SCANNED': 'Scanned, confirm on phone',
 'CONFIRMED': 'Confirmed',
 'EXPIRED': 'QR expired'}
```

**Step 5 — 拿到凭据**

```python
if status == 'CONFIRMED':
    login_token = qdata.get('token') or qdata.get('lgToken')
    # 注释原文：CONFIRMED 响应的 Set-Cookie 里已经包含了 sgcookie/unb/tracknick/csg
```

→ **两条路并行**：响应 JSON 里可能有 `token`/`lgToken`；同时 `Set-Cookie` 已经在往下发 `unb`/`tracknick`/`sgcookie`。源码对"没有 token 字段"的版本做了兼容：如果 `s.cookies.get('unb')` 存在，就直接认为登录成功。

**Step 6 — 完成登录**

`POST https://passport.goofish.com/login_token/login.do`
query：`token=<login_token>, subFlow=DIALOG_CHECK_LOGIN_RPC, nextCode=0018, bizScene=qrcode, confirm=true`
body：`deviceId=<cna>`

**Step 7 — 刷新 mtop cookie**

`POST https://h5api.m.goofish.com/h5/mtop.idle.web.user.page.nav/1.0/`，`sign=''`（空串），`data=%7B%7D`
→ 让服务端为 `.goofish.com` 重新下发 `_m_h5_tk`。

**Step 8 — 收尾**：取 `unb` / `tracknick`，把 `.goofish.com` + `.mmstat.com` 域下所有 cookie 收成 dict，用 `generate_device_id(unb)` 生成 device_id。

### 4.4 它怎么处理 tfstk（🔵 读了源码，这是一个重要风险点）

`utils/gen_tfstk.js`（17KB）的文件头注释：

> `node 补环境生成 tfstk。核心策略：`
> `1. vm.createContext + 深度 Proxy 记录 SDK 每一个属性访问`
> `2. crypto.subtle 同步化（绕 VMP setTimeout race）`
> `3. 缺失属性从 env_snapshot.json（真浏览器 dump）回填`

配套 `utils/et_f.js`（阿里埋点 SDK）。

**这意味着 `tfstk` 的生成依赖在 Node 里"补浏览器环境"去跑阿里混淆过的埋点 SDK，还需要一份从真浏览器 dump 出来的环境快照。** 但 `build_initial_cookies()` 里 `tfstk` 是**尽力而为**的：生成失败就回退成空串，登录流程照常继续。所以**它不是扫码登录的硬依赖**，但可能是降低风控概率的软依赖。**具体影响程度未核实。**

---

## 5. 重点核实：`yuan71058/XianYuApis-GO`（Go 移植，同样无许可证）

**结论：它的签名函数、搜索接口与本项目逐字一致，是最贴近本项目的参考；但同样没有 LICENSE 文件。**

### 5.1 许可证（🔵 已核实）

- README 徽章写 `![License](https://img.shields.io/badge/License-MIT-green.svg)` 并链接 `LICENSE`
- **但 `LICENSE` 文件 404**；四个候选名 × 两个分支全部 404；GitHub API `license.spdx_id` 为空
- → 与 cv-cat 同样的问题：**徽章声称 MIT，实际无许可证文件**

另注：`go.mod` 的 module 名是 `github.com/cv-cat/xianyuapis`——**它是 cv-cat 项目的 Go 移植**（README 也写"整合 XianYuApis (Python) + goofish_api (Python) 双库功能"）。所以它继承了同一个许可证缺陷。

### 5.2 纯 HTTP 扫码登录实现（🔵 `pkg/apis/qrcode.go`）

函数 `QrcodeLogin(cfg)` 的 docstring 给出 8 步，与 cv-cat 的 Python 版**一一对应**：

```
1. BuildInitialCookies()          → 获取基础 Cookie
2. 加载 passport.goofish.com/mini_login.htm → 获取 XSRF-TOKEN
3. POST /qrcode/generate.do       → 生成二维码 URL   ← 注意源码实际用的是 GET
4. 终端打印二维码 (可选)
5. 轮询 /qrcode/query.do          → 等待用户扫码
6. POST /login_token/login.do     → 完成登录
7. 刷新 mtop Cookie               → 更新 _m_h5_tk
8. 返回已登录的 XianyuAPI 实例
```

> ⚠️ docstring 第 3 步写 `POST`，但实际代码是 `http.NewRequest(http.MethodGet, ...)`。以代码为准。**这类 docstring 与实现不一致的情况，说明"只读文档"不足以作为协议依据。**

它还额外提供了**异步三步式** API（为 Wails 等桌面应用设计），这对本项目很有参考价值：
- `QrcodeGenerateAsync()` → 返回 `QrcodeSession`（持有带 CookieJar 的 `http.Client`、`CSRFToken`、`Cookie2`、`Cna`、`QRData`）
- `(*QrcodeSession).PollOnce()` → 单次非阻塞轮询，返回 `NEW`/`SCANNED`/`CONFIRMED`/`EXPIRED`/`ERROR`
- `(*QrcodeSession).Complete()` → 完成登录并返回 `.goofish.com` 域的 cookie dict

**这正是本项目 Web UI 场景需要的形状**：HTTP 服务端持有 session，前端轮询状态、渲染二维码。

### 5.3 关键差异与坑（🔵 读了源码）

**（a）`CONFIRMED` 时 token 字段有 4 个候选**：

```go
token := rawResult.Content.Data.Token     // "token"
if token == "" { token = rawResult.Content.Data.LgToken }  // "lgToken"
if token == "" { token = rawResult.Content.Data.St }       // "st"
if token == "" { token = rawResult.Content.Data.StEx }     // "stEx"
if token == "" { return "ERROR", fmt.Errorf("CONFIRMED but no token found") }
```

比 Python 版多兼容了 `st` / `stEx` 两个字段。**说明不同版本/灰度下响应字段名会变**——实现时应当把 4 个都兜住。

**（b）超时兜底**：轮询超时后会再查一次 `unb` cookie，若存在则认为"登录可能已通过 Set-Cookie 完成"。

**（c）成功后强制校验 `unb`**：

```go
finalCookies := extractGoofishCookies(client)
if unb, ok := finalCookies["unb"]; !ok || unb == "" {
    return nil, fmt.Errorf("qrcode: unb cookie not found after login")
}
```

**（d）Go cookiejar 的坑（注释写得很清楚，Node 侧同样适用）**：

> Go 的 cookiejar 遵循 RFC 6265，不接受以点开头的域名（如 `.goofish.com`）作为 URL 主机名。必须使用合法主机名（如 `www.goofish.com`）查询。Domain 字段为 `.goofish.com` 的 Cookie 可以被 `www.goofish.com` 查询到。

**（e）tfstk 依赖 node 子进程，且仓库缺文件**：`pkg/util/tfstk.go` 通过 `exec.Command("node", scriptPath)` 调用 `assets/gen_tfstk.js`，30 秒超时。而 `gen_tfstk.js` 的注释说要读 `env_snapshot.json`，**但该文件不在仓库的文件清单里**（只有 `assets/et_f.js` 和 `assets/gen_tfstk.js`）。→ **开箱即用时 tfstk 生成大概率失败**，回退为空。这从侧面印证 tfstk 不是硬依赖。

**（f）它的签名函数与本项目完全一致**（`pkg/util/sign.go`）：

```go
// 签名公式: MD5(token + "&" + timestamp + "&" + appKey + "&" + data)
// 其中 appKey = "34839810"
func GenerateSign(timestamp, token, data string) string {
	msg := fmt.Sprintf("%s&%s&%s&%s", token, timestamp, "34839810", data)
	sum := md5.Sum([]byte(msg))
	return fmt.Sprintf("%x", sum)
}
```

**（g）搜索接口与本项目完全一致**（`pkg/search/crawler.go`）：`mtop.taobao.idlemtopsearch.pc.search` / `1.0`，`data` 字段为
`pageNumber, keyword, fromFilter, rowsPerPage, sortValue, sortField, customDistance, gps, propValueStr{searchFilter:"publishDays:1;"}, customGps, searchReqFromPage:"pcSearch", extraFilterValue:"{}", userPositionJson:"{}"`，
extra query 为 `spm_cnt=a21ybx.search.0.0, spm_pre=a21ybx.home.searchInput.0, accountSite=xianyu`。

**（h）风控错误码识别**（`pkg/apis/login.go`）：识别 `FAIL_SYS_USER_VALIDATE` 与 `RGV587_ERROR`，从 `data.url` / `data.data.url` / 顶层 `url` 提取验证链接，并有 `CaptchaHandler` 回调让用户自行完成验证（**不是自动绕过**）。另识别 `令牌过期` 关键字做重试。

---

## 6. 纯 HTTP 扫码登录完整流程还原

综合三个实现 + 我的实测，还原如下。**标 🟢 的是我实测确认的，标 🔵 的是源码交叉确认但未实测的。**

```
┌─ 阶段 A：准备设备态 cookie ──────────────────────────────── 🔵
│  1. GET  https://log.mmstat.com/eg.js          → cna
│  2. POST h5api.m.goofish.com/h5/mtop.taobao.idlehome.home.webpc.feed/1.0/        → _m_h5_tk
│     POST h5api.m.goofish.com/h5/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/ → cookie2
│     （sign 可为空串；body 必须手工拼 "data=%7B%7D"）
│  3. （可选）node gen_tfstk.js → tfstk
│
├─ 阶段 B：拿二维码 ──────────────────────────────────────── 🟢 本人实测
│  4. GET  https://passport.goofish.com/mini_login.htm
│          ?lang=zh_cn&appName=xianyu&appEntrance=web&styleType=vertical
│          &bizParams=&notLoadSsoView=false&notKeepLogin=false
│          &isMobile=false&qrCodeFirst=false&stie=77&rnd=<rand>
│          → HTTP 200；Set-Cookie: XSRF-TOKEN, _samesite_flag_, cookie2, t, _tb_token_
│  5. GET  https://passport.goofish.com/newlogin/qrcode/generate.do
│          ?appName=xianyu&fromSite=77&appEntrance=web&umidToken=
│          &mainPage=false&isMobile=false&lang=zh_CN&returnUrl=&umidTag=SERVER
│          → { content: { data: { t, codeContent, ck, resultCode:100, processFinished:true } } }
│          codeContent = https://passport.goofish.com/qrcodeCheck.htm?lgToken=<...>&_from=havana
│          用任意二维码库把 codeContent 渲染成图片给用户扫
│
├─ 阶段 C：轮询 ──────────────────────────────────────────── 🟢 本人实测（NEW 状态）
│  6. POST https://passport.goofish.com/newlogin/qrcode/query.do?appName=xianyu&fromSite=77
│          Content-Type: application/x-www-form-urlencoded
│          body: appName, fromSite, appEntrance=web, umidToken=, mainPage=false,
│                isMobile=false, lang=zh_CN, returnUrl=, umidTag=SERVER,
│                navlanguage=en, navPlatform=Win32, isIframe=true,
│                documentReferer=https://www.goofish.com/, defaultView=sms,
│                deviceId=<cna>, t=<generate.t>, ck=<generate.ck>
│          → { content: { data: { qrCodeStatus: "NEW"|"SCANNED"|"CONFIRMED"|"EXPIRED",
│                                resultCode: 100, token?, lgToken?, st?, stEx? } } }
│          建议 3 秒一次，总超时 120 秒
│
├─ 阶段 D：兑换登录态 ────────────────────────────────────── 🔵 源码交叉确认，未实测
│  7. CONFIRMED 时：token = data.token || data.lgToken || data.st || data.stEx
│     同时 Set-Cookie 已下发 sgcookie / unb / tracknick / csg
│  8. POST https://passport.goofish.com/login_token/login.do
│          ?token=<token>&subFlow=DIALOG_CHECK_LOGIN_RPC&nextCode=0018
│          &bizScene=qrcode&confirm=true
│          body: deviceId=<cna>
│
├─ 阶段 E：激活 mtop ─────────────────────────────────────── 🔵
│  9. POST https://h5api.m.goofish.com/h5/mtop.idle.web.user.page.nav/1.0/
│          ?jsv=2.7.2&appKey=34839810&t=<ms>&sign=&v=1.0&type=originaljson
│          &dataType=json&timeout=20000&api=mtop.idle.web.user.page.nav
│          &sessionOption=AutoLoginOnly&spm_cnt=a21ybx.home.0.0
│          body: data=%7B%7D
│          → 服务端为 .goofish.com 重新下发 _m_h5_tk
│
└─ 阶段 F：收尾校验 ──────────────────────────────────────── 🔵
  10. 从 jar 取出 .goofish.com 域全部 cookie
  11. 硬校验：必须有 unb（用户 ID）与 cookie2（会话 token）
  12. device_id = generate_device_id(unb)   // UUIDv4 形状 + "-" + unb
```

### 6.1 状态值汇总（三家交叉对比）

| 状态 | goofish-client (TS) | cv-cat (Python) | yuan71058 (Go) | 含义 |
|---|---|---|---|---|
| 待扫描 | `NEW` | `NEW` | `NEW` | 二维码已生成，无人扫 |
| 已扫码待确认 | `SCANED` ⚠️ | `SCANNED` | `SCANNED` | 手机扫了，还没点确认 |
| 已确认 | `CONFIRMED` | `CONFIRMED` | `CONFIRMED` | **登录成功，可取凭据** |
| 已过期 | `EXPIRED` | `EXPIRED` | `EXPIRED` | 重新生成 |
| 已取消 | `CANCELED` | 未处理 | 未处理 | 用户拒绝 |
| 错误 | `ERROR` | 未处理 | `ERROR` | — |

**只有 `CONFIRMED` 和 `EXPIRED` 是三家和我的实测都一致的。** 建议只依赖这两个，其余仅用于 UI 展示。

### 6.2 这些 cookie 够不够调 mtop 搜索？

**够，但必须满足三个条件**（🔵 三家源码一致）：

1. **必须有 `cookie2`** —— 这是**会话级** cookie。本项目的 `src/cookies.mjs` 已经把 `REQUIRED_COOKIES = ['cookie2']` 写对了，且注释里已经点破："`cookie2` 是会话语级 cookie（关掉浏览器即失效），而 mtop 必须带它"。
2. **必须有 `unb`** —— 用户 ID；Go 版把它作为登录成功的硬校验。
3. **必须有一次 mtop 请求把 `_m_h5_tk` 刷新到 `.goofish.com` 域** —— 即阶段 E 的 `page.nav`。否则搜索会因为 `FAIL_SYS_TOKEN_EMPTY` / `FAIL_SYS_TOKEN_ILLEGAL` 失败。

本项目已有的 `FileCookieStore` 会持久化 `Set-Cookie` 并支持 `refused` 值黑名单，**这套机制在纯 HTTP 登录后同样适用**，无需改动。

---

## 7. 协议风险

### 7.1 🟢 我的实测结论（最高可信度）

我以普通 UA 对 passport 发起了只读请求，**未使用任何代理、未伪造任何风控参数**：

| 请求 | 结果 |
|---|---|
| `GET mini_login.htm` | HTTP 200，28770 字节，正常下发 5 个 cookie |
| `GET newlogin/qrcode/generate.do` | HTTP 200，`success: true`，返回有效 `t` / `ck` / `codeContent` |
| `POST newlogin/qrcode/query.do`（连续 2 次） | HTTP 200，`qrCodeStatus: "NEW"`，`success: true` |

**关键点**：我在 `generate.do` 里**没有传** `_csrf_token`、`hsiz`、`bizParams`、`bx-ua`、`bx-umidtoken`，**依然成功**。全程**没有任何风控挑战、滑块、或 `x5sec` 拦截**。

→ **扫码登录这条链路目前是开放的、低风控的**，与"搜索接口"的严格风控形成鲜明对比。

### 7.2 风控参数到底需不需要（🟢 实测 + 🔵 源码）

| 参数 | 扫码登录是否需要 | 依据 |
|---|---|---|
| `bx-ua` / `bx-umidtoken` | **不需要** | 🟢 实测省略成功；源码中为可选 |
| `umidToken` | 传空串即可 | 🟢 实测；🔵 三家都传空串 |
| `_csrf_token` | **不需要**（有更好） | 🟢 实测省略成功；🔵 两家会传 XSRF-TOKEN |
| `cna` | 用于 `deviceId`，建议带上 | 🔵 三家一致 |
| `tfstk` | **不是硬依赖** | 🔵 生成失败即回退为空，流程继续 |
| `sgcookie` | **反而要小心** | 🔵 本项目 `src/browser.mjs` 已记录：值一旦变脏会导致搜索被拒 |

> 关于 `sgcookie`：本项目代码注释里已实测过"只摘掉 `sgcookie` → `SUCCESS`，正常返回 30 条商品"。**纯 HTTP 登录后新下发的 `sgcookie` 是干净的**，这一点反而是纯 HTTP 方案的优势——不必继承浏览器 profile 里那个可能已经变脏的值。

### 7.3 已知的真实失效案例（🟡 搜索结果，未读原文全文）

[fancyboi999/goofish-cli Issue #17](https://github.com/fancyboi999/goofish-cli/issues/17)：「**fix (auth): auth login --qr 失效——闲鱼登录页改版**」，摘要为"等不到 passport iframe，120s 超时"。

**这个案例非常有价值，因为它恰恰是"浏览器方案"失效、"纯 HTTP 方案"不受影响**：它依赖的是**渲染出来的 DOM 选择器**（`.qrcode-login`）和 **iframe 结构**，闲鱼一改版就崩。而纯 HTTP 方案依赖的是**接口契约**，改版不影响。

> 这也解释了本项目当前的痛点：`src/browser.mjs` 用 Playwright 渲染二维码，同样脆弱。**纯 HTTP 化同时也是"抗改版"的加固。**

### 7.4 其他风险（🔵 源码确认）

| 风险 | 说明 | 来源 |
|---|---|---|
| `_m_h5_tk` 寿命短 | 约 **10 分钟**；浏览器活跃访问时靠 `Set-Cookie` 续期，不访问页面就会过期 | goofish-cli `core/refresh.py` |
| 错误码拼写 | 服务端真实返回 `FAIL_SYS_TOKEN_EXOIRED`（**平台自己拼错了 EXPIRED**），匹配时不能只写正确拼写 | goofish-cli `core/refresh.py` |
| 风控码 | `RGV587_ERROR`、`FAIL_SYS_USER_VALIDATE`、`FAIL_SYS_SESSION_EXPIRED`、`FAIL_SYS_TOKEN_EMPTY/ILLEGAL`、`FAIL_SYS_ILLEGAL_ACCESS` | 四家一致 |
| 非 JSON 响应 | 返回 HTML 拦截页（含 `punish` / `x5sec` 字样）或 HTTP 419/429 即为风控 | xianyu-search `mtop.py` |
| 响应字段漂移 | `CONFIRMED` 的 token 字段在 `token`/`lgToken`/`st`/`stEx` 之间漂移 | Go 版 `PollOnce` |
| 状态值拼写漂移 | `SCANED` vs `SCANNED` | goofish-client vs 另两家 |

---

## 8. Cookie 生命周期管理横向对比

| 项目 | 过期检测 | 自动续期 | 持久化格式 | 加密 | 评价 |
|---|---|---|---|---|---|
| **fancyboi999/goofish-cli** | 调 `mtop.idle.web.user.page.nav` 探测；记录 `h5_token_exp` | ✅ 命中 `FAIL_SYS_TOKEN_EXOIRED` 自动走 Playwright"快速进入" | `~/.goofish-cli/cookies.json`（含 name/value/domain/path）+ `im_token.json` | 仅文件权限 `chmod 0o600` | 🏆 **最完善，最值得借鉴** |
| **SearchT-zy/xianyu-search** | 依赖 `ret` 里的 TOKEN 类错误 | ✅ 每次响应从 `Set-Cookie` 捞新 `_m_h5_tk`，立即重试（最多 2 次） | Playwright `storage_state.json`，`protect_file` 收紧权限 | 仅权限 | 简洁有效，MIT 可放心参考 |
| **11273/goofish-client** | `TokenManager.isTokenError()` 匹配 3 个错误码 | ✅ `updateFromHeaders()` 从 `Set-Cookie` 刷新 | 无内置持久化（交给调用方） | 无 | 库形态，生命周期推给使用者 |
| **cv-cat / yuan71058** | 靠 mtop `ret` 关键字（含"令牌过期"） | 部分（重试 + `CaptchaHandler`） | 内存 dict，交给调用方 | 无 | 弱 |
| **Usagi-org/ai-goofish-monitor** | 任务失败阈值 + 账号轮换 | 靠多账号轮换，非续期 | SQLite + `state/acc_*.json` | 无 | 思路是"换号"而非"续期" |
| **本项目 `FileCookieStore`** | 已有 `refused` 值黑名单 + `REQUIRED_COOKIES=['cookie2']` | 已有（每次响应吸收 `Set-Cookie`） | `data/cookies.json`，原子写 + `0o600` | 仅权限 | 已相当好，**缺的是"主动探测 + 重新登录"闭环** |

### 🏆 最值得借鉴的三点（都来自 goofish-cli，Apache-2.0 可放心参考）

1. **熔断器（circuit breaker）**：命中 `RGV587` 后写 `~/.goofish-cli/circuit.json` 记一个时间戳，冷却期内直接拒绝请求而不是继续撞墙（默认 10 分钟，`GOOFISH_CIRCUIT_BREAK_MINUTES` 可调），并提供 `auth reset-guard` 手动解除。
   → **本项目目前的"每轮恰好 1 次请求"已经很克制，但缺一个"撞了风控就整体暂停"的开关。**

2. **凭据的"新鲜度"硬校验**：刷新后必须同时看到 `_m_h5_tk`、`unb`、`cookie2` 三个才算成功，否则**拒绝合并**，避免"看起来成功、实际缺件"的假成功。

3. **同名 cookie 跨域去重**：合并新旧 cookie 前，先按 `(name, domain, path)` 删掉旧条目再写入，否则会出现"两个 `_m_h5_tk` 并存"导致 `CookieConflict` 异常。
   → **本项目 `FileCookieStore` 用的是 `Map<name, cookie>`（按 name 去重），已经天然规避了这个坑。**

---

## 9. 许可证红线（务必遵守）

本项目 `LICENSE` 为 **MIT**（`Copyright (c) 2026 timefunnel`），`package.json` 亦声明 `"license": "MIT"`。

| 项目 | 许可证 | 能否复制代码进本项目 | 说明 |
|---|---|---|---|
| 11273/goofish-client | **GPL-3.0** | 🔴 **绝对不能** | 传染性强，会让整个项目被迫 GPL-3.0 |
| cv-cat/XianYuApis | **无 LICENSE 文件** | 🔴 **绝对不能** | 默认保留全部权利；README 的 MIT 徽章指向一个不存在的文件，不构成授权 |
| yuan71058/XianYuApis-GO | **无 LICENSE 文件** | 🔴 **绝对不能** | 同上；且它是 cv-cat 的移植，继承同一缺陷 |
| jeanmoumou/XianYuApis | **无 LICENSE 文件** | 🔴 **绝对不能** | — |
| fancyboi999/goofish-cli | Apache-2.0 | 🟢 可以（需保留 NOTICE） | 仓库含 `NOTICE` 文件，引入时需一并保留 |
| SearchT-zy/xianyu-search | MIT | 🟢 可以 | 保留版权声明即可 |
| Usagi-org/ai-goofish-monitor | MIT | 🟢 可以 | — |
| voltwake/xianyu-monitor | MIT | 🟢 可以 | README 声明 |
| XIE7654/goofish_api | MIT | 🟡 谨慎 | LICENSE 是 MIT，但 `spider/xianyu_sign.py` 文件头写"禁止用于商业用途"，**自相矛盾**；本项目非商业则风险低 |
| IAMLZY2018/xianyuapis | MIT | 🟢 可以 | 但无扫码登录模块 |
| yuzhiblue/xianyu | MIT | 🟢 可以 | 但无扫码登录模块 |

### ⚠️ 最重要的合规结论

**唯二两个"纯 HTTP 扫码登录"的可用实现（cv-cat 和 yuan71058），都没有许可证；第三个（goofish-client）是 GPL-3.0。**

→ **本项目必须"照协议自己写"，不能复制任何一家的代码。**

**好消息是这完全可行**，理由：
- **接口路径、参数名、状态值是协议事实（facts），不是受版权保护的表达**。独立实现协议不构成侵权。
- 本项目的 `src/mtop.mjs` 已经在独立实现同一套 mtop 签名，且实现方式与三家都不同（自己组织代码结构）。
- 我本人已经**实测验证了协议的前两步**，实现时不必"照抄"任何人的代码，只需照协议写。

**建议做法**：把本报告的 §6 当作协议规格（spec），自己写 `src/qrlogin.mjs`，不引入任何第三方依赖。这也符合本项目"零依赖直连"的既有风格。

---

## 10. 落地建议（针对本项目）

### 10.1 现有架构已经准备好的部分

| 现有资产 | 现状 | 纯 HTTP 登录后的复用情况 |
|---|---|---|
| `src/cookies.mjs` `FileCookieStore` | 原子写、`0o600`、`refused` 值黑名单、`REQUIRED_COOKIES=['cookie2']` | ✅ **完全复用**，只需保证登录后 `save()` |
| `src/mtop.mjs` | 已实现 `md5(token&t&appKey&data)`、appKey 34839810 | ✅ **完全复用**，用于阶段 E 刷新 `_m_h5_tk` |
| `src/search.mjs` / `src/monitor.mjs` | 每轮 1 次请求，无浏览器 | ✅ **完全不动** |
| `src/browser.mjs` | Playwright 渲染二维码 + 导出 cookie + `dropRiskCookies()` | 🔄 **扫码登录部分可整体删除**；`dropRiskCookies()` 保留（本地操作，仍有用） |
| `src/server.mjs` + `src/web/index.html` | Web UI | 🔄 **新增"扫码登录"页面**：展示二维码 + 轮询状态 |
| `package.json` 依赖 `playwright` | 唯一运行时依赖 | 🎯 若"点开看商品"也改为纯 HTTP，则 **playwright 依赖可彻底移除**，Docker 镜像可从 ~1GB 降到 ~100MB |

### 10.2 建议的改动清单

1. **新增 `src/qrlogin.mjs`**（照 §6 协议独立实现，约 200–300 行）
   - `createSession()` → 阶段 A + B，返回 `{ qrUrl, t, ck, session }`
   - `pollStatus(session)` → 阶段 C，返回 `NEW|SCANNED|CONFIRMED|EXPIRED|CANCELED`
   - `completeLogin(session, token)` → 阶段 D + E + F，返回 cookie jar
   - **对 `token`/`lgToken`/`st`/`stEx` 四个字段全兜**；对 `SCANED`/`SCANNED` 两种拼写全兜
2. **新增 CLI 命令** `node src/cli.mjs login --qr`（纯 HTTP 版，终端打印二维码，复用 cv-cat 那套半块字符 `▀▄█` 渲染法，或直接输出 URL）
3. **Web UI 新增扫码登录页**：`POST /api/login/qr` 建会话 → 前端用二维码库渲染 → 轮询 `GET /api/login/qr/status` → `CONFIRMED` 后落盘并提示
4. **保留现有浏览器登录作为降级路径**（`--qr --browser`），至少在灰度期保留——因为阶段 D 我无法实测
5. **补一个主动探测**：登录后立刻用 `mtop.idle.web.user.page.nav` 或 `mtop.taobao.idlemtopsearch.pc.search` 验证一次，把"文件里有 cookie"和"服务端认这个 cookie"区分开（本项目 `src/browser.mjs` 注释里已经踩过这个坑）
6. **补一个熔断开关**：命中 `RGV587` / `FAIL_SYS_USER_VALIDATE` 时整体暂停 N 分钟

### 10.3 工作量估算

| 阶段 | 内容 | 工作量 |
|---|---|---|
| 核心实现 | `src/qrlogin.mjs`（阶段 A–F） | **0.5–1 人日** |
| 实测联调 | 需要真人拿手机扫码，跑通 `CONFIRMED` → 拿到可用 cookie → 搜索成功 | **0.5 人日 + 等待扫码** |
| CLI 接入 | `login --qr` 命令 + 终端二维码 | 0.25 人日 |
| Web UI | 扫码页 + 2 个 API + 轮询 | 0.5–1 人日 |
| 降级与风控 | 浏览器降级路径保留、熔断开关、探测 | 0.5 人日 |
| 测试 | 单元测试（mock 响应）+ 端到端 | 0.5 人日 |
| **合计** | | **约 3–5 人日** |

若只需 CLI 可用（不做 Web UI），**约 1.5–2 人日**。

---

## 11. 最大不确定性（按风险排序）

| # | 不确定性 | 影响 | 缓解措施 |
|---|---|---|---|
| 1 | **阶段 D（`CONFIRMED` → token → `login_token/login.do` → 刷新 mtop cookie）我无法实测**，需要真人扫码。三家源码在"token 字段名"上已经出现漂移（`token`/`lgToken`/`st`/`stEx`） | 🔴 高：这是唯一的"能不能真正登进去"的关键 | 四个字段全兜；`unb` 存在即视为成功；**保留浏览器登录作为降级路径** |
| 2 | **`login_token/login.do` 可能已改版或已废弃**（没有任何公开资料确认它当前状态） | 🔴 高：如果这步失效，需要靠 `Set-Cookie` 兜底（cv-cat 已有此兜底逻辑） | 实现 `unb` 兜底；先实测再删浏览器 |
| 3 | **`SCANED` vs `SCANNED` 拼写**未实测确认 | 🟡 低：只影响"已扫码待确认"的 UI 提示 | 两种都匹配；只依赖 `CONFIRMED`/`EXPIRED` |
| 4 | **`tfstk` 是否真的可省**：三家都"尽力生成、失败回退"，但没有公开资料说明它对风控概率的实际影响 | 🟡 中：可能影响长期稳定性 | 先不实现 tfstk；观察登录后搜索的成功率；本项目"每轮 1 次请求"已很克制 |
| 5 | **`deviceId` 用 `cna` 还是 `generate_device_id(unb)`**：登录阶段用 `cna`（三家一致），登录后 mtop 用 `generate_device_id(unb)`。但 `generate_device_id` 是**随机 UUID + unb**，每次重新登录都会变 | 🟡 中：设备 ID 变化可能被风控视为"新设备" | 本项目目前搜索不传 deviceId，**影响可能很小**；如需固定，把首次生成的 ID 持久化 |
| 6 | **服务端随时可能加严 passport 风控**：目前宽松是因为扫码登录本身是"引导用户登录"，攻击面小；若被滥用，可能加滑块 | 🟡 中：方案整体失效 | 保留浏览器降级路径；关注 `fancyboi999/goofish-cli` 等活跃项目的 issue |
| 7 | 部分仓库元数据（`XIE7654`、`yuzhiblue`、`IAMLZY2018` 的 star / 提交时间）因 GitHub API 限流**未核实** | ⚪ 低：不影响技术结论 | 需时再查 |

---

## 12. 最终结论

### 要彻底去掉浏览器，可行吗？

**可行。** 依据：

1. **协议已完整还原**，且被**三个独立项目**（TS / Python / Go）交叉验证，参数与状态值高度一致。
2. **我本人实测通过了协议的前两步**（拿二维码、轮询到 `NEW`），服务端无任何风控拦截，且**不需要 `bx-ua` / `umid` / `_csrf_token`**——实现难度比预期低。
3. **本项目已有的基础设施（`FileCookieStore`、`mtop.mjs` 签名、每轮 1 次请求）几乎可以原样复用**，改动是"新增"而非"重构"。
4. **浏览器方案反而更脆弱**：`fancyboi999/goofish-cli` 的 `auth login --qr` 已因闲鱼登录页改版而失效（依赖 DOM 选择器与 iframe 结构）。纯 HTTP 依赖接口契约，抗改版能力更强。

### 需要多少工作量？

- **CLI 可用**：约 **1.5–2 人日**
- **含 Web UI 扫码页 + 降级路径 + 测试**：约 **3–5 人日**

### 最大的不确定性是什么？

**`CONFIRMED` 之后的三步（换 token → `login_token/login.do` → 刷新 mtop cookie）我无法实测**，必须靠真人扫码才能验证。这是唯一"能不能真正登进去"的关口。三家源码在这几步上已经出现字段名漂移（`token`/`lgToken`/`st`/`stEx`），说明服务端在此处存在灰度或版本差异。

**因此强烈建议**：先实现纯 HTTP 路径，**但保留现有浏览器登录作为降级路径**，实测跑通若干天、确认 `CONFIRMED → 可用 cookie → 搜索成功` 闭环稳定后，再删除 Playwright 依赖。

### 一条红线

**协议照抄，代码不抄。** 两个纯 HTTP 实现（cv-cat、yuan71058）**都没有许可证文件**，第三个（goofish-client）是 **GPL-3.0**。本项目是 MIT，必须依据本报告 §6 的协议规格**独立实现**。接口路径、参数名、状态值属于协议事实，独立实现不构成侵权；但复制代码会带来许可证污染。

---

## 附录 A：我的实测原始响应

> 以下均为我本人于本次调研中对公开登录接口发起的**只读**请求的原始返回，未经任何修改。**未执行任何登录、未提交任何凭据、未绕过任何验证。**

### A.1 `GET https://passport.goofish.com/mini_login.htm`

```
URL: .../mini_login.htm?lang=zh_cn&appName=xianyu&appEntrance=web&styleType=vertical
     &bizParams=&notLoadSsoView=false&notKeepLogin=false&isMobile=false
     &qrCodeFirst=false&stie=77

→ HTTP 200, 28770 bytes
→ Set-Cookie: XSRF-TOKEN, _samesite_flag_, cookie2, t, _tb_token_
```

### A.2 `GET https://passport.goofish.com/newlogin/qrcode/generate.do`

```
URL: .../newlogin/qrcode/generate.do?appName=xianyu&fromSite=77&appEntrance=web
     &umidToken=&mainPage=false&isMobile=false&lang=zh_CN&returnUrl=&umidTag=SERVER
（注意：未传 _csrf_token / hsiz / bizParams / bx-ua）

→ HTTP 200
{
  "content": {
    "data": {
      "t": 1790237764126,
      "codeContent": "https://passport.goofish.com/qrcodeCheck.htm?lgToken=138ac5eeb9d06254acc098d7eacb16223_0000000&_from=havana",
      "ck": "1ffb3b6af7fa74f4a63bd292fb700b7a",
      "resultCode": 100,
      "processFinished": true
    },
    "status": 0,
    "success": true
  },
  "hasError": false
}
```

### A.3 `POST https://passport.goofish.com/newlogin/qrcode/query.do?appName=xianyu&fromSite=77`

```
Content-Type: application/x-www-form-urlencoded
body: appName=xianyu&fromSite=77&appEntrance=web&umidToken=&mainPage=false&isMobile=false
      &lang=zh_CN&returnUrl=&umidTag=SERVER&navlanguage=en&navPlatform=Win32&isIframe=true
      &documentReferer=https://www.goofish.com/&defaultView=sms&t=1790237784992
      &ck=14d0e818d7299e1aab84b1dadc842c11

→ HTTP 200（连续两次轮询，结果一致）
{
  "content": { "data": { "qrCodeStatus": "NEW", "resultCode": 100 }, "status": 0, "success": true },
  "hasError": false
}
```

**结论**：协议前两步（生成二维码、轮询状态）**当前有效且无风控拦截**。`codeContent` 确实是需要自行渲染成二维码的 URL，`lgToken` 就在这个 URL 里。

---

## 附录 B：未能核实的部分（诚实声明）

| 项目 | 状态 |
|---|---|
| `CONFIRMED` 之后阶段的真实响应 | ❌ 未实测（需真人扫码） |
| `SCANED` 与 `SCANNED` 哪个是服务端真实值 | ❌ 未实测 |
| `token` / `lgToken` / `st` / `stEx` 哪个当前有效 | ❌ 未实测（三家源码均出现） |
| `login_token/login.do` 当前是否仍可用 | ❌ 未实测，也无公开资料 |
| `tfstk` 对风控概率的实际影响 | ❌ 未核实 |
| `XIE7654/goofish_api`、`yuzhiblue/xianyu`、`IAMLZY2018/xianyuapis` 的 star / 提交时间 | ❌ GitHub API 限流，未核实 |
| `fancyboi999/goofish-cli` Issue #17 的完整正文 | 🟡 仅读到搜索摘要（"等不到 passport iframe，120s 超时"），未读全文 |
| `jeanmoumou/XianYuApis` 的登录方式 | 🔵 文件清单显示无扫码模块，推测为 cookie 粘贴，**未逐行确认** |
