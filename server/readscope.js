'use strict';

/**
 * 读文件权限：Kiro 的「读文件」工具通过 ACP 的 fs/read_text_file 交给后端执行（见 acp.js），
 * 这里决定允许读哪些路径。
 *
 *   pages：只读页面文件（server/workspace/pages/），默认
 *   dirs ：页面文件 + 用户指定的目录
 *   all  ：本机任意文件
 *
 * 配置保存在 server/workspace/.plugin-config.json（workspace 目录不进 git），在设置页修改。
 * 放宽权限有风险：网页内容里的提示注入可能诱导 Kiro 读取本机文件，再配合联网工具发出去。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { WORKSPACE_DIR } = require('./agents');
const { PAGES_DIR } = require('./pages');

const CONFIG_FILE = path.join(WORKSPACE_DIR, '.plugin-config.json');
const SCOPES = ['pages', 'dirs', 'all'];
const MAX_DIRS = 20;

let config = { readScope: 'pages', readDirs: [] };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const v = validate(j);
    if (!v.error) config = v.config;
  } catch {
    /* 没有配置文件：用默认值 */
  }
  return config;
}

/** 校验设置页提交的配置；目录必须是存在的绝对路径（支持 ~ 开头） */
function validate(body) {
  if (!body || typeof body !== 'object') return { error: '无效的配置' };
  const readScope = String(body.readScope || 'pages');
  if (!SCOPES.includes(readScope)) return { error: '无效的读取范围: ' + readScope };
  const dirs = Array.isArray(body.readDirs) ? body.readDirs : [];
  if (dirs.length > MAX_DIRS) return { error: `最多 ${MAX_DIRS} 个目录` };
  const readDirs = [];
  for (const d of dirs) {
    let p = String(d || '').trim();
    if (!p) continue;
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) return { error: '目录必须是绝对路径: ' + d };
    p = path.resolve(p);
    if (p === path.parse(p).root) return { error: '不能直接放行根目录，请改选「本机所有文件」' };
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return { error: '目录不存在: ' + p };
    }
    if (!st.isDirectory()) return { error: '不是目录: ' + p };
    if (!readDirs.includes(p)) readDirs.push(p);
  }
  if (readScope === 'dirs' && !readDirs.length) return { error: '选了「指定目录」时至少填写一个目录' };
  return { config: { readScope, readDirs } };
}

function save(body) {
  const v = validate(body);
  if (v.error) return v;
  config = v.config;
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  return { config };
}

function get() {
  return { ...config, pagesDir: PAGES_DIR };
}

/** p 是否在 root 目录里（解析符号链接后判断，防止用链接跳出） */
function within(real, root) {
  try {
    const r = fs.realpathSync(root);
    return real === r || real.startsWith(r + path.sep);
  } catch {
    return false;
  }
}

function canReadFile(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return false;
  }
  if (within(real, PAGES_DIR) && real !== fs.realpathSync(PAGES_DIR)) return true;
  if (config.readScope === 'all') return true;
  if (config.readScope === 'dirs') return config.readDirs.some((d) => within(real, d));
  return false;
}

/** 拒绝读取时给 Kiro 看的说明 */
function denyMessage() {
  if (config.readScope === 'dirs') {
    return '不允许读取该文件：插件只允许读取页面文件和这些目录：' + config.readDirs.join('、') + '。如需放宽，请在插件设置页的「文件读取权限」里修改。';
  }
  return '不允许读取该文件：插件目前只允许读取页面文件（server/workspace/pages/ 下的 .md）。如需读取本机其它文件，请在插件设置页的「文件读取权限」里放宽。';
}

load();

module.exports = { get, save, canReadFile, denyMessage, SCOPES };
