'use strict';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8787';

const els = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  composer: document.getElementById('composer'),
  sendBtn: document.getElementById('sendBtn'),
  stopBtn: document.getElementById('stopBtn'),
  clearBtn: document.getElementById('clearBtn'),
  settingsBtn: document.getElementById('settingsBtn'),
  status: document.getElementById('status'),
  statusText: document.getElementById('statusText'),
  useContext: document.getElementById('useContext'),
  pageTitle: document.getElementById('pageTitle'),
  refreshPageBtn: document.getElementById('refreshPageBtn'),
  previewBtn: document.getElementById('previewBtn'),
  previewModal: document.getElementById('previewModal'),
  previewClose: document.getElementById('previewClose'),
  previewMeta: document.getElementById('previewMeta'),
  previewBody: document.getElementById('previewBody'),
  quickActions: document.getElementById('quickActions'),
  modelSelect: document.getElementById('modelSelect'),
  agentSelect: document.getElementById('agentSelect'),
  toolChips: document.getElementById('toolChips'),
  expandBtn: document.getElementById('expandBtn'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  fullSrc: document.getElementById('fullSrc'),
  backendBar: document.getElementById('backendBar'),
  backendMsg: document.getElementById('backendMsg'),
  startBackendBtn: document.getElementById('startBackendBtn'),
  chatBody: document.getElementById('chatBody'),
  selAsk: document.getElementById('selAsk'),
  threadMap: document.getElementById('threadMap'),
  tmTree: document.getElementById('tmTree'),
  mapBtn: document.getElementById('mapBtn'),
  mapClose: document.getElementById('mapClose'),
  quoteBar: document.getElementById('quoteBar'),
  quoteLabel: document.getElementById('quoteLabel'),
  quoteText: document.getElementById('quoteText'),
  quoteClear: document.getElementById('quoteClear'),
  attachBar: document.getElementById('attachBar'),
  composerNote: document.getElementById('composerNote'),
  attachBtn: document.getElementById('attachBtn'),
  shotBtn: document.getElementById('shotBtn'),
  fileInput: document.getElementById('fileInput'),
  imgViewer: document.getElementById('imgViewer'),
};

let settings = { endpoint: DEFAULT_ENDPOINT, model: '', agent: '', autoStart: true };
let currentController = null; // 用于中止请求
let pageContext = null; // 当前页面抓取结果

// ---------- 多轮会话状态 ----------
let sessionId = null; // 当前会话 id
let injectedUrl = null; // 已把哪个页面的全文注入过会话（避免每轮重复塞全文）
let lastPageUrl = null; // 上一次抓取到的页面 url（用于检测换页）
let lastQuestion = null; // 最近一次用户提问（用于「重新生成」）
let convAgent = ''; // 当前会话是用哪个 agent 开启的（换 agent 后不能续聊旧会话）

// ---------- 按标签页隔离的会话持久化 ----------
// 对话绑定到打开它的标签页：切走切回不丢，关闭标签页即清空。
// 存储用 chrome.storage.session（浏览器关闭自动清空）。
let currentTabId = null; // 侧边栏当前展示的是哪个标签页的对话
const CONV_PREFIX = 'conv_'; // 存储 key 前缀 + tabId
let restoring = false; // 恢复对话期间，抑制自动抓取/开新会话副作用

// ---------- 全屏模式 ----------
// 同一个页面有两种打开方式：
//   侧边栏：跟随当前激活的标签页切换对话；
//   全屏页（sidepanel.html?mode=full&tabId=N）：在独立标签页中打开，始终绑定标签页 N，
//   与侧边栏共用 conv_N 这份对话，两边互相同步。
const PAGE_PARAMS = new URLSearchParams(location.search);
const FULL_MODE = PAGE_PARAMS.get('mode') === 'full';
const BOUND_TAB_ID = FULL_MODE ? Number(PAGE_PARAMS.get('tabId')) || null : null;
let boundTabClosed = false; // 全屏页绑定的源标签页已关闭
let lastSyncedConv = null; // 最近一次本页写入/读到的对话 JSON，用于忽略自己触发的同步事件

// ---------- 设置读取 ----------
async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(['endpoint', 'model', 'agent', 'autoStart']);
    settings.endpoint = (stored.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    settings.model = stored.model || '';
    settings.agent = stored.agent || '';
    settings.autoStart = stored.autoStart !== false; // 默认开启
  } catch {
    settings.endpoint = DEFAULT_ENDPOINT;
  }
}

// ---------- 健康检查 + 自动启动后端 ----------
let backendOnline = false;
let backendFeatures = null; // /health 返回的功能列表；旧版后端没有 'image'，会默默丢掉图片
let startingBackend = null; // 正在进行的启动 Promise（防止重复启动）
let lastAutoStartAt = 0; // 上次自动启动时间，避免反复拉起
const AUTO_START_COOLDOWN = 30 * 1000;

