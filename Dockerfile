# 云服务器 / NAS 部署镜像。
# 用官方 node 镜像 + playwright install --with-deps，避免依赖某个具体版本的 Playwright 基础镜像标签。
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    XIANYU_CONFIG=/app/config.json

WORKDIR /app

COPY package.json ./
# 先装依赖再拷源码，源码改动不会让依赖层失效。
# xvfb + xauth：扫码登录必须跑在有头模式下（闲鱼对无头请求返回「非法访问」页，二维码不渲染）。
# 监控本身不需要它们——http 模式不启浏览器。
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb xauth \
    && npm install --omit=dev --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY config.example.json ./

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# profile 与状态文件都在 /app/data，用 volume 挂出来，容器重建不丢登录态。
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 非 root 运行；data 目录需要可写。
RUN chown -R node:node /app
USER node

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/cli.mjs", "run"]
