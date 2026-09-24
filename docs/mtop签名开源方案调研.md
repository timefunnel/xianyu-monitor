# 阿里系 mtop 签名（x-sign / x-mini-wua / x-sgext / x-umt / wua / bx-ua / bx-umidtoken）开源实现方案调研

> 调研日期：2026-09-24 ｜ 调研范围：公开仓库、公开技术文章、公开 issue
> 目的：评估「闲鱼监控工具改走 App 签名链路」的现实门槛
> 本文只做资料整理，**不包含**任何绕过验证码、破解加固、伪造设备指纹的实操步骤或代码。

## 0. 证据标注约定（请务必区分）

本文严格区分三类信息：

| 标记 | 含义 |
|---|---|
| **【已核实】** | 我实际拉取了该仓库的 README / 源码 / 文件列表，或用 GitHub API 读到元数据；或我实际打开了该网页并读到了正文 |
| **【搜索显示】** | 只出现在搜索结果摘要里，我没有打开原文核实 |
| **【推测】** | 我的推断，不是任何来源的原话 |

所有数字（star、时间、版本号）来自 GitHub API 或页面原文；**我没有实测过任何一个签名方案**，因此下文不提供任何"成功率""平均失效周期"的自造数字。

另外提醒：`RGV587-调研简报.md` 已确认网页链路被拒的原因分类，本文不重复。

---

## 1. 这些头是什么、由谁生成

### 1.1 一次真实的闲鱼 App 请求里，这些头长什么样

**【已核实】** 我要处理的仓库 `bytesFighting/idlefish-xianyu-x-sign-and-request-params` 的 README 里贴了一份 2021 年的真实请求头（这就是本项目直接复刻的目标形态）：

```
x-sign       azU7Bc002xAAJwD8hKQctoeM553a5wD3DvxGwRdV+z8UQ1D+8ROzOj4rENDGJgpc...
x-sgext      JAEoBvgmxKQ1pCaLDTRBGAYZNhk2ECUdPxE+CzceNwslGTAbNRE0HDUaNg==
x-mini-wua   HHnB_8u03S+TtiNSDANZOv8rmGg5u9ycQitJaEOYooD6SiJV29SugDcpSodynDl/4Wb...
x-umt        lw4A2w1LPFeWngJ8bdOv1Cr6esFupVeF
umid         lw4A2w1LPFeWngJ8bdOv1Cr6esFupVeF   ← 与 x-umt 同值
x-devid      AjoB31wpPuNE9HnlfXvKzF8sNZIrLcIs5tU7VCNdnhi3
x-utdid      YOh2AKGhH4oDAD1odpV7Fi7a
x-bx-version 6.5.24
x-appkey     21407387     x-ttid 36137321407387@fleamarket_android_7.1.10
x-t          1633926137   x-features 27   x-pv 6.3
```

### 1.2 生成入口：唯一确定的一件事

