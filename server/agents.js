'use strict';

/**
 * 插件管理的 Kiro agent。
 *
 * agent 文件放在独立工作目录 server/workspace/.kiro/agents/ 下，
 * 后端以 server/workspace 为 cwd 启动 kiro-cli，kiro-cli 会自动发现这些 agent，
 * 同时也能找到全局（~/.kiro/agents）和内置 agent。
 *
 * 只有插件目录里的 agent 可以编辑/删除；全局和内置 agent 只读。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DEFAULT_MODE } = require('./acp');

const WORKSPACE_DIR = path.join(__dirname, 'workspace');
const AGENTS_DIR = path.join(WORKSPACE_DIR, '.kiro', 'agents');
const TMP_DIR = path.join(WORKSPACE_DIR, '.tmp');

// 设置页可选的工具分类（kiro-cli V3 的 tools 标签）
const TOOL_CATEGORIES = [
  { id: 'web', label: '网络', description: '搜索网页、抓取链接内容（web_search / web_fetch）', risky: false },
  { id: 'read', label: '读文件', description: '读取本机文件、搜索目录', risky: false },
  { id: 'write', label: '写文件', description: '创建、修改、删除本机文件', risky: true },
  { id: 'shell', label: '执行命令', description: '在本机执行任意 shell 命令', risky: true },
];
const TOOL_IDS = new Set(TOOL_CATEGORIES.map((t) => t.id));

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// model / agent 名作为命令行参数传给 kiro-cli，限制字符集并禁止以 - 开头（防止被当成选项）
const ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROMPT = 20000;
const MAX_DESC = 300;

const DEFAULT_AGENTS = [
  {
    name: 'web-reader',
    description: '网页阅读助手：根据当前页面内容回答，必要时可联网查外链',
    prompt: [
      '你是一个网页阅读助手，用户会把正在浏览的网页内容发给你。',
      '',
      '回答规则：',
      '1. 优先依据页面内容回答；页面里没有的信息要明确说明，不要编造。',
      '2. 长页面会保存成 Markdown 文件，用读文件和 grep 工具按需读取相关段落，读过原文再回答。',
      '3. 用户问到页面中的外链或需要补充背景时，可以用网络工具查找，并注明信息来自哪里。',
      '4. 默认用中文回答。先给结论，再分点列出要点；引用页面原文时用引号标出，PDF 注明页码。',
      '5. 回答简洁，避免重复页面里的大段原文。',
    ].join('\n'),
    tools: ['web', 'read'],
    model: null,
  },
  {
    name: 'local-helper',
    description: '本机助手：在你的电脑上执行命令、读写文件，完成查看、构建、整理等操作',
    prompt: [
      '你是运行在用户本机的助手，可以执行命令、读文件来完成任务。',
      '',
      '规则：',
      '1. 先说明你打算做什么，再执行；破坏性或不可逆的操作（删除、覆盖、提交推送等）要先征得同意。',
      '2. 命令由插件后端审核：只读命令自动放行，其它会弹窗让用户确认，危险命令会被拒绝。被拒绝时说明原因并给出更安全的做法，不要试图绕过。',
      '3. 优先用简单、可预期的命令；需要多步时逐条执行，关注每步结果。',
      '4. 默认用中文回答，给出关键输出即可，不要粘贴大段无关内容。',
    ].join('\n'),
    tools: ['shell', 'read', 'web'],
    model: null,
  },
];

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function isSafeArg(v) {
  return typeof v === 'string' && ARG_RE.test(v);
}

function agentPath(name) {
  return path.join(AGENTS_DIR, name + '.json');
}

/** 确保工作目录存在；插件目录为空时写入预置 agent */
function ensureWorkspace() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const existing = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json'));
  if (existing.length === 0) {
    for (const a of DEFAULT_AGENTS) {
      fs.writeFileSync(agentPath(a.name), JSON.stringify(toFileJson(a, {}), null, 2) + '\n');
    }
  }
}

/** 把表单数据合并进已有 JSON。只覆盖可编辑字段，保留用户手动加的其它字段（如 mcpServers） */
function toFileJson(a, existing) {
  const out = { ...existing };
  out.name = a.name;
  out.description = a.description || '';
  out.prompt = a.prompt || null;
  out.tools = a.tools;
  if (a.model) out.model = a.model;
  else delete out.model;
  return out;
}

