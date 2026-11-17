'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

const endpointEl = document.getElementById('endpoint');
const modelEl = document.getElementById('model');
const modelHintEl = document.getElementById('modelHint');
const agentEl = document.getElementById('agent');
const autoStartEl = document.getElementById('autoStart');
const savedEl = document.getElementById('saved');
const nativeBadge = document.getElementById('nativeBadge');
const nativeOut = document.getElementById('nativeOut');
const installCmdEl = document.getElementById('installCmd');

const MODEL_HINT = '对应 kiro-cli 的 --model 参数，侧边栏输入框下方也可以随时切换';

let modelList = [];
let defaultModel = null;
let agentList = [];
let toolDefs = [];

function currentEndpoint() {
  return (endpointEl.value.trim() || DEFAULT_ENDPOINT).replace(/\/$/, '');
}

function api(path, opts = {}) {
  return fetch(currentEndpoint() + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  });
}

/** 把模型列表填进一个下拉框；selected 不在列表里时补一个选项，避免丢失已保存的值 */
function fillModelSelect(sel, selected, defaultLabel) {
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = defaultLabel;
  sel.appendChild(def);
  for (const m of modelList) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.name + (typeof m.rate === 'number' ? '  ·  ' + m.rate + 'x credits' : '');
    o.title = m.description || '';
    sel.appendChild(o);
  }
  if (selected && !modelList.some((m) => m.id === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = selected;
    sel.appendChild(o);
  }
  sel.value = selected || '';
}

async function loadModels(selected, force) {
  modelHintEl.textContent = '正在获取模型列表…';
  try {
    const data = await api('/models' + (force ? '?refresh=1' : ''));
    modelList = data.models || [];
    defaultModel = data.defaultModel || null;
    modelHintEl.textContent = MODEL_HINT;
  } catch (e) {
    modelHintEl.textContent = '无法从后端获取模型列表（后端离线？）。' + MODEL_HINT;
  }
  fillModelSelect(
    modelEl,
    selected,
    '跟随 Agent / 默认' + (defaultModel ? '（' + defaultModel + '）' : '')
  );
  if (!agentForm.classList.contains('hidden')) {
    fillModelSelect(afModel, afModel.value, '不指定（使用 kiro-cli 默认模型）');
  }
}

/** 填充「默认 Agent」下拉框 */
function fillAgentSelect(selected) {
  agentEl.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = '默认 Agent';
  agentEl.appendChild(def);
  for (const a of agentList) {
    const o = document.createElement('option');
    o.value = a.name;
    o.textContent = a.name + (a.source === 'plugin' ? '' : a.source === 'global' ? '（全局）' : '（内置）');
    agentEl.appendChild(o);
  }
  if (selected && !agentList.some((a) => a.name === selected)) {
    const o = document.createElement('option');
    o.value = selected;
    o.textContent = selected + (agentList.length ? '（已不存在）' : '');
    agentEl.appendChild(o);
  }
  agentEl.value = selected || '';
}

// ---------- 文件读取权限（保存在后端） ----------
const readDirsEl = document.getElementById('readDirs');
const readWarnEl = document.getElementById('readWarn');
const readErrEl = document.getElementById('readErr');
const scopeRadios = [...document.querySelectorAll('input[name="readScope"]')];
let readLoaded = false; // 后端没连上时不提交，免得用默认值覆盖后端的配置

function currentScope() {
  const r = scopeRadios.find((x) => x.checked);
  return r ? r.value : 'pages';
}
function syncReadUi() {
  const scope = currentScope();
  readDirsEl.disabled = scope !== 'dirs';
  readWarnEl.classList.toggle('hidden', scope === 'pages');
}
scopeRadios.forEach((r) => r.addEventListener('change', syncReadUi));

function showReadErr(msg) {
  readErrEl.textContent = msg || '';
  readErrEl.classList.toggle('hidden', !msg);
}

async function loadReadScope() {
  try {
    const c = await api('/config');
    scopeRadios.forEach((r) => (r.checked = r.value === c.readScope));
    readDirsEl.value = (c.readDirs || []).join('\n');
    readLoaded = true;
    showReadErr('');
  } catch (e) {
    readLoaded = false;
    showReadErr('读取后端配置失败：' + e.message + '（后端离线或版本过旧时无法修改）');
  }
  syncReadUi();
}

async function saveReadScope() {
  if (!readLoaded) return true;
  try {
    const c = await api('/config', {
      method: 'PUT',
      body: JSON.stringify({
        readScope: currentScope(),
        readDirs: readDirsEl.value.split('\n').map((l) => l.trim()).filter(Boolean),
      }),
    });
    readDirsEl.value = (c.readDirs || []).join('\n'); // 显示展开 ~ 之后的路径
    showReadErr('');
    return true;
  } catch (e) {
    showReadErr('文件读取权限没有保存：' + e.message);
    return false;
  }
}

