# 部署到公网服务器（Docker + 既有反向代理）

这份说明对应一次真实部署：Debian 服务器上已装 1Panel（自带 OpenResty 占用 80/443），
应用跑在 Docker 里、只绑 `127.0.0.1:7788`，公网入口由 OpenResty 转发并签发证书。

## 0. 前提

| 项 | 说明 |
| --- | --- |
| 服务器 | 已装 Docker 与 `docker compose` |
| 反向代理 | 宿主机上已有 OpenResty/Nginx（本例是 1Panel），**能占 80/443** |
| DNS | 把域名（如 `yu.example.com`）的 A 记录指向服务器公网 IP——**证书签发依赖它** |
| 访问密码 | 必须设。这个控制台能改配置、看历史、触发推送 |

## 1. 上传代码

只需要源码与依赖清单，**不要**把本机的 `data/` 和 `config.json` 打包进去：

```bash
# 本机
tar czf deploy-pkg.tar.gz src package.json Dockerfile config.example.json diagnose-risk.mjs LICENSE
scp deploy-pkg.tar.gz 用户@服务器:/tmp/
# 服务器
mkdir -p /opt/xianyu-monitor/data
tar xzf /tmp/deploy-pkg.tar.gz -C /opt/xianyu-monitor && rm /tmp/deploy-pkg.tar.gz
```

## 2. 写配置与密钥

`config.json` 的 `web` 段是这个部署的关键：

```jsonc
"web": {
  "port": 7788,
  "host": "0.0.0.0",              // 容器内监听所有网卡，再由 Docker 映射到宿主机 127.0.0.1
  "password": "${WEB_PASSWORD}",  // 从 .env 读；对外监听时必填
  "trustProxy": true,             // 反代之后必须开：按真实 IP 限流 + 认 X-Forwarded-Proto
  "open": false                   // 容器里没有桌面，别去调 xdg-open
}
```

`.env`（权限收 600，别提交）：

```ini
WEB_PASSWORD=<32 位随机串，例如 openssl rand -hex 16>
BARK_KEY=<通知渠道密钥>
```

`docker-compose.yml` 直接用 `deploy/compose.server.yml`。

> **权限坑（实测踩过）**：容器里以 uid 1000 运行，而 `config.json` 是以 root 建的。
> `chmod 600` 之后容器会以 `EACCES: permission denied, open '/app/config.json'` 反复重启。
> 正确做法是把属主给容器用户：
>
> ```bash
> chown 1000:1000 config.json && chmod 600 config.json
> chown -R 1000:1000 data
> ```
> `config.json` 里只有 `${VAR}` 占位符、没有明文密钥，`data/cookies.json` 才是要护住的那个。

## 3. 起服务

```bash
cd /opt/xianyu-monitor
docker compose up -d --build
docker compose logs -f --tail 30
```

日志里应看到 `已启用访问密码，打开地址后会先跳转登录页`，以及监控开始的几条。

## 4. 验证鉴权（在服务器上）

```bash
# 未登录：页面 302 跳登录页，接口 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7788/api/state

# 正确密码：拿到会话 Cookie 并 302 回首页
curl -s -i -X POST -H 'content-type: application/x-www-form-urlencoded' \
     --data-urlencode "password=$WEB_PASSWORD" http://127.0.0.1:7788/login | head -5
```

## 5. 接上反向代理与证书（1Panel）

DNS 生效后，在 1Panel 里：

1. **网站 → 创建网站 → 反向代理**
   - 域名：`yu.example.com`
   - 代理地址：`http://127.0.0.1:7788`
2. **该网站 → HTTPS → 申请证书**（Let's Encrypt，`http-01` 校验需要 80 端口可达）
3. 打开 **强制 HTTPS**

1Panel 会把站点配置写到 `/opt/1panel/www/sites/<域名>/`，其中 `proxy/root.conf` 就是上面那条代理规则
（`proxy_pass http://127.0.0.1:7788;`）。**不要手写 vhost 文件绕过 1Panel**：站点在它的数据库里登记，
手写的配置它不认识，下次改配置可能被覆盖。

对应的 nginx 片段（仅供理解，实际由 1Panel 生成）：

```nginx
location ^~ / {
    proxy_pass http://127.0.0.1:7788;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;   # app 靠它决定 Cookie 要不要加 Secure
    proxy_http_version 1.1;
    proxy_read_timeout 3600s;                     # SSE 实时日志要长连接
    proxy_buffering off;                          # 同上：不关缓冲日志会被攒着
}
```

> `proxy_buffering off` 与长 `proxy_read_timeout` 是必须的——控制台的实时日志走 SSE，
> 缓冲会把日志攒住不发，超时短了会被反复掐断。

## 6. 登录态

容器里的登录态就是 `data/cookies.json`。两种来源：

- 从本机拷过去（本机已登录时最省事）：`scp data/cookies.json 用户@服务器:/opt/xianyu-monitor/data/`
- 或者在服务器上扫码登录（二维码打在容器终端里，不需要浏览器）：

  ```bash
  docker compose exec xianyu-monitor node src/cli.mjs login
  ```

## 7. 日常运维

```bash
docker compose logs -f --tail 100        # 看日志
docker compose restart                   # 重启
docker compose up -d --build             # 改了源码后重建
docker compose exec xianyu-monitor node src/cli.mjs check   # 校验配置
```

改密码：改 `.env` 里的 `WEB_PASSWORD`，然后 `docker compose up -d`（会话存在内存里，重启即全部失效）。

## 安全检查清单

- [ ] `web.password` 至少 12 位随机串（校验会拦 8 位以下）
- [ ] `web.host` 是 `0.0.0.0` 但**端口只映射到 `127.0.0.1`**，容器不直接暴露公网
- [ ] `web.trustProxy: true`（否则限流把所有访客算成一个 IP，一个人试错会锁住所有人）
- [ ] 反向代理开了 HTTPS 并强制跳转（否则密码是明文传输）
- [ ] `data/cookies.json` 与 `.env` 权限 600、属主是容器用户
- [ ] 失败 5 次会按 IP 锁定（首次 5 分钟，逐步加长，上限 1 小时）