/** 读取插件管理的 agent（解析失败的文件也列出来，标记 error） */
function readManaged() {
  let files = [];
  try {
    files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      const name = f.slice(0, -5);
      try {
        const j = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8'));
        return {
          name,
          description: j.description || '',
          prompt: typeof j.prompt === 'string' ? j.prompt : '',
          tools: Array.isArray(j.tools) ? j.tools : [],
          model: j.model || '',
          source: 'plugin',
          editable: true,
        };
      } catch (e) {
        return { name, description: '', prompt: '', tools: [], model: '', source: 'plugin', editable: true, error: '配置文件无法解析: ' + e.message };
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function run(kiroBin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(kiroBin, args, { cwd: WORKSPACE_DIR, timeout: 20000, maxBuffer: 1 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let listCache = null; // { at, data }
const LIST_TTL = 60 * 1000;

function invalidate() {
  listCache = null;
}

/** 列出所有可用 agent：插件管理的（可编辑）+ 全局 / 内置（只读，来自常驻 ACP 进程） */
async function listAgents(getModes, force) {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL) return listCache.data;
  const managed = readManaged();
  const managedNames = new Set(managed.map((a) => a.name));
  let modes = [];
  try {
    modes = await getModes();
  } catch {
    modes = []; // 进程起不来时至少能列出插件 agent
  }
  const others = modes
    .filter((m) => !managedNames.has(m.id) && m.source !== 'workspace' && m.id !== DEFAULT_MODE)
    .map((m) => ({
      name: m.id,
      description: m.description || m.name || '',
      source: m.source === 'global' ? 'global' : 'builtin',
      editable: false,
    }));
  const data = { agents: managed.concat(others), tools: TOOL_CATEGORIES };
  listCache = { at: Date.now(), data };
  return data;
}

/** 校验并规整前端提交的 agent 数据；返回 { agent } 或 { error } */
function normalizeInput(name, body) {
  if (!isValidName(name)) return { error: '名字只能用小写字母、数字和 -，以字母或数字开头，最多 40 个字符' };
  const description = String(body.description || '').trim();
  if (description.length > MAX_DESC) return { error: '描述最多 ' + MAX_DESC + ' 个字符' };
  const prompt = String(body.prompt || '');
  if (prompt.length > MAX_PROMPT) return { error: '提示词最多 ' + MAX_PROMPT + ' 个字符' };
  const model = body.model ? String(body.model) : '';
  if (model && !isSafeArg(model)) return { error: '无效的模型名' };
  if (!Array.isArray(body.tools)) return { error: 'tools 必须是数组' };
  const tools = [];
  for (const t of body.tools) {
    if (!TOOL_IDS.has(t)) return { error: '未知工具: ' + String(t) };
    if (!tools.includes(t)) tools.push(t);
  }
  return { agent: { name, description, prompt, tools, model: model || null } };
}

/**
 * 保存 agent：先写到临时目录用 `kiro-cli agent validate` 校验，通过后再原子替换。
 * create=true 时若已存在则报错。
 */
async function saveAgent(kiroBin, getModes, name, body, { create } = {}) {
  const norm = normalizeInput(name, body);
  if (norm.error) return { status: 400, error: norm.error };

  const file = agentPath(name);
  const exists = fs.existsSync(file);
  if (create && exists) return { status: 409, error: '已存在同名 agent: ' + name };
  if (!create && !exists) return { status: 404, error: 'agent 不存在: ' + name };

  if (create) {
    // 不允许和全局 / 内置 agent 重名，避免「本地覆盖全局」带来的混淆
    const all = await listAgents(getModes, true);
    if (all.agents.some((a) => a.name === name) || name === DEFAULT_MODE) {
      return { status: 409, error: '与已有 agent 重名: ' + name };
    }
  }

  let existing = {};
  if (exists) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const json = toFileJson(norm.agent, existing);
  const tmp = path.join(TMP_DIR, name + '.json');
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
  const v = await run(kiroBin, ['agent', 'validate', '--path', tmp]);
  if (v.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { status: 400, error: '配置校验失败: ' + stripAnsi(v.stderr || v.stdout).trim().slice(0, 500) };
  }
  fs.renameSync(tmp, file);
  invalidate();
  return { status: 200, agent: readManaged().find((a) => a.name === name) };
}

function deleteAgent(name) {
  if (!isValidName(name)) return { status: 400, error: '无效的名字' };
  const file = agentPath(name);
  if (!fs.existsSync(file)) return { status: 404, error: 'agent 不存在，或不是插件管理的 agent' };
  fs.rmSync(file);
  invalidate();
  return { status: 200 };
}

/** 读取一个插件 agent 的配置（不是插件 agent 时返回 null） */
function getManagedAgent(name) {
  if (!isValidName(name)) return null;
  return readManaged().find((a) => a.name === name) || null;
}

/** /ask 使用前检查：agent 必须是当前可用的 agent */
async function agentExists(getModes, name) {
  if (!isSafeArg(name)) return false;
  if (fs.existsSync(agentPath(name))) return true;
  const data = await listAgents(getModes, false);
  return data.agents.some((a) => a.name === name);
}

module.exports = {
  WORKSPACE_DIR,
  DEFAULT_MODE,
  ensureWorkspace,
  listAgents,
  saveAgent,
  deleteAgent,
  agentExists,
  getManagedAgent,
  isSafeArg,
};
