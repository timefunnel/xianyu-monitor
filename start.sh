#!/bin/sh
# 图形控制台启动脚本（Linux / NAS）。首次运行会自动装依赖。
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js，请先安装 Node 20 或更高版本。" >&2
  exit 1
fi

if [ ! -d node_modules/playwright ]; then
  echo "首次运行，正在安装依赖..."
  npm install --no-audit --no-fund
fi

echo "控制台启动后，在本机浏览器打开上面打印的地址；服务器上请用 ssh 端口转发或设置 web.token 后从局域网访问。"
# 服务器上没有图形界面，闲鱼会识别无头浏览器，所以用 xvfb-run 提供虚拟显示。
if [ -z "$DISPLAY" ] && command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a node src/cli.mjs web --no-open "$@"
fi
exec node src/cli.mjs web --no-open "$@"
