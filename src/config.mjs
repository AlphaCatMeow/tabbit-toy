// src/config.mjs — 配置加载（.env + 环境变量）

import { readFileSync, existsSync } from 'node:fs';

function loadEnvFile() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

const ENV = loadEnvFile();

export const config = {
  // Tabbit 登录态 Cookie（web.tabbit.ai 域下，含 HttpOnly token）
  // 可为空：若本机 Tabbit 以 --remote-debugging-port 运行，服务会自动从浏览器拉取
  cookie: ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE || '',
  // Tabbit 版本号，用于 x-req-ctx 头（来自 getDeviceInfo().tabbitVersion）
  version: ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39(10101039)',
  // 签名 key（留空则自动从 /chat/sign-key 拉取并定期刷新）
  signKey: ENV.TABBIT_SIGN_KEY || process.env.TABBIT_SIGN_KEY || '',
  // HTTP 服务端口
  port: Number(ENV.PORT || process.env.PORT || 8787),
  // 可选：保护代理端点的 API Key（客户端用 Authorization: Bearer <KEY>）
  apiKey: ENV.API_KEY || process.env.API_KEY || '',
  // CDP 调试端口（Tabbit 需以 --remote-debugging-port=<port> 启动）
  cdpPort: Number(ENV.CDP_PORT || process.env.CDP_PORT || 9222),
  // cookie 自动刷新间隔（分钟）
  cookieRefreshMinutes: Number(ENV.COOKIE_REFRESH_MINUTES || process.env.COOKIE_REFRESH_MINUTES || 360),
};