async function pingHealth() {
  try {
    const r = await fetch(settings.endpoint + '/health', { method: 'GET' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function setStatus(state, text, title) {
  els.status.className = 'status-chip' + (state ? ' ' + state : '');
  els.statusText.textContent = text;
  els.status.title = title;
}

/** 显示/隐藏离线横幅。html 为可信的固定文案（含 <code>） */
function setBackendBar(visible, html, opts = {}) {
  els.backendBar.classList.toggle('hidden', !visible);
  els.backendBar.classList.toggle('busy', !!opts.busy);
  if (html != null) els.backendMsg.innerHTML = html;
  els.startBackendBtn.classList.toggle('hidden', !!opts.hideBtn);
  els.startBackendBtn.disabled = !!opts.busy;
  els.startBackendBtn.textContent = opts.btnText || '启动后端';
}

/**
 * 检查后端状态。
 * allowAutoStart: 离线时是否按设置自动启动（默认 true）。
 * 返回是否在线。
 */
async function checkHealth(allowAutoStart = true) {
  if (startingBackend) return startingBackend;
  setStatus('', '检测中', '正在检测后端…');
  const j = await pingHealth();
  if (j) {
    backendOnline = true;
    backendFeatures = Array.isArray(j.features) ? j.features : [];
    setStatus('ok', '在线', '后端在线: ' + (j.kiroBin || '') + '（点击重新检测）');
    setBackendBar(false);
    loadModels();
    loadAgents();
    return true;
  }
  backendOnline = false;
  setStatus('bad', '离线', '后端离线 (' + settings.endpoint + ')，点击尝试启动');

  const local = isLocalEndpoint(settings.endpoint);
  if (
    allowAutoStart &&
    local &&
    settings.autoStart &&
    Date.now() - lastAutoStartAt > AUTO_START_COOLDOWN
  ) {
    lastAutoStartAt = Date.now();
    return startBackend();
  }
  if (local) {
    setBackendBar(true, '后端未运行（' + escapeText(settings.endpoint) + '）');
  } else {
    setBackendBar(
      true,
      '无法连接远程后端 ' + escapeText(settings.endpoint) + '，请在该机器上启动服务。',
      { hideBtn: true }
    );
  }
  return false;
}

/** 通过 Native Messaging 启动器执行 start.sh，并等待后端就绪 */
function startBackend() {
  if (startingBackend) return startingBackend;
  startingBackend = (async () => {
    setStatus('busy', '启动中', '正在启动本地后端…');
    setBackendBar(true, '正在启动本地后端…', { busy: true, btnText: '启动中…' });

    const resp = await callNativeHost('start', endpointPort(settings.endpoint));
    if (!resp.ok) {
      setStatus('bad', '离线', '后端离线，启动失败');
      if (resp.needsReload) {
        setBackendBar(
          true,
          '后端未运行。插件还没获得启动权限，请在 <code>chrome://extensions</code> 重新加载本插件。',
          { btnText: '重试' }
        );
      } else if (resp.notInstalled) {
        setBackendBar(
          true,
          '后端未运行。要让插件自动启动它，请先在项目目录执行一次：<br/><code>' +
            escapeText(nativeInstallCommand()) +
            '</code><br/>或手动执行 <code>cd server &amp;&amp; ./start.sh</code>',
          { btnText: '重试' }
        );
      } else {
        setBackendBar(
          true,
          '启动失败：' + escapeText(resp.error || resp.output || '未知错误') +
            '<br/>详见 <code>server/server.log</code>',
          { btnText: '重试' }
        );
      }
      return false;
    }

    // start.sh 返回后，轮询 /health 直到就绪（最多约 10 秒）
    for (let i = 0; i < 20; i++) {
      const j = await pingHealth();
      if (j) {
        backendOnline = true;
        setStatus('ok', '在线', '后端在线: ' + (j.kiroBin || '') + '（点击重新检测）');
        setBackendBar(false);
        loadModels();
        loadAgents();
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    setStatus('bad', '离线', '后端已启动但无响应');
    setBackendBar(
      true,
      '后端进程已启动但未响应，请检查端口是否一致或查看 <code>server/server.log</code>',
      { btnText: '重试' }
    );
    return false;
  })();
  startingBackend.finally(() => {
    startingBackend = null;
  });
  return startingBackend;
}

/** 发送前确保后端可用：离线且为本机地址时尝试启动 */
async function ensureBackend() {
  if (backendOnline) return true;
  if (await pingHealth()) return checkHealth(false);
  if (!isLocalEndpoint(settings.endpoint) || !settings.autoStart) return false;
  return startBackend();
}

// ---------- 模型 / Agent 列表 ----------
let modelsLoaded = false;
let agentsLoaded = false;
let modelList = []; // [{ id, name, ... }]
let defaultModel = null;
let agentList = []; // [{ name, description, tools, model, source }]
let toolDefs = []; // [{ id, label, risky }]

function modelOptionLabel(m) {
  let label = m.name || m.id;
  if (typeof m.rate === 'number') label += '  ·  ' + m.rate + 'x';
  return label;
}

function currentAgent() {
  return agentList.find((a) => a.name === settings.agent) || null;
}

/** 从后端拉取模型列表并填充下拉框 */
async function loadModels(force = false) {
  if (!modelsLoaded || force) {
    try {
      const r = await fetch(settings.endpoint + '/models' + (force ? '?refresh=1' : ''));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      modelList = (data.models || []).filter((m) => m.id);
      defaultModel = data.defaultModel || null;
      modelsLoaded = true;
    } catch (e) {
      // 旧版后端没有 /models，保留已有选项
    }
  }
  syncModelSelect();
}

/** 从后端拉取 agent 列表 */
async function loadAgents(force = false) {
  if (!agentsLoaded || force) {
    try {
      const r = await fetch(settings.endpoint + '/agents' + (force ? '?refresh=1' : ''));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      agentList = data.agents || [];
      toolDefs = data.tools || [];
      agentsLoaded = true;
    } catch (e) {
      // 旧版后端没有 /agents
    }
  }
  syncAgentSelect();
  syncModelSelect(); // 「跟随 Agent」的文案依赖当前 agent
}

/** 让下拉框显示当前设置的模型；设置里的模型不在列表时补一个选项 */
function syncModelSelect() {
  const sel = els.modelSelect;
  const want = settings.model || '';
  const agent = currentAgent();
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  if (agent && agent.model) def.textContent = '跟随 Agent（' + agent.model + '）';
  else def.textContent = '默认' + (defaultModel ? '（' + defaultModel + '）' : '模型');
  sel.appendChild(def);
  for (const m of modelList) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = modelOptionLabel(m);
    o.title = m.description || '';
    sel.appendChild(o);
  }
  if (want && !modelList.some((m) => m.id === want)) {
    const o = document.createElement('option');
    o.value = want;
    o.textContent = want;
    sel.appendChild(o);
  }
  sel.value = want;
  const opt = sel.options[sel.selectedIndex];
  sel.parentElement.title =
    '切换模型（对应 kiro-cli --model），下一次提问生效' + (opt && opt.title ? '\n' + opt.title : '');
}

/** 填充 agent 下拉框 */
function syncAgentSelect() {
  const sel = els.agentSelect;
  const want = settings.agent || '';
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = '默认 Agent';
  sel.appendChild(def);

  const groups = [
    ['plugin', '插件 Agent'],
    ['global', '全局 Agent'],
    ['builtin', '内置 Agent'],
  ];
  for (const [src, label] of groups) {
    const items = agentList.filter((a) => a.source === src);
    if (!items.length) continue;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const a of items) {
      const o = document.createElement('option');
      o.value = a.name;
      o.textContent = a.name;
      o.title = a.description || '';
      g.appendChild(o);
    }
    sel.appendChild(g);
  }
  if (want && !agentList.some((a) => a.name === want)) {
    const o = document.createElement('option');
    o.value = want;
    o.textContent = want + (agentsLoaded ? '（已不存在）' : '');
    sel.appendChild(o);
  }
  sel.value = want;
  const agent = currentAgent();
  sel.parentElement.title =
    '切换 Agent（切换后开启新会话）' + (agent && agent.description ? '\n' + agent.description : '');
  renderToolChips(agent);
}

/** 在输入框下方显示当前 agent 的工具（只有插件 agent 才知道具体工具） */
function renderToolChips(agent) {
  const box = els.toolChips;
  box.innerHTML = '';
  if (!agent || !Array.isArray(agent.tools)) return;
  if (agent.tools.length === 0) {
    const s = document.createElement('span');
    s.className = 'tool-chip';
    s.textContent = '无工具';
    box.appendChild(s);
    return;
  }
  for (const id of agent.tools) {
    const def = toolDefs.find((t) => t.id === id);
    const s = document.createElement('span');
    s.className = 'tool-chip' + (def && def.risky ? ' risky' : '');
    s.textContent = def ? def.label : id;
    s.title = def ? def.description : '';
    box.appendChild(s);
  }
}

// ---------- UI 辅助 ----------
function clearEmptyHint() {
  const hint = els.messages.querySelector('.empty-hint');
  if (hint) hint.remove();
}

function showEmptyHint() {
  if (els.messages.children.length === 0) {
    const d = document.createElement('div');
    d.className = 'empty-hint';
    // 和界面上的按钮用同一套图标，用户照着找得到
    const ico = (d) =>
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="' + d +
      '" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const EYE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.25a2.75 2.75 0 110 5.5 2.75 2.75 0 010-5.5z';
    const TRASH = 'M4 7h16M9.5 7V5.5A1.5 1.5 0 0111 4h2a1.5 1.5 0 011.5 1.5V7M6 7l.8 11.2A2 2 0 008.8 20h6.4a2 2 0 002-1.8L18 7';
    const AGENT = 'M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9';
    d.innerHTML =
      '<div class="eh-title">针对当前网页提问</div>' +
      '<p class="eh-text">Kiro 会读取这个页面的内容来回答，同一会话里可以连续追问。</p>' +
      '<ul class="eh-tips">' +
      '<li>' + ico(EYE) + '<span>点顶栏的眼睛图标，查看发给 Kiro 的页面内容</span></li>' +
      '<li>' + ico(TRASH) + '<span>点垃圾桶开启新会话，之前的对话不再带入</span></li>' +
      '<li>' + ico(AGENT) + '<span>在输入框下方切换 Agent 和模型</span></li>' +
      '</ul>';
    els.messages.appendChild(d);
  }
}

/**
 * 添加一条消息。opts.id：消息 id（恢复对话时沿用，否则新建）；
 * opts.quote：用户追问引用的内容 { msgId?, text, start?, end?, source: 'answer' | 'page' }
 */
function addMessage(role, text = '', steps = null, meta = null, opts = {}) {
  clearEmptyHint();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  wrap.dataset.id = opts.id || newMsgId();
  if (opts.quote) wrap._quote = opts.quote;
  if (opts.images && opts.images.length) wrap._images = opts.images;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  const roleName = document.createElement('span');
  roleName.textContent = role === 'user' ? '你' : role === 'assistant' ? 'Kiro' : '错误';
  roleEl.appendChild(roleName);
  const body = document.createElement('div');
  body.className = 'body';
  wrap.appendChild(roleEl);
  if (role === 'assistant') {
    // 回答上方：思考过程 / 工具调用时间线 + 实时状态行
    const stepsEl = document.createElement('div');
    stepsEl.className = 'steps';
    const liveEl = document.createElement('div');
    liveEl.className = 'live-status hidden';
    liveEl.innerHTML = '<span class="live-spin" aria-hidden="true"></span><span class="live-text"></span><span class="live-time"></span>';
    const metaEl = document.createElement('span');
    metaEl.className = 'role-meta';
    roleEl.appendChild(metaEl);
    wrap.appendChild(stepsEl);
    wrap.appendChild(liveEl);
    body._act = { stepsEl, liveEl, metaEl, steps: [], timer: null, startedAt: 0, answered: false, meta: meta || null };
    if (steps && steps.length) {
      for (const s of steps) renderStep(body, s, false);
    }
    if (meta) setRoleMeta(body, meta);

    body.classList.add('md'); // Markdown 渲染容器
    body.dataset.raw = text || ''; // 累积的原始 markdown
    if (text) body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text; // 用户/错误消息保持纯文本
  }
  if (role === 'user' && opts.quote) {
    // 追问气泡顶部显示引用摘要；点击跳回被引用的原文
    const q = document.createElement('button');
    q.type = 'button';
    q.className = 'msg-quote';
    q.textContent = opts.quote.text.replace(/\s+/g, ' ');
    q.title = opts.quote.source === 'page' ? '引用自网页' : '跳到被引用的回答';
    if (opts.quote.source !== 'page' && opts.quote.msgId) {
      q.addEventListener('click', () => jumpToAnchor(opts.quote.msgId, wrap.dataset.id));
    }
    wrap.appendChild(q);
  }
  if (role === 'user' && wrap._images) {
    const box = document.createElement('div');
    box.className = 'msg-images';
    wrap._images.forEach((im, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-img';
      b.title = '查看大图';
      const img = document.createElement('img');
      img.src = im.thumb;
      img.alt = '图片 ' + (i + 1);
      b.appendChild(img);
      b.addEventListener('click', () => {
        const orig = origImages.get(wrap.dataset.id);
        openImageViewer(orig && orig[i] ? orig[i].url : im.thumb);
      });
      box.appendChild(b);
    });
    wrap.appendChild(box);
  }
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  // 新增消息（发送/收到新气泡）时强制滚到底部并恢复跟随
  forceScrollBottom();
  return body;
}

/**
 * 向助手消息追加流式文本。
 * 每个 chunk 都整段重渲染 Markdown 在长回答时会很卡，这里按帧合并：一帧最多渲染一次。
 */
function appendAssistantChunk(bodyEl, chunk) {
  bodyEl.dataset.raw = (bodyEl.dataset.raw || '') + chunk;
  if (bodyEl._raf) return;
  bodyEl._raf = requestAnimationFrame(() => {
    bodyEl._raf = 0;
    renderAnswerNow(bodyEl);
  });
}

/** 立即渲染（流结束、停止时调用，确保最后一段不丢） */
function flushAnswer(bodyEl) {
  if (bodyEl._raf) {
    cancelAnimationFrame(bodyEl._raf);
    bodyEl._raf = 0;
    renderAnswerNow(bodyEl);
  }
}

function renderAnswerNow(bodyEl) {
  bodyEl.innerHTML = renderMarkdown(bodyEl.dataset.raw || '');
  wireCopyButtons(bodyEl);
  followScroll();
}

// ---------- 思考过程 / 工具调用 ----------
const TOOL_STATUS_TEXT = {
  pending: '等待中',
  in_progress: '执行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已中断',
};

/** 开始一轮回答的实时状态（发出请求后立刻显示，避免界面空白） */
function startLive(answerEl, text) {
  const act = answerEl._act;
  if (!act) return;
  act.startedAt = act.startedAt || Date.now();
  setLive(answerEl, text);
  act.liveEl.classList.remove('hidden');
  if (!act.timer) {
    const tick = () => {
      const s = (Date.now() - act.startedAt) / 1000;
      act.liveEl.querySelector('.live-time').textContent = s < 60 ? s.toFixed(0) + 's' : Math.floor(s / 60) + 'm' + Math.floor(s % 60) + 's';
    };
    tick();
    act.timer = setInterval(tick, 1000);
  }
}

function setLive(answerEl, text) {
  const act = answerEl._act;
  if (!act) return;
  act.liveEl.querySelector('.live-text').textContent = text;
}

/** 结束实时状态，在角色行写上用时和工具次数 */
function stopLive(answerEl) {
  const act = answerEl._act;
  if (!act || act.stopped) return;
  act.stopped = true;
  if (act.timer) clearInterval(act.timer);
  act.timer = null;
  act.liveEl.classList.add('hidden');
  if (act.startedAt) {
    const tools = act.steps.filter((s) => s.type === 'tool').length;
    act.meta = { elapsed: Date.now() - act.startedAt, tools };
    setRoleMeta(answerEl, act.meta);
  }
  // 没收到结果的工具调用标记为已中断
  for (const s of act.steps) {
    if (s.type === 'tool' && (s.status === 'pending' || s.status === 'in_progress')) {
      s.status = 'cancelled';
      updateToolDom(s);
    }
  }
}

function setRoleMeta(answerEl, meta) {
  const act = answerEl._act;
  if (!act || !meta) return;
  const parts = [];
  if (meta.elapsed) parts.push('用时 ' + (meta.elapsed / 1000).toFixed(1) + 's');
  if (meta.tools) parts.push(meta.tools + ' 次工具调用');
  act.metaEl.textContent = parts.join(' · ');
}

/** 收到思考增量：接在最后一段思考后面，前面是工具调用时另起一段 */
function appendThought(answerEl, text) {
  const act = answerEl._act;
  if (!act) return;
  let last = act.steps[act.steps.length - 1];
  if (!last || last.type !== 'thought') {
    last = { type: 'thought', text: '' };
    renderStep(answerEl, last, !act.answered);
  }
  last.text += text;
  last._textNode.appendData(text);
  last._meta.textContent = last.text.length + ' 字';
  setLive(answerEl, '思考中');
  followScroll();
}

/** 收到工具事件：同一个 id 合并更新 */
function upsertTool(answerEl, ev) {
  const act = answerEl._act;
  if (!act) return;
  let s = act.steps.find((x) => x.type === 'tool' && x.id === ev.id);
  if (!s) {
    s = { type: 'tool', id: ev.id, title: '', kind: '', summary: '', status: 'pending', input: '', output: '' };
    // 开始调用工具后，之前的思考已经说完，收起来
    collapseThoughts(act);
    renderStep(answerEl, s, false);
  }
  for (const k of ['title', 'kind', 'summary', 'status', 'input', 'output']) {
    if (ev[k] != null && ev[k] !== '') s[k] = ev[k];
  }
  updateToolDom(s);
  const name = s.title || s.kind || '工具';
  if (s.status === 'pending' || s.status === 'in_progress') setLive(answerEl, '正在调用 ' + name);
  else setLive(answerEl, '思考中');
  followScroll();
}

function collapseThoughts(act) {
  for (const s of act.steps) if (s.type === 'thought' && s._el) s._el.open = false;
}

/** 正式回答开始输出：收起思考，状态行改为「正在回答」 */
function markAnswering(answerEl) {
  const act = answerEl._act;
  if (!act || act.answered) return;
  act.answered = true;
  collapseThoughts(act);
  setLive(answerEl, '正在回答');
}

/** 把一个步骤渲染到时间线里。open: 思考块是否默认展开 */
function renderStep(answerEl, s, open) {
  const act = answerEl._act;
  const d = document.createElement('details');
  d.className = 'step step-' + s.type;
  const sum = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'step-icon';
  icon.setAttribute('aria-hidden', 'true');
  const title = document.createElement('span');
  title.className = 'step-title';
  const sub = document.createElement('span');
  sub.className = 'step-sub';
  const meta = document.createElement('span');
  meta.className = 'step-meta';
  sum.append(icon, title, sub, meta);
  d.appendChild(sum);
  const bodyEl = document.createElement('div');
  bodyEl.className = 'step-body';
  d.appendChild(bodyEl);

  if (s.type === 'thought') {
    title.textContent = '思考过程';
    s._textNode = document.createTextNode(s.text || '');
    bodyEl.appendChild(s._textNode);
    s._meta = meta;
    meta.textContent = s.text ? s.text.length + ' 字' : '';
    d.open = !!open;
  } else {
    s._title = title;
    s._sub = sub;
    s._meta = meta;
    s._body = bodyEl;
  }
  s._el = d;
  act.steps.push(s);
  act.stepsEl.appendChild(d);
  if (s.type === 'tool') updateToolDom(s);
}

function updateToolDom(s) {
  if (!s._el) return;
  s._el.className = 'step step-tool tool-' + (s.status || 'pending');
  s._title.textContent = s.title || s.kind || '工具调用';
  s._sub.textContent = s.summary || '';
  s._sub.title = s.summary || '';
  s._meta.textContent = TOOL_STATUS_TEXT[s.status] || s.status || '';
  // 展开内容：输入 / 输出
  s._body.innerHTML = '';
  if (s.input) {
    const l = document.createElement('div');
    l.className = 'step-label';
    l.textContent = '输入';
    const pre = document.createElement('pre');
    pre.textContent = s.input;
    s._body.append(l, pre);
  }
  if (s.output) {
    const l = document.createElement('div');
    l.className = 'step-label';
    l.textContent = '输出';
    const pre = document.createElement('pre');
    pre.textContent = s.output;
    s._body.append(l, pre);
  }
  if (!s.input && !s.output) {
    s._body.textContent = '暂无详情';
  }
}

/** 序列化时去掉 DOM 引用 */
function stepsForStorage(answerEl) {
  const act = answerEl._act;
  if (!act) return [];
  return act.steps.map((s) =>
    s.type === 'thought'
      ? { type: 'thought', text: s.text }
      : { type: 'tool', id: s.id, title: s.title, kind: s.kind, summary: s.summary, status: s.status, input: s.input, output: s.output }
  );
}

/** 为代码块的「复制」按钮绑定事件（幂等） */
function wireCopyButtons(scope) {
  scope.querySelectorAll('.md-copy-btn').forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', () => {
      const block = btn.closest('.md-code-block');
      const code = block ? block.querySelector('code') : null;
      if (!code) return;
      navigator.clipboard
        .writeText(code.textContent || '')
        .then(() => {
          const old = btn.textContent;
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = old;
            btn.classList.remove('copied');
          }, 1400);
        })
        .catch(() => {
          btn.textContent = '复制失败';
          setTimeout(() => (btn.textContent = '复制'), 1400);
        });
    });
  });
}

