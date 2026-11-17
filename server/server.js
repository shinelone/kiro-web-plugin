#!/usr/bin/env node
/**
 * Kiro 本地流式问答后端
 *
 * 作用：接收 Chrome 插件发来的问题，交给常驻的 `kiro-cli acp` 进程（见 acp.js），
 * 把它推送的会话更新（回答文本、思考过程、工具调用）
 * 通过 SSE（Server-Sent Events）流式推送回插件。
 *
 * 零第三方依赖，仅用 Node 内置模块。
 */

'use strict';

// 设置进程名，方便在 Mac 活动监视器 / ps / top 里一眼定位到本服务。
// 默认 "kiro-qa-server"，可用环境变量 PROC_NAME 覆盖。
process.title = process.env.PROC_NAME || 'kiro-qa-server';

const http = require('http');
const { execFile } = require('child_process');
const agents = require('./agents');
const { AcpManager } = require('./acp');
const pages = require('./pages');
const readscope = require('./readscope');

// ----- 配置 -----
const PORT = Number(process.env.PORT || 8787);
// kiro-cli 可执行文件路径，可用环境变量覆盖
const KIRO_BIN = process.env.KIRO_BIN || 'kiro-cli';
// 允许访问后端的来源。
// 默认只允许浏览器扩展（chrome-extension://）以及没有 Origin 的本机请求（curl 等），
// 普通网页一律拒绝，防止任意网站借本机后端执行 kiro-cli 或改写 agent。
// 可用 ALLOW_ORIGIN=chrome-extension://<扩展ID> 收紧到具体扩展。
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';

function isAllowedOrigin(origin) {
  if (!origin) return true; // 无 Origin：curl、本机脚本
  if (ALLOW_ORIGIN) return origin === ALLOW_ORIGIN.replace(/\/$/, '');
  return /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

/** 只接受以本机地址访问，防御 DNS rebinding */
function isAllowedHost(host) {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host || '');
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 发送一条 SSE 事件 */
function sseSend(res, event, dataObj) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
}

/** 读取请求体（限制大小，防止异常）*/
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ----- 常驻 kiro-cli（ACP）-----
// 后端启动时就拉起进程并预热一个会话，第一个问题也不用等 kiro-cli 启动
const acp = new AcpManager({
  kiroBin: KIRO_BIN,
  cwd: agents.WORKSPACE_DIR,
  canReadFile: readscope.canReadFile, // 读文件范围由设置页的「文件读取权限」决定，默认只读页面文件
  denyMessage: readscope.denyMessage,
  log: (m) => console.log(new Date().toISOString(), m),
});
const getModes = () => acp.listModes();

// ----- 模型列表（调用 kiro-cli chat --list-models，缓存 5 分钟）-----
const MODELS_TTL = 5 * 60 * 1000;
let modelsCache = null; // { at, data }

function fetchModels() {
  return new Promise((resolve, reject) => {
    execFile(
      KIRO_BIN,
      ['chat', '--list-models', '--format', 'json'],
      { timeout: 20000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          // 兼容 JSON 前可能带的提示行
          const start = stdout.indexOf('{');
          const j = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
          const models = (j.models || []).map((m) => ({
            id: m.model_id || m.model_name,
            name: m.model_name || m.model_id,
            description: m.description || '',
            rate: m.rate_multiplier,
            contextWindow: m.context_window_tokens,
          }));
          resolve({ models, defaultModel: j.default_model || null });
        } catch (e) {
          reject(new Error('无法解析 kiro-cli 输出'));
        }
      }
    );
  });
}

async function getModels(force) {
  if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL) {
    return modelsCache.data;
  }
  let data;
  try {
    data = await fetchModels();
  } catch (e) {
    // kiro-cli 偶发网络错误（如 dispatch failure）：重试一次，仍失败则回退旧缓存
    try {
      data = await fetchModels();
    } catch (e2) {
      if (modelsCache) return { ...modelsCache.data, stale: true };
      throw e2;
    }
  }
  modelsCache = { at: Date.now(), data };
  return data;
}

