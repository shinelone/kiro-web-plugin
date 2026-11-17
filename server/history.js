'use strict';

/**
 * 对话历史：持久化到 ~/.ai/kiro/history/<convId>.jsonl。
 *
 * JSONL 格式：第一行是元信息（type:"meta"，含标题、时间、会话状态），
 * 之后每行一条消息。列表时只读第一行，快。
 *
 * 容量：最多保留 MAX_CONV 条，超出删最旧；单条超过 MAX_BYTES 时丢掉消息里的图片缩略图只留文字。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HIST_DIR = path.join(os.homedir(), '.ai', 'kiro', 'history');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CONV = 100;
const MAX_BYTES = 1.5 * 1024 * 1024;
const TITLE_MAX = 80;

function ensureDir() {
  fs.mkdirSync(HIST_DIR, { recursive: true });
}
function fileOf(id) {
  return path.join(HIST_DIR, id + '.jsonl');
}
function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** 读文件第一行（元信息）；失败返回 null */
function readMeta(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
    const m = JSON.parse(firstLine);
    return m && m.type === 'meta' ? m : null;
  } catch {
    return null;
  }
}

/** 历史列表（按 updatedAt 新→旧） */
function list() {
  ensureDir();
  let files = [];
  try {
    files = fs.readdirSync(HIST_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const items = [];
  for (const f of files) {
    const meta = readMeta(path.join(HIST_DIR, f));
    if (!meta || !isValidId(meta.id)) continue;
    items.push({
      id: meta.id,
      title: meta.title || '(无标题)',
      createdAt: meta.createdAt || 0,
      updatedAt: meta.updatedAt || 0,
      count: meta.count || 0,
      agent: meta.agent || '',
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

/** 读取完整对话，重建成前端的 state 结构；无则 null */
function get(id) {
  if (!isValidId(id)) return null;
  let raw;
  try {
    raw = fs.readFileSync(fileOf(id), 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) return null;
  let meta = {};
  const msgs = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'meta') meta = obj;
    else msgs.push(obj);
  }
  return {
    id: meta.id || id,
    title: meta.title || '',
    createdAt: meta.createdAt || 0,
    updatedAt: meta.updatedAt || 0,
    msgs,
    sessionId: meta.sessionId || null,
    injectedUrl: meta.injectedUrl || null,
    lastQuestion: meta.lastQuestion || null,
    lastPageUrl: meta.lastPageUrl || null,
    convAgent: meta.convAgent || '',
  };
}

function deriveTitle(body) {
  if (body && typeof body.title === 'string' && body.title.trim()) return body.title.trim().slice(0, TITLE_MAX);
  const msgs = (body && body.state && body.state.msgs) || [];
  const firstUser = msgs.find((m) => m.role === 'user' && (m.text || '').trim());
  const t = firstUser ? firstUser.text.replace(/\s+/g, ' ').trim() : '新对话';
  return t.slice(0, TITLE_MAX) || '新对话';
}

/** 去掉消息里的图片缩略图（仅在整条过大时），保留一个占位说明 */
function stripImages(msgs) {
  return msgs.map((m) => {
    if (!m.images || !m.images.length) return m;
    return { ...m, images: m.images.map(() => ({ thumb: '', stripped: true })) };
  });
}

/**
 * 保存 / 更新一条对话（upsert）。body = { title?, state }，
 * state 来自前端 serializeConversation：{ msgs, sessionId, injectedUrl, lastQuestion, lastPageUrl, convAgent }。
 */
function save(id, body) {
  if (!isValidId(id)) return { error: '无效的对话 id' };
  const state = (body && body.state) || {};
  let msgs = Array.isArray(state.msgs) ? state.msgs : [];
  if (!msgs.length) {
    // 空对话不落盘（避免一打开就生成空历史）；若已存在则删掉
    remove(id);
    return { ok: true, empty: true };
  }
  ensureDir();
  const now = Date.now();
  const existing = readMeta(fileOf(id));
  const meta = {
    type: 'meta',
    id,
    title: deriveTitle(body),
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    count: msgs.length,
    agent: state.convAgent || '',
    sessionId: state.sessionId || null,
    injectedUrl: state.injectedUrl || null,
    lastQuestion: state.lastQuestion || null,
    lastPageUrl: state.lastPageUrl || null,
    convAgent: state.convAgent || '',
  };
  let content = [JSON.stringify(meta)].concat(msgs.map((m) => JSON.stringify(m))).join('\n') + '\n';
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    msgs = stripImages(msgs);
    content = [JSON.stringify(meta)].concat(msgs.map((m) => JSON.stringify(m))).join('\n') + '\n';
  }
  const tmp = fileOf(id) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, fileOf(id));
  trim();
  return { ok: true, meta: { id, title: meta.title, updatedAt: meta.updatedAt, count: meta.count, agent: meta.agent } };
}

function remove(id) {
  if (!isValidId(id)) return { error: '无效的对话 id' };
  try {
    fs.unlinkSync(fileOf(id));
  } catch {
    /* 不存在无所谓 */
  }
  return { ok: true };
}

function clear() {
  ensureDir();
  try {
    for (const f of fs.readdirSync(HIST_DIR)) {
      if (f.endsWith('.jsonl')) fs.unlinkSync(path.join(HIST_DIR, f));
    }
  } catch {
    /* 忽略 */
  }
  return { ok: true };
}

/** 超过上限时删最旧的几条 */
function trim() {
  let files;
  try {
    files = fs.readdirSync(HIST_DIR).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }
  if (files.length <= MAX_CONV) return;
  const withTime = files.map((f) => {
    const meta = readMeta(path.join(HIST_DIR, f));
    return { f, t: (meta && meta.updatedAt) || 0 };
  });
  withTime.sort((a, b) => a.t - b.t); // 旧的在前
  for (const { f } of withTime.slice(0, files.length - MAX_CONV)) {
    try {
      fs.unlinkSync(path.join(HIST_DIR, f));
    } catch {
      /* 忽略 */
    }
  }
}

module.exports = { HIST_DIR, list, get, save, remove, clear, isValidId };
