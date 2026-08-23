// src/config.mjs — 配置加载（.env + 环境变量）

import { readFileSync, existsSync } from 'node:fs';

// 每个实例可用独立 env 文件（多版本共存时互不干扰）：
//   TABBIT_ENV=.env.domestic node src/server.mjs
//   或简写： node src/server.mjs --profile domestic   （等价 .env.domestic）
function loadEnvFile(path = '.env') {
  const env = {};
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

// 注意：TABBIT_ENV 本身只能来自 shell 环境变量（文件还没读之前就需要它）
// 支持 --profile <name> 简写：优先级 TABBIT_ENV > --profile > 默认 .env
function parseProfileArg(argv = process.argv) {
  const eq = argv.find(a => a.startsWith('--profile='));
  if (eq) return eq.slice('--profile='.length);
  const i = argv.indexOf('--profile');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return null;
}
const PROFILE = parseProfileArg();
const ENV_PATH = process.env.TABBIT_ENV || (PROFILE ? `.env.${PROFILE}` : '.env');
const ENV = loadEnvFile(ENV_PATH);

export const config = {
  // 当前实例使用的 env 文件路径（persistEnv 写回时用）
  envFile: ENV_PATH,
  // Tabbit 登录态 Cookie（web.tabbit.ai 域下，含 HttpOnly token）
  // 可为空：若本机 Tabbit 以 --remote-debugging-port 运行，服务会自动从浏览器拉取
  cookie: ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE || '',
  // Tabbit 版本号，用于 x-req-ctx 头（来自 getDeviceInfo().tabbitVersion）
  version: ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39(10101039)',
  // Tabbit Web 后端地址。国际版默认 https://web.tabbit.ai；
  // 国内版改为对应域名（如 https://web.tabbit-ai.com）即可兼容，协议完全一致。
  baseUrl: (ENV.TABBIT_BASE_URL || process.env.TABBIT_BASE_URL || 'https://web.tabbit.ai').replace(/\/$/, ''),
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
