// scripts/probe.mjs — P0 探测脚本
// 用真实 Cookie 依次打通：sign-key → 模型列表 → 聊天补全
// 验证：1) Cookie 有效 2) 签名通过 3) 伪造 unique-uuid 标记位=1 能否解锁 Pro
//
// 用法：
//   1. 复制 .env.example → .env，填入 TABBIT_COOKIE
//   2. node scripts/probe.mjs              # 全跑
//   3. node scripts/probe.mjs --step models  # 只跑到模型列表
//   4. node scripts/probe.mjs --no-pro     # 标记位=0 对比测试（应返回 493）

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SIGN_KEY, sha256Hex, signHeaders, baseHeaders, parseSSE, fetchSessionList,
} from './lib/tabbit.mjs';

// ─── 配置加载 ──────────────────────────────────────────────
function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return env;
}

const ENV = loadEnv();
const COOKIE = ENV.TABBIT_COOKIE || process.env.TABBIT_COOKIE;
const VERSION = ENV.TABBIT_VERSION || process.env.TABBIT_VERSION || '1.1.39.0';
const TEST_MODEL = ENV.TABBIT_TEST_MODEL || process.env.TABBIT_TEST_MODEL || '';
const IS_PRO = !process.argv.includes('--no-pro');
const ONLY_STEP = (process.argv.find(a => a.startsWith('--step=')) || '').split('=')[1] || null;

const BASE = ENV.TABBIT_BASE_URL || process.env.TABBIT_BASE_URL || 'https://web.tabbit.ai';
mkdirSync('logs', { recursive: true });

if (!COOKIE) {
  console.error(`✗ 缺少 TABBIT_COOKIE。请把 .env.example 复制为 .env 并填入 ${BASE} 的 Cookie。`);
  process.exit(1);
}

console.log('═══════════════════════════════════════════════════════════');
console.log(' Tabbit2API · P0 探测');
console.log(`  版本: ${VERSION}  |  Pro标记位: ${IS_PRO ? '1 (伪装Pro)' : '0 (对比)'}  |  步骤: ${ONLY_STEP || 'all'}`);
console.log('═══════════════════════════════════════════════════════════\n');

// 进程内 key 缓存
let signKey = ENV.TABBIT_SIGN_KEY || DEFAULT_SIGN_KEY;

function saveLog(name, obj) {
  const path = `logs/${name}.json`;
  writeFileSync(path, JSON.stringify(obj, null, 2));
  console.log(`  📝 日志 → ${path}`);
}

// ─── Step 1: sign-key（验证 Cookie + 拿动态 key）──────────
async function probeSignKey() {
  console.log('▶ Step 1: GET /chat/sign-key');
  const headers = baseHeaders(COOKIE, VERSION, IS_PRO);
  const res = await fetch(`${BASE}/chat/sign-key`, { headers });
  const text = await res.text();
  console.log(`  HTTP ${res.status}`);
  console.log(`  body: ${text.slice(0, 200)}`);
  saveLog('probe-1-signkey', {
    url: '/chat/sign-key', status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: text,
  });
  if (res.ok && text.trim()) {
    signKey = text.trim();
    console.log(`  ✓ 拿到动态 key: ${signKey.slice(0, 8)}…（后续请求使用）`);
    return true;
  }
  console.log(`  ⚠ 未拿到新 key，继续用默认 key: ${signKey.slice(0, 8)}…`);
  return res.ok;
}

// ─── Step 2: 模型列表（验证签名通过）──────────────────────
async function probeModels() {
  console.log('\n▶ Step 2: GET /proxy/v1/model_config/models?a=0&scene=chat');
  const body = '';
  const headers = {
    ...baseHeaders(COOKIE, VERSION, IS_PRO),
    ...signHeaders(body, signKey),
  };
  const res = await fetch(`${BASE}/proxy/v1/model_config/models?a=0&scene=chat`, { headers });
  const text = await res.text();
  console.log(`  HTTP ${res.status}`);
  let parsed = null, models = [];
  try { parsed = JSON.parse(text); } catch {}
  if (parsed) {
    // 尝试多种可能的结构
    const candidates = parsed?.data?.models || parsed?.data?.list || parsed?.models || parsed?.data || [];
    if (Array.isArray(candidates)) {
      models = candidates;
      console.log(`  ✓ 拿到 ${models.length} 个模型：`);
      for (const m of models.slice(0, 10)) {
        const id = m.model_id || m.id || m.model_name || m.name;
        const name = m.display_name || m.name || m.model_name || '';
        console.log(`     - ${id}  ${name ? '(' + name + ')' : ''}`);
      }
      if (models.length > 10) console.log(`     …还有 ${models.length - 10} 个`);
    }
  } else {
    console.log(`  body: ${text.slice(0, 500)}`);
  }
  saveLog('probe-2-models', {
    url: '/proxy/v1/model_config/models?a=0&scene=chat', status: res.status,
    reqHeaders: headers, body: text, parsed, models,
  });
  return models;
}

