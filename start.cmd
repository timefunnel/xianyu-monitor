@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 闲鱼监控控制台
echo.
echo   闲鱼监控 —— 正在启动控制台...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没有找到 Node.js，请先安装 Node 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\qrcode-generator" (
  echo   首次运行，正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo   [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo   控制台即将在浏览器中打开。关闭本窗口即停止监控。
echo.
node src/cli.mjs web
echo.
echo   控制台已退出。
pause