// ---------- 流式输出时的「智能跟随滚动」 ----------
// 仅当用户停留在底部附近时才自动跟随；用户主动上滚后停止跟随，滚回底部后恢复。
let stickToBottom = true;
const STICK_THRESHOLD = 48; // 距底部多少像素内算「在底部」

function isNearBottom() {
  const el = els.messages;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
}

// 监听用户滚动，更新跟随状态
els.messages.addEventListener('scroll', () => {
  stickToBottom = isNearBottom();
});

/** 强制滚到底部（如发送新消息时） */
function forceScrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
  stickToBottom = true;
}

/** 跟随滚动：仅在用户处于底部时才滚 */
function followScroll() {
  if (stickToBottom) {
    els.messages.scrollTop = els.messages.scrollHeight;
  }
}

function scrollToBottom() {
  followScroll();
}

function setBusy(busy) {
  els.sendBtn.classList.toggle('hidden', busy);
  els.stopBtn.classList.toggle('hidden', !busy);
  els.input.disabled = busy;
  els.modelSelect.disabled = busy; // 生成中不允许切模型
  els.agentSelect.disabled = busy;
  els.expandBtn.disabled = busy; // 生成中不展开，避免两边同时续聊同一会话
  els.quickActions
    .querySelectorAll('button')
    .forEach((b) => (b.disabled = busy));
  els.attachBtn.disabled = busy;
  els.shotBtn.disabled = busy;
}

// ---------- 当前页面抓取 ----------
async function getActiveTab() {
  if (FULL_MODE) {
    // 全屏页：始终针对打开它的源标签页，而不是全屏页自己
    if (BOUND_TAB_ID == null || boundTabClosed) return null;
    try {
      return await chrome.tabs.get(BOUND_TAB_ID);
    } catch {
      return null;
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') ||
    url.startsWith('about:') ||
    url.startsWith('https://chrome.google.com/webstore') ||
    url.startsWith('https://chromewebstore.google.com')
  );
}

/** 判断是否为 PDF（按 URL 后缀，去掉查询串/锚点） */
function isPdfUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return /\.pdf($|[?#])/i.test(url);
  }
}

/** 设置页面标题栏的文本与状态样式 */
function setPageTitle(text, state) {
  els.pageTitle.textContent = text;
  els.pageTitle.className = 'page-title' + (state ? ' ' + state : '');
}

/** 用 pdf.js 提取 PDF 文本（经 window.extractPdfText） */
async function capturePdf(tab) {
  if (typeof window.extractPdfText !== 'function') {
    setPageTitle('PDF 组件未就绪，请稍后重试', 'err');
    return null;
  }
  setPageTitle('正在解析 PDF…', '');
  try {
    const data = await window.extractPdfText(tab.url, 200000, 300);
    if (!data || !data.text) {
      setPageTitle('未能从 PDF 提取文字（可能是扫描版/图片型 PDF）', 'err');
      els.pageTitle.title =
        '该 PDF 可能是扫描件，没有可提取的文字层。可手动复制内容后提问。';
      return null;
    }
    pageContext = data;
    setPageTitle(data.title || 'PDF 文档', 'live');
    els.pageTitle.title =
      data.url +
      '\nPDF · 共 ' +
      data.pages +
      ' 页，已解析 ' +
      data.parsedPages +
      ' 页，约 ' +
      data.length +
      ' 字' +
      (data.truncated ? '（已截断）' : '');
    lastPageUrl = data.url;
    return data;
  } catch (e) {
    setPageTitle('解析 PDF 失败：' + (e.message || e), 'err');
    els.pageTitle.title = String(e.message || e);
    return null;
  }
}

/**
 * 抓取当前标签页内容；失败返回 null。
 * opts.full：飞书文档要自动滚动读完全文（耗时几秒到几十秒，期间页面会滚动）。
 * 默认只读已渲染的部分，结果带 partial: true，发问题或打开预览前再用 full 补全（见 ensureFullPage）。
 */
async function capturePage(opts = {}) {
  pageContext = null;
  setPageTitle(opts.full ? '正在滚动读取飞书文档全文…' : '抓取中…', '');
  els.pageTitle.title = '';
  try {
    const tab = await getActiveTab();
    if (FULL_MODE && !tab) {
      setPageTitle('源标签页已关闭，无法读取页面', 'err');
      els.pageTitle.title = '全屏页绑定的标签页已关闭。对话仍可继续，但不会再带上页面内容。';
      return null;
    }
    if (FULL_MODE) document.title = 'Kiro · ' + (tab.title || tab.url || '页面问答');
    if (!tab || isRestrictedUrl(tab.url)) {
      setPageTitle('当前页面无法读取', 'err');
      els.pageTitle.title = tab ? tab.url : '';
      return null;
    }

    // PDF：改用 pdf.js 提取文字，而不是注入脚本读 DOM
    if (isPdfUrl(tab.url)) {
      return await capturePdf(tab);
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageContent, // 来自 extract.js
      args: [200000, { scroll: !!opts.full }], // 抓取全文（上限 20 万字），长页面由后端存成文件按需读取
    });
    const data = results && results[0] && results[0].result;
    if (!data) {
      setPageTitle('未能抓取内容', 'err');
      return null;
    }
    pageContext = data;
    const label = data.title || data.url || '（无标题）';
    setPageTitle(label, 'live');
    els.pageTitle.title =
      data.url +
      '\n正文约 ' + data.length + ' 字' +
      (data.truncated ? '（已截断）' : '') +
      (data.partial ? '\n飞书文档：目前只读了屏幕附近的内容，提问或预览时会自动滚动读取全文' : '');
    lastPageUrl = data.url || lastPageUrl;
    return data;
  } catch (e) {
    let msg = e.message || String(e);
    if (/Cannot access contents of|cannot be scripted|No tab with id/i.test(msg)) {
      msg =
        '无法读取该页面（可能是受限页面，或插件权限未生效）。' +
        '请在 chrome://extensions 重新加载本插件后重试；浏览器商店、设置页等页面无法读取。';
    }
    setPageTitle('抓取失败：' + msg, 'err');
    els.pageTitle.title = msg;
    return null;
  }
}