// ─── Step 3: 聊天补全（验证 Pro 标记位 + SSE）─────────────
async function probeChat(models) {
  console.log('\n▶ Step 3: POST /api/v1/chat/completion  (SSE)');
  const model = TEST_MODEL || 'Default';
  console.log(`  使用模型: ${model}`);

  // 拉取会话列表，取一个已登记的 session_id（随机 UUID 会被后端拒绝）
  console.log('  拉取会话列表…');
  let sessionId = null;
  try {
    const sessions = await fetchSessionList(COOKIE);
    console.log(`  ✓ 拿到 ${sessions.length} 个会话: ${sessions.map(s => s.slice(0, 8)).join(', ')}`);
    sessionId = sessions[0];
  } catch (e) {
    console.log(`  ⚠ 拉取会话列表失败: ${e.message}`);
  }
  if (!sessionId) {
    console.log('  ⚠ 无可用 session_id，跳过');
    return;
  }
  console.log(`  使用 session_id: ${sessionId}`);

  const content = '你好，请用一句话介绍你自己';
  const reqBody = {
    chat_session_id: sessionId,
    message_id: null,
    content,
    selected_model: model,
    parallel_group_id: null,
    task_name: 'chat',
    agent_mode: false,
    metadatas: { html_content: `<p>${content}</p>` },
    references: [],
    entity: { key: 'd41d8cd98f00b204e9800998ecf8427e', extras: { type: 'tab', url: '' } },
  };
  const bodyStr = JSON.stringify(reqBody);
  const headers = {
    ...baseHeaders(COOKIE, VERSION, IS_PRO),
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...signHeaders(bodyStr, signKey),
  };

  console.log(`  unique-uuid: ${headers['unique-uuid']}`);
  console.log(`  trace-id:    ${headers['trace-id']}`);
  console.log('  请求体:', bodyStr);
  console.log('  ──────────────── 响应 SSE ────────────────');

  const res = await fetch(`${BASE}/api/v1/chat/completion`, {
    method: 'POST', headers, body: bodyStr,
  });
  console.log(`  HTTP ${res.status}  ${res.statusText}`);

  const log = { url: '/api/v1/chat/completion', status: res.status, reqHeaders: headers, reqBody, events: [] };

  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    const text = await res.text();
    console.log(`  ✗ 非 SSE 响应: ${text.slice(0, 800)}`);
    log.errorBody = text;
    saveLog('probe-3-chat', log);
    return;
  }

  let fullText = '';
  let eventCount = 0;
  try {
    for await (const ev of parseSSE(res.body)) {
      eventCount++;
      let data = ev.data;
      try { data = JSON.parse(ev.data); } catch {}
      log.events.push({ event: ev.event, data });

      // 只打印关键事件
      if (ev.event === 'message_chunk') {
        const c = typeof data === 'object' ? (data.content || data.delta || '') : data;
        process.stdout.write(String(c));
        fullText += String(c);
      } else if (['error', 'finish', 'message_finish', 'message_start', 'risky', 'close', 'usage'].includes(ev.event)) {
        console.log(`\n  [${ev.event}] ${JSON.stringify(data).slice(0, 300)}`);
      }
    }
  } catch (e) {
    console.log(`\n  ✗ 流中断: ${e.message}`);
    log.streamError = e.message;
  }

  console.log(`\n  ────────────────────────────────────────`);
  console.log(`  共 ${eventCount} 个事件，拼接文本: ${fullText.slice(0, 200)}`);
  saveLog('probe-3-chat', log);
  const errEvent = log.events.find(e => e.event === 'error');
  if (errEvent) {
    const code = errEvent.data?.code;
    const action = errEvent.data?.action;
    console.log(`\n  ⚠ 收到 error 事件: code=${code} action=${action}`);
    if (code === 493 && action === 'set_default_browser') {
      console.log(`  → ${IS_PRO ? '伪造标记位=1 仍被拒（后端可能交叉校验注册表）' : '标记位=0 被拒，符合预期'}`);
    } else if (code === 492) {
      console.log(`  → 需付费升级 Pro（即使设了默认浏览器，此功能仍需付费）`);
    }
  } else if (fullText) {
    console.log(`\n  ✓✓✓ 成功收到模型回复！伪造 Pro 标记位有效，可正常使用 ✅`);
  }
}

// ─── 主流程 ────────────────────────────────────────────────
(async () => {
  try {
    if (!ONLY_STEP || ONLY_STEP === 'signkey') {
      await probeSignKey();
    }
    let models = [];
    if (!ONLY_STEP || ONLY_STEP === 'models') {
      models = await probeModels();
    }
    if (!ONLY_STEP || ONLY_STEP === 'chat') {
      await probeChat(models);
    }
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(' 探测完成。查看 logs/ 下的完整请求/响应日志。');
    console.log('═══════════════════════════════════════════════════════════\n');
  } catch (e) {
    console.error('\n✗ 探测异常:', e);
    process.exit(1);
  }
})();
