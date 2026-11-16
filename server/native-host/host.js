#!/usr/bin/env node
/**
 * Chrome Native Messaging 启动器
 *
 * 浏览器扩展不能直接执行本地命令，所以通过本程序代为执行 start.sh / stop.sh。
 * Chrome 每次 sendNativeMessage 都会拉起本进程，经 stdin/stdout 交换一条消息：
 *   消息格式：4 字节小端长度 + UTF-8 JSON
 *
 * 支持的请求：
 *   { "action": "start" }   启动后端（已运行则直接返回）
 *   { "action": "stop" }    停止后端
 *   { "action": "restart" } 先停再启
 *   { "action": "status" }  查询是否在运行
 *
 * 只接受上述固定动作，不执行任何来自消息内容的命令。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SERVER_DIR = path.resolve(__dirname, '..');
const START_SH = path.join(SERVER_DIR, 'start.sh');
const STOP_SH = path.join(SERVER_DIR, 'stop.sh');
const PID_FILE = path.join(SERVER_DIR, 'server.pid');

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

/** 读取一条来自 Chrome 的消息 */
function readMessage() {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (len > 1 << 20) {
        cleanup();
        reject(new Error('消息过大'));
        return;
      }
      if (buf.length < 4 + len) return;
      cleanup();
      try {
        resolve(JSON.parse(buf.slice(4, 4 + len).toString('utf8')));
      } catch (e) {
        reject(new Error('无效的 JSON'));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('未收到消息'));
    };
    function cleanup() {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
    }
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}

function isRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return { running: false };
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/**
 * 运行脚本并收集输出。
 * detached: 让脚本进入独立会话，后端进程不会随 Chrome 关闭启动器而被一起结束。
 */
function runScript(script, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', [script], {
      cwd: SERVER_DIR,
      env: { ...process.env, ...extraEnv },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, output: e.message }));
    child.on('close', (code) => resolve({ code, output: out.trim() }));
  });
}

async function handle(msg) {
  const action = msg && msg.action;
  // 只接受数字端口，透传给 start.sh
  const env = {};
  if (msg && Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536) {
    env.PORT = String(msg.port);
  }

  switch (action) {
    case 'status':
      return { ok: true, ...isRunning() };
    case 'start': {
      const r = await runScript(START_SH, env);
      return { ok: r.code === 0, output: r.output, ...isRunning() };
    }
    case 'stop': {
      const r = await runScript(STOP_SH, env);
      return { ok: r.code === 0, output: r.output, ...isRunning() };
    }
    case 'restart': {
      await runScript(STOP_SH, env);
      const r = await runScript(START_SH, env);
      return { ok: r.code === 0, output: r.output, ...isRunning() };
    }
    default:
      return { ok: false, error: '未知动作: ' + String(action) };
  }
}

readMessage()
  .then(handle)
  .catch((e) => ({ ok: false, error: e.message }))
  .then((res) => {
    send(res);
    // 等 stdout 写完再退出
    process.stdout.end(() => process.exit(0));
  });