// ---------- 页面上下文 ----------
// 正文不超过这个字数时后端直接内联进 prompt；更长的页面保存成文件，由 Kiro 按需读取。
// 与 server/pages.js 的 INLINE_LIMIT 保持一致（这里只用于预览里的提示）。
const PAGE_INLINE_LIMIT = 30000;

/** 发给后端的页面数据；prompt 由后端组装（见 server/pages.js） */
function pagePayload(c) {
  return {
    title: c.title || '',
    url: c.url || '',
    description: c.description || '',
    selection: c.selection || '',
    text: c.text || '',
    truncated: !!c.truncated || !!c.partial, // 飞书文档没读全时也按截断处理
    isPdf: !!c.isPdf,
    pages: c.pages,
    parsedPages: c.parsedPages,
  };
}

/**
 * 发送一个 prompt 并把流式结果渲染进 answerEl。
 * 返回一个 Promise，在该轮结束后 resolve。
 * options.silent: 该轮为内部「喂数据」轮，出错时不切换成错误气泡（交由上层处理）。
 */
async function sendPrompt(prompt, answerEl, page, images) {
  if (images && images.length && backendFeatures && !backendFeatures.includes('image')) {
    throw new Error('本地后端还是旧版本，不支持图片。请在 server 目录运行 ./stop.sh && ./start.sh 重启后端后再试。');
  }
  const payload = { prompt };
  if (images && images.length) payload.images = images.map((im) => ({ mimeType: im.mimeType, data: im.data }));
  if (page) payload.page = page; // 首次涉及该页面：带上页面全文
  if (settings.model) payload.model = settings.model;
  if (settings.agent) payload.agent = settings.agent;
  // 会话与 agent 绑定：agent 变了（例如在别的标签页切换过）就不再续聊旧会话
  if (sessionId && convAgent !== (settings.agent || '')) {
    sessionId = null;
    injectedUrl = null;
  }
  if (!sessionId) convAgent = settings.agent || '';
  if (sessionId) payload.sessionId = sessionId; // 续聊：带上当前会话 id

  const doFetch = () =>
    fetch(settings.endpoint + '/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: currentController.signal,
    });

  let resp;
  try {
    resp = await doFetch();
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // 网络错误：后端可能没起来，尝试自动启动后重试一次
    backendOnline = false;
    if (!(await ensureBackend())) {
      throw new Error('无法连接后端 ' + settings.endpoint + '，请先启动本地服务');
    }
    resp = await doFetch();
  }

  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    if (/agent 不存在/.test(txt)) loadAgents(true); // agent 被删了：刷新下拉框
    throw new Error('请求失败 HTTP ' + resp.status + ' ' + txt);
  }

  await parseSSE(resp.body, answerEl);
}

// ---------- 发送与流式接收 ----------
/** 飞书文档只抓了屏幕附近的部分时，滚动读取全文；失败时保留已有的部分内容 */
async function ensureFullPage() {
  const c = pageContext;
  if (!els.useContext.checked || !c || !c.partial) return c;
  await capturePage({ full: true });
  if (!pageContext) pageContext = c;
  return pageContext;
}

async function ask(question, quote = null, images = null) {
  // 发送前确保已抓取页面（若开启上下文且尚未抓取）
  if (els.useContext.checked && !pageContext) {
    await capturePage();
  }

  const userEl = addMessage('user', question, null, null, {
    quote,
    images: images && images.length ? images.map((im) => ({ thumb: im.thumb, w: im.w, h: im.h })) : null,
  });
  if (images && images.length) rememberOriginals(userEl.parentElement.dataset.id, images);
  refreshMap();
  // 实际发给 Kiro 的内容：追问时带上被引用的那段文字（界面上只显示用户的问题）
  const promptText = quote ? quotedPrompt(question, quote) : question;
  const answerEl = addMessage('assistant', '');
  answerEl.classList.add('cursor');
  lastQuestion = question; // 记录用于「重新生成」

  setBusy(true);
  currentController = new AbortController();

  // 判断本轮是否需要带上页面全文
  let c = pageContext;
  const needInject =
    els.useContext.checked && c && !(injectedUrl && injectedUrl === c.url);

  // 发出请求前就显示状态行和计时，kiro-cli 启动和首个事件之间界面不会空白
  startLive(answerEl, needInject && c.partial ? '正在滚动读取飞书文档全文' : '等待 Kiro 响应');
  if (needInject && c.partial) {
    c = await ensureFullPage();
    setLive(answerEl, '等待 Kiro 响应');
  }

  try {
    if (!needInject) {
      // 不注入页面：直接发问题（含关闭上下文、或已注入过本页）
      await sendPrompt(promptText, answerEl, null, images);
    } else {
      // 首次涉及该页面：带上页面全文，后端决定内联还是存成文件按需读取
      await sendPrompt(promptText, answerEl, pagePayload(c), images);
      injectedUrl = c.url;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      appendAssistantChunk(answerEl, '\n\n_[已停止]_');
    } else {
      answerEl.classList.remove('cursor');
      answerEl.classList.remove('md');
      answerEl.parentElement.className = 'msg error';
      answerEl.parentElement.querySelector('.role').textContent = '错误';
      answerEl.textContent = e.message;
      checkHealth(false);
    }
  } finally {
    flushAnswer(answerEl);
    stopLive(answerEl);
    answerEl.classList.remove('cursor');
    setBusy(false);
    currentController = null;
    els.input.focus();
    // 为已完成的助手回答添加操作条（复制 / 重新生成）
    maybeAddAnswerActions(answerEl);
    // 追问原文高亮、关系图
    applyAnchors();
    refreshMap();
    // 持久化当前标签页的对话
    saveConversation();
  }
}

/** 为一条已完成的助手回答添加操作条（复制整条回答 / 重新生成） */
function maybeAddAnswerActions(answerEl) {
  const wrap = answerEl.parentElement;
  if (!wrap || !wrap.classList.contains('assistant')) return; // 错误气泡不加
  if (wrap.querySelector('.msg-actions')) return; // 已有则跳过
  const raw = (answerEl.dataset.raw || '').trim();
  if (!raw) return; // 空回答不加

  const bar = document.createElement('div');
  bar.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-action';
  copyBtn.innerHTML = actionIcon('copy') + '<span>复制</span>';
  copyBtn.title = '复制';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard
      .writeText(answerEl.dataset.raw || '')
      .then(() => flashAction(copyBtn, '已复制'))
      .catch(() => flashAction(copyBtn, '复制失败'));
  });

  const regenBtn = document.createElement('button');
  regenBtn.type = 'button';
  regenBtn.className = 'msg-action';
  regenBtn.innerHTML = actionIcon('regen') + '<span>重新生成</span>';
  regenBtn.title = '重新生成';
  regenBtn.addEventListener('click', () => {
    if (currentController) return;
    // 用这条回答对应的那次提问（含追问引用）重新生成
    const prev = wrap.previousElementSibling;
    const isUser = prev && prev.classList.contains('user');
    const q = isUser ? prev.querySelector('.body').textContent : lastQuestion;
    const quote = isUser ? prev._quote || null : null;
    const imgs = isUser ? imagesForResend(prev) : null;
    if (!q) return;
    // 删除这条助手回答，以及它前面对应的那条用户提问
    wrap.remove();
    if (isUser) prev.remove();
    // 在原位重新提问生成
    ask(q, quote, imgs);
  });

  bar.appendChild(copyBtn);
  bar.appendChild(regenBtn);
  wrap.appendChild(bar);
}

function flashAction(btn, text) {
  const span = btn.querySelector('span');
  if (!span) return;
  const old = span.textContent;
  span.textContent = text;
  btn.classList.add('done');
  setTimeout(() => {
    span.textContent = old;
    btn.classList.remove('done');
  }, 1400);
}

function actionIcon(kind) {
  if (kind === 'copy') {
    return (
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/>' +
      '<path d="M5 15V5a2 2 0 012-2h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    );
  }
  // regen
  return (
    '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M20 11a8 8 0 10-.5 4M20 5v6h-6" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  );
}

/** 解析 SSE 流（手写，因为 EventSource 不支持 POST）*/
async function parseSSE(stream, answerEl) {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 事件以空行(\n\n)分隔
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleSSEEvent(rawEvent, answerEl);
    }
  }
}

function handleSSEEvent(rawEvent, answerEl) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) continue; // 注释行
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return;

  let data;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }

  if (eventName === 'chunk' && typeof data.text === 'string') {
    markAnswering(answerEl);
    appendAssistantChunk(answerEl, data.text);
  } else if (eventName === 'thought' && typeof data.text === 'string') {
    appendThought(answerEl, data.text);
  } else if (eventName === 'tool' && data && data.id) {
    upsertTool(answerEl, data);
  } else if (eventName === 'page' && data.mode === 'file') {
    if (!(answerEl._act && answerEl._act.answered)) setLive(answerEl, '页面较长，Kiro 正在按需阅读');
  } else if (eventName === 'start' || eventName === 'status') {
    if (!(answerEl._act && answerEl._act.answered)) setLive(answerEl, '思考中');
  } else if (eventName === 'done') {
    // 回答已生成完；kiro-cli 退出还要几秒，状态行先结束，用时按这里算
    flushAnswer(answerEl);
    stopLive(answerEl);
  } else if (eventName === 'session' && typeof data.sessionId === 'string') {
    // 保存会话 id，用于后续续聊
    sessionId = data.sessionId;
  } else if (eventName === 'error') {
    // 抛出错误，交由上层 ask() 的 catch 统一渲染错误气泡
    const err = new Error(
      (data.message || '未知错误') + (data.stderr ? '\n' + data.stderr : '')
    );
    err.__fromStream = true;
    throw err;
  }
  // 'done' / 'start' / 'end' 事件无需额外处理
}

// ---------- 事件绑定 ----------
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  let text = els.input.value.trim();
  if (currentController || preparingImages) return;
  const images = pendingImages.slice();
  if (!text && !images.length) return;
  if (!text) text = images.length > 1 ? '请描述这些图片。' : '请描述这张图片。';
  els.input.value = '';
  autosize();
  const quote = pendingQuote;
  setQuote(null);
  clearPendingImages();
  ask(text, quote, images);
});

// 输入法（IME）组词状态：组词期间的回车只是确认候选词，不应触发发送
let isComposing = false;
els.input.addEventListener('compositionstart', () => {
  isComposing = true;
});
els.input.addEventListener('compositionend', () => {
  isComposing = false;
});

