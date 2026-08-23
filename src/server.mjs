// src/server.mjs — OpenAI 兼容代理服务（原生 http，零依赖）
//
// 端点：
//   GET  /v1/models            模型列表（OpenAI 格式）
//   POST /v1/chat/completions  聊天补全（支持 stream / 非 stream）
//   GET  /healthz              健康检查
//   POST /admin/refresh-cookie 手动触发 cookie 自动刷新（从本机 Tabbit 浏览器拉取）
//
// Cookie 自动续期：
//   - 启动时若本机 Tabbit 以 --remote-debugging-port 运行，自动从浏览器拉取最新 cookie
//   - 每 COOKIE_REFRESH_MINUTES（默认 360）分钟后台刷新一次
//   - 请求遇 401/403/492/493 等认证类错误时，立即刷新并重试一次
//   - 刷新成功后同步写回 .env，浏览器关闭时也能用最近一次有效 cookie
//
// 用法：
//   node src/server.mjs
//   curl http://localhost:8787/v1/chat/completions -d '{"model":"Default","messages":[{"role":"user","content":"你好"}],"stream":true}'

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.mjs';
import {
  DEFAULT_SIGN_KEY, fetchSignKey, getModels, fetchSessionList, chat, TabbitError,
} from '../scripts/lib/tabbit.mjs';
import { refreshFromBrowser } from '../scripts/lib/cdp.mjs';

// ─── 状态缓存 ─────────────────────────────────────────────
let signKey = config.signKey || DEFAULT_SIGN_KEY;
let signKeyFetchedAt = 0;
let sessionCache = null;
let sessionCacheAt = 0;

// Cookie / 版本号运行时状态（支持自动刷新，不再只读 .env）
let cookie = config.cookie;
let version = config.version;
let lastCookieRefresh = 0;
let cookieRefreshInFlight = null;   // 防止并发刷新

const SIGN_KEY_TTL = 10 * 60 * 1000;  // 10 分钟刷新一次签名 key
const SESSION_TTL = 5 * 60 * 1000;    // 5 分钟刷新一次会话列表
const COOKIE_REFRESH_MS = config.cookieRefreshMinutes * 60 * 1000;

// ─── Cookie 自动刷新 ──────────────────────────────────────
// 从本机 Tabbit 浏览器（CDP）拉取最新 cookie + 版本号，写回内存与 .env
async function refreshCookieFromBrowser(force = false) {
  if (cookieRefreshInFlight) return cookieRefreshInFlight;
  if (!force && cookie && Date.now() - lastCookieRefresh < COOKIE_REFRESH_MS) return cookie;

  cookieRefreshInFlight = (async () => {
    try {
      const { cookie: fresh, count, version: freshVersion } = await refreshFromBrowser({ port: config.cdpPort, baseUrl: config.baseUrl });
      if (!fresh) throw new Error('浏览器返回空 cookie');
      cookie = fresh;
      if (freshVersion && freshVersion !== version) {
        log(`版本号更新: ${version} → ${freshVersion}`);
        version = freshVersion;
      }
      lastCookieRefresh = Date.now();
      persistEnv();
      log(`cookie 已自动刷新 (${count} 个, 长度 ${cookie.length}, 版本 ${version})`);
      return cookie;
    } catch (e) {
      log(`cookie 自动刷新失败: ${e.message}（若 Tabbit 未以 --remote-debugging-port 启动属正常）`);
      return cookie;
    } finally {
      cookieRefreshInFlight = null;
    }
  })();
  return cookieRefreshInFlight;
}

// 把最新 cookie / 版本号持久化到当前实例的 env 文件（默认 .env，可用 TABBIT_ENV 指定），
// 浏览器关闭后重启服务仍可用
function persistEnv() {
  try {
    const envPath = new URL('../' + config.envFile, import.meta.url).pathname;
    let content = readFileSync(envPath, 'utf8');
    content = content.replace(/^TABBIT_COOKIE=.*$/m, `TABBIT_COOKIE=${cookie}`);
    content = content.replace(/^TABBIT_VERSION=.*$/m, `TABBIT_VERSION=${version}`);
    writeFileSync(envPath, content);
  } catch (e) {
    log('写回', config.envFile, '失败:', e.message);
  }
}

// 判断错误是否由 cookie/版本失效引起，需要刷新
function isAuthError(e) {
  if (e instanceof TabbitError) {
    return [401, 403, 492, 493].includes(e.status) || [401, 403, 492, 493].includes(e.code);
  }
  return false;
}

