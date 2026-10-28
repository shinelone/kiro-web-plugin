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
};

let settings = { endpoint: DEFAULT_ENDPOINT, model: '', agent: '' };
let currentController = null; // 用于中止请求
let pageContext = null; // 当前页面抓取结果

// ---------- 多轮会话状态 ----------
let sessionId = null; // 当前会话 id（内存存储，关闭侧边栏即重置）
let injectedUrl = null; // 已把哪个页面的全文注入过会话（避免每轮重复塞全文）
let lastPageUrl = null; // 上一次抓取到的页面 url（用于检测换页）
let lastQuestion = null; // 最近一次用户提问（用于「重新生成」）

// ---------- 设置读取 ----------
async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(['endpoint', 'model', 'agent']);
    settings.endpoint = (stored.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    settings.model = stored.model || '';
    settings.agent = stored.agent || '';
  } catch {
    settings.endpoint = DEFAULT_ENDPOINT;
  }
}

// ---------- 健康检查 ----------
async function checkHealth() {
  els.status.className = 'status-chip';
  els.statusText.textContent = '检测中';
  els.status.title = '正在检测后端…';
  try {
    const r = await fetch(settings.endpoint + '/health', { method: 'GET' });
    if (r.ok) {
      const j = await r.json();
      els.status.className = 'status-chip ok';
      els.statusText.textContent = '在线';
      els.status.title = '后端在线: ' + (j.kiroBin || '') + '（点击重新检测）';
    } else {
      throw new Error('HTTP ' + r.status);
    }
  } catch (e) {
    els.status.className = 'status-chip bad';
    els.statusText.textContent = '离线';
    els.status.title = '后端离线，请先启动本地服务 (' + settings.endpoint + ')';
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
    d.innerHTML =
      '<span class="eh-mark" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5 3.5v17M5 12l8.5-8.5M5 12l9 8.5" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
      '<div class="eh-title">针对当前网页提问</div>' +
      '<div class="eh-text">点上方快捷按钮，或直接输入问题，' +
      '回答会逐字流式返回。支持连续追问（有上下文记忆），' +
      '点右上角清空按钮可开启新会话。<br/>状态为「离线」时，请先在终端启动后端：' +
      '<br/><code>node server/server.js</code></div>';
    els.messages.appendChild(d);
  }
}

function addMessage(role, text = '') {
  clearEmptyHint();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? '你' : role === 'assistant' ? 'Kiro' : '错误';
  const body = document.createElement('div');
  body.className = 'body';
  if (role === 'assistant') {
    body.classList.add('md'); // Markdown 渲染容器
    body.dataset.raw = text || ''; // 累积的原始 markdown
    if (text) body.innerHTML = renderMarkdown(text);
  } else {
    body.textContent = text; // 用户/错误消息保持纯文本
  }
  wrap.appendChild(roleEl);
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  // 新增消息（发送/收到新气泡）时强制滚到底部并恢复跟随
  forceScrollBottom();
  return body;
}

/** 向助手消息追加流式文本并重新渲染 Markdown */
function appendAssistantChunk(bodyEl, chunk) {
  bodyEl.dataset.raw = (bodyEl.dataset.raw || '') + chunk;
  bodyEl.innerHTML = renderMarkdown(bodyEl.dataset.raw);
  wireCopyButtons(bodyEl);
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
  els.quickActions
    .querySelectorAll('button')
    .forEach((b) => (b.disabled = busy));
}

// ---------- 当前页面抓取 ----------
async function getActiveTab() {
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

    // 换文档则开新会话（同网页逻辑）
    if (
      els.useContext.checked &&
      lastPageUrl &&
      data.url !== lastPageUrl &&
      sessionId
    ) {
      startNewConversation();
    }
    lastPageUrl = data.url;
    return data;
  } catch (e) {
    setPageTitle('解析 PDF 失败：' + (e.message || e), 'err');
    els.pageTitle.title = String(e.message || e);
    return null;
  }
}