els.input.addEventListener('keydown', (e) => {
  // 正在用输入法组词时（或 keyCode 229，兼容部分输入法），回车不发送
  if (isComposing || e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
}
els.input.addEventListener('input', autosize);

els.stopBtn.addEventListener('click', () => {
  if (currentController) currentController.abort();
});

els.clearBtn.addEventListener('click', () => {
  startNewConversation();
});

/** 开启新会话：清空消息、丢弃会话 id 和注入记录 */
function startNewConversation() {
  els.messages.innerHTML = '';
  sessionId = null;
  injectedUrl = null;
  lastQuestion = null;
  convAgent = settings.agent || '';
  setQuote(null);
  origImages.clear();
  showEmptyHint();
  refreshMap();
  saveConversation(); // 同步清空该标签页的持久化对话
}

els.settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ---------- 展开为全屏页 / 浏览器全屏 ----------
const FULL_PAGE_URL = chrome.runtime.getURL('sidepanel.html');

/** 在新标签页中打开当前对话；该标签页已有全屏页时直接切过去 */
async function openFullPage() {
  if (currentController) return;
  const tab = await getActiveTab();
  if (!tab) return;
  await saveConversation(); // 先把当前对话写入，全屏页打开后直接读取
  const url = FULL_PAGE_URL + '?mode=full&tabId=' + tab.id;
  const all = await chrome.tabs.query({});
  const existing = all.find((t) => t.url === url);
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
}

function toggleBrowserFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

els.expandBtn.addEventListener('click', openFullPage);
els.fullscreenBtn.addEventListener('click', toggleBrowserFullscreen);
document.addEventListener('fullscreenchange', () => {
  const on = !!document.fullscreenElement;
  document.body.classList.toggle('is-fullscreen', on);
  els.fullscreenBtn.title = on ? '退出浏览器全屏（Esc）' : '浏览器全屏（F11 效果，Esc 退出）';
});

if (FULL_MODE) {
  document.body.classList.add('full');
  els.expandBtn.classList.add('hidden');
  els.fullscreenBtn.classList.remove('hidden');
  els.fullSrc.classList.remove('hidden');
  els.input.rows = 2;
}

els.status.addEventListener('click', () => {
  // 离线时点击 = 尝试启动；在线时点击 = 重新检测
  if (!backendOnline && isLocalEndpoint(settings.endpoint)) {
    checkHealth(false).then((ok) => ok || startBackend());
  } else {
    checkHealth(false);
  }
});

els.startBackendBtn.addEventListener('click', () => startBackend());

// 切换模型：写入同步设置（设置页也会同步显示），下一次提问生效
els.modelSelect.addEventListener('change', () => {
  settings.model = els.modelSelect.value;
  syncModelSelect();
  chrome.storage.sync.set({ model: settings.model }).catch(() => {});
});

// 切换 agent：会话与 agent 绑定，所以切换后开启新会话
els.agentSelect.addEventListener('change', () => {
  const next = els.agentSelect.value;
  const hasConversation = !!els.messages.querySelector('.msg');
  if (
    hasConversation &&
    !window.confirm('切换 Agent 会开启新会话，当前对话将被清空。继续吗？')
  ) {
    els.agentSelect.value = settings.agent || ''; // 取消：恢复原选择
    return;
  }
  settings.agent = next;
  syncAgentSelect();
  syncModelSelect();
  if (hasConversation) startNewConversation();
  chrome.storage.sync.set({ agent: next }).catch(() => {});
});

// 快捷问题按钮
els.quickActions.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (currentController) return;
    if (preparingImages) return;
    const quote = pendingQuote;
    const images = pendingImages.slice();
    setQuote(null);
    clearPendingImages();
    ask(btn.dataset.q, quote, images);
  });
});

// 重新抓取当前页面
els.refreshPageBtn.addEventListener('click', () => capturePage());

// 预览发给 Kiro 的页面内容
els.previewBtn.addEventListener('click', openPreview);
els.previewClose.addEventListener('click', closePreview);
els.previewModal.addEventListener('click', (e) => {
  if (e.target === els.previewModal) closePreview(); // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.previewModal.classList.contains('hidden')) {
    closePreview();
  }
});

// 预览显示方式：渲染后的 Markdown，或 Markdown 原文。记住上次的选择
let previewRaw = localStorage.getItem('previewRaw') === '1';

/** 渲染预览正文：选中文字 + 页面正文 */
function renderPreviewBody(c) {
  const body = els.previewBody;
  body.scrollTop = 0;
  if (previewRaw) {
    body.classList.remove('md');
    let t = '';
    if (c.selection) t += '【用户当前选中的文字】\n' + c.selection + '\n\n';
    t += '【页面正文 · Markdown' + (c.truncated ? '（已截断）' : '') + '】\n' + (c.text || '(空)');
    body.textContent = t;
    return;
  }
  body.classList.add('md');
  let html = '';
  if (c.selection) {
    html +=
      '<div class="pv-section">用户当前选中的文字</div>' +
      '<blockquote class="md-quote">' + escapeText(c.selection).replace(/\n/g, '<br/>') + '</blockquote>' +
      '<div class="pv-section">页面正文</div>';
  }
  html += c.text ? renderMarkdown(c.text) : '<p class="md-p">(空)</p>';
  body.innerHTML = html;
  // 页面里的相对链接（/路径、#锚点）按页面网址解析，否则会指向扩展自己
  body.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^(https?:|mailto:)/i.test(href)) return;
    try {
      a.setAttribute('href', new URL(href, c.url).href);
    } catch {
      a.removeAttribute('href');
    }
  });
  wireCopyButtons(body);
}

async function openPreview() {
  // 若开启上下文但还没抓取，先抓一次
  if (els.useContext.checked && !pageContext) {
    await capturePage();
  }
  await ensureFullPage();
  const c = pageContext;
  if (!els.useContext.checked) {
    els.previewMeta.innerHTML =
      '<span class="pv-tag pv-off">页面上下文已关闭</span>';
    els.previewBody.classList.remove('md');
    els.previewBody.textContent = '当前不会把页面内容发给 Kiro。打开「页面上下文」开关后可预览。';
  } else if (!c) {
    els.previewMeta.innerHTML = '<span class="pv-tag pv-off">未抓取到页面</span>';
    els.previewBody.classList.remove('md');
    els.previewBody.textContent = '当前页面无法读取或尚未抓取。';
  } else {
    const len = c.length || (c.text ? c.text.length : 0);
    const asFile = len > PAGE_INLINE_LIMIT;
    const already = injectedUrl && injectedUrl === c.url;

    const tags = [];
    if (c.isPdf) {
      tags.push(
        '<span class="pv-tag pv-chunk">PDF · ' +
          (c.pages || '?') +
          ' 页' +
          (c.parsedPages && c.parsedPages < c.pages
            ? '（已解析前 ' + c.parsedPages + ' 页）'
            : '') +
          '</span>'
      );
    }
    if (c.site === 'feishu') {
      tags.push(
        c.partial
          ? '<span class="pv-tag pv-warn">飞书文档 · 只读了屏幕附近的内容</span>'
          : '<span class="pv-tag pv-chunk">飞书文档 · 已滚动读取全文</span>'
      );
    }
    tags.push('<span class="pv-tag">约 ' + len + ' 字</span>');
    if (c.truncated) tags.push('<span class="pv-tag pv-warn">已截断</span>');
    tags.push(
      asFile
        ? '<span class="pv-tag pv-chunk">长页面 · 存成文件，Kiro 按需读取</span>'
        : '<span class="pv-tag">一次性注入</span>'
    );
    if (already) {
      tags.push('<span class="pv-tag pv-done">本会话已注入，追问只发问题</span>');
    }

    let meta =
      '<div class="pv-title">' + escapeText(c.title || '(无标题)') + '</div>' +
      '<div class="pv-url">' + escapeText(c.url || '') + '</div>' +
      '<div class="pv-tags">' + tags.join('') + '</div>' +
      '<div class="pv-view" role="group" aria-label="显示方式">' +
      '<button type="button" class="pv-view-btn" data-raw="0">渲染</button>' +
      '<button type="button" class="pv-view-btn" data-raw="1">原文</button>' +
      '</div>';
    els.previewMeta.innerHTML = meta;

    const syncViewBtns = () => {
      els.previewMeta.querySelectorAll('.pv-view-btn').forEach((b) => {
        const on = (b.dataset.raw === '1') === previewRaw;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    };
    els.previewMeta.querySelectorAll('.pv-view-btn').forEach((b) => {
      b.addEventListener('click', () => {
        const raw = b.dataset.raw === '1';
        if (raw === previewRaw) return;
        previewRaw = raw;
        localStorage.setItem('previewRaw', raw ? '1' : '0');
        syncViewBtns();
        renderPreviewBody(c);
      });
    });
    syncViewBtns();
    renderPreviewBody(c);
  }
  els.previewModal.classList.remove('hidden');
}

function closePreview() {
  els.previewModal.classList.add('hidden');
}

/** 纯文本转义（用于 innerHTML 的 meta 区） */
function escapeText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 切换上下文开关时，开启则抓取
els.useContext.addEventListener('change', () => {
  if (els.useContext.checked) {
    capturePage();
  } else {
    setPageTitle('已关闭页面上下文', '');
    els.pageTitle.title = '';
  }
});

// 切换标签页：保存旧标签页对话、恢复新标签页对话（含页面抓取）
// 全屏页固定绑定源标签页，不跟随切换
chrome.tabs.onActivated.addListener((info) => {
  if (FULL_MODE) return;
  switchToTab(info.tabId);
});
// 同一标签页内导航完成后，仅刷新页面抓取（不开新会话，对话保留）
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (
    info.status === 'complete' &&
    (tab.active || FULL_MODE) && // 全屏页打开时源标签页不在前台，也要刷新
    tabId === currentTabId &&
    els.useContext.checked &&
    !currentController
  ) {
    capturePage();
  }
});
// 标签页关闭：清除它的对话（实现「关页卡即清空」）
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(CONV_PREFIX + tabId).catch(() => {});
  if (FULL_MODE && tabId === BOUND_TAB_ID) {
    // 源标签页关了：对话留在本页内存里继续用，不再持久化，也不再带页面内容
    boundTabClosed = true;
    currentTabId = null;
    pageContext = null;
    setPageTitle('源标签页已关闭，无法读取页面', 'err');
    els.pageTitle.title = '对话仍可继续，但不会再带上页面内容；关闭本页后对话会丢失。';
  }
});

// ---------- 右键「追问」处理（网页上选中的文字） ----------
let lastHandledActionTs = 0;

/** 把一个 pendingAction 转成一次提问 */
function runPendingAction(action) {
  if (FULL_MODE) return; // 右键请求只由侧边栏处理，避免两边重复提问
  if (!action || !action.ts || action.ts === lastHandledActionTs) return;
  lastHandledActionTs = action.ts;
  const text = (action.text || '').trim();
  if (!text) return;
  if (action.type === 'followup' || action.type === 'explain') {
    // 网页上选中文字后右键「追问」：把这段文字放进引用条，等用户输入问题
    setQuote({ source: 'page', text: text.slice(0, 4000), url: action.url || '' });
  }
}

