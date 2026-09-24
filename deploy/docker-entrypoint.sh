#!/bin/sh
# 容器里没有显示器，而闲鱼会识别无头浏览器并返回「非法访问」页，
# 因此用 Xvfb 提供一块虚拟显示，让 Chromium 以正常的有头模式运行。
# 已经有 DISPLAY（例如本地调试或接了 VNC）时直接用。
set -e
if [ -z "$DISPLAY" ]; then
  exec xvfb-run -a "$@"
fi
exec "$@"
