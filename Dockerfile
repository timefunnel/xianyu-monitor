# 云服务器 / NAS 部署镜像。
# 运行时只有一个纯 JS 依赖（qrcode-generator，用来把二维码画在终端里），
# 所以镜像里**不需要 Chromium，也不需要 Xvfb**。
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    XIANYU_CONFIG=/app/config.json

WORKDIR /app

COPY package.json ./
# 先装依赖再拷源码，源码改动不会让依赖层失效。
RUN npm install --omit=dev --no-audit --no-fund \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY diagnose-risk.mjs ./
COPY config.example.json ./

# 状态文件与登录态都在 /app/data，用 volume 挂出来，容器重建不丢登录态。
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 非 root 运行；data 目录需要可写。
RUN chown -R node:node /app
USER node

CMD ["node", "src/cli.mjs", "run"]