/** 读取并消费暂存的待处理请求 */
async function consumePendingAction() {
  if (FULL_MODE) return;
  try {
    const { pendingAction } = await chrome.storage.session.get('pendingAction');
    if (pendingAction) {
      runPendingAction(pendingAction);
      // 消费后清除，避免下次正常打开侧边栏时重复触发
      chrome.storage.session.remove('pendingAction').catch(() => {});
    }
  } catch (e) {
    // chrome.storage.session 不可用时静默忽略
  }
}

// ---------- 按标签页隔离的对话持久化 ----------

/** 把当前 DOM 里的对话序列化成可存储结构 */
function serializeConversation() {
  const msgs = [];
  els.messages.querySelectorAll('.msg').forEach((wrap) => {
    const body = wrap.querySelector('.body');
    if (!body) return;
    let role = 'assistant';
    if (wrap.classList.contains('user')) role = 'user';
    else if (wrap.classList.contains('error')) role = 'error';
    // 助手消息存原始 markdown，其它存纯文本
    const text =
      role === 'assistant' ? body.dataset.raw || '' : body.textContent || '';
    const m = { role, text, id: wrap.dataset.id };
    if (wrap._quote) m.quote = wrap._quote;
    if (wrap._images) m.images = wrap._images;
    if (body._act) {
      const steps = stepsForStorage(body);
      if (steps.length) m.steps = steps;
      if (body._act.meta) m.meta = body._act.meta;
    }
    msgs.push(m);
  });
  return { msgs, sessionId, injectedUrl, lastQuestion, lastPageUrl, convAgent };
}

/** 把结构化对话渲染回 DOM */
function renderConversation(state) {
  els.messages.innerHTML = '';
  const msgs = (state && state.msgs) || [];
  if (msgs.length === 0) {
    showEmptyHint();
  } else {
    for (const m of msgs) {
      const body = addMessage(m.role, m.text, m.steps, m.meta, { id: m.id, quote: m.quote, images: m.images });
      // 为已完成的助手回答补上操作条
      if (m.role === 'assistant' && (m.text || '').trim()) {
        maybeAddAnswerActions(body);
      }
    }
  }
  sessionId = (state && state.sessionId) || null;
  injectedUrl = (state && state.injectedUrl) || null;
  lastQuestion = (state && state.lastQuestion) || null;
  lastPageUrl = (state && state.lastPageUrl) || null;
  // 旧版本保存的对话没有 convAgent，视为用当前 agent 开启
  convAgent = state && typeof state.convAgent === 'string' ? state.convAgent : settings.agent || '';
  applyAnchors();
  refreshMap();
}

/** 保存当前标签页的对话 */
async function saveConversation() {
  if (currentTabId == null) return;
  try {
    const state = serializeConversation();
    lastSyncedConv = JSON.stringify(state);
    await chrome.storage.session.set({
      [CONV_PREFIX + currentTabId]: state,
    });
  } catch (e) {
    /* storage.session 不可用时忽略 */
  }
}

/**
 * 侧边栏与全屏页同步：另一边保存了同一标签页的对话时，在本页重新渲染。
 * 正在生成时不覆盖，等本轮结束后由本页自己保存。
 */
function onConversationChanged(newValue) {
  if (currentController || restoring) return;
  if (!newValue) return; // 被删除（标签页关闭）时由 onRemoved 处理
  const json = JSON.stringify(newValue);
  if (json === lastSyncedConv) return; // 自己刚写入的
  lastSyncedConv = json;
  const keepScroll = !isNearBottom();
  const top = els.messages.scrollTop;
  restoring = true;
  renderConversation(newValue);
  restoring = false;
  if (keepScroll) els.messages.scrollTop = top; // 用户在看历史时不跳到底部
}

/** 读取某标签页的对话（无则返回 null） */
async function loadConversation(tabId) {
  try {
    const key = CONV_PREFIX + tabId;
    const got = await chrome.storage.session.get(key);
    return got[key] || null;
  } catch (e) {
    return null;
  }
}

/**
 * 切换到某个标签页：先存旧标签页的对话，再恢复新标签页的对话。
 * 正在生成时不切换，避免打断流式输出。
 */
async function switchToTab(tabId) {
  if (tabId == null || tabId === currentTabId) return;
  if (currentController) return; // 生成中，暂不切换
  // 保存当前标签页
  await saveConversation();
  currentTabId = tabId;
  // 恢复目标标签页
  restoring = true;
  const state = await loadConversation(tabId);
  lastSyncedConv = state ? JSON.stringify(state) : null;
  renderConversation(state);
  restoring = false;
  // 抓取新标签页的页面内容（供上下文使用）
  if (els.useContext.checked) capturePage();
}

// ---------- 图片：粘贴、拖放、选择文件、截取网页 ----------
const MAX_IMAGES = 4; // 一次最多几张（与 server.js 一致）
const MAX_EDGE = 2048; // 发给 Kiro 的图片长边上限
const THUMB_EDGE = 320; // 保存在对话记录里的缩略图长边
const MAX_SEND_BYTES = 4 << 20; // 单张压缩后的上限（与 server.js 一致）
const ACCEPT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

let pendingImages = []; // [{ id, mimeType, data, url, thumb, w, h }]
let preparingImages = 0; // 正在压缩的张数，压缩完才能发送
const origImages = new Map(); // 消息 id → 原图（只在本页内存里，用于看大图和重新生成）

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** 把图片缩到长边 edge 以内，返回 Blob。transparentToWhite：转 JPEG 时透明处填白 */
async function drawScaled(bitmap, edge, type, quality) {
  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { blob: await canvas.convertToBlob({ type, quality }), w, h };
}

/**
 * 压缩一张图：截图类（PNG）保持 PNG，文字更清楚；PNG 太大或照片（JPEG / WebP）转成 JPEG。
 * GIF 只取第一帧。
 */
async function prepareImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    let out;
    if (blob.type === 'image/png' || blob.type === 'image/gif') {
      out = await drawScaled(bitmap, MAX_EDGE, 'image/png');
      if (out.blob.size > 1.5 * 1024 * 1024) out = await drawScaled(bitmap, MAX_EDGE, 'image/jpeg', 0.88);
    } else {
      out = await drawScaled(bitmap, MAX_EDGE, 'image/jpeg', 0.85);
    }
    if (out.blob.size > MAX_SEND_BYTES) out = await drawScaled(bitmap, 1600, 'image/jpeg', 0.8);
    if (out.blob.size > MAX_SEND_BYTES) throw new Error('图片太大，压缩后仍超过 4MB');
    const url = await blobToDataUrl(out.blob);
    const thumb = await blobToDataUrl((await drawScaled(bitmap, THUMB_EDGE, 'image/jpeg', 0.8)).blob);
    return { id: newMsgId(), mimeType: out.blob.type, data: url.slice(url.indexOf(',') + 1), url, thumb, w: out.w, h: out.h };
  } finally {
    bitmap.close();
  }
}

/** 输入框上方的短提示（几秒后消失） */
let noteTimer = 0;
function showComposerNote(text) {
  els.composerNote.textContent = text;
  els.composerNote.classList.remove('hidden');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => els.composerNote.classList.add('hidden'), 3500);
}

async function addImageBlobs(blobs) {
  const list = blobs.filter((b) => b && ACCEPT_TYPES.includes(b.type));
  if (!list.length) {
    if (blobs.length) showComposerNote('只支持 PNG、JPEG、WebP、GIF 图片');
    return;
  }
  const room = MAX_IMAGES - pendingImages.length - preparingImages;
  if (room <= 0) {
    showComposerNote('一次最多 ' + MAX_IMAGES + ' 张图片');
    return;
  }
  if (list.length > room) showComposerNote('一次最多 ' + MAX_IMAGES + ' 张图片，多出的已忽略');
  const take = list.slice(0, room);
  preparingImages += take.length;
  renderAttachBar();
  for (const b of take) {
    try {
      pendingImages.push(await prepareImage(b));
    } catch (e) {
      showComposerNote('图片处理失败：' + (e.message || e));
    } finally {
      preparingImages--;
      renderAttachBar();
    }
  }
  els.input.focus();
}

function renderAttachBar() {
  const bar = els.attachBar;
  bar.innerHTML = '';
  pendingImages.forEach((im) => {
    const item = document.createElement('div');
    item.className = 'attach-item';
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'attach-thumb';
    view.title = '查看大图';
    const img = document.createElement('img');
    img.src = im.thumb;
    img.alt = '待发送的图片';
    view.appendChild(img);
    view.addEventListener('click', () => openImageViewer(im.url));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'attach-del';
    del.title = '移除';
    del.setAttribute('aria-label', '移除这张图片');
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    del.addEventListener('click', () => {
      pendingImages = pendingImages.filter((x) => x !== im);
      renderAttachBar();
      els.input.focus();
    });
    item.append(view, del);
    bar.appendChild(item);
  });
  for (let i = 0; i < preparingImages; i++) {
    const ph = document.createElement('div');
    ph.className = 'attach-item attach-loading';
    ph.innerHTML = '<span class="live-spin" aria-hidden="true"></span>';
    bar.appendChild(ph);
  }
  bar.classList.toggle('hidden', !pendingImages.length && !preparingImages);
}

function clearPendingImages() {
  pendingImages = [];
  renderAttachBar();
}

/** 发送后记下原图，看大图、重新生成时用 */
function rememberOriginals(msgId, images) {
  origImages.set(msgId, images.map((im) => ({ mimeType: im.mimeType, data: im.data, url: im.url })));
}

/** 重新生成时要重发的图片：本页内存里有原图就用原图，否则用对话记录里的缩略图 */
function imagesForResend(userWrap) {
  const thumbs = userWrap._images;
  if (!thumbs || !thumbs.length) return null;
  const orig = origImages.get(userWrap.dataset.id);
  return thumbs.map((t, i) => {
    if (orig && orig[i]) return { ...orig[i], thumb: t.thumb, w: t.w, h: t.h };
    const url = t.thumb;
    return { mimeType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url, thumb: url, w: t.w, h: t.h };
  });
}

// 粘贴：剪贴板里有图片就加进来；同时有文字时文字照常粘贴
els.input.addEventListener('paste', (e) => {
  const items = [...((e.clipboardData && e.clipboardData.items) || [])];
  const files = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile());
  if (!files.length) return;
  const hasText = items.some((it) => it.kind === 'string' && it.type === 'text/plain');
  if (!hasText) e.preventDefault();
  addImageBlobs(files);
});

