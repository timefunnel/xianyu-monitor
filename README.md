# xianyu-monitor

闲鱼关键词监控工具。定时搜索商品，按价格、地区、关键词等条件筛选，并将新命中推送到 Telegram、钉钉、企业微信、Bark、Server酱或自定义 Webhook。

> [!WARNING]
> 本项目仅供学习和个人研究。自动化访问闲鱼可能违反平台用户协议，并可能触发限流、验证、账号限制或封禁。请勿使用主账号，也不要用于代拍、代抢、批量倒卖或对外服务。

项目只负责搜索、筛选和提醒，**不会自动下单或支付**。

## 功能

- 纯 HTTP 扫码登录，无需浏览器、Chromium 或 Xvfb
- 多任务定时监控，支持随机抖动、全局请求间隔和失败退避
- 支持价格、地区、发布时间、关键词、正则、卖家等筛选条件
- 已推送商品自动去重，状态保存在本地
- 支持多种通知渠道和 App / 网页跳转
- 内置 Web 控制台，可管理任务、查看命中与日志、测试通知
- 支持 Windows、Linux、NAS、Docker 和 systemd

## 快速开始

要求：Node.js 20.11 或更高版本。

```bash
npm install
```

复制配置文件：

```powershell
# Windows PowerShell
Copy-Item config.example.json config.json
Copy-Item .env.example .env
```

```bash
# Linux / macOS
cp config.example.json config.json
cp .env.example .env
```

然后修改 `config.json` 中的关键词和筛选条件，并在 `.env` 中填写通知凭据。

```bash
npm run login          # 用闲鱼 App 扫描终端二维码
npm run check          # 校验配置，不访问闲鱼
npm run test:notify    # 测试通知渠道
npm run web            # 启动控制台并开始监控
```

控制台默认地址为 <http://127.0.0.1:7788>。Windows 也可以双击 `start.cmd`，Linux / NAS 可以执行 `./start.sh`。

只需要命令行监控时运行：

```bash
npm start
```

建议先试跑一轮确认筛选结果。默认只打印，不推送：

```bash
node src/cli.mjs once --task macbook-air-m2
node src/cli.mjs once --task macbook-air-m2 --notify
```

## 配置

完整示例见 [`config.example.json`](config.example.json)。`${VAR_NAME}` 会从环境变量或同目录的 `.env` 读取；变量缺失时程序会直接报错。

一个任务的主要配置如下：

```jsonc
{
  "name": "macbook-air-m2",
  "enabled": true,
  "notify": true,
  "keyword": "MacBook Air M2",
  "intervalSeconds": 120,
  "jitterSeconds": 20,
  "jumpLink": "app",
  "nativeFilters": {
    "priceRange": [2000, 3200],
    "region": "江浙沪",
    "sort": "newest",
    "publishDays": 3
  },
  "filters": {
    "requireKeywords": [],
    "excludeKeywords": ["求购", "展示机", "代拍", "回收"],
    "excludeSellers": [],
    "cityContains": ""
  }
}
```

### 筛选规则

| 配置 | 用途 |
| --- | --- |
| `nativeFilters.priceRange` | 闲鱼服务端价格筛选 |
| `nativeFilters.region` | 闲鱼服务端地区筛选，填写闲鱼界面中的地区名称 |
| `nativeFilters.sort` | 目前只支持 `"newest"` |
| `nativeFilters.publishDays` | 只看 1、3、7 或 14 天内发布的商品 |
| `filters.requireKeywords` | 标题至少包含其中一个关键词 |
| `filters.excludeKeywords` | 标题包含任一关键词时排除 |
| `filters.requirePattern` / `excludePattern` | 用正则表达式包含或排除 |
| `filters.excludeSellers` | 按卖家昵称精确排除 |
| `filters.requireSellerCredit` | 最低卖家信用，可填 `优秀` 或 `极好` |
| `filters.cityContains` / `cityAnyOf` | 对返回结果做本地地区判断 |

价格、地区和发布时间优先使用 `nativeFilters`，这样服务端返回的结果已经经过筛选。`filters` 适合处理闲鱼服务端不支持的条件。

搜索结果经常缺少发布时间和信用标签。默认 `monitor.onUnknownField` 为 `pass`，字段缺失时会放行并标注；如果宁可漏报也不接受未知字段，可改为 `reject`。

### 轮询频率

每个任务的一轮搜索只发出一次请求。建议单任务间隔从 120 秒起，根据任务数量适当增加。多个任务还会受到 `monitor.minRequestGapSeconds` 的全局间隔限制。

不要为了调试连续运行搜索。触发风控后程序会告警并长时间退避，反复重试通常只会加重限制。

### 去重

只有通知至少成功送达一个渠道后，商品才会写入 `data/state.json` 的去重记录。因此：

- 被筛掉的商品之后仍会重新判断；
- 所有通知渠道都失败时，下一轮仍会重试；
- 关闭推送开关时，命中会保留在控制台历史中，但不会在恢复后补发。

## 通知

支持以下 `notify.channels[].type`：