/** 抓取当前标签页内容；失败返回 null */
async function capturePage() {
  pageContext = null;
  setPageTitle('抓取中…', '');
  els.pageTitle.title = '';
  try {
    const tab = await getActiveTab();
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
      args: [200000], // 抓取全文（上限 20 万字），长页面交由分块逻辑处理
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
      data.url + '\n正文约 ' + data.length + ' 字' + (data.truncated ? '（已截断）' : '');

    // 决策 B：换到不同网页 → 若正处于某个会话中，自动开启新会话
    if (
      els.useContext.checked &&
      lastPageUrl &&
      data.url &&
      data.url !== lastPageUrl &&
      sessionId
    ) {
      startNewConversation();
    }
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

// ---------- 长页面分块参数 ----------
// 单次直发的正文上限：正文不超过此值时一次性注入（快）
const SINGLE_SHOT_LIMIT = 12000;
// 分块时每块的目标大小
const CHUNK_SIZE = 9000;
// 分块数量硬上限，避免超长页面产生过多轮次
const MAX_CHUNKS = 12;

/** 把长文本按段落边界尽量均匀地切成若干块 */
function splitIntoChunks(text, size) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > size) {
    // 在 size 附近寻找一个自然断点（段落 > 换行 > 句号 > 空格）
    let cut = remaining.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf('。', size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf('. ', size);
    if (cut < size * 0.5) cut = remaining.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size; // 实在找不到就硬切
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** 组装「首次注入页面」的头部说明 + 元信息 */
function buildPageHeader(c) {
  const parts = [
    '你是一个网页阅读助手。下面是用户当前浏览的网页内容，请基于这些内容回答问题。',
    '在本次对话接下来的追问中，请继续围绕这个页面作答（无需我再次提供页面内容）。',
    '如果问题无法从页面内容中得到答案，请明确说明。',
    '',
    '【页面标题】' + (c.title || '(无)'),
    '【页面网址】' + (c.url || '(无)'),
  ];
  if (c.description) parts.push('【页面描述】' + c.description);
  if (c.selection) parts.push('', '【用户当前选中的文字】', c.selection);
  return parts.join('\n');
}

/**
 * 发送一个 prompt 并把流式结果渲染进 answerEl。
 * 返回一个 Promise，在该轮结束后 resolve。
 * options.silent: 该轮为内部「喂数据」轮，出错时不切换成错误气泡（交由上层处理）。
 */
async function sendPrompt(prompt, answerEl) {
  const payload = { prompt };
  if (settings.model) payload.model = settings.model;
  if (settings.agent) payload.agent = settings.agent;
  if (sessionId) payload.sessionId = sessionId; // 续聊：带上当前会话 id

  const resp = await fetch(settings.endpoint + '/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: currentController.signal,
  });

  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    throw new Error('请求失败 HTTP ' + resp.status + ' ' + txt);
  }

  await parseSSE(resp.body, answerEl);
}

// ---------- 发送与流式接收 ----------
async function ask(question) {
  // 发送前确保已抓取页面（若开启上下文且尚未抓取）
  if (els.useContext.checked && !pageContext) {
    await capturePage();
  }

  addMessage('user', question);
  const answerEl = addMessage('assistant', '');
  answerEl.classList.add('cursor');
  lastQuestion = question; // 记录用于「重新生成」

  setBusy(true);
  currentController = new AbortController();

  // 判断本轮是否需要注入页面、是否需要分块
  const c = pageContext;
  const needInject =
    els.useContext.checked && c && !(injectedUrl && injectedUrl === c.url);
  const pageText = c ? c.text || '' : '';
  const needChunking = needInject && pageText.length > SINGLE_SHOT_LIMIT;

  try {
    if (!needInject) {
      // 不注入页面：直接发问题（含关闭上下文、或已注入过本页）
      await sendPrompt(question, answerEl);
    } else if (!needChunking) {
      // 页面不长：一次性注入全文 + 问题
      const prompt =
        buildPageHeader(c) +
        '\n\n【页面正文' +
        (c.truncated ? '（已截断）' : '') +
        '】\n' +
        pageText +
        '\n\n【用户问题】\n' +
        question;
      await sendPrompt(prompt, answerEl);
      injectedUrl = c.url;
    } else {
      // 长页面：分块逐轮喂入，最后再发问题
      await askWithChunking(c, pageText, question, answerEl);
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
      checkHealth();
    }
  } finally {
    answerEl.classList.remove('cursor');
    setBusy(false);
    currentController = null;
    els.input.focus();
    // 为已完成的助手回答添加操作条（复制 / 重新生成）
    maybeAddAnswerActions(answerEl);
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
  regenBtn.addEventListener('click', () => {
    if (currentController || !lastQuestion) return;
    const q = lastQuestion;
    // 删除这条助手回答，以及它前面对应的那条用户提问
    const prev = wrap.previousElementSibling;
    wrap.remove();
    if (prev && prev.classList.contains('user')) prev.remove();
    // 在原位重新提问生成
    ask(q);
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

/**
 * 长页面分块流程：
 * 1) 先发「头部说明 + 第 1 块」建立会话；
 * 2) 依次把剩余块作为「阅读」轮喂入（Kiro 只回确认，不作答）；
 * 3) 最后发用户问题，Kiro 基于全部块作答。
 * 喂入过程中在 answerEl 显示进度，真正作答时清空进度、渲染回答。
 */
async function askWithChunking(c, pageText, question, answerEl) {
  let chunks = splitIntoChunks(pageText, CHUNK_SIZE);

  // 超过上限则合并尾部，保证块数可控
  if (chunks.length > MAX_CHUNKS) {
    const head = chunks.slice(0, MAX_CHUNKS - 1);
    const tail = chunks.slice(MAX_CHUNKS - 1).join('\n\n');
    chunks = head.concat(tail);
  }
  const total = chunks.length;

  const showProgress = (i) => {
    answerEl.classList.remove('md');
    answerEl.textContent = '正在阅读长页面…（' + i + '/' + total + ' 块）';
  };

  // 第 1 块：带头部说明
  showProgress(1);
  const firstPrompt =
    buildPageHeader(c) +
    '\n\n这个页面较长，我会分 ' +
    total +
    ' 块发给你。请逐块阅读并记住，读完每一块只回复「已读第 N 块」，不要作答，等我最后提问。' +
    '\n\n【第 1/' +
    total +
    ' 块】\n' +
    chunks[0];
  // 喂数据轮用一个临时隐藏容器接收 Kiro 的「已读」确认，避免污染回答区
  const sink = document.createElement('div');
  await sendPrompt(firstPrompt, sink);

  // 中间块
  for (let i = 1; i < total; i++) {
    if (currentController.signal.aborted) throw new DOMException('aborted', 'AbortError');
    showProgress(i + 1);
    sink.textContent = '';
    const p =
      '【第 ' +
      (i + 1) +
      '/' +
      total +
      ' 块】\n' +
      chunks[i] +
      (i === total - 1 ? '\n\n（以上是最后一块，读完等我提问。）' : '');
    await sendPrompt(p, sink);
  }

  // 最后：发用户问题，正式作答（渲染进 answerEl）
  answerEl.classList.add('md');
  answerEl.dataset.raw = '';
  answerEl.textContent = '';
  await sendPrompt('【用户问题】\n' + question, answerEl);
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
    appendAssistantChunk(answerEl, data.text);
    scrollToBottom();
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
  const text = els.input.value.trim();
  if (!text || currentController) return;
  els.input.value = '';
  autosize();
  ask(text);
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
  showEmptyHint();
}

els.settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

els.status.addEventListener('click', checkHealth);

// 快捷问题按钮
els.quickActions.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (currentController) return;
    ask(btn.dataset.q);
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

async function openPreview() {
  // 若开启上下文但还没抓取，先抓一次
  if (els.useContext.checked && !pageContext) {
    await capturePage();
  }
  const c = pageContext;
  if (!els.useContext.checked) {
    els.previewMeta.innerHTML =
      '<span class="pv-tag pv-off">页面上下文已关闭</span>';
    els.previewBody.textContent = '当前不会把页面内容发给 Kiro。打开「页面上下文」开关后可预览。';
  } else if (!c) {
    els.previewMeta.innerHTML = '<span class="pv-tag pv-off">未抓取到页面</span>';
    els.previewBody.textContent = '当前页面无法读取或尚未抓取。';
  } else {
    const len = c.length || (c.text ? c.text.length : 0);
    const willChunk = len > SINGLE_SHOT_LIMIT;
    const nChunks = willChunk
      ? Math.min(splitIntoChunks(c.text || '', CHUNK_SIZE).length, MAX_CHUNKS)
      : 1;
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
    tags.push('<span class="pv-tag">约 ' + len + ' 字</span>');
    if (c.truncated) tags.push('<span class="pv-tag pv-warn">已截断</span>');
    tags.push(
      willChunk
        ? '<span class="pv-tag pv-chunk">长页面 · 将分 ' + nChunks + ' 块喂入</span>'
        : '<span class="pv-tag">一次性注入</span>'
    );
    if (already) {
      tags.push('<span class="pv-tag pv-done">本会话已注入，追问只发问题</span>');
    }

    let meta =
      '<div class="pv-title">' + escapeText(c.title || '(无标题)') + '</div>' +
      '<div class="pv-url">' + escapeText(c.url || '') + '</div>' +
      '<div class="pv-tags">' + tags.join('') + '</div>';
    els.previewMeta.innerHTML = meta;

    let bodyText = '';
    if (c.selection) {
      bodyText += '【用户当前选中的文字】\n' + c.selection + '\n\n';
    }
    bodyText += '【页面正文' + (c.truncated ? '（已截断）' : '') + '】\n' + (c.text || '(空)');
    els.previewBody.textContent = bodyText;
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

// 切换标签页时自动重新抓取（若开启上下文）
chrome.tabs.onActivated.addListener(() => {
  if (els.useContext.checked) capturePage();
});
// 页面导航完成后也刷新
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active && els.useContext.checked) {
    capturePage();
  }
});

// ---------- 右键「解释选中内容」处理 ----------
let lastHandledActionTs = 0;

/** 把一个 pendingAction 转成一次提问 */
function runPendingAction(action) {
  if (!action || !action.ts || action.ts === lastHandledActionTs) return;
  lastHandledActionTs = action.ts;
  if (action.type === 'explain') {
    const text = (action.text || '').trim();
    if (!text) return;
    if (currentController) return; // 正在生成时忽略，避免打断
    const q =
      '请解释下面这段我从网页中选中的内容（用中文，必要时给出背景和通俗说明）：\n\n「' +
      text +
      '」';
    ask(q);
  }
}

/** 读取并消费暂存的待处理请求 */
async function consumePendingAction() {
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

// ---------- 初始化 ----------
(async function init() {
  await loadSettings();
  showEmptyHint();
  checkHealth();
  await capturePage();
  consumePendingAction(); // 若侧边栏由右键菜单打开，这里会接到选中文字
  els.input.focus();
})();

// 设置变更时实时生效 + 监听右键请求（侧边栏已打开的情况）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    loadSettings().then(checkHealth);
  } else if (area === 'session' && changes.pendingAction) {
    const action = changes.pendingAction.newValue;
    if (action) runPendingAction(action);
  }
});
