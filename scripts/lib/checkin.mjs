// scripts/lib/checkin.mjs — Tabbit 每日签到核心逻辑（可被 server.mjs 或 CLI 复用）
//
// 逆向自扩展 popup JS（个人中心签到按钮）：
//   1. 鉴权只靠 Cookie（Cookie 里的 token 字段就是 JWT，Bearer 头只是备选）
//   2. 状态接口：GET  {base}/api/commerce/activity/v1/sign-in/status?scene_codes=<code>&scene_codes=<code>
//   3. 签到接口：POST {base}/api/commerce/activity/v1/sign-in
//      body: { request_no: <32hex>, scene_codes: ["daily_sign_in","desktop_pet"] }
//      request_no 格式：32 位 hex；时间戳位置 [2,7,11,14,18,21,25,28] 填 Unix 秒 hex(8位)；
//                       第 5 位是默认浏览器标记 "1"（非默认浏览器则随机）；其余位随机。
//
// 开关：每个 env 文件里 TABBIT_AUTO_CHECKIN=1 才签到（默认关）。
//       独立于 LLM 代理请求链路，不影响 src/server.mjs 的代理功能。

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, '..', '..');

// 默认 profile 表（CLI 不带 --profile 时用）
export const PROFILES = [
  { name: 'domestic', envFile: '.env.domestic', base: 'https://web.tabbit.com', cdpPort: 9223 },
  { name: 'intl', envFile: '.env', base: 'https://web.tabbit.ai', cdpPort: 9222 },
];

// ── 读 env 文件 ───────────────────────────────────────────
export function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// ── 生成 request_no（还原扩展 en() 逻辑）──────────────────
export function genRequestNo(isDefaultBrowser = true) {
  const cfg = { markerPos: 5, defaultBrowserMarker: '1', timestampPositions: [2, 7, 11, 14, 18, 21, 25, 28] };
  const hex = '0123456789abcdef';
  const pool = hex.replace(cfg.defaultBrowserMarker, ''); // 去掉 "1"
  const ts = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-8);
  const pos = new Map();
  cfg.timestampPositions.forEach((p, i) => pos.set(p, ts[i]));
  let out = '';
  for (let i = 0; i < 32; i++) {
    if (i === cfg.markerPos) out += isDefaultBrowser ? cfg.defaultBrowserMarker : pool[Math.floor(Math.random() * pool.length)];
    else if (pos.has(i)) out += pos.get(i);
    else out += pool[Math.floor(Math.random() * pool.length)];
  }
  return out;
}

// 开关是否开启
export function isCheckinEnabled(env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.TABBIT_AUTO_CHECKIN || '').trim().toLowerCase());
}

// ── 单 profile 签到一轮 ───────────────────────────────────
// profile: { name, envFile, base, cdpPort }
// 返回 { profile, skipped|error|signedToday|result|signedDays|... }
export async function checkInProfile(profile) {
  // envFile 可能是相对路径（.env / .env.domestic）或绝对路径（TABBIT_ENV=...）
  const envPath = profile.envFile.startsWith('/') ? profile.envFile : join(PROJECT_ROOT, profile.envFile);
  const env = loadEnvFile(envPath);
  const cookie = (env.TABBIT_COOKIE || '').trim();

  if (!isCheckinEnabled(env)) {
    console.log(`[checkin:${profile.name}] 跳过：${profile.envFile} 未开启 TABBIT_AUTO_CHECKIN=1`);
    return { profile: profile.name, skipped: true, reason: 'disabled by env' };
  }

  if (!cookie) {
    console.log(`[checkin:${profile.name}] 跳过：${profile.envFile} 未配置 TABBIT_COOKIE（可先启动代理或浏览器 ${profile.cdpPort} 自动拉取）`);
    return { profile: profile.name, skipped: true, reason: 'no cookie' };
  }

  const base = profile.base;
  const scenes = ['daily_sign_in', 'desktop_pet'];
  const qs = scenes.map(s => `scene_codes=${encodeURIComponent(s)}`).join('&');

  // 1) 查状态
  let status;
  try {
    const r = await fetch(`${base}/api/commerce/activity/v1/sign-in/status?${qs}`, {
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    });
    if (!r.ok) return { profile: profile.name, error: `status HTTP ${r.status}` };
    status = await r.json();
  } catch (e) {
    return { profile: profile.name, error: `status fetch: ${e.message}` };
  }

  const daily = status?.results?.find(s => s.scene_code === 'daily_sign_in');
  if (!daily) return { profile: profile.name, error: 'no daily_sign_in in status', raw: status };

  if (daily.signed_today) {
    console.log(`[checkin:${profile.name}] 今日已签到（连续 ${daily.signed_days} 天），跳过`);
    return {
      profile: profile.name, base, signedToday: true, signedDays: daily.signed_days,
      totalSignedDays: daily.total_signed_days, raw: status,
    };
  }

  // 2) 签到
  const body = JSON.stringify({ request_no: genRequestNo(true), scene_codes: scenes });
  try {
    const r = await fetch(`${base}/api/commerce/activity/v1/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body,
    });
    const txt = await r.text();
    if (!r.ok) return { profile: profile.name, error: `sign-in HTTP ${r.status}: ${txt.slice(0, 200)}` };
    const data = JSON.parse(txt);
    const result = data?.results?.find(s => s.scene_code === 'daily_sign_in');
    const done = result?.sign_in_result === 'success' || result?.sign_in_result === 'already_signed';
    console.log(`[checkin:${profile.name}] 签到完成：${result?.sign_in_result || 'unknown'}（连续 ${result?.signed_days ?? daily.signed_days} 天）`);
    return {
      profile: profile.name, base, signedToday: done, result: result?.sign_in_result,
      signedDays: result?.signed_days ?? daily.signed_days, totalSignedDays: result?.total_signed_days ?? daily.total_signed_days,
      raw: data,
    };
  } catch (e) {
    return { profile: profile.name, error: `sign-in fetch: ${e.message}` };
  }
}

// ── 计算到下次签到（本地次日 00:00:30）的毫秒数 ───────────
export function msUntilNextCheckin(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  return next.getTime() - now.getTime();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 常驻循环（启动立即签一轮，之后睡到次日 00:00:30 再签）──
// 返回 stop() 用于停止。unref 定时器避免阻塞进程退出（如被 server 引用时）。
export function startAutoCheckin(profile) {
  let stopped = false;
  let timer = null;

  async function loop() {
    if (stopped) return;
    try {
      await checkInProfile(profile);
    } catch (e) {
      console.error(`[checkin:${profile.name}] 签到异常:`, e.message);
    }
    if (stopped) return;
    const waitMs = msUntilNextCheckin();
    const next = new Date(Date.now() + waitMs);
    console.log(`[checkin:${profile.name}] 下次签到: ${next.toLocaleString('zh-CN', { hour12: false })}（${(waitMs / 3600000).toFixed(1)} 小时后）`);
    timer = setTimeout(loop, waitMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  loop();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