async function ensureSignKey() {
  if (config.signKey) return config.signKey;
  if (!signKey || Date.now() - signKeyFetchedAt > SIGN_KEY_TTL) {
    signKey = await fetchSignKey(cookie, version);
    signKeyFetchedAt = Date.now();
    log(`signKey 刷新: ${signKey.slice(0, 8)}…`);
  }
  return signKey;
}

async function getSessionId() {
  if (sessionCache && Date.now() - sessionCacheAt < SESSION_TTL) return sessionCache;
  const sessions = await fetchSessionList(cookie);
  if (sessions.length === 0) {
    throw new Error('账号下无可用会话，请先在 Tabbit 浏览器里创建一个对话');
  }
  sessionCache = sessions[0];
  sessionCacheAt = Date.now();
  log(`会话缓存: ${sessionCache.slice(0, 8)}… (共 ${sessions.length} 个)`);
  return sessionCache;
}

function invalidateSession() {
  sessionCache = null;
}

// ─── 工具函数 ─────────────────────────────────────────────
function log(...a) { console.log('[server]', ...a); }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!config.apiKey) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${config.apiKey}`;
}

// OpenAI messages 数组 → Tabbit content 字符串
// 策略：把完整对话历史拼成带角色标注的文本，作为单条 content 发给 Tabbit
// （Tabbit 是会话制，但无状态代理不维护跨请求上下文，故自带历史进 content）
function messagesToContent(messages) {
  const valid = messages.filter(m => m && m.content != null);
  if (valid.length === 0) throw new Error('messages 为空');
  if (valid.length === 1) return String(valid[0].content);
  const roleLabel = { assistant: 'Assistant', system: 'System', user: 'User' };
  return valid.map(m => `[${roleLabel[m.role] || 'User'}]\n${m.content}`).join('\n\n');
}

// ─── 路由处理 ─────────────────────────────────────────────

// GET /v1/models
async function handleModels(res) {
  const key = await ensureSignKey();
  const models = await getModels(cookie, version, key);
  sendJson(res, 200, {
    object: 'list',
    data: models.map(m => ({
      id: m.display_name,
      object: 'model',
      owned_by: 'tabbit',
    })),
  });
}

// GET /healthz
async function handleHealth(res) {
  try {
    const key = await ensureSignKey();
    const sessions = await fetchSessionList(cookie);
    sendJson(res, 200, {
      ok: true,
      version,
      signKey: key.slice(0, 8) + '…',
      sessions: sessions.length,
      cookieAutoRefresh: config.cdpPort ? 'on' : 'off',
      lastCookieRefresh: lastCookieRefresh ? new Date(lastCookieRefresh).toISOString() : null,
    });
  } catch (e) {
    sendJson(res, 503, { ok: false, error: e.message });
  }
}

// POST /admin/refresh-cookie — 手动触发 cookie 刷新（幂等）
async function handleRefreshCookie(res) {
  await refreshCookieFromBrowser(true);
  sendJson(res, 200, {
    ok: true,
    cookieLength: cookie.length,
    version,
    lastCookieRefresh: lastCookieRefresh ? new Date(lastCookieRefresh).toISOString() : null,
  });
}

// POST /v1/chat/completions
async function handleChat(req, res, rawBody) {
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return sendJson(res, 400, { error: { message: 'invalid JSON body' } }); }

  const { model = 'Default', messages, stream = false } = body;
  if (!Array.isArray(messages) || !messages.length) {
    return sendJson(res, 400, { error: { message: 'messages is required and must be non-empty array' } });
  }

  let key, sessionId, content;
  try {
    [key, sessionId] = await Promise.all([ensureSignKey(), getSessionId()]);
    content = messagesToContent(messages);
  } catch (e) {
    return sendJson(res, 502, { error: { message: 'prepare failed: ' + e.message } });
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // ─── 非流式：聚合所有 chunk ───
  if (!stream) {
    let full = '';
    try {
      for await (const ev of chat({ cookie, version, signKey: key, sessionId, model, content })) {
        if (ev.event === 'message_chunk' && ev.data?.content) {
          full += ev.data.content;
        } else if (ev.event === 'error') {
          invalidateSession();
          // 认证类错误 → 自动刷新 cookie 后重试一次
          if (isAuthError(new TabbitError(ev.data?.code || 0, ev.data?.message || ''))) {
            log('检测到认证错误，刷新 cookie 后重试…');
            await refreshCookieFromBrowser(true);
            key = await ensureSignKey();
            sessionId = await getSessionId();
            full = '';
            for await (const ev2 of chat({ cookie, version, signKey: key, sessionId, model, content })) {
              if (ev2.event === 'message_chunk' && ev2.data?.content) full += ev2.data.content;
              else if (ev2.event === 'error') {
                invalidateSession();
                return sendJson(res, 502, { error: { message: ev2.data?.message || 'Tabbit error', code: ev2.data?.code } });
              }
            }
          } else {
            return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } });
          }
        }
      }
    } catch (e) {
      if (e instanceof TabbitError) invalidateSession();
      // fetch 级认证错误同样触发刷新重试
      if (isAuthError(e)) {
        log('检测到认证错误（fetch），刷新 cookie 后重试…');
        await refreshCookieFromBrowser(true);
        try {
          key = await ensureSignKey();
          sessionId = await getSessionId();
          full = '';
          for await (const ev of chat({ cookie, version, signKey: key, sessionId, model, content })) {
            if (ev.event === 'message_chunk' && ev.data?.content) full += ev.data.content;
            else if (ev.event === 'error') { invalidateSession(); return sendJson(res, 502, { error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } }); }
          }
        } catch (e2) {
          return sendJson(res, 502, { error: { message: e2.message } });
        }
      } else {
        return sendJson(res, 502, { error: { message: e.message } });
      }
    }
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: full },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // ─── 流式：SSE 转 OpenAI chunk ───
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // 客户端断开时中止上游请求
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  const sendChunk = (delta, finishReason = null) =>
    res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);

  // 首块：role
  sendChunk({ role: 'assistant' });

  try {
    for await (const ev of chat({ cookie, version, signKey: key, sessionId, model, content, signal: ac.signal })) {
      if (ev.event === 'message_chunk' && ev.data?.content) {
        sendChunk({ content: ev.data.content });
      } else if (ev.event === 'error') {
        invalidateSession();
        if (isAuthError(new TabbitError(ev.data?.code || 0, ev.data?.message || ''))) {
          log('检测到认证错误，后台刷新 cookie…（下一次请求生效）');
          await refreshCookieFromBrowser(true);
        }
        res.write(`data: ${JSON.stringify({ error: { message: ev.data?.message || 'Tabbit error', code: ev.data?.code } })}\n\n`);
        break;
      } else if (ev.event === 'message_finish' || ev.event === 'finish') {
        sendChunk({}, 'stop');
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (e instanceof TabbitError) invalidateSession();
      if (isAuthError(e)) {
        log('检测到认证错误（fetch），后台刷新 cookie…');
        await refreshCookieFromBrowser(true);
      }
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
    }
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// ─── HTTP 服务 ────────────────────────────────────────────
const server = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (!checkAuth(req)) {
    return sendJson(res, 401, { error: { message: 'invalid API key', type: 'invalid_request_error' } });
  }

  try {
    if (path === '/v1/models' && req.method === 'GET') return await handleModels(res);
    if (path === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      return await handleChat(req, res, raw);
    }
    if (path === '/healthz' && req.method === 'GET') return await handleHealth(res);
    if (path === '/admin/refresh-cookie' && req.method === 'POST') return await handleRefreshCookie(res);
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${path}` } });
  } catch (e) {
    log('error:', e);
    if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' Tabbit2API · OpenAI 兼容代理');
  console.log(`  端口: ${config.port}`);
  console.log(`  鉴权: ${config.apiKey ? '已开启 (Bearer ' + config.apiKey.slice(0, 4) + '…)' : '未开启'}`);
  console.log(`  版本: ${version}`);
  console.log(`  Cookie自动刷新: ${cookie ? '开' : '开（启动时从浏览器拉取）'} (CDP :${config.cdpPort}, 每 ${config.cookieRefreshMinutes} 分钟)`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  GET  /v1/models             模型列表');
  console.log('  POST /v1/chat/completions   聊天补全 (stream / 非 stream)');
  console.log('  GET  /healthz               健康检查');
  console.log('  POST /admin/refresh-cookie  手动刷新 cookie');
  console.log('═══════════════════════════════════════════════════════════\n');
});

// ─── 启动与定时刷新 ────────────────────────────────────────
// 启动时从浏览器拉一次最新 cookie（幂等：失败则用 .env 中的值）
refreshCookieFromBrowser(true);
// 定时后台刷新（COOKIE_REFRESH_MINUTES，默认 6 小时）
setInterval(() => refreshCookieFromBrowser(), COOKIE_REFRESH_MS).unref();
