'use strict';

/**
 * 命令执行的设置与审计。配置并进 readscope 用的同一个文件 .plugin-config.json。
 *
 * mode:
 *   off     关闭，任何命令都拒绝
 *   confirm 每条命令都要用户确认
 *   auto    只读命令自动放行，其它需确认（默认）
 *   sandbox 沙箱内全部自动放行（仍走沙箱、超时、审计），危险命令照样拒绝
 */

const fs = require('fs');
const path = require('path');
const { WORKSPACE_DIR } = require('./agents');

const CONFIG_FILE = path.join(WORKSPACE_DIR, '.plugin-config.json');
const LOG_FILE = path.join(WORKSPACE_DIR, '.command-log.jsonl');
const MODES = ['off', 'confirm', 'auto', 'sandbox'];
const MAX_LIST = 100;
const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 600;

let cfg = {
  shellMode: 'auto',
  shellNetwork: true, // 沙箱是否允许联网
  shellTimeout: 60, // 单条命令超时（秒）
  shellWriteDirs: [], // 工作目录之外额外可写的目录
  shellAllow: [], // 追加白名单（命令名）
  shellDeny: [], // 追加黑名单（命令名）
};

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function load() {
  const j = readRaw();
  const v = validate(j);
  if (!v.error) cfg = v.config;
  return cfg;
}

function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    const s = String(x || '').trim();
    // 命令名：字母数字、- . _，防止塞进带空格的整条命令
    if (s && /^[A-Za-z0-9._-]{1,40}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_LIST);
}

function validate(body) {
  if (!body || typeof body !== 'object') return { error: '无效的配置' };
  const shellMode = body.shellMode == null ? cfg.shellMode : String(body.shellMode);
  if (!MODES.includes(shellMode)) return { error: '无效的命令执行模式: ' + shellMode };
  let shellTimeout = body.shellTimeout == null ? cfg.shellTimeout : Number(body.shellTimeout);
  if (!Number.isFinite(shellTimeout)) shellTimeout = 60;
  shellTimeout = Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, Math.round(shellTimeout)));
  return {
    config: {
      shellMode,
      shellNetwork: body.shellNetwork == null ? cfg.shellNetwork : !!body.shellNetwork,
      shellTimeout,
      shellWriteDirs: validateDirs(body.shellWriteDirs == null ? cfg.shellWriteDirs : body.shellWriteDirs),
      shellAllow: cleanList(body.shellAllow == null ? cfg.shellAllow : body.shellAllow),
      shellDeny: cleanList(body.shellDeny == null ? cfg.shellDeny : body.shellDeny),
    },
  };
}

const os = require('os');
function validateDirs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    let p = String(d || '').trim();
    if (!p) continue;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) continue;
    p = path.resolve(p);
    if (p !== path.parse(p).root && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 20);
}

/** 合并 readscope 写的配置，只更新 shell 相关字段，别的原样保留 */
function save(body) {
  const v = validate(body);
  if (v.error) return v;
  cfg = v.config;
  const merged = { ...readRaw(), ...cfg };
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
  return { config: cfg };
}

function get() {
  return { ...cfg };
}

/** 写一条审计日志 */
function log(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch {
    /* 忽略 */
  }
}

/** 读最近 n 条审计日志（新的在前） */
function recentLog(n = 50) {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

load();

module.exports = { get, save, load, log, recentLog, MODES };