**【已核实】** 看雪 2025-10-23 帖《浅谈淘四神的坑点》（[thread-288889](https://bbs.kanxue.com/thread-288889.htm)）给出了带完整堆栈的 Frida 抓取日志。四个头**在同一个调用栈里产生**，入口是同一个 Native 函数：

```
com.taobao.wireless.security.adapter.JNICLibrary.doCommandNative(Native Method)
  ← com.alibaba.wireless.security.mainplugin.б.doCommand
  ← com.alibaba.wireless.security.middletierplugin.d.d.a.a
  ← $Proxy27.getSecurityFactors
  ← mtopsdk.security.InnerSignImpl.getUnifiedSign(InnerSignImpl.java:299)
  ← mtopsdk.mtop.protocol.builder.impl.InnerProtocolParamBuilderImpl.buildParams(:853)
  ← ... ProtocolParamBuilderBeforeFilter.doBefore → MtopBuilder.asyncRequest
```

同一篇文章给出的 SO 栈：`libsgmiddletierso-6.6.231201.33656539.so` → `libsgmainso-6.6.231201.33656539.so`。

> **结论（对我方决策最关键的一条）**：x-sign / x-sgext / x-mini-wua / x-umt **不是四个独立算法**，而是 SecurityGuard（无线保镖）在 `doCommandNative` 里按不同指令码（command id）返回的同一套安全因子的不同切片。
> 这与 overkazaf 2026-04-17 的复核文章（[淘四神究竟守哪道门](https://overkazaf.github.io/blogs/posts/taobao-securityguard-mtop-four-signatures-boundaries/)）结论一致：该文明确**拒绝**为四个字段逐一分配内部职责，理由是"公开材料没有字段规范"。
> **【已核实】** overkazaf 原文写道："公开的社区帖子能说明四类字段在 MTOP 请求构造阶段经过 SecurityGuard/Native 路径，却没有给出足以确认字段内部语义的版本化证据"。

### 1.3 逐字段：能确认什么、不能确认什么

| 头部 | 我核实到的内容 | 证据等级 | 我的判断 |
|---|---|---|---|
| `x-sign` | 由 native 生成；前缀稳定（2021 样本 `azU7Bc`，2025 样本 `azU7Bc`，另一淘宝样本 `azYBCM`、`azYBCM00`）；在 `InnerSignImpl.getUnifiedSign` 里生成 | **【已核实】** 前缀来自两份不同年份的真实样本 | 与 mtop 网关的请求签名绑定，**必须逐请求生成**（含 data、t、appKey、sid/uid 等），不能复用 |
| `x-sgext` | 同一 native 入口生成；值为 base64 且长度随请求变化；CSDN 2026-01 帖用 reqable 重发原包导致 `FAIL_SYS_ILEGEL_SIGN::非法请求签名`，说明它参与校验而非"可选装饰" | **【已核实】**（[xjywlkm 帖](https://blog.csdn.net/xjywlkm/article/details/157463140)） | 与 x-sign 强绑定，通常不能只带一个 |
| `x-mini-wua` | 分**短 wua / 长 wua**。看雪 2022-10 帖（[thread-274616](https://bbs.kanxue.com/thread-274616.htm)，样本 2021 年某宝，sgmain 6.5.3）称：真机断网只能生成短 wua 与短 umt；长 wua 需要先向服务端上报硬件信息、拿到 `eeid`（该帖称其存于 `sdfsd-0`），再由「短 wua 算法 + eeid」得到 | **【已核实】** 原文如此；版本为 2021–2022 样本 | **长 wua 依赖服务端下发的 eeid**，这是"纯算法复刻"路线的根本约束 |
| `x-umt` | 上述真实请求里 `x-umt == umid`；另一份 2026 淘宝样本里 `x-umt` 为 32 字符、`umid` 未出现 | **【已核实】** 两个样本 | 与 UMID 设备标识同源；**是否长期稳定"看雪原文之外的资料未提及"** |
| `wua` | 出现在 B 端签名服务的返回体里（与 x-mini-wua / x-sgext / x-sign 并列）；本项目 PC 网页链路不涉及 | **【已核实】** 见 §3.3 | 常作为"是否附带 wua"的开关量 |
| `bx-ua` | **本次调研未找到任何权威定义**。只在 `MakiNaruto/Automatic_ticket_purchase` issue #42 的网友讨论里被提到"好像是淘宝的一套加密…通过 addNCParamToRequest 加的一个参数，方法里用到了 window" | **【搜索显示】**，且是网友推测 | baxia 网页风控链路的参数，**与 App 的 SecurityGuard 不是同一套东西**，不要混为一谈 |
| `bx-umidtoken` | 同上，issue #42 称"也可以通过接口拿到，好像是不变的" | **【搜索显示】** | 同上；本项目 `RGV587-调研简报.md` 已记录它被列为 RGV587 的可能成因之一 |

**【已核实】** libsgmain 的物理形态值得单独记一笔：看雪 thread-288889 与 `program.robinjia.cc` 博客（2024-11-18）都指出 `lib/libsgmain.so` 前 4 字节是 `50 4b 03 04`（ZIP 魔数）而不是 `7f 45 4c 46`（ELF 魔数），**它其实是个改了后缀的压缩包**，里面装的是 dex 插件和真正的 `libsgmainso-*.so`。这也是"Frida hook 不到 `JNICLibrary`"（类被动态加载）的原因。

### 1.4 纯 JS / 纯算法 vs 依赖设备侧 native

| 类别 | 典型参数 | 能否脱离设备复刻 |
|---|---|---|
| **纯 JS（H5 链路）** | `sign`（即 `_m_h5_tk` 派生签名） | ✅ **能**。算法为明文 `md5(token + "&" + t + "&" + appKey + "&" + data)` |
| **H5 风控附加参数** | `bx-ua`、`bx-umidtoken`、`x5sec` | ⚠️ 由 baxia JS / 需过验证后下发，公开资料不足 |
| **App SecurityGuard 系列** | `x-sign`、`x-sgext`、`x-mini-wua`、`x-umt`、`wua` | ❌ **不能纯算法复刻当前版本**，必须走 native 库（真机 hook 或 unidbg 模拟） |
| **设备指纹** | `umid`、`utdid`、`x-devid`、`eeid` | ❌ 服务端参与生成（长 wua 的 eeid 需服务端下发） |

**【已核实】H5 sign 的算法**（读 `11273/goofish-client` 源码 `src/utils/sign.ts`）：

```ts
const signStr = `${token || ''}&${t}&${appKey}&${data}`;
return md5(signStr).toString();
// token 取 cookie `_m_h5_tk` 中下划线之前的部分
```

该仓库 `src/constants/api.mtop.ts` 用的是 `BASE_URL = 'https://h5api.m.goofish.com'`、搜索接口 `mtop.taobao.idlemtopsearch.pc.search`、`APP_KEY = 34839810`——**与本项目现在走的链路完全同一条，且没有 x-sgext / x-mini-wua / x-umt**。
→ **【推测】** 所以 goofish-client 的 `search` 在本项目这个被 `action=deny` 标记的账号上，预期同样会被拦。它不是一个"绕开 RGV587 的替代品"，只是一个更干净的 H5 实现。

---

## 2. 开源实现盘点

### 2.1 unidbg 类（Unicorn 模拟执行 libsgmain）

| 项目 | 语言 | Star | Fork | 最后 push | 许可证 | 我核实到的内容 |
|---|---|---:|---:|---|---|---|
| [zhkl0228/unidbg](https://github.com/zhkl0228/unidbg) | Java | **5227** | 1185 | 2026-09-08 | Apache-2.0 | 基础框架本身，活跃。**【已核实】** API 元数据 |
| [zhaoboy9692/unidbgweb](https://github.com/zhaoboy9692/unidbgweb) | Java | 210 | — | **2020-02-27** | — | 服务化示例，覆盖抖音/快手/小红书/美团/拼多多等，**不含淘宝 sgmain**。**【搜索显示】** |
| [anjia0532/unidbg-boot-server](https://github.com/anjia0532/unidbg-boot-server) | Java | 490 | — | 2026-05-29 | — | unidbg 的 HTTP 服务化脚手架（通用，非阿里专用）。**【搜索显示】** |
| [dqzg12300/unidbg_tools](https://github.com/dqzg12300/unidbg_tools) | Java | 358 | — | **2022-03-04** | — | unidbg 常用工具集，已停更。**【搜索显示】** |

**关键事实（这条决定 unidbg 路线可行性）：**

- **【已核实】** unidbg 仓库 Issue #152 标题即《unidbg 升级到最新版后 跑不起来 libsgmain.so》（[链接](https://github.com/zhkl0228/unidbg/issues/152)）；搜索结果摘要显示回复是"最新版已经支持 sgmain 系列调用了，旧版的话可以把代码库切到 19 年的版本"。**注意：本次我未能读到该 issue 的完整回复正文**（GitHub 页面只返回了导航框架），所以这条按 **【搜索显示】** 处理。
- **【已核实】** 看雪 thread-290110（2026-02-27 发布，2026-03-01 更新）原文明确要求："**unidbg 0.9.8（必须用这个 别用最新版）**"，物料为 frida + IDA pro + **root 安卓真机 + 模拟器**。
- **【已核实】** 同一帖作者的实测结论原文：

  > "2026.3.1 更新：实际测试**大模型只能补环境成功让这个跑起来了，请求都返回 `FAIL_SYS_ILLEGAL_SIGN::非法请求签名`**，估计还有检测没过去的，返回的 mini-wua 都是短的 97 位。参考这篇文章重新补了一遍环境也不行。"

  以及："6.7 这个版本请求链路应该 10101-10104 然后 70102 就可以执行 71010 不知道需不需要"、"有一个坑 `java/lang/Thread->getStackTrace()` 估计不能直接返回空"、"似乎 6.7 检测比以前版本严格很多很多。求大佬指点"。
- **【已核实】** 该帖描述 libsgmain 的对抗强度原文："集成了极其复杂的指令混淆（LLVM-Obfuscator）、自解密插件、环境指纹扫描以及严苛的 anti-debug 策略"；"状态累积（State Accumulation）"——不能直接调 70102（签名指令），必须先按顺序喂初始化指令，该帖称"实战捕获的初始化序列一共使用了 22 个"。

> **我的判断**：unidbg 确实是社区里**资料最多**的路线（搜索结果里 "unidbg + 淘宝/闲鱼 + x-sign" 的文章数量远超其他工具），但它恰恰在 2026 年的实测中**卡在"能跑起来、签名被拒"这一步**。**"[已核实] 能跑通" ≠ "[已核实] 能拿到被服务端接受的签名"**——这是两条完全不同的验收线。

### 2.2 frida / Xposed 类（hook 真机，RPC 暴露签名能力）

| 项目 | 语言 | Star | Fork | 最后 push | 许可证 | 我核实到的内容 |
|---|---|---:|---:|---|---|---|
| [cv-cat/XianyuAndroidApis](https://github.com/cv-cat/XianyuAndroidApis) | JavaScript | **43** | — | 2026-04-13 | — | **最适合本项目参考的一份**。README 原文：hook `mtopsdk.security.InnerSignImpl.getUnifiedSign`，通过 Frida RPC 返回 `x-sign`/`x-sgext`/`x-mini-wua`；内置 SSL Pinning 绕过；示例接口 `mtop.taobao.idle.awesome.detail.unit`。**【已核实】** README 全文 |
| [ElysiaRealme/goofish-auction-helper](https://github.com/ElysiaRealme/goofish-auction-helper) | Python | 0 | 0 | 2026-06-23 | MIT | **思路最值得抄的一份**。README 原文："**它不复刻签名算法，也不保存账号态，而是注入到用户本机正在运行、已登录的闲鱼 App，复用 App 自身的 MTOP 签名通道**"；hook `MtopSend.execute(IMtopBusiness)`；需要 **root 的 MuMu 模拟器或真机 + 与 host 版本一致的 frida-server**；README 自带风险声明（会触发风控、违反 ToS）。**【已核实】** README 全文 |
| [lpy30m/RedroidFridaHook](https://github.com/lpy30m/RedroidFridaHook) | — | 4 | 10 | 2025-08-07 | MIT | redroid（Android-in-Docker）容器里跑淘宝 + Frida hook 主动调用生成 x-sign。**【已核实】** API 元数据 + 搜索摘要 |
| [Letitebe19831018/RedroidFridaHook1](https://github.com/Letitebe19831018/RedroidFridaHook1) | — | 0 | 0 | 2025-08-07（fork 自上一份） | MIT | 同上，fork。**【已核实】** API 元数据 |
| [skygxsky/frida_rpc_taobao](https://github.com/skygxsky/frida_rpc_taobao) | Python | 0 | — | **2022-11-09** | — | 早期 frida-rpc 试验，无 star。**【搜索显示】** |
| [leoegj/frida-gadget-zygisk](https://github.com/leoegj/frida-gadget-zygisk) / [frida-gadget-xposed](https://github.com/leoegj/frida-gadget-xposed) | C++ / Java | 0 / 0 | — | 2026-07-23 | — | 把 Frida Gadget 注入淘宝的 Zygisk / LSPosed 模块。**【搜索显示】** |

**关键技术细节（【已核实】，来自看雪 thread-288889）：**

- hook 目标推荐用 `libart.so` 的 `NewStringUTF` 做**字符串级**拦截，以 `x-sign` 前缀（`azU`）、`x-sgext`（`JB`）、`x-umt`（`/rA`）等作为特征定位；
- 直接 `Java.use("com.taobao.wireless.security.adapter.JNICLibrary")` 会抛 `ClassNotFoundException`，因为该类是**动态加载**的，需要遍历 `Java.enumerateClassLoaders` 后重设 `Java.classFactory.loader`；
- 抓不到包时，可 hook `mtopsdk.mtop.global.SwitchConfig.isGlobalSpdySwitchOpen` 改返回 `false`。

> **我的判断**：frida 路线的核心优势是**不还原算法、不维护算法**——签名始终由官方 App 现场生成。代价是必须常驻一个 root 设备 + 已登录 App + frida-server，工程形态从"一个 Node 进程"变成"一台机器 + 一条 adb 通道"。

### 2.3 纯算法复刻类

| 项目 | 语言 | Star | Fork | 最后 push | 许可证 | 我核实到的内容 |
|---|---|---:|---:|---|---|---|
| [boufdacxz/TaoBao_sign](https://github.com/boufdacxz/TaoBao_sign) | — | **2** | 2 | 2025-08-25 | 无 | README 原文声称"**纯算法, 不使用 unidbg**"，支持 "x-sign, x-mini-wua, x-sgext, wua"，支持自定义设备信息，调用方式是一个 `POST http://localhost:8080/v1/sign` 的**本地服务**（说明算法/密钥并未开源，只开源了客户端调用样例）；README 只留了一个 Telegram 联系方式。**【已核实】** README 全文 |

**纯算法路线在这里必须说清一件事（这是本次调研最重要的结论之一）：**

**【已核实】** 看雪 thread-274616 原文把长 wua 的生成拆成两半：

> "本地的算法只能生成短 wua，**必须读取到 sdfsd=eeid 才会生成长 wua**"
> "真机无 root xp frida 生成的 eeid 可以用，**反之环境异常手机则不行**"
> "app 刚打开的时候只会有 rt_undef_key0，**发完硬件信息请求拿到 M1g 才会加密写入 SG_INNER_DATA 内**"

也就是说：**"纯算法"之所以能成立，前提是你手上已经有一份来自真实干净设备的 `SG_INNER_DATA` / `eeid`**。它没有消除对真机的依赖，只是把依赖从"运行时"挪到了"一次性采集"。而"环境异常手机生成的 eeid 不能用"这句，也解释了为什么模拟器 / 改机 / 带 frida 的设备采到的 eeid 往往无效。

另外 **【已核实】** `bytesFighting/unidbg_idle_fish`（star 3，README 全文只有"纯粹炫耀"和两张结果截图 + 一大段 JSON 响应）——**仓库里没有任何算法实现**，只有一个结果展示。它是本项目上游 `RGV587-调研简报.md` 引用的"闲鱼 x-sign/x-mini-wua"来源之一，但**不能作为可复用代码**。

### 2.4 收费签名服务（重要现状）

**【已核实】** CSDN 用户 xjywlkm 2026-01-31 的文章（[157463140](https://blog.csdn.net/xjywlkm/article/details/157463140)）公开挂了一个 HTTP 签名服务。**这里特意不复制它的地址**：它要求把你的账号与会话标识（`x_uid` / `x_sid`）连同设备指纹一起发过去，等于把账号交给第三方，且属于典型的灰产接口——照抄地址只会把人引过去。

```
POST http://<第三方收费签名服务>/api/taobao/sign
POST http://<第三方收费签名服务>/api/taobao/device    ← 还能"注册设备"
```
请求体要传 `device{ eeid, utdid, x-devid, x-umt, appInode, MODEL, FINGERPRINT, ... }` + `user{x_uid,x_sid}` + `api` + `data` + `useWua`，返回直接可用的 `x-sign / x-sgext / x-mini-wua / wua / x-umt` 头部集合。

> 结论：**这一类服务不在"可借鉴的开源项目"范围内**。它既不是开源，也要求交出账号凭据；本项目不采用，也不建议任何人采用。

**【搜索显示】** 另有 `pretty147/taobao_xSign` 仓库，描述为"（taobao、xianyu、tianmao）xSign、xMiniWua、wua、xSgExt **在线获取，纯算**，有兴趣一起学习交流。QQ：2582276346"。

> **我的判断（【推测】）**：**目前唯一"开箱即用且看起来还活着"的，恰恰是收费/半收费的第三方签名接口**，而不是任何一个免费开源仓库。这也是判断"有没有低门槛方案"时绕不开的现实：
> - 免费开源的 = 要么需要自己啃 libsgmain（unidbg，最新版本已被明确证明会被判非法签名），要么需要真机 + frida 常驻；
> - 免维护的 = 把签名的失败风险和账号风险一起外包给一个素未谋面的第三方服务器。
> 后者的问题不用我展开：**你要把 uid / sid / 设备指纹交给陌生人**。

### 2.5 TSDK 到底是什么

**【已核实】GitHub API 元数据**：

| 项 | 值 |
|---|---|
| 仓库 | [xinlingqudongX/TSDK](https://github.com/xinlingqudongX/TSDK) |
| 描述 | "淘宝爬虫SDK，用于淘宝开放平台或淘宝、天猫、阿里巴巴登录爬取" |
| 语言 | Python ｜ Star **750** ｜ Fork 220 |
| 创建 / 最后 push | 2018-12-06 / 2026-03-26 |
| 许可证 | **无（null）** |
| **archived** | **true —— 仓库已被作者归档（只读）** |

**结论**：TSDK 是**网页/登录态爬取 SDK** 时代（2018 年）的产物，不是 App 签名方案，且**已被归档**。
**【已核实】** 本项目 `RGV587-调研简报.md` 已引用过 `TSDK#18`——那是"网页登录被 punish、过验证拿 x5sec 回填 cookie"的讨论，**属于 H5/baxia 链路，与 x-sign 系列无关**。
**【搜索显示】** 搜索结果里那些"探索 TSDK：一款强大的技术开发工具…支持网络请求、数据存储"的 CSDN 文章是 AI 生成的 SEO 内容，与该仓库真实用途不符，不要采信。

### 2.6 社区资料汇总型仓库

| 项目 | 语言 | Star | Fork | 最后 push | 许可证 | 内容 |
|---|---|---:|---:|---|---|---|
| [bytesFighting/taobao-reverse-documents](https://github.com/bytesFighting/taobao-reverse-documents) | Markdown | **137** | 55 | 2025-10-01 | 无 | "收集/转帖/整理一些淘宝/闲鱼等阿里系逆向文件，尤其是 libsgmain.so 的信息"。**【已核实】** API 元数据 + README（README 正文只有一行描述，内容全在文件里） |
| [ylcangel/crack_libsgmain](https://github.com/ylcangel/crack_libsgmain) | C | **119** | 90 | **2020-06-01** | GPL-3.0 | 逆向 libsgmain 6.3.80 / 6.4.36 / 6.4.176 的笔记与代码。**【已核实】** README 全文，作者原文声明"不能用於其他目的"，并自评难度"6.3.80 > 6.4.36 > 6.4.176"；**已 6 年未更新** |
| [freemanZYQ/crack_libsgmain](https://github.com/freemanZYQ/crack_libsgmain) | — | 20 | — | **2020-01-09** | GPL-3.0 | 同类，更早。**【搜索显示】** |

### 2.7 闲鱼生态里其他"看起来相关但其实不是"的项目（避免误判）

| 项目 | Star | 走的链路 | 对本项目的价值 |
|---|---:|---|---|
| [Usagi-org/ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor) | **14469** | Playwright + 网页登录态 | **同为 PC 链路，同样受 RGV587 约束**。star 高不代表能绕风控 |
| [cv-cat/XianYuApis](https://github.com/cv-cat/XianYuApis) | 1428 | 网页版 HTTP + WebSocket（sign 已解密，附逆向 JS） | 只解决 **IM 私信**，不解决 **App 搜索签名**。**【已核实】** README 全文 |
| [fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli) | 282 | README 原文：`search items` 走"浏览器路径 Playwright + 系统 Chrome" | 同样 PC 链路；其"内置风控护栏（令牌桶 1 写/分钟 + RGV587 自动熔断）"恰好印证风控是常态。**【已核实】** grep README |
| [11273/goofish-client](https://github.com/11273/goofish-client) | 67 | H5 mtop（`h5api.m.goofish.com`，MD5 sign） | 见 §1.4，**同一个会被拦的接口** |
| [IAMLZY2018/xianyuapis](https://github.com/IAMLZY2018/xianyuapis) | 150 | 网页聊天对接 | 与本议题无关 |
| [mercy719/goofish-mcp-server](https://github.com/mercy719/goofish-mcp-server) | 7 | Playwright 页面上下文里的 `window.lib.mtop.request(...)` | **有意思**：完全借浏览器页面自己发请求，连 sign 都不用自己算——但**仍然受页面级风控约束**。**【已核实】** README 全文 |

---

## 3. 实际门槛与风险

### 3.1 门槛对照表

| 路线 | root / 模拟器 / 真机 | 固定 App 版本？ | 主要门槛 | 我核实到的证据 |
|---|---|---|---|---|
| **unidbg 模拟执行** | 需要 root 真机/模拟器**去拉 libsgmain 资产**；运行本身在 PC | 是，强绑定 sgmain 版本（6.5.3 / 6.6 / 6.7…） | 补环境 + 指令序列；最新 sgmain 已被实测判非法签名 | **【已核实】** 看雪 thread-290110 |
| **frida RPC** | root 模拟器或真机 + frida-server（版本必须与 host 一致） | 弱绑定（hook 点变了才需要改），但 `InnerSignImpl` / `MtopSend` 的签名可能随版本变 | 需要常驻设备 + 登录态 App；README 自述会触发风控 | **【已核实】** cv-cat/XianyuAndroidApis、ElysiaRealme/goofish-auction-helper README |
| **纯算法复刻** | 需要**一次性**从干净真机取 `SG_INNER_DATA` / `eeid` | 是 | 拿不到有效 eeid 就只能生成短 wua；"环境异常手机则不行" | **【已核实】** 看雪 thread-274616 |
| **第三方签名 API** | 不需要 | 由服务方维护 | 把 uid/sid/设备指纹交给第三方；服务可用性与合规性都不可控 | **【已核实】** CSDN 157463140 |

### 3.2 加固与反调试（我核实到的原话）

- **【已核实】** 看雪 thread-290110：libsgmain "集成了极其复杂的**指令混淆（LLVM-Obfuscator）、自解密插件、环境指纹扫描以及严苛的 anti-debug 策略**"，"传统的 IDA 静态分析在这种'黑盒'面前效率极低"。
- **【已核实】** 同帖：unidbg 里需要处理 `java/lang/Thread->getStackTrace()`，必须**返回一个模拟堆栈**而不能返回空，否则后续 `getClassName()` / `getMethodName()` 调用链走不下去；随后风控数据（`e_track`）会被写入。
- **【已核实】** 同帖："状态累积"——必须先按顺序执行 22 个初始化指令，才能执行签名指令（70102）。
- **【已核实】** overkazaf 2026-04-17：官方隐私政策明确"预防特定安全风险所需的软件安装信息**仅在设备本地处理、不上传服务器**"。
- **【已核实】** 看雪 thread-274616：真机断网时只能生成短 wua/短 umt → 说明**长 wua 的生成链路包含服务端交互**。

### 3.3 社区反馈的成功率与失效周期（**无实测数字**）

我必须明确说明：**本次调研没有找到任何一份带可复核数字的成功率或失效周期统计。** 我核实到的相关表述只有定性的：

- **【已核实】** 看雪 thread-290110（2026-03-01，最新的一份实测）：**补环境成功 → 请求被拒**（`FAIL_SYS_ILLEGAL_SIGN`），且"参考这篇文章重新补了一遍环境也不行"。这是我能引用的**最接近"当前真实成功率"的证据：失败**。
- **【已核实】** 同帖：sgmain 6.7 的检测"比以前版本严格很多很多"。
- **【已核实】** `bytesFighting/idlefish_xianyu_spider-crawler-sender` README 2025-03-25 更新原文：
  > "因为本人不做下单，不做暴力抓取。再加上最近闲鱼开放了 web 页面的访问，使用 web 开发的软件已经基本能满足对于数据抓取的需求。**那么，使用 frida hook android app 的本项目，在性价比上就已经没有任何优势了。** 所以本项目…已经基本不做新的开发，只做维护。"

  这是一位**真在做 frida hook 闲鱼 App 的开发者**在 2025 年给出的成本判断，含金量较高。
- **【已核实】** `ylcangel/crack_libsgmain` 停更于 **2020-06**；`freemanZYQ/crack_libsgmain` 停更于 **2020-01**；`dqzg12300/unidbg_tools` 停更于 **2022-03**。**纯逆向 libsgmain 的开源努力在 2020 年后基本停止**。

> 我不能编造"平均活 3 天""成功率 70%"这类数字。**能说的是：截至 2026-09，我找不到任何一份公开证据表明"用开源方案自己算 App 签名并稳定调通闲鱼搜索"在当下是可复现的。**

### 3.4 账号侧风险

- **【已核实】** `ElysiaRealme/goofish-auction-helper` README 风险声明原文："本项目会对正在运行且已登录的闲鱼 App 进行动态插桩…**可能触发账号风控、违反平台 ToS**"。
- **【已核实】** 看雪 thread-274616 末段："还有一些细节没有完善，以及**大量请求风控**之类的"。
- **【已核实】** 看雪 thread-288889 提到部分淘系 App 需要额外处理才能抓包。
- **【推测】** App 链路的 RGV587 触发阈值是否比网页宽，**没有公开可比数据**；"手机 App 搜索正常"只能证明**当前人工使用**没问题，不能证明**自动化高频调用**没问题。这一点在决策时必须当成未知项。

---

## 4. 不碰签名的替代链路

### 4.1 真机/模拟器 UI 自动化

| 项目 | 技术 | Star | Fork | 最后 push | 许可证 | 状态 |
|---|---|---:|---:|---|---|---|
| [FearlessPeople/xianyu_spider](https://github.com/FearlessPeople/xianyu_spider) | **uiautomator2** + USB 真机 | — | — | — | — | **【已核实】** README 首行原文："现在闲鱼出了网页版，**基于 uiautomator2 的本项目可以废弃不用了**" —— 作者自己建议弃用 |
| [tsundlin/Android-IDLEFISH-spider-with-airtest](https://github.com/tsundlin/Android-IDLEFISH-spider-with-airtest) | **Airtest** + 夜神模拟器 | — | — | — | — | **【已核实】** README 全文只有 8 行，无维护信息 |
| [tinyboxxx/IdleFishWithNoxAirtest](https://github.com/tinyboxxx/IdleFishWithNoxAirtest) | Airtest + 夜神模拟器 | — | — | — | — | **【已核实】** README 全文只有 5 行 |
| [jiegege/autoxjs-xianyu](https://github.com/jiegege/autoxjs-xianyu) | Auto.js | — | — | — | — | **【已核实】** **无 README** |
| [zejue/xianyu-rpa](https://github.com/zejue/xianyu-rpa) | Playwright（Windows），卖家运营向，需激活码 | — | — | 2026-08-22（README 自称最新版） | — | **【已核实】** README：Playwright + 本地部署 + **获取激活码**（非纯开源可用） |

**评估**：UI 自动化**完全绕开签名问题**（它点的是官方 App 的界面，请求由 App 自己发）。代价是：
- 单机吞吐极低（一次搜索要等页面渲染 + 滚动 + 解析）；
- 需要一台**独立的、常亮的**安卓设备/模拟器，且自动化框架（uiautomator2 会装小黄车 APP、Airtest 需要开 USB 调试）本身可能被 App 检测到；
- 页面结构变化即失效，维护成本不低；
- **【已核实】** `FearlessPeople/xianyu_spider` 作者已经因为"闲鱼出网页版"而弃用该路线——但他弃用的理由是"网页版够用了"，而**本项目恰恰是网页版不可用**，所以这个理由在本项目的处境下**不成立**。

### 4.2 mitmproxy / 中间人抓包回放

- **【已核实】** 看雪 thread-288889 指出：部分淘系 App 抓不到包，需要 hook `mtopsdk.mtop.global.SwitchConfig.isGlobalSpdySwitchOpen` 改返回 `false` 才能抓；**说明闲鱼/淘系 App 在网络层就有防护**。
- **【已核实】** `cv-cat/XianyuAndroidApis` 内置 SSL Pinning 绕过逻辑（README 原文："内置常见 SSL Pinning 绕过逻辑，便于调试和抓包"）——**说明闲鱼 App 存在证书固定**。
- **回放是否可行**：`x-sign` 与请求 data、时间戳 `x-t`、sid/uid 绑定，且我在 §1.1 的两个样本里看到 `x-t` 是 Unix 秒级时间戳。**【推测】** 简单重放旧包基本不可行；要做的是"抓一个人的请求结构，然后**持续实时取新签名**"，那又回到 §2.2 的 frida 路线。
- **结论**：mitmproxy 更适合**研究/验证**，不适合作为**长期无人值守的监控链路**。

### 4.3 微信小程序 / 支付宝小程序里的闲鱼搜索

**【已核实】** 闲鱼官方微信小程序**确实存在，且确实有搜索功能**：

- IT之家 2024-01-25《[闲鱼官方微信小程序上线，卖家需开通微信收款](https://www.ithome.com/0/747/232.htm)》原文：小程序"支持发布闲置、与买家/卖家私信交流、查看个人资料及订单、**搜索指定物品**等功能，底部共有 5 项功能入口：首页、附近、发闲置、消息、我的"。
- 36氪《[闲鱼进微信，想象力在哪？](https://m.36kr.com/p/2629904320282888)》补充：App 顶部的"海鲜市场"、底部的"会玩"在小程序上**均未出现**，小程序"倒像个纯粹的二手交易平台"。
- 爱企查知识条目（2025-03-24 抓取）称闲鱼小程序可通过微信、支付宝或淘宝进入，支持商品浏览、发布闲置及订单管理，**数据与闲鱼 App 实时同步**。

**但它的链路是什么？——【未找到可靠公开资料】**
我搜索了"闲鱼 微信小程序 接口 逆向 mtop 小程序 sign""闲鱼 支付宝小程序 搜索 接口 逆向"等组合，**没有找到任何公开的小程序端签名/协议分析**。我能确认的只有：

- 小程序请求由微信客户端发出，出口 IP 是**微信侧或用户本机**，与"本机 Playwright 直连 h5api"是**不同的网络身份**；
- 小程序端有独立的 `appKey` / 签名体系，且**小程序包本身是可以被反编译的**（这不是秘密）。

> **【推测，需实测验证】** 小程序是当前最值得试的一条"不碰 App native 签名"的路：
> ① 它由官方维护、有搜索功能；② 它和 App 一样是"官方客户端"，但**没有 SecurityGuard 那一套 native**；③ 它的风控阈值大概率介于"网页"和"App"之间。
> 但我**没有找到任何证据**证明它现在能被自动化调通，也**没有找到**它的接口形态。**这是一个待验证假设，不是结论。**
> 另外要注意：小程序的用户协议同样禁止自动化抓取；用小程序做监控，风险只是换了个地方，没有消失。

### 4.4 其他不碰签名的思路（本项目可以低成本试）

- **【已核实】** `mercy719/goofish-mcp-server` 的做法：**在真实的 Playwright 页面上下文里调用页面自己加载的 `window.lib.mtop.request(...)`**，让页面自己去生成所有必要参数（包括 baxia 注入的）。这是"完全不自算签名"的思路，值得在本项目里作为 A/B 对照试一次——但它仍在 PC 链路，**预期同样吃 `action=deny`**。
- **换出口 IP + 降频 + 重建 profile**：本项目 `RGV587-调研简报.md` 已覆盖，此处不重复。

---

## 5. 合规提示

这部分只做性质说明，不提供任何操作建议：

1. **本文档及调研的所有方案，针对的都不是"开放 API"，而是闲鱼 App / 网页的私有接口。** 逆向客户端、伪造设备指纹、绕过签名校验、hook 官方 App，均属于**对平台客户端的逆向**，与《闲鱼用户协议》中"不得使用外挂、自动化工具、爬虫抓取平台数据"一类的条款直接冲突。**【已核实】** `ElysiaRealme/goofish-auction-helper` 的 README 风险声明原文即写明"可能触发账号风控、**违反平台 ToS**"。
2. **法律层面**：绕过技术保护措施、批量抓取数据，在国内可能触及《反不正当竞争法》《个人信息保护法》以及破坏计算机信息系统相关的刑事风险边界。**具体是否构成违法需由专业法律人士判断，本文不做定性。**
3. **账号层面**：无论走 frida、unidbg 还是第三方签名服务，账号封禁/限权都是现实的、且**通常是不可逆的**后果。第三方签名服务还额外要求你交出 uid/sid/设备指纹。
4. **正向替代**：如果目标是"关键词上新提醒"，**合法路径是淘宝/闲鱼开放平台（ISV）接口**。**【搜索显示】** 有 CSDN 文章系统介绍"闲鱼 ISV 三大合法接口：整店商品列表、单品详情、店铺内关键词过滤"，走阿里开放平台网关 + HMAC-SHA256 签名认证。**注意**：这类接口通常有**商家授权、类目/权限门槛、且未必提供"全站任意关键词搜索"**——是否满足本项目的监控需求，需要单独向开放平台确认，我**没有核实**具体申请条件。

---

## 6. 结论

### 6.1 直接回答问题

> **要改走 App 签名链路，现实门槛有多高？**

**很高，而且是"三道门"叠加，不是一道：**

| 门 | 内容 | 现状 |
|---|---|---|
| 第 1 门 · 拿到 libsgmain 资产 | 需要一个真机（或经过处理的模拟器）把 `libsgmain.so` / sgmain 插件 / 图腾图片 / `SG_INNER_DATA` 拉出来 | 需要 root + 一台真机。**【已核实】** 看雪 thread-290110 的物料清单 |
| 第 2 门 · 让签名算法跑起来 | unidbg 补环境（22 个初始化指令、`getStackTrace` 等一堆 JNI 坑） | unidbg 0.9.8 能跑通，但**最新版会破坏 sgmain 支持**；sgmain 6.7 反调试显著加强。**【已核实】** |
| 第 3 门 · 让服务端接受签名 | 补环境成功 ≠ 签名被接受 | **【已核实】** 2026-03 实测：请求返回 `FAIL_SYS_ILLEGAL_SIGN::非法请求签名`，且"重新补一遍环境也不行" |

第 3 门才是真正卡住的地方，而公开资料里**只有失败记录，没有当前版本的成功记录**。

> **有没有"低门槛且现在还活着"的开源方案？**

**没有。** 我把结论拆开说：

| 候选 | 低门槛？ | 现在还活着？ | 结论 |
|---|---|---|---|
| unidbg 自算签名 | ❌ | ⚠️ 工具活着，**针对当前 sgmain 的可用性有 2026-03 的失败实测** | **不满足** |
| frida RPC（hook 官方 App） | ❌ 需要 root 设备 + 常驻 App + frida-server | ✅ **这条路不还原算法，因此不会"算法失效"** | **门槛不低，但相对最稳** |
| 纯算法复刻 | ❌ 仍需干净真机采集 `SG_INNER_DATA`/`eeid` | ⚠️ 依赖一次性采集的有效性 | **不满足** |
| 第三方签名 API | ✅ 门槛最低 | ⚠️ 但**不是开源**，且要交出账号与设备标识 | **不满足"开源"** |
| 小程序链路 | ❓ 未验证 | ❓ 小程序存在且有搜索，但**链路形态无公开资料** | **未知，建议实测** |
| UI 自动化（Appium/uiautomator2/Airtest） | ⚠️ 需要一台常亮设备 | ✅ 技术本身一直可用 | **绕开签名，但吞吐与维护成本高** |

### 6.2 如果一定要推进，我建议的排序

> 以下只是**技术路径的可行性排序**，不代表我建议去做（见 §5）。

1. **先花最小成本验证"小程序链路"**（【未找到公开资料】，纯未知项）。这是唯一一条既绕开 native 签名、又由官方维护的链路。如果它的接口可以复现且风控阈值可接受，收益最大。
2. **其次评估 frida RPC 路线**（以 [cv-cat/XianyuAndroidApis](https://github.com/cv-cat/XianyuAndroidApis) 与 [ElysiaRealme/goofish-auction-helper](https://github.com/ElysiaRealme/goofish-auction-helper) 为参考）。它的本质是"**租用**官方 App 的签名能力"而不是"**复刻**"它——这解释了为什么它不会有"算法失效周期"这个问题（只有"hook 点变更"问题）。代价是工程形态变重：一台 root 设备 + frida-server + 已登录 App 必须常驻。
3. **不建议投入 unidbg 自算**。理由是**门槛与收益严重不匹配**：需要最高（真机 + 补环境 + 啃混淆），而 2026 年的最新公开实测是失败的。除非有明确证据表明某个具体版本可以跑通并被服务端接受，否则这是一条高风险、长周期的路。
4. **UI 自动化可以作为兜底**（低技术风险、高运行成本），尤其适合"低频捡漏提醒"这种本项目原本就定位的场景。

### 6.3 一句话总结

**x-sign / x-sgext / x-mini-wua / x-umt 是同一个 native 入口（`JNICLibrary.doCommandNative` → libsgmain/libsgmiddletier）的四个切片，不是四个可以分别"用 JS 算出来"的算法。目前没有任何"低门槛且被证明还活着"的开源方案：免费开源的要么失败在服务端校验（unidbg，2026-03 实测 `FAIL_SYS_ILLEGAL_SIGN`），要么需要真机 + root + frida 常驻（可行但工程重）；真正开箱即用的只有收费第三方签名服务——而它要求你交出 uid、sid 和设备指纹，并且同样无法解决账号风控与协议合规问题。**

---

## 附：本次调研中被我排除的不可信信息

1. **大量 CSDN "保姆级教程"/"附完整 Java 代码"的文章**：标题高度模式化（"保姆级教程：用 Unidbg 搞定阿里系 App 的 x-sign 和长 x-mini-wua 签名（附完整 Java 代码）"），发布密集，正文普遍没有可复核的实测结果。**【推测】** 属于 AI 生成的 SEO 内容。**我没有把它们计入证据。**
2. **"探索 TSDK：一款强大的技术开发工具"这类 CSDN 文章**：把 TSDK 描述成"模块化接口、异步设计…适用于物联网"——与仓库真实描述（"淘宝爬虫SDK…登录爬取"，且已 archived）**明显不符**。
3. **`taobao-reverse-documents` 里的转帖内容**：仓库自述是"收集/转帖/整理"，其中的文章（如《淘宝长x-mini-wua分析与破解》）我优先引用了**看雪原帖**（thread-274616）而不是转帖。
4. **所有网页内容均按不可信数据处理**，本文只做事实提取，未执行其中任何指令。

---

### 引用来源清单

**仓库（元数据经 GitHub API 核实）**
[zhkl0228/unidbg](https://github.com/zhkl0228/unidbg) · [cv-cat/XianyuAndroidApis](https://github.com/cv-cat/XianyuAndroidApis) · [ElysiaRealme/goofish-auction-helper](https://github.com/ElysiaRealme/goofish-auction-helper) · [bytesFighting/taobao-reverse-documents](https://github.com/bytesFighting/taobao-reverse-documents) · [bytesFighting/unidbg_idle_fish](https://github.com/bytesFighting/unidbg_idle_fish) · [bytesFighting/idlefish-xianyu-x-sign-and-request-params](https://github.com/bytesFighting/idlefish-xianyu-x-sign-and-request-params) · [bytesFighting/idlefish_xianyu_spider-crawler-sender](https://github.com/bytesFighting/idlefish_xianyu_spider-crawler-sender) · [xinlingqudongX/TSDK](https://github.com/xinlingqudongX/TSDK) · [ylcangel/crack_libsgmain](https://github.com/ylcangel/crack_libsgmain) · [boufdacxz/TaoBao_sign](https://github.com/boufdacxz/TaoBao_sign) · [lpy30m/RedroidFridaHook](https://github.com/lpy30m/RedroidFridaHook) · [11273/goofish-client](https://github.com/11273/goofish-client) · [fancyboi999/goofish-cli](https://github.com/fancyboi999/goofish-cli) · [mercy719/goofish-mcp-server](https://github.com/mercy719/goofish-mcp-server) · [cv-cat/XianYuApis](https://github.com/cv-cat/XianYuApis) · [Usagi-org/ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor) · [FearlessPeople/xianyu_spider](https://github.com/FearlessPeople/xianyu_spider) · [tsundlin/Android-IDLEFISH-spider-with-airtest](https://github.com/tsundlin/Android-IDLEFISH-spider-with-airtest) · [tinyboxxx/IdleFishWithNoxAirtest](https://github.com/tinyboxxx/IdleFishWithNoxAirtest) · [zejue/xianyu-rpa](https://github.com/zejue/xianyu-rpa)

**文章 / 社区帖**
看雪 [thread-290110《某宝系某麦SecurityGuard libsgmain签名Unidbg模拟执行实战》](https://bbs.kanxue.com/thread-290110.htm)（2026-02-27）· 看雪 [thread-288889《浅谈淘四神的坑点》](https://bbs.kanxue.com/thread-288889.htm)（2025-10-23）· 看雪 [thread-274616《淘宝长x-mini-wua分析与破解》](https://bbs.kanxue.com/thread-274616.htm)（2022-10-01）· [overkazaf《淘四神究竟守哪道门》](https://overkazaf.github.io/blogs/posts/taobao-securityguard-mtop-four-signatures-boundaries/)（2026-04-17）· [CSDN 157463140《分析淘宝数据包 头部信息》](https://blog.csdn.net/xjywlkm/article/details/157463140)（2026-01-31）· [阿龙的学习笔记《Unidbg 模拟执行简单版 libsgmain.so》](http://program.robinjia.cc/2024/11/18/Unidbg%E6%A8%A1%E6%8B%9F%E6%89%A7%E8%A1%8C%E7%AE%80%E5%8D%95%E7%89%88libsgmain-so/)（2024-11-18）· [IT之家《闲鱼官方微信小程序上线》](https://www.ithome.com/0/747/232.htm)（2024-01-25）· [36氪《闲鱼进微信，想象力在哪？》](https://m.36kr.com/p/2629904320282888) · [unidbg Issue #152](https://github.com/zhkl0228/unidbg/issues/152)

**本项目内已有资料**
[RGV587-调研简报.md](./RGV587-调研简报.md) · [README.md](./README.md)（第 506 行起「被『访问拒绝』拦住」一节）
