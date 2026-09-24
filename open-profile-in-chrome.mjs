// 用**普通 Chrome** 打开监控用的那个 profile，用来处理闲鱼的风控验证。
//
// 为什么需要它：baxia 风控会识别自动化环境，Playwright 控制的窗口里验证**永远过不了**
// （用户实测即使操作正确也会被判失败）。用不带自动化特征的普通 Chrome 打开同一个
// user-data-dir 才能通过。
//
// 用法（必须先停掉监控进程，否则 profile 被占用）：
//   node open-profile-in-chrome.mjs
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './src/config.mjs';

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const chrome = candidates.find((candidate) => existsSync(candidate));
if (!chrome) {
  console.error('没找到 Chrome，请用 CHROME_PATH 环境变量指定可执行文件路径。');
  process.exit(1);
}

const configPath = process.env.XIANYU_CONFIG ?? 'config.json';
const { config } = await loadConfig(configPath);
const profileDir = path.resolve(path.dirname(configPath), config.browser?.userDataDir ?? './data/browser-profile');
const site = config.baseUrl ?? 'https://www.goofish.com';

console.log('Chrome  :', chrome);
console.log('profile :', profileDir);
console.log('打开    :', site);
console.log('\n注意：如果监控进程还在跑，它会占着这个 profile，Chrome 会打不开或报错。');
console.log('处理完风控验证后关掉这个 Chrome 窗口，再重新启动监控即可。\n');

// 用 detached 启动，让脚本自己退出、Chrome 留在桌面上
const child = spawn(chrome, [`--user-data-dir=${profileDir}`, site], { detached: true, stdio: 'ignore' });
child.unref();
