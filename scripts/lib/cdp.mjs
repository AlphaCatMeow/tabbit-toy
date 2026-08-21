// lib/cdp.mjs — 零依赖 CDP (Chrome DevTools Protocol) 客户端
//
// 用途：从运行中的 Tabbit 浏览器（--remote-debugging-port=9222）实时拉取
// 最新 cookie 和真实版本号，实现 tabbit2api 的 cookie 自动续期。
//
// 前提：Tabbit 需以调试模式启动：
//   open -a Tabbit --args --remote-debugging-port=9222
//
// 零依赖：使用 Node 22+ 内置 WebSocket 与全局 fetch。

import { config } from '../../src/config.mjs';
import { cookieDomains } from './tabbit.mjs';

const DEFAULT_PORT = 9222;
const DEFAULT_BASE = config.baseUrl || 'https://web.tabbit.ai';

// ─── 基础 CDP 工具 ─────────────────────────────────────────

// GET http://localhost:9222/json/list，返回 page target 列表
async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://localhost:${port}/json/list`);
  if (!res.ok) throw new Error(`CDP /json/list HTTP ${res.status}`);
  return res.json();
}

// 对某个 target 执行一条 CDP 命令（JSON-RPC over WebSocket）
function cdpCall(wsUrl, method, params = {}, timeoutMs = 8000) {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new Error('CDP 自动刷新需要 Node 22+（内置 WebSocket）。请在 Node 22+ 下运行，或在 .env 手动配置 TABBIT_COOKIE 关闭自动刷新');
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP ${method} 超时`));
    }, timeoutMs);

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 连接失败: ${wsUrl}`));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(`CDP ${method} 错误: ${msg.error.message}`));
      else resolve(msg.result);
    };
  });
}

// 找到目标域的页面 target（优先 session 页，其次任意该域页面）
function findTabbitPage(targets, baseUrl = DEFAULT_BASE) {
  const host = new URL(baseUrl).hostname;
  const pages = targets.filter(t => t.type === 'page' && t.url.includes(host));
  if (pages.length === 0) return null;
  return pages.find(t => t.url.includes('/session/')) || pages[0];
}

// ─── 对外 API ──────────────────────────────────────────────

// 拉取目标域全部 cookie，返回拼接字符串；浏览器未开/未登录返回 null
export async function fetchTabbitCookies(port = DEFAULT_PORT, baseUrl = DEFAULT_BASE) {
  const targets = await listTargets(port);
  const page = findTabbitPage(targets, baseUrl);
  if (!page) {
    throw new Error(`浏览器未打开 ${baseUrl} 页面`);
  }
  const { cookies } = await cdpCall(page.webSocketDebuggerUrl, 'Network.getAllCookies');
  const domains = cookieDomains(baseUrl);
  const web = (cookies || []).filter(c => domains.includes(c.domain));
  if (web.length === 0) {
    throw new Error(`${baseUrl} 下无 cookie（可能未登录）`);
  }
  return {
    cookie: web.map(c => `${c.name}=${c.value}`).join('; '),
    count: web.length,
    token: (web.find(c => c.name === 'token') || {}).value || '',
  };
}

// 通过 chrome.tabInstance.getDeviceInfo() 获取真实版本号（如 1.9.22(10109022)）
export async function fetchTabbitVersion(port = DEFAULT_PORT, baseUrl = DEFAULT_BASE) {
  const targets = await listTargets(port);
  const page = findTabbitPage(targets, baseUrl);
  if (!page) throw new Error(`浏览器未打开 ${baseUrl} 页面`);

  const expr = `(async () => {
    try {
      const d = await chrome.tabInstance.getDeviceInfo();
      return d.tabbitVersion || '';
    } catch (e) { return ''; }
  })()`;
  const result = await cdpCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  });
  return result?.result?.value || '';
}

// 一键刷新：拉 cookie + 版本号，浏览器不可用时抛错由调用方兜底
export async function refreshFromBrowser({ port = DEFAULT_PORT, baseUrl = DEFAULT_BASE } = {}) {
  const [cookieInfo, version] = await Promise.all([
    fetchTabbitCookies(port, baseUrl),
    fetchTabbitVersion(port, baseUrl).catch(() => ''),
  ]);
  return { cookie: cookieInfo.cookie, count: cookieInfo.count, version };
}