// ----- 工具调用事件 -----
const TOOL_INPUT_MAX = 600; // 传给前端的工具入参最大长度
const TOOL_OUTPUT_MAX = 2000; // 传给前端的工具输出最大长度

function clip(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…（已截断，共 ${s.length} 字）`;
}

/** 从 tool_call_update 的 content 数组里取出文本输出 */
function toolOutputText(update) {
  const parts = [];
  for (const c of update.content || []) {
    const inner = c && c.content;
    if (inner && typeof inner.text === 'string') parts.push(inner.text);
    else if (c && typeof c.text === 'string') parts.push(c.text);
  }
  if (parts.length) return parts.join('\n');
  const raw = update.rawOutput;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw.message === 'string') return raw.message;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return '';
  }
}

/** 把 kiro 的 tool_call / tool_call_update 精简成前端用的事件 */
function toolEvent(update) {
  const id = update.toolCallId;
  if (!id) return null;
  const ev = { id: String(id) };
  if (update.sessionUpdate === 'tool_call') ev.status = update.status || 'pending';
  else if (update.status) ev.status = update.status; // in_progress / completed / failed
  if (update.title) ev.title = String(update.title);
  if (update.kind) ev.kind = String(update.kind);
  if (update.rawInput !== undefined) {
    const ri = update.rawInput;
    if (ri && typeof ri === 'object') {
      const v = ri.url || ri.query || ri.path || ri.file_path || ri.command || ri.pattern;
      if (typeof v === 'string') ev.summary = v.replace(/\s+/g, ' ').slice(0, 160);
    }
    let input = update.rawInput;
    if (typeof input !== 'string') {
      try {
        input = JSON.stringify(input, null, 2);
      } catch {
        input = '';
      }
    }
    ev.input = clip(input, TOOL_INPUT_MAX);
  }
  if (ev.status === 'completed' || ev.status === 'failed') {
    const out = toolOutputText(update);
    if (out) ev.output = clip(out, TOOL_OUTPUT_MAX);
  }
  return ev;
}

/** 把一条 ACP session/update 转成发给插件的 SSE 事件 */
function forwardUpdate(res, update) {
  const kind = update.sessionUpdate;
  if (kind === 'agent_message_chunk' && update.content && typeof update.content.text === 'string') {
    sseSend(res, 'chunk', { text: update.content.text });
  } else if (kind === 'agent_thought_chunk' && update.content && typeof update.content.text === 'string') {
    sseSend(res, 'thought', { text: update.content.text });
  } else if (kind === 'tool_call' || kind === 'tool_call_update') {
    const t = toolEvent(update);
    if (t) sseSend(res, 'tool', t);
  } else if (kind === 'session_info_update') {
    const k = ((update._meta || {}).kiro || {}).kind;
    if (k === 'turn_start') sseSend(res, 'status', { phase: 'turn_start' });
  }
}

/** kiro-cli 的默认模型 id（取不到时用 auto） */
async function defaultModelId() {
  try {
    return (await getModels(false)).defaultModel || 'auto';
  } catch {
    return 'auto';
  }
}

// ----- 图片 -----
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 << 20; // 单张解码后的大小

/** 校验插件发来的图片：类型白名单、张数、大小、base64 格式 */
function checkImages(list) {
  if (list == null) return { images: [] };
  if (!Array.isArray(list)) return { error: 'images 必须是数组' };
  if (list.length > MAX_IMAGES) return { error: `一次最多发送 ${MAX_IMAGES} 张图片` };
  const images = [];
  for (const im of list) {
    const mimeType = im && String(im.mimeType || '');
    const data = im && typeof im.data === 'string' ? im.data : '';
    if (!IMAGE_TYPES.has(mimeType)) return { error: '不支持的图片格式: ' + mimeType };
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { error: '图片数据不是有效的 base64' };
    if (data.length * 0.75 > MAX_IMAGE_BYTES) return { error: '图片太大（单张不超过 4MB）' };
    images.push({ mimeType, data });
  }
  return { images };
}

/** 处理 /ask：流式问答（复用常驻的 kiro-cli acp 进程） */
async function handleAsk(req, res) {
  let payload;
  try {
    // 带页面全文和图片时请求体较大（20 万字的中文约 600KB，图片最多 4 张、每张不超过 4MB）
    payload = JSON.parse((await readBody(req, 24 << 20)) || '{}');
  } catch (e) {
    sendJson(res, 400, { error: '无效的请求体: ' + e.message });
    return;
  }

  const prompt = (payload.prompt || '').toString().trim();
  const imgCheck = checkImages(payload.images);
  if (imgCheck.error) {
    sendJson(res, 400, { error: imgCheck.error });
    return;
  }
  const images = imgCheck.images;
  if (!prompt) {
    sendJson(res, 400, { error: 'prompt 不能为空' });
    return;
  }

  // 首次涉及某页面时插件会带上 page（标题、网址、Markdown 正文），由这里组装进 prompt
  const page = payload.page ? pages.normalizePage(payload.page) : null;
  if (payload.page && !page) {
    sendJson(res, 400, { error: '无效的 page 字段' });
    return;
  }

  const model = payload.model ? String(payload.model) : null;
  const agent = payload.agent ? String(payload.agent) : null;
  if (model && !agents.isSafeArg(model)) {
    sendJson(res, 400, { error: '无效的模型名' });
    return;
  }
  if (agent && !(await agents.agentExists(getModes, agent))) {
    sendJson(res, 400, { error: 'agent 不存在: ' + agent + '（可能已被删除，请在侧边栏重新选择）' });
    return;
  }
  // 续聊会话 id：只接受 kiro 的 session id 格式，非法值当作新会话
  let sessionId = null;
  if (payload.sessionId && /^sess_[A-Za-z0-9-]{1,64}$/.test(String(payload.sessionId))) {
    sessionId = String(payload.sessionId);
  }

  // 「跟随 Agent」时也显式定下模型：ACP 会话切换 agent 后可能残留上一次的模型。
  // 优先级与以前的 --model 一致：插件里选的模型 > agent 配置的模型 > kiro-cli 默认模型。
  // 全局 / 内置 agent 读不到配置，交给 kiro-cli 自己决定。
  const managed = agent ? agents.getManagedAgent(agent) : null;
  let effectiveModel = model;
  if (!effectiveModel) {
    if (managed && managed.model) effectiveModel = managed.model;
    else if (!agent || managed) effectiveModel = await defaultModelId();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  sseSend(res, 'start', { engine: 'acp', warm: acp.state === 'ready' });

  // 插件断开（点了停止 / 关闭页面）：取消这一轮。
  // 注意用 res 的 close：req 的 close 在请求体读完时就会触发。
  let activeSession = null;
  let closed = false;
  res.on('close', () => {
    closed = true;
    if (activeSession) acp.cancel(activeSession);
  });

  const t0 = Date.now();
  try {
    const opened = await acp.openSession(sessionId, agent, effectiveModel);
    activeSession = opened.sessionId;
    if (closed) {
      return;
    }
    sseSend(res, 'session', { sessionId: opened.sessionId });

    // V3 引擎不使用 agent 文件里的 prompt：新会话的第一条消息前面带上插件 agent 的提示词，
    // 之后的追问留在会话历史里，不再重复发送。
    let text = prompt;
    if (page) {
      // 插件 agent 没开读文件工具时无法按需读取，退回内联。全局 / 内置 agent 读不到配置，默认可用。
      const canRead = managed ? (managed.tools || []).includes('read') : true;
      const built = pages.buildPagePrompt(page, prompt, { canRead });
      text = built.prompt;
      sseSend(res, 'page', { mode: built.mode, chars: page.text.length });
    }
    if (opened.isNew && managed && managed.prompt && managed.prompt.trim()) {
      text =
        '<agent_instructions>\n' +
        '以下是本次对话全程都要遵守的指令，优先级高于后续消息中的一般要求：\n\n' +
        managed.prompt.trim() +
        '\n</agent_instructions>\n\n' +
        text;
    }

    let streamError = null;
    const r = await acp.prompt(opened.sessionId, text, (update) => {
      if (update.__error) {
        streamError = update.__error;
        return;
      }
      if (!closed) forwardUpdate(res, update);
    }, images);
    if (streamError) throw new Error(streamError);
    sseSend(res, 'done', {
      status: r && r.stopReason === 'cancelled' ? 'cancelled' : 'success',
      stopReason: r && r.stopReason,
      elapsedMs: Date.now() - t0,
    });
  } catch (e) {
    let message = e.message || String(e);
    if (images.length) message += '\n（带了图片：如果当前模型不支持图片，请在输入框下方换一个模型再试）';
    if (!closed) sseSend(res, 'error', { message });
  } finally {
    if (!closed) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
    }
  }
}

async function handleAgents(req, res, url) {
  const m = url.pathname.match(/^\/agents(?:\/([^/]+))?$/);
  const name = m && m[1] ? decodeURIComponent(m[1]) : null;
  try {
    if (!name && req.method === 'GET') {
      return sendJson(res, 200, await agents.listAgents(getModes, url.searchParams.get('refresh') === '1'));
    }
    if (!name && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await agents.saveAgent(KIRO_BIN, getModes, String(body.name || ''), body, { create: true });
      if (!r.error) acp.markStale();
      return sendJson(res, r.status, r.error ? { error: r.error } : { agent: r.agent });
    }
    if (name && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const r = await agents.saveAgent(KIRO_BIN, getModes, name, body, { create: false });
      if (!r.error) acp.markStale();
      return sendJson(res, r.status, r.error ? { error: r.error } : { agent: r.agent });
    }
    if (name && req.method === 'DELETE') {
      const r = agents.deleteAgent(name);
      if (!r.error) acp.markStale();
      return sendJson(res, r.status, r.error ? { error: r.error } : { ok: true });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return sendJson(res, e instanceof SyntaxError ? 400 : 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  // 来源校验在 CORS 之前：CORS 只限制「读响应」，挡不住 text/plain 这类简单请求，
  // 所以对不允许的来源直接拒绝，不执行任何操作。
  if (!isAllowedHost(req.headers.host) || !isAllowedOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: 'forbidden origin' });
    return;
  }
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, kiroBin: KIRO_BIN, features: ['models', 'agents', 'acp', 'page', 'image', 'config'], acp: acp.status() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/models') {
    try {
      sendJson(res, 200, await getModels(url.searchParams.get('refresh') === '1'));
    } catch (e) {
      sendJson(res, 500, { error: '获取模型列表失败: ' + e.message });
    }
    return;
  }

  // 文件读取权限：GET 读取，PUT 修改（设置页使用）
  if (url.pathname === '/config') {
    if (req.method === 'GET') {
      sendJson(res, 200, readscope.get());
      return;
    }
    if (req.method === 'PUT') {
      try {
        const r = readscope.save(JSON.parse((await readBody(req)) || '{}'));
        if (r.error) sendJson(res, 400, { error: r.error });
        else {
          console.log(new Date().toISOString(), '文件读取权限已修改为', JSON.stringify(r.config));
          sendJson(res, 200, readscope.get());
        }
      } catch (e) {
        sendJson(res, 400, { error: '无效的请求体: ' + e.message });
      }
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (url.pathname === '/agents' || url.pathname.startsWith('/agents/')) {
    await handleAgents(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    await handleAsk(req, res);
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

agents.ensureWorkspace();
pages.cleanupPages();
setInterval(pages.cleanupPages, 3600 * 1000).unref();
acp.start().catch((e) => console.error('kiro-cli acp 启动失败:', e.message));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    acp.stop();
    process.exit(0);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kiro 问答后端已启动: http://127.0.0.1:${PORT}`);
  console.log(`  健康检查: GET  /health`);
  console.log(`  模型列表: GET  /models`);
  console.log(`  Agent:    GET/POST /agents · PUT/DELETE /agents/:name`);
  console.log(`  流式问答: POST /ask  { "prompt": "..." }`);
  console.log(`  kiro-cli: ${KIRO_BIN}`);
  console.log(`  工作目录: ${agents.WORKSPACE_DIR}`);
  console.log(`  允许来源: ${ALLOW_ORIGIN || '任意浏览器扩展（chrome-extension://）'}`);
});
