#!/usr/bin/env node
/**
 * Kiro 本地流式问答后端
 *
 * 作用：接收 Chrome 插件发来的问题，spawn 一个 kiro-cli 进程，
 * 把它 `--output-format stream-json` 的逐行输出解析成文本增量，
 * 通过 SSE（Server-Sent Events）流式推送回插件。
 *
 * 零第三方依赖，仅用 Node 内置模块。
 */

'use strict';

// 设置进程名，方便在 Mac 活动监视器 / ps / top 里一眼定位到本服务。
// 默认 "kiro-qa-server"，可用环境变量 PROC_NAME 覆盖。
process.title = process.env.PROC_NAME || 'kiro-qa-server';

const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');

// ----- 配置 -----
const PORT = Number(process.env.PORT || 8787);
// kiro-cli 可执行文件路径，可用环境变量覆盖
const KIRO_BIN = process.env.KIRO_BIN || 'kiro-cli';
// 允许的跨域来源。Chrome 插件请求的 Origin 形如 chrome-extension://<id>
// 这里默认放开（本地工具），如需收紧可改成具体的扩展 id。
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

/** 处理 /ask：流式问答 */
async function handleAsk(req, res) {
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '无效的请求体: ' + e.message }));
    return;
  }

  const prompt = (payload.prompt || '').toString().trim();
  if (!prompt) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'prompt 不能为空' }));
    return;
  }

  // 可选参数
  const model = payload.model ? String(payload.model) : null;
  const agent = payload.agent ? String(payload.agent) : null;
  const cwd = payload.cwd ? String(payload.cwd) : process.cwd();

  // 续聊会话 id：只允许 kiro 的 session id 字符集，防止命令注入
  let resumeId = null;
  if (payload.sessionId) {
    const sid = String(payload.sessionId);
    if (/^sess_[A-Za-z0-9-]{1,64}$/.test(sid)) {
      resumeId = sid;
    } else {
      // 非法 id 直接忽略（当作新会话），不报错
      resumeId = null;
    }
  }

  // 开启 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // 立刻 flush 头
  res.write(': connected\n\n');

  // 组装 kiro-cli 参数
  const args = [
    'chat',
    '--output-format',
    'stream-json',
    '--trust-all-tools',
    '--no-interactive',
  ];
  if (model) args.push('--model', model);
  if (agent) args.push('--agent', agent);
  if (resumeId) args.push('--resume-id', resumeId);
  args.push(prompt);

  let child;
  try {
    child = spawn(KIRO_BIN, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    sseSend(res, 'error', { message: '无法启动 kiro-cli: ' + e.message });
    res.end();
    return;
  }

  // 客户端断开时，杀掉子进程
  req.on('close', () => {
    if (child && !child.killed) child.kill('SIGTERM');
  });

  const rl = readline.createInterface({ input: child.stdout });

  let sentSession = false;
  function maybeSendSession(data) {
    if (sentSession) return;
    const sid = data && data.sessionId;
    if (sid && typeof sid === 'string') {
      sentSession = true;
      sseSend(res, 'session', { sessionId: sid });
    }
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行忽略
    }

    const type = evt.type;
    const data = evt.data || {};

    // 尽早把 sessionId 回传给插件（runStarted 或任意带 sessionId 的事件）
    maybeSendSession(data);

    if (type === 'sessionUpdate') {
      const update = data.update || {};
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content &&
        typeof update.content.text === 'string'
      ) {
        // 核心：把文本增量推给插件
        sseSend(res, 'chunk', { text: update.content.text });
      }
    } else if (type === 'runFinished') {
      sseSend(res, 'done', {
        status: data.status,
        stopReason: data.stopReason,
        finalText: data.finalText,
      });
    } else if (type === 'runStarted') {
      sseSend(res, 'start', { engine: data.engine });
    }
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  child.on('error', (e) => {
    sseSend(res, 'error', { message: 'kiro-cli 进程错误: ' + e.message });
    res.end();
  });

  child.on('close', (code) => {
    if (code !== 0) {
      sseSend(res, 'error', {
        message: `kiro-cli 退出码 ${code}`,
        stderr: stderrBuf.slice(-2000),
      });
    }
    // 结束 SSE
    res.write('event: end\ndata: {}\n\n');
    res.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, kiroBin: KIRO_BIN }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/ask') {
    await handleAsk(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Kiro 问答后端已启动: http://127.0.0.1:${PORT}`);
  console.log(`  健康检查: GET  /health`);
  console.log(`  流式问答: POST /ask  { "prompt": "..." }`);
  console.log(`  kiro-cli: ${KIRO_BIN}`);
});
