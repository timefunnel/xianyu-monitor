#!/bin/sh
# 容器里没有显示器。**监控本身不需要它**（http 模式不启浏览器），需要的是扫码登录那一步：
# 闲鱼对无头请求直接返回「非法访问」页，二维码不会渲染，所以登录必须跑在有头模式下。
# 这里统一套一层 Xvfb，登录、以及 browser 模式回退都能直接用。
# 已经有 DISPLAY（例如本地调试或接了 VNC）时直接用。
set -e
if [ -z "$DISPLAY" ]; then
  exec xvfb-run -a "$@"
fi
exec "$@"