async function load() {
  const s = await chrome.storage.sync.get(['endpoint', 'model', 'agent', 'autoStart']);
  endpointEl.value = s.endpoint || DEFAULT_ENDPOINT;
  autoStartEl.checked = s.autoStart !== false;
  fillAgentSelect(s.agent || '');
  await loadModels(s.model || '');
  await loadAgents(s.agent || '');
  await loadReadScope();
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  await chrome.storage.sync.set({
    endpoint: currentEndpoint(),
    model: modelEl.value,
    agent: agentEl.value,
    autoStart: autoStartEl.checked,
  });
  if (!(await saveReadScope())) {
    savedEl.textContent = '';
    return;
  }
  savedEl.textContent = '已保存 ✓';
  setTimeout(() => (savedEl.textContent = ''), 2000);
});

document.getElementById('refreshModels').addEventListener('click', () =>
  loadModels(modelEl.value, true)
);

// 侧边栏里切换模型 / agent 时，这里同步显示
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.model) fillModelSelect(modelEl, changes.model.newValue || '', modelEl.options[0].textContent);
  if (changes.agent) fillAgentSelect(changes.agent.newValue || '');
});

// ---------- Agent 管理 ----------
const agentListEl = document.getElementById('agentList');
const agentListErr = document.getElementById('agentListErr');
const agentForm = document.getElementById('agentForm');
const afTitle = document.getElementById('agentFormTitle');
const afBadge = document.getElementById('agentFormBadge');
const afName = document.getElementById('afName');
const afDesc = document.getElementById('afDesc');
const afModel = document.getElementById('afModel');
const afPrompt = document.getElementById('afPrompt');
const afTools = document.getElementById('afTools');
const afToolWarn = document.getElementById('afToolWarn');
const afDelete = document.getElementById('afDelete');
const afMsg = document.getElementById('afMsg');

let editing = null; // 正在编辑的 agent 名；null 表示新建

async function loadAgents(selectedDefault) {
  try {
    const data = await api('/agents?refresh=1');
    agentList = data.agents || [];
    toolDefs = data.tools || [];
    agentListErr.classList.add('hidden');
  } catch (e) {
    agentList = [];
    agentListErr.textContent = '无法获取 agent 列表：' + e.message + '（后端离线或版本过旧？）';
    agentListErr.classList.remove('hidden');
  }
  fillAgentSelect(selectedDefault != null ? selectedDefault : agentEl.value);
  renderAgentList();
}

function toolTag(id) {
  const def = toolDefs.find((t) => t.id === id);
  const s = document.createElement('span');
  s.className = 'tag' + (def && def.risky ? ' risky' : '');
  s.textContent = def ? def.label : id;
  return s;
}

function renderAgentList() {
  agentListEl.innerHTML = '';
  for (const a of agentList) {
    const item = document.createElement(a.editable ? 'button' : 'div');
    item.className = 'agent-item' + (a.editable ? '' : ' readonly') + (editing === a.name ? ' active' : '');
    if (a.editable) {
      item.type = 'button';
      item.addEventListener('click', () => openForm(a));
    }
    const main = document.createElement('div');
    main.className = 'ai-main';
    const name = document.createElement('div');
    name.className = 'ai-name';
    name.textContent = a.name;
    const desc = document.createElement('div');
    desc.className = 'ai-desc';
    desc.textContent = a.error || a.description || '（无描述）';
    main.append(name, desc);

    const tags = document.createElement('div');
    tags.className = 'ai-tags';
    if (a.error) {
      const t = document.createElement('span');
      t.className = 'tag err';
      t.textContent = '配置有误';
      tags.appendChild(t);
    } else if (a.editable) {
      if (a.model) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = a.model;
        tags.appendChild(t);
      }
      if (!a.tools.length) {
        const t = document.createElement('span');
        t.className = 'tag';
        t.textContent = '无工具';
        tags.appendChild(t);
      }
      a.tools.forEach((id) => tags.appendChild(toolTag(id)));
    } else {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = a.source === 'global' ? '全局 · 只读' : '内置 · 只读';
      tags.appendChild(t);
    }
    item.append(main, tags);
    agentListEl.appendChild(item);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'ghost agent-new';
  add.textContent = '+ 新建 Agent';
  add.addEventListener('click', () => openForm(null));
  agentListEl.appendChild(add);
}