// 拖放：本地图片文件，或从网页里拖过来的图片（只有地址，需要下载）
function hasDraggedFiles(e) {
  const types = [...((e.dataTransfer && e.dataTransfer.types) || [])];
  return types.includes('Files') || types.includes('text/uri-list');
}
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!hasDraggedFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dropping');
});
document.addEventListener('dragover', (e) => {
  if (hasDraggedFiles(e)) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  if (!hasDraggedFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (currentController) return;
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) {
    addImageBlobs(files);
    return;
  }
  const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => /^https?:/i.test(l.trim()));
  if (!url) return;
  try {
    const r = await fetch(url.trim());
    const blob = await r.blob();
    if (!blob.type.startsWith('image/')) throw new Error('拖进来的不是图片');
    addImageBlobs([blob]);
  } catch (err) {
    showComposerNote('无法读取这张图片：' + (err.message || err));
  }
});

els.attachBtn.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  addImageBlobs([...els.fileInput.files]);
  els.fileInput.value = '';
});

// 截取当前网页可见区域。全屏页里源标签页不在前台，截不到，隐藏按钮
if (FULL_MODE) els.shotBtn.classList.add('hidden');
els.shotBtn.addEventListener('click', async () => {
  try {
    const tab = await getActiveTab();
    if (!tab || isRestrictedUrl(tab.url)) {
      showComposerNote('当前页面无法截图');
      return;
    }
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const blob = await (await fetch(url)).blob();
    addImageBlobs([blob]);
  } catch (e) {
    showComposerNote('截图失败：' + (e.message || e));
  }
});

// 大图查看：点任意位置或按 Esc 关闭
function openImageViewer(src) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = '图片大图';
  els.imgViewer.replaceChildren(img);
  els.imgViewer.classList.remove('hidden');
}
function closeImageViewer() {
  els.imgViewer.classList.add('hidden');
  els.imgViewer.replaceChildren();
}
els.imgViewer.addEventListener('click', closeImageViewer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.imgViewer.classList.contains('hidden')) closeImageViewer();
});

// ---------- 追问：选中回答里的文字后追问 ----------
let msgSeq = 0;
function newMsgId() {
  return 'm' + Date.now().toString(36) + (msgSeq++).toString(36);
}

/** 当前引用条里的内容（发送时随问题一起带上） */
let pendingQuote = null;
const QUOTE_PROMPT_MAX = 4000; // 发给 Kiro 的引用最长字数

/** 追问时实际发给 Kiro 的文字：引用 + 问题 */
function quotedPrompt(question, quote) {
  const text = quote.text.length > QUOTE_PROMPT_MAX ? quote.text.slice(0, QUOTE_PROMPT_MAX) + '…' : quote.text;
  const block = text
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
  const lead = quote.source === 'page' ? '关于我在页面里选中的这段内容：' : '针对你前面回答中的这段内容追问：';
  return lead + '\n\n' + block + '\n\n我的问题：' + question;
}

/** 设置 / 清除引用条 */
function setQuote(quote) {
  pendingQuote = quote;
  els.quoteBar.classList.toggle('hidden', !quote);
  if (!quote) {
    refreshMap();
    return;
  }
  els.quoteLabel.textContent = quote.source === 'page' ? '引用网页' : '追问';
  els.quoteText.textContent = quote.text.replace(/\s+/g, ' ');
  els.quoteText.title = quote.text;
  els.input.focus();
  refreshMap();
}
els.quoteClear.addEventListener('click', () => {
  setQuote(null);
  els.input.focus();
});
els.input.addEventListener('keydown', (e) => {
  // 输入框为空时按 Esc / 退格清掉引用
  if (pendingQuote && !els.input.value && (e.key === 'Escape' || e.key === 'Backspace')) {
    setQuote(null);
  }
});

/** 选区落在哪条回答的正文里；不在同一条回答内返回 null */
function selectionInAnswer() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const endEl = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
  const body = startEl && startEl.closest('.msg.assistant .body');
  if (!body || !endEl || endEl.closest('.msg.assistant .body') !== body) return null;
  const text = sel.toString().trim();
  if (text.length < 2) return null;
  // 在正文文本里的位置（按文本节点拼接计算），恢复对话后用来重新高亮
  const pre = document.createRange();
  pre.setStart(body, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  return { body, range, text, start, end, msgId: body.parentElement.dataset.id };
}

let selInfo = null;
function hideSelAsk() {
  selInfo = null;
  els.selAsk.classList.add('hidden');
}
function updateSelAsk() {
  const info = selectionInAnswer();
  if (!info || currentController) {
    hideSelAsk();
    return;
  }
  selInfo = info;
  const r = info.range.getBoundingClientRect();
  const box = els.chatBody.getBoundingClientRect();
  const btn = els.selAsk;
  btn.classList.remove('hidden');
  const w = btn.offsetWidth;
  const h = btn.offsetHeight;
  // 放在选区上方居中；上方放不下就放下方
  let left = r.left + r.width / 2 - w / 2 - box.left;
  left = Math.max(6, Math.min(left, box.width - w - 6));
  let top = r.top - box.top - h - 8;
  if (top < 4) top = r.bottom - box.top + 8;
  btn.style.left = left + 'px';
  btn.style.top = top + 'px';
}
els.messages.addEventListener('mouseup', () => setTimeout(updateSelAsk, 0));
els.messages.addEventListener('keyup', (e) => {
  if (e.shiftKey || e.key === 'Shift') updateSelAsk();
});
els.messages.addEventListener('scroll', hideSelAsk, { passive: true });
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) hideSelAsk();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideSelAsk();
});
// 按下按钮时不要让选区消失
els.selAsk.addEventListener('mousedown', (e) => e.preventDefault());
els.selAsk.addEventListener('click', () => {
  if (!selInfo) return;
  startFollowUp(selInfo);
});

/** 开始一次追问：把选中的文字放进引用条，并打开关系图 */
function startFollowUp(info) {
  setQuote({
    source: 'answer',
    msgId: info.msgId,
    text: info.text.slice(0, QUOTE_PROMPT_MAX),
    start: info.start,
    end: info.end,
  });
  hideSelAsk();
  window.getSelection().removeAllRanges();
  setMapOpen(true);
}

// 侧边栏 / 全屏页里右键「追问」：由 background 转发过来，这里用当前选区
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'kiro-followup-selection') return;
  if (!document.hasFocus()) return; // 侧边栏和全屏页都会收到，只由有焦点的那个处理
  const info = selectionInAnswer();
  if (info) startFollowUp(info);
  else if (msg.text) setQuote({ source: 'answer', text: String(msg.text).slice(0, QUOTE_PROMPT_MAX) });
});

// ---------- 被追问的原文高亮 ----------
/** 正文里所有文本节点及其起始位置 */
function textNodesOf(body) {
  const list = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let n;
  while ((n = walker.nextNode())) {
    list.push({ node: n, start: pos });
    pos += n.nodeValue.length;
  }
  return { list, length: pos };
}

/** 把 [start, end) 范围内的文字逐个文本节点包进 <mark> */
function wrapRange(body, start, end, toId) {
  const { list } = textNodesOf(body);
  let first = null;
  for (const { node, start: ns } of list) {
    const ne = ns + node.nodeValue.length;
    if (ne <= start || ns >= end) continue;
    if (node.parentElement.closest('.md-code-head')) continue; // 代码块的「复制」按钮
    const a = Math.max(start, ns) - ns;
    const b = Math.min(end, ne) - ns;
    if (b <= a || !node.nodeValue.slice(a, b).trim()) continue;
    let target = node;
    if (a > 0) target = target.splitText(a);
    if (b - a < target.nodeValue.length) target.splitText(b - a);
    const mark = document.createElement('mark');
    mark.className = 'quote-anchor';
    mark.dataset.to = toId;
    mark.title = '查看对这段的追问';
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    if (!first) first = mark;
  }
  return first;
}

/** 找不到记录的位置时按文字查找（只用第一行，跨段落的选区文字和正文拼接后不一样） */
function findQuote(body, text) {
  const { list } = textNodesOf(body);
  const full = list.map((x) => x.node.nodeValue).join('');
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] || '';
  if (!line) return null;
  const i = full.indexOf(line);
  return i < 0 ? null : { start: i, end: i + line.length };
}

/** 给所有被追问过的回答加高亮（幂等：先清掉旧的再加） */
function applyAnchors() {
  els.messages.querySelectorAll('mark.quote-anchor').forEach((m) => {
    const parent = m.parentNode;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
    parent.normalize();
  });
  els.messages.querySelectorAll('.msg.user').forEach((u) => {
    const q = u._quote;
    if (!q || q.source === 'page' || !q.msgId) return;
    const wrap = els.messages.querySelector('.msg.assistant[data-id="' + CSS.escape(q.msgId) + '"]');
    const body = wrap && wrap.querySelector('.body');
    if (!body) return;
    let pos = null;
    if (Number.isInteger(q.start) && Number.isInteger(q.end) && q.end > q.start) {
      const { list } = textNodesOf(body);
      const full = list.map((x) => x.node.nodeValue).join('');
      const slice = full.slice(q.start, q.end).replace(/\s+/g, '');
      const want = q.text.replace(/\s+/g, '');
      if (slice && (want.startsWith(slice.slice(0, 20)) || slice.startsWith(want.slice(0, 20)))) pos = q;
    }
    if (!pos) pos = findQuote(body, q.text);
    if (pos) wrapRange(body, pos.start, pos.end, u.dataset.id);
  });
}

// 点高亮的原文：跳到对应的追问
els.messages.addEventListener('click', (e) => {
  const mark = e.target.closest && e.target.closest('mark.quote-anchor');
  if (!mark) return;
  if (!window.getSelection().isCollapsed) return; // 正在选字
  scrollToMsg(mark.dataset.to);
  if (mapOpen) {
    currentLockUntil = Date.now() + 1200;
    currentTurnId = null;
    setCurrentTurn(mark.dataset.to);
  }
});

