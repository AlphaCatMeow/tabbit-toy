// scripts/checkin-api.mjs — Tabbit 每日签到 CLI（核心逻辑在 scripts/lib/checkin.mjs）
//
// 运行模式：
//   默认：常驻循环 —— 启动立即检查+签到，然后睡到次日再签（无需 cron/launchd）
//   --once             —— 只执行一轮后退出（用于手动/测试）
//
// profile 约定与 src/server.mjs 一致：
//   --profile domestic  → .env.domestic  → https://web.tabbit.com   （国内版）
//   --profile intl      → .env           → https://web.tabbit.ai    （国际版）
//   不带参数            → 两个 profile 都尝试（各自读自己的 env 文件）
//
// 用法：
//   node scripts/checkin-api.mjs                    # 常驻：国内+国际，启动即签，之后每日循环
//   node scripts/checkin-api.mjs --once             # 只跑一轮
//   node scripts/checkin-api.mjs --profile domestic # 常驻：只签国内版
// 退出码：0=成功（含已签到跳过），2=该 profile 无 cookie/未配置，1=接口失败

import { checkInProfile, startAutoCheckin, PROFILES } from './lib/checkin.mjs';

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

const targets = ARGS.profile ? PROFILES.filter(p => p.name === ARGS.profile) : PROFILES;
if (targets.length === 0) {
  console.error(`未知 profile: ${ARGS.profile}（可选: ${PROFILES.map(p => p.name).join(', ')}）`);
  process.exit(2);
}

// ── 单轮执行 ──────────────────────────────────────────────
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

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  const failed = await runOnce();
  if (ARGS.once) {
    if (failed.length) { console.error(JSON.stringify(failed, null, 2)); process.exit(1); }
    process.exit(0);
  }
  // 常驻：每个 profile 一个循环
  for (const p of targets) startAutoCheckin(p);
}

main().catch(e => { console.error(e); process.exit(1); });