function renderToolOptions(selected) {
  afTools.innerHTML = '';
  for (const t of toolDefs) {
    const label = document.createElement('label');
    label.className = 'tool-opt' + (t.risky ? ' risky' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = t.id;
    cb.checked = selected.includes(t.id);
    cb.addEventListener('change', updateToolWarn);
    const text = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'to-label';
    l.textContent = t.label + '（' + t.id + '）';
    const d = document.createElement('div');
    d.className = 'to-desc';
    d.textContent = t.description;
    text.append(l, d);
    label.append(cb, text);
    afTools.appendChild(label);
  }
  updateToolWarn();
}

function selectedTools() {
  return Array.from(afTools.querySelectorAll('input:checked')).map((c) => c.value);
}

function updateToolWarn() {
  const risky = selectedTools().some((id) => (toolDefs.find((t) => t.id === id) || {}).risky);
  afToolWarn.classList.toggle('hidden', !risky);
}

function setFormMsg(text, cls) {
  afMsg.textContent = text;
  afMsg.className = 'form-msg' + (cls ? ' ' + cls : '');
}

/** 打开编辑表单；a 为 null 时新建（以 web-reader 风格的空模板开始） */
function openForm(a) {
  editing = a ? a.name : null;
  afTitle.textContent = a ? '编辑 Agent' : '新建 Agent';
  afBadge.textContent = a ? a.name : '';
  afBadge.classList.toggle('hidden', !a);
  afName.value = a ? a.name : '';
  afName.disabled = !!a;
  afDesc.value = a ? a.description : '';
  afPrompt.value = a ? a.prompt : '';
  fillModelSelect(afModel, a ? a.model : '', '不指定（使用 kiro-cli 默认模型）');
  renderToolOptions(a ? a.tools : ['web']);
  afDelete.classList.toggle('hidden', !a);
  setFormMsg('');
  agentForm.classList.remove('hidden');
  renderAgentList();
  (a ? afDesc : afName).focus();
}

function closeForm() {
  editing = null;
  agentForm.classList.add('hidden');
  renderAgentList();
}

/** 通知侧边栏刷新 agent 列表 */
function notifyAgentsChanged() {
  chrome.storage.local.set({ agentsRev: Date.now() }).catch(() => {});
}

agentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: afName.value.trim(),
    description: afDesc.value.trim(),
    prompt: afPrompt.value,
    model: afModel.value,
    tools: selectedTools(),
  };
  setFormMsg('保存中…');
  try {
    const r = editing
      ? await api('/agents/' + encodeURIComponent(editing), { method: 'PUT', body: JSON.stringify(body) })
      : await api('/agents', { method: 'POST', body: JSON.stringify(body) });
    editing = r.agent.name;
    await loadAgents();
    openForm(agentList.find((x) => x.name === editing) || r.agent);
    setFormMsg('已保存 ✓', 'ok');
    notifyAgentsChanged();
  } catch (err) {
    setFormMsg(err.message, 'err');
  }
});

document.getElementById('afCancel').addEventListener('click', closeForm);

afDelete.addEventListener('click', async () => {
  if (!editing) return;
  if (!window.confirm('删除 agent「' + editing + '」？此操作不能撤销。')) return;
  const name = editing;
  try {
    await api('/agents/' + encodeURIComponent(name), { method: 'DELETE' });
    // 删掉的是当前默认 agent：改回默认
    const { agent } = await chrome.storage.sync.get('agent');
    if (agent === name) await chrome.storage.sync.set({ agent: '' });
    closeForm();
    await loadAgents(agent === name ? '' : undefined);
    notifyAgentsChanged();
  } catch (err) {
    setFormMsg(err.message, 'err');
  }
});

// ---------- 本地启动器 ----------
installCmdEl.textContent = nativeInstallCommand();

document.getElementById('copyCmd').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  navigator.clipboard.writeText(installCmdEl.textContent).then(() => {
    btn.textContent = '已复制';
    setTimeout(() => (btn.textContent = '复制'), 1400);
  });
});

function setBadge(cls, text) {
  nativeBadge.className = 'badge' + (cls ? ' ' + cls : '');
  nativeBadge.textContent = text;
}

function showOutput(text) {
  nativeOut.textContent = text;
  nativeOut.classList.toggle('hidden', !text);
}

async function refreshNativeStatus() {
  const r = await callNativeHost('status');
  if (!r.ok) {
    if (r.needsReload) {
      setBadge('bad', '需重新加载插件');
      showOutput(r.error);
    } else {
      setBadge('bad', r.notInstalled ? '未安装' : '异常');
      if (!r.notInstalled) showOutput(r.error || '');
    }
    return;
  }
  setBadge('ok', r.running ? '已安装 · 后端运行中 (PID ' + r.pid + ')' : '已安装 · 后端未运行');
}

async function runAction(action) {
  const buttons = document.querySelectorAll('#nativeSection .row button');
  buttons.forEach((b) => (b.disabled = true));
  showOutput('执行中…');
  const r = await callNativeHost(action, endpointPort(currentEndpoint()));
  // 去掉终端颜色控制符
  const out = (r.output || r.error || '').replace(/\x1b\[[0-9;]*m/g, '');
  showOutput(out || (r.ok ? '完成' : '失败'));
  buttons.forEach((b) => (b.disabled = false));
  await refreshNativeStatus();
  if (action !== 'stop') loadModels(modelEl.value);
}

document.getElementById('startSrv').addEventListener('click', () => runAction('start'));
document.getElementById('stopSrv').addEventListener('click', () => runAction('stop'));
document.getElementById('restartSrv').addEventListener('click', () => runAction('restart'));

load();
refreshNativeStatus();