| 类型 | 必填字段 |
| --- | --- |
| `telegram` | `botToken`、`chatId` |
| `dingtalk` | `webhook`，可选 `secret` |
| `wecom` | `webhook` |
| `bark` | `key`，可选 `server`、`sound` |
| `serverchan` | `sendKey` |
| `webhook` | `url`，可选 `headers` |

推荐把密钥放在 `.env`，在 `config.json` 中引用：

```json
{
  "notify": {
    "channels": [
      {
        "type": "telegram",
        "botToken": "${TG_BOT_TOKEN}",
        "chatId": "${TG_CHAT_ID}"
      }
    ]
  }
}
```

控制台的“配置”页也可以添加、编辑和单独测试通知渠道，保存后立即生效。

## Web 控制台

`npm run web` 会启动控制台和监控进程。控制台提供：

- 运行概览和累计统计
- 任务的新建、编辑、复制、停用和删除
- 命中历史与手动重推
- 实时日志
- 通知渠道配置与测试

默认只监听本机。需要从局域网或反向代理访问时，至少配置：

```jsonc
{
  "web": {
    "host": "0.0.0.0",
    "port": 7788,
    "password": "${WEB_PASSWORD}",
    "trustProxy": true,
    "open": false
  }
}
```

- 对外监听时必须设置访问密码，公网建议使用至少 12 位随机串；
- 只有放在会覆写转发头的可信反向代理后面时，才启用 `trustProxy`；
- 公网访问必须使用 HTTPS；
- 不要直接把 7788 端口暴露到公网。

## 登录态与数据

扫码登录后，登录态保存在 `data/cookies.json`。搜索响应可能更新 Cookie，因此 `data/` 必须可写。

`data/cookies.json` 等同于账号凭据：不要分享、不要提交到 Git，也不要放进部署包。登录失效时重新运行：

```bash
npm run login
```

也可以在其他机器登录后，将 `data/cookies.json` 复制到服务器的同一位置。

## Docker 部署

先准备 `config.json`、`.env` 和可写的 `data/` 目录：

```bash
mkdir -p data
sudo chown -R 1000:1000 data
docker compose run --rm xianyu-monitor node src/cli.mjs login
docker compose run --rm xianyu-monitor node src/cli.mjs check
docker compose up -d --build
docker compose logs -f
```

仓库根目录的 `docker-compose.yml` 默认只运行命令行监控。需要通过反向代理使用 Web 控制台时，请使用 [`deploy/compose.server.yml`](deploy/compose.server.yml)，完整步骤见 [`deploy/README-部署.md`](deploy/README-部署.md)。

群晖等 NAS 可以用 Container Manager 导入 Compose 文件，并将 `config.json` 与 `data/` 映射到持久化目录。

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run web` | 启动 Web 控制台和监控 |
| `npm start` | 仅启动命令行监控 |
| `npm run login` | 扫码登录 |
| `npm run check` | 校验配置和运行环境 |
| `npm run test:notify` | 测试全部通知渠道 |
| `node src/cli.mjs once` | 运行一轮，默认不推送 |
| `node src/cli.mjs dump` | 保存原始搜索响应，便于排查接口变化 |

通用参数为 `--config 路径` 和 `--task 名称`。`web` 还支持 `--port`、`--host`、`--no-open`；`login` 支持 `--timeout 秒`。也可以用 `XIANYU_CONFIG` 指定配置文件。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示登录态不可用或搜索要求登录 | 重新运行 `npm run login` |
| 命中长期为 0 | 用 `once` 查看每条商品被跳过的原因，检查筛选是否过严 |
| 通知发送失败 | 运行 `npm run test:notify`，检查密钥和 Webhook |
| 出现 `RGV587`、baxia 或 `action=deny` | 停止频繁尝试并等待退避；可运行 `node diagnose-risk.mjs` 查看分类 |
| 提示筛选未生效 | 检查 `nativeFilters` 的字段和值，程序会中止本轮推送而不是返回未筛选结果 |
| 字段显示未知 | 运行 `dump` 保存响应，确认闲鱼接口是否改变 |
| 终端二维码无法扫描 | 使用等宽字体、拉宽窗口，或换一台机器登录后复制 Cookie 文件 |

## 安全与风险

- 本项目使用网页端二维码登录和 H5 mtop 签名，均不是公开 API；平台可能随时调整接口。
- 默认 `search.riskCookies` 为 `omit`，不会携带已知的风控状态 Cookie。请在理解其行为和平台规则后使用。
- 保持低频，不要启用多账号并发，也不要尝试绕过验证码或平台风控。
- 不要提交 `config.json`、`.env` 或 `data/`。其中可能包含通知密钥和账号登录态。
- 使用本项目产生的后果由使用者自行承担。

## 开发

```bash
npm test
```

核心代码位于 `src/`，测试位于 `test/`，部署文件位于 `deploy/`。运行时只依赖纯 JavaScript 包；Playwright 仅用于控制台验收脚本。

## 许可证

[MIT](LICENSE) © 2026 timefunnel

MIT 许可证只授权代码的使用、修改和分发，不代表通过本工具访问闲鱼符合平台服务条款。
