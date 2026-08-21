// scripts/checkin-api.mjs — Tabbit 每日签到（纯接口版，无弹窗、不依赖 CDP）
//
// 逆向自扩展 popup JS（个人中心签到按钮）：
//   1. 鉴权只靠 Cookie（Cookie 里的 token 字段就是 JWT，Bearer 头只是备选）
//   2. 状态接口：GET  {base}/api/commerce/activity/v1/sign-in/status?scene_codes=<code>&scene_codes=<code>
//   3. 签到接口：POST {base}/api/commerce/activity/v1/sign-in
//      body: { request_no: <32hex>, scene_codes: ["daily_sign_in","desktop_pet"] }
//      request_no 格式：32 位 hex；时间戳位置 [2,7,11,14,18,21,25,28] 填 Unix 秒 hex(8位)；
//                       第 5 位是默认浏览器标记 "1"（非默认浏览器则随机）；其余位随机。
//
// profile 约定与 src/server.mjs 一致：
//   --profile domestic  → .env.domestic  → https://web.tabbit.com   （国内版）
//   --profile intl      → .env           → https://web.tabbit.ai    （国际版）
//   不带参数            → 两个 profile 都尝试（各自读自己的 env 文件）
//
// 运行模式：
//   默认：常驻循环 —— 启动立即检查+签到，然后睡到次日再签（无需 cron/launchd）
//   --once             —— 只执行一轮后退出（用于手动/测试）
//
// 用法：
//   node scripts/checkin-api.mjs                    # 常驻：国内+国际，启动即签，之后每日循环
//   node scripts/checkin-api.mjs --once             # 只跑一轮
//   node scripts/checkin-api.mjs --profile domestic # 常驻：只签国内版
// 退出码：0=成功（含已签到跳过），2=该 profile 无 cookie/未配置，1=接口失败

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// ── profile 定义 ──────────────────────────────────────────
const PROFILES = [
  { name: 'domestic', envFile: '.env.domestic', base: 'https://web.tabbit.com', cdpPort: 9223 },
  { name: 'intl', envFile: '.env', base: 'https://web.tabbit.ai', cdpPort: 9222 },
];

// ── 参数解析 ──────────────────────────────────────────────
function parseArgs(argv = process.argv) {
  const out = { profile: null, once: false };
  const eq = argv.find(a => a.startsWith('--profile='));
  if (eq) out.profile = eq.slice('--profile='.length);
  const i = argv.indexOf('--profile');
  if (i !== -1 && argv[i + 1]) out.profile = argv[i + 1];
  if (argv.includes('--once')) out.once = true;
  return out;
}
const ARGS = parseArgs();
const PROFILE = ARGS.profile;

// ── 计算到下次签到（本地次日 00:00:30）的毫秒数 ───────────
function msUntilNextCheckin() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 30);
  return next.getTime() - now.getTime();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 读 env 文件 ───────────────────────────────────────────
function loadEnvFile(path) {
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

// ── 生成 request_no（还原扩展 en() 逻辑）──────────────────
function genRequestNo(isDefaultBrowser = true) {
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

// ── 单 profile 签到 ───────────────────────────────────────
async function checkInProfile(profile) {
  const env = loadEnvFile(join(PROJECT_ROOT, profile.envFile));
  const cookie = (env.TABBIT_COOKIE || '').trim();

  // 附加功能开关：每个 env 文件里 TABBIT_AUTO_CHECKIN=1 才签到（默认关）
  // 独立于 LLM 代理运行，不影响 src/server.mjs
  const enabled = ['1', 'true', 'yes', 'on'].includes(String(env.TABBIT_AUTO_CHECKIN || '').trim().toLowerCase());
  if (!enabled) {
    console.log(`[${profile.name}] 跳过：${profile.envFile} 未开启 TABBIT_AUTO_CHECKIN=1`);
    return { profile: profile.name, skipped: true, reason: 'disabled by env' };
  }

  if (!cookie) {
    console.log(`[${profile.name}] 跳过：${profile.envFile} 未配置 TABBIT_COOKIE（可先启动代理或浏览器 ${profile.cdpPort} 自动拉取）`);
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
    console.log(`[${profile.name}] 今日已签到（连续 ${daily.signed_days} 天），跳过`);
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
    console.log(`[${profile.name}] 签到完成：${result?.sign_in_result || 'unknown'}（连续 ${result?.signed_days ?? daily.signed_days} 天）`);
    return {
      profile: profile.name, base, signedToday: done, result: result?.sign_in_result,
      signedDays: result?.signed_days ?? daily.signed_days, totalSignedDays: result?.total_signed_days ?? daily.total_signed_days,
      raw: data,
    };
  } catch (e) {
    return { profile: profile.name, error: `sign-in fetch: ${e.message}` };
  }
}

// ── 主流程（常驻循环）────────────────────────────────────
const targets = PROFILE ? PROFILES.filter(p => p.name === PROFILE) : PROFILES;
if (targets.length === 0) {
  console.error(`未知 profile: ${PROFILE}（可选: ${PROFILES.map(p => p.name).join(', ')}）`);
  process.exit(2);
}

// 单轮：所有目标 profile 各签到一次，返回 { failed }
async function runOnce() {
  const results = [];
  for (const p of targets) {
    results.push(await checkInProfile(p));
  }
  const failed = results.filter(r => r.error);
  const skipped = results.filter(r => r.skipped);
  const ok = results.filter(r => !r.error && !r.skipped);
  console.log(`汇总: ${ok.length} 成功, ${skipped.length} 跳过, ${failed.length} 失败`);
  return failed;
}

async function main() {
  // 启动立即执行一轮
  const failed = await runOnce();

  if (ARGS.once) {
    if (failed.length) { console.error(JSON.stringify(failed, null, 2)); process.exit(1); }
    process.exit(0);
  }

  // 常驻：循环等待到次日 00:00:30 再签
  while (true) {
    const waitMs = msUntilNextCheckin();
    const next = new Date(Date.now() + waitMs);
    console.log(`\n下次签到: ${next.toLocaleString('zh-CN', { hour12: false })}（等待 ${(waitMs / 3600000).toFixed(1)} 小时）`);
    await sleep(waitMs);
    try {
      await runOnce();
    } catch (e) {
      console.error('签到异常，继续等待下轮:', e.message);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