/** 滚动到某条消息并闪一下 */
function scrollToMsg(id) {
  const el = els.messages.querySelector('.msg[data-id="' + CSS.escape(id) + '"]');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/** 从追问跳回被引用的原文 */
function jumpToAnchor(answerId, followId) {
  const mark = els.messages.querySelector('mark.quote-anchor[data-to="' + CSS.escape(followId) + '"]');
  if (mark) {
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.remove('flash');
    void mark.offsetWidth;
    mark.classList.add('flash');
  } else {
    scrollToMsg(answerId);
  }
}

// ---------- 追问关系图 ----------
const collapsedTurns = new Set(); // 折叠起来的节点（本页内存，不持久化）
let mapOpen = FULL_MODE && localStorage.getItem('mapOpen') === '1';
let currentTurnId = null;
let currentLockUntil = 0; // 点了节点后短时间内不按滚动位置改写高亮
let mapRaf = 0;

function setMapOpen(open) {
  mapOpen = !!open;
  document.body.classList.toggle('map-open', mapOpen);
  els.mapBtn.setAttribute('aria-pressed', mapOpen ? 'true' : 'false');
  els.mapBtn.classList.toggle('active', mapOpen);
  if (FULL_MODE) localStorage.setItem('mapOpen', mapOpen ? '1' : '0');
  if (mapOpen) refreshMap();
}
els.mapBtn.addEventListener('click', () => setMapOpen(!mapOpen));
els.mapClose.addEventListener('click', () => setMapOpen(false));
setMapOpen(mapOpen);

/**
 * 从对话里整理出「轮次」：一次提问 + 它的回答。
 * 引用了某条回答的追问挂在那条回答所在的轮次下面，其它的作为主线。
 */
function buildTurns() {
  const turns = [];
  const byAnswer = new Map();
  let cur = null;
  els.messages.querySelectorAll('.msg').forEach((wrap) => {
    if (wrap.classList.contains('user')) {
      cur = {
        id: wrap.dataset.id,
        q: wrap.querySelector('.body').textContent,
        quote: wrap._quote || null,
        images: wrap._images ? wrap._images.length : 0,
        answerId: null,
        error: false,
        children: [],
      };
      turns.push(cur);
    } else if (cur && !cur.answerId) {
      cur.answerId = wrap.dataset.id;
      cur.error = wrap.classList.contains('error');
      byAnswer.set(wrap.dataset.id, cur);
    }
  });
  const roots = [];
  for (const t of turns) {
    const parent = t.quote && t.quote.msgId ? byAnswer.get(t.quote.msgId) : null;
    if (parent && parent !== t) parent.children.push(t);
    else roots.push(t);
  }
  return { roots, byAnswer };
}

function countDesc(t) {
  return t.children.reduce((n, c) => n + 1 + countDesc(c), 0);
}

function refreshMap() {
  if (!mapOpen) return;
  if (mapRaf) return;
  mapRaf = requestAnimationFrame(() => {
    mapRaf = 0;
    renderMap();
  });
}

function renderMap() {
  const { roots, byAnswer } = buildTurns();
  const tree = els.tmTree;
  tree.innerHTML = '';
  if (!roots.length && !pendingQuote) {
    tree.innerHTML =
      '<p class="tm-empty">还没有提问。选中回答里的一段文字，点「追问」，追问关系会显示在这里。</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'tm-list';
  for (const t of roots) ul.appendChild(renderTurn(t));
  // 正在准备的追问：在被引用的回答下面显示一个虚线节点
  if (pendingQuote && pendingQuote.source === 'answer' && pendingQuote.msgId && byAnswer.get(pendingQuote.msgId)) {
    const parentLi = ul.querySelector('li[data-turn="' + CSS.escape(byAnswer.get(pendingQuote.msgId).id) + '"]');
    if (parentLi) {
      let sub = parentLi.querySelector(':scope > ul');
      if (!sub) {
        sub = document.createElement('ul');
        sub.className = 'tm-list';
        parentLi.appendChild(sub);
      }
      sub.hidden = false;
      sub.appendChild(pendingNode(pendingQuote));
    }
  } else if (pendingQuote) {
    ul.appendChild(pendingNode(pendingQuote));
  }
  tree.appendChild(ul);
  if (Date.now() < currentLockUntil && currentTurnId) setCurrentTurn(currentTurnId);
  else markCurrentTurn(true);
}

function pendingNode(q) {
  const li = document.createElement('li');
  li.className = 'tm-item tm-pending';
  li.innerHTML = '<div class="tm-node"><span class="tm-quote"></span><span class="tm-q">输入问题后发送…</span></div>';
  li.querySelector('.tm-quote').textContent = q.text.replace(/\s+/g, ' ');
  return li;
}

function renderTurn(t) {
  const li = document.createElement('li');
  li.className = 'tm-item';
  li.dataset.turn = t.id;
  li.setAttribute('role', 'treeitem');
  const row = document.createElement('div');
  row.className = 'tm-row';

  const hasKids = t.children.length > 0;
  const collapsed = hasKids && collapsedTurns.has(t.id);
  if (hasKids) {
    li.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const tog = document.createElement('button');
    tog.type = 'button';
    tog.className = 'tm-toggle';
    tog.title = collapsed ? '展开追问' : '折叠追问';
    tog.setAttribute('aria-label', tog.title);
    tog.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    tog.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsedTurns.has(t.id)) collapsedTurns.delete(t.id);
      else collapsedTurns.add(t.id);
      renderMap();
    });
    row.appendChild(tog);
  } else {
    const dot = document.createElement('span');
    dot.className = 'tm-dot';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);
  }

  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'tm-node' + (t.error ? ' tm-error' : '') + (!t.answerId ? ' tm-waiting' : '');
  if (t.quote) {
    const qq = document.createElement('span');
    qq.className = 'tm-quote' + (t.quote.source === 'page' ? ' tm-quote-page' : '');
    qq.textContent = t.quote.text.replace(/\s+/g, ' ');
    node.appendChild(qq);
  }
  const qt = document.createElement('span');
  qt.className = 'tm-q';
  if (t.images) {
    const ic = document.createElement('span');
    ic.className = 'tm-img';
    ic.title = t.images + ' 张图片';
    ic.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M4 17l4.5-4.5 3.5 3.5 3-3 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    qt.appendChild(ic);
  }
  qt.appendChild(document.createTextNode(t.q));
  node.appendChild(qt);
  if (collapsed) {
    const more = document.createElement('span');
    more.className = 'tm-more';
    more.textContent = countDesc(t) + ' 条追问已折叠';
    node.appendChild(more);
  }
  node.title = t.q;
  node.addEventListener('click', () => {
    scrollToMsg(t.id);
    // 点哪个节点就高亮哪个；平滑滚动期间不按滚动位置改写
    currentLockUntil = Date.now() + 1200;
    currentTurnId = null;
    setCurrentTurn(t.id);
    if (!FULL_MODE && window.innerWidth < 560) setMapOpen(false); // 窄侧边栏里跳转后收起抽屉，免得挡住内容
  });
  row.appendChild(node);
  li.appendChild(row);

  if (hasKids) {
    const sub = document.createElement('ul');
    sub.className = 'tm-list';
    sub.setAttribute('role', 'group');
    sub.hidden = collapsed;
    for (const c of t.children) sub.appendChild(renderTurn(c));
    li.appendChild(sub);
  }
  return li;
}

/**
 * 关系图里高亮当前正在看的那一轮：取对话区顶部附近第一条可见的消息。
 * 已经滚到底时，取视口里最后一次提问（最后几轮可能一起出现在屏幕上，顶部那条不代表正在看的）。
 */
function markCurrentTurn(force) {
  if (!mapOpen) return;
  if (!force && Date.now() < currentLockUntil) return;
  const box = els.messages.getBoundingClientRect();
  let turnId = null;
  let lastUser = null;
  const all = els.messages.querySelectorAll('.msg');
  if (isNearBottom() && els.messages.scrollTop > 0) {
    for (const wrap of all) {
      if (!wrap.classList.contains('user')) continue;
      const r = wrap.getBoundingClientRect();
      if (r.top >= box.top && r.top < box.bottom - 40) turnId = wrap.dataset.id;
    }
  }
  if (!turnId) {
    for (const wrap of all) {
      if (wrap.classList.contains('user')) lastUser = wrap.dataset.id;
      const r = wrap.getBoundingClientRect();
      if (r.bottom > box.top + 40) {
        turnId = wrap.classList.contains('user') ? wrap.dataset.id : lastUser;
        break;
      }
    }
  }
  if (!force && turnId === currentTurnId) return;
  setCurrentTurn(turnId);
}

function setCurrentTurn(turnId) {
  if (Date.now() < currentLockUntil && turnId !== currentTurnId && currentTurnId) return;
  currentTurnId = turnId;
  els.tmTree.querySelectorAll('.tm-item.current').forEach((li) => li.classList.remove('current'));
  if (!turnId) return;
  let li = els.tmTree.querySelector('li[data-turn="' + CSS.escape(turnId) + '"]');
  if (!li) return;
  // 当前轮次在折叠的分支里：高亮折叠起来的那个祖先
  for (let p = li.parentElement; p && p !== els.tmTree; p = p.parentElement) {
    if (p.tagName === 'UL' && p.hidden) li = p.closest('li');
  }
  li.classList.add('current');
  const row = li.querySelector('.tm-row');
  const tr = row.getBoundingClientRect();
  const mr = els.tmTree.getBoundingClientRect();
  if (tr.top < mr.top || tr.bottom > mr.bottom) row.scrollIntoView({ block: 'nearest' });
}
let curRaf = 0;
els.messages.addEventListener(
  'scroll',
  () => {
    if (!mapOpen || curRaf) return;
    curRaf = requestAnimationFrame(() => {
      curRaf = 0;
      markCurrentTurn(false);
    });
  },
  { passive: true }
);

// ---------- 初始化 ----------
(async function init() {
  await loadSettings();
  syncModelSelect(); // 后端未就绪前先显示已保存的模型
  syncAgentSelect();
  // 绑定到当前激活标签页（全屏页则绑定源标签页），并恢复它的对话
  const tab = await getActiveTab();
  currentTabId = tab ? tab.id : null;
  if (FULL_MODE && !tab) {
    boundTabClosed = true; // 打开时源标签页就已经不存在了
  }
  const saved = currentTabId != null ? await loadConversation(currentTabId) : null;
  if (saved) lastSyncedConv = JSON.stringify(saved);
  if (saved && saved.msgs && saved.msgs.length) {
    restoring = true;
    renderConversation(saved);
    restoring = false;
  } else {
    showEmptyHint();
  }
  checkHealth();
  await capturePage();
  consumePendingAction(); // 若侧边栏由右键菜单打开，这里会接到选中文字
  els.input.focus();
})();

// 设置变更时实时生效 + 监听右键请求（侧边栏已打开的情况）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    const keys = Object.keys(changes);
    const onlyModel = keys.every((k) => k === 'model' || k === 'agent');
    if (onlyModel) {
      // 仅模型/agent 变化：更新本地状态即可，不必重新检测后端
      loadSettings().then(() => {
        syncAgentSelect();
        syncModelSelect();
      });
    } else {
      modelsLoaded = false; // 后端地址可能变了，重新拉模型列表
      agentsLoaded = false;
      loadSettings().then(() => checkHealth());
    }
  } else if (area === 'local' && changes.agentsRev) {
    // 设置页增删改了 agent：重新拉取列表
    loadAgents(true);
  } else if (area === 'session' && changes.pendingAction) {
    const action = changes.pendingAction.newValue;
    if (action) runPendingAction(action);
  }
  if (area === 'session' && currentTabId != null) {
    const ch = changes[CONV_PREFIX + currentTabId];
    if (ch) onConversationChanged(ch.newValue);
  }
});
