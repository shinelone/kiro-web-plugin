/**
 * 页面内容抽取函数。
 * 这个函数会被 chrome.scripting.executeScript 注入到目标页面中执行，
 * 因此它必须是自包含的（不能引用外部变量）。
 *
 * 在页面的真实 DOM 上遍历（不克隆），这样能判断元素是否可见，
 * 并把正文转成 Markdown：保留标题层级、列表、表格、代码块、引用和链接地址。
 * 也会进入 open shadow root 和同源 iframe。
 *
 * 飞书 / Lark 云文档（docx、wiki）只渲染屏幕附近的块，滚走的块会被卸载，直接读 DOM 只能拿到一屏。
 * 对这类页面单独处理：自动滚动文档、逐屏收集块，最后按块的层级和顺序拼成 Markdown（见 extractFeishuDoc）。
 *
 * 返回 Promise<{ title, url, description, selection, text, format, truncated, length }>，text 为 Markdown。
 */
async function extractPageContent(maxChars, opts) {
  // opts.scroll：飞书文档是否自动滚动读完全文。默认只读当前已渲染的部分（不打扰用户阅读），
  // 返回 partial: true；真正发给 Kiro 或打开预览时再带 scroll: true 重新抓取
  const scrollAll = !!(opts && opts.scroll);
  const LIMIT = maxChars || 200000;

  // ---------- 1) 选中的文字 ----------
  let selection = '';
  try {
    selection = ((window.getSelection && window.getSelection().toString()) || '').trim();
  } catch (e) {
    selection = '';
  }

  // ---------- 飞书 / Lark 云文档 ----------
  // extractFeishuDoc 定义在本函数末尾（executeScript 只会注入这一个函数，所以要写在里面）
  const feishuPage = document.querySelector('.docx-page-block[data-block-type="page"], [data-block-type="page"].docx-page-block');
  if (feishuPage) {
    try {
      const r = await extractFeishuDoc(feishuPage, LIMIT, scrollAll);
      if (r && r.text) {
        return {
          title: document.title || '',
          url: location.href || '',
          description: '',
          selection: selection,
          text: r.text,
          format: 'markdown',
          truncated: r.truncated,
          length: r.text.length,
          scrolled: r.steps,
          blocks: r.blocks,
          partial: !scrollAll, // 只读了屏幕附近的块
          site: 'feishu',
        };
      }
    } catch (e) {
      /* 出错时退回通用抓取 */
    }
  }

  // ---------- 2) 选主内容容器 ----------
  const SKIP_TEXT_PARENTS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1 };

  /** 统计元素内的文字量和链接文字量（跳过 script/style 等，避免 SPA 内联数据干扰） */
  function textStats(el) {
    let total = 0;
    let link = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const p = n.parentElement;
      if (!p || SKIP_TEXT_PARENTS[p.tagName.toUpperCase()]) continue;
      const len = n.nodeValue.replace(/\s+/g, '').length;
      if (!len) continue;
      total += len;
      if (p.closest('a')) link += len;
    }
    return { total, link, body: total - link };
  }

  function pickRoot() {
    const body = document.body;
    if (!body) return null;
    const bodyStats = textStats(body);
    if (bodyStats.body < 200) return body; // 内容很少（或都在 shadow DOM 里），直接用 body

    const need = bodyStats.body * 0.5; // 候选容器至少要包含全页一半的非链接文字
    const seen = new Set();
    const candidates = [];
    const selectors = [
      'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
      '#content', '#main', '.content', '.main', '.post', '.article', '.entry-content',
      '.markdown-body', '.post-content', '.article-content', '#mw-content-text', '#readme',
    ];
    for (const sel of selectors) {
      let list;
      try {
        list = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      list.forEach((el) => {
        if (el !== body && !seen.has(el)) {
          seen.add(el);
          candidates.push(el);
        }
      });
    }

    // 没有语义容器时按段落打分（类似 Readability）：段落文字计入父级，一半计入祖父级
    if (!candidates.length) {
      const scores = new Map();
      document.querySelectorAll('p, pre, blockquote, li, td').forEach((p) => {
        const len = (p.textContent || '').trim().length;
        if (len < 25) return;
        const parent = p.parentElement;
        if (parent) scores.set(parent, (scores.get(parent) || 0) + len);
        const gp = parent && parent.parentElement;
        if (gp) scores.set(gp, (scores.get(gp) || 0) + len / 2);
      });
      let best = null;
      let bestScore = 0;
      scores.forEach((s, el) => {
        if (s > bestScore && el !== body) {
          best = el;
          bestScore = s;
        }
      });
      if (best) candidates.push(best);
    }

    // 在满足阈值的候选里选文字最少的（最贴近正文的那一层）
    let root = body;
    let rootTotal = Infinity;
    for (const el of candidates) {
      const s = textStats(el);
      if (s.body >= need && s.total < rootTotal) {
        root = el;
        rootTotal = s.total;
      }
    }
    return root;
  }

  const root = pickRoot();

  // ---------- 3) DOM → Markdown ----------
  const SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, VIDEO: 1, AUDIO: 1,
    BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, OPTION: 1, DIALOG: 1, OBJECT: 1, EMBED: 1,
    MAP: 1, LINK: 1, META: 1,
  };
  // 噪音容器：不在正文容器自身时跳过
  const NOISE_TAGS = { NAV: 1, ASIDE: 1, FOOTER: 1 };
  const NOISE_ROLES = { navigation: 1, banner: 1, contentinfo: 1, complementary: 1, search: 1, dialog: 1, alertdialog: 1 };
  const BLOCK_TAGS = {
    P: 1, DIV: 1, SECTION: 1, ARTICLE: 1, MAIN: 1, HEADER: 1, FOOTER: 1, NAV: 1, ASIDE: 1,
    FIGURE: 1, FIGCAPTION: 1, ADDRESS: 1, FORM: 1, FIELDSET: 1, CENTER: 1, BODY: 1, HTML: 1,
    DETAILS: 1, SUMMARY: 1, DD: 1, DT: 1, DL: 1, LEGEND: 1, CAPTION: 1, HGROUP: 1,
  };

  let outLen = 0; // 已产出的文字量，超过上限后停止遍历
  let stopped = false;
  // 代码块先存起来、正文里放占位符，最后再放回，避免整理空白时破坏缩进
  const codes = [];
  const PAD = '\u0001'; // 列表续行缩进，整理空白时换回空格
  let rootTotal = 0;

  function styleOf(el) {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  }

  /** 元素是否应跳过：true 为噪音，'hidden' 为隐藏元素（里面的代码块仍会保留） */
  function shouldSkip(el, st, inDetails) {
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS[tag]) return true;
    if (el === root) return false;
    if (NOISE_TAGS[tag]) return true;
    // 页面级的 header 是站点头部；文章内部的 header 常有标题和作者，保留
    if (tag === 'HEADER' && root === document.body && !el.closest('article, main, [role="main"]')) return true;
    const role = el.getAttribute('role');
    if (role && NOISE_ROLES[role]) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    if (el.classList && el.classList.contains('mw-editsection')) return true; // 维基百科的「编辑」链接
    // 未选中的标签页（tab）内容虽然隐藏，但常是正文的一部分（如不同系统的安装步骤），保留
    const keepHidden = inDetails || role === 'tabpanel';
    if (el.hidden && !keepHidden) return 'hidden';
    if (st) {
      if (st.display === 'none') return keepHidden ? false : 'hidden';
      if (st.visibility === 'hidden' || st.visibility === 'collapse') return keepHidden ? false : 'hidden';
      // 固定定位的一般是 cookie 横幅、浮动工具条、弹窗；
      // 但有些应用把整个正文放在 fixed 容器里，所以只跳过文字量小的
      if (st.position === 'fixed' && textStats(el).total < rootTotal * 0.3) return true;
    }
    return false;
  }

  function isBlock(el, st) {
    const tag = el.tagName.toUpperCase();
    if (BLOCK_TAGS[tag]) return true;
    if (!st) return false;
    const d = st.display || '';
    if (d === 'contents') return false;
    return d !== '' && !d.startsWith('inline');
  }

  /** 链接地址：同站链接写成以 / 开头的路径，并解码百分号编码，省 token 也便于阅读 */
  function linkUrl(href, el) {
    if (!href) return '';
    try {
      const u = new URL(href, el.ownerDocument.baseURI);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      let out = u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
      try {
        out = decodeURI(out);
      } catch (e) {}
      return out.replace(/[\s()]/g, (c) => encodeURIComponent(c));
    } catch (e) {
      return '';
    }
  }

  // 链接密集的列表/表格（导航框、标签云、站点地图）里的站内链接只保留文字，不带地址
  const LINKY_TAGS = { UL: 1, OL: 1, TABLE: 1, DL: 1, DIV: 1 };
  function isLinkDense(el) {
    if (el.getElementsByTagName('a').length < 8) return false;
    const s = textStats(el);
    return s.total > 0 && s.link / s.total > 0.8;
  }

  function escapeInline(s) {
    return s.replace(/([\\`*_[\]])/g, '\\$1');
  }

  /** 子节点：shadow root 优先；slot 取分配进来的节点 */
  function childrenOf(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.tagName.toUpperCase() === 'SLOT' && el.assignedNodes) {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    if (el.tagName.toUpperCase() === 'IFRAME') {
      try {
        const doc = el.contentDocument;
        if (doc && doc.body) return [doc.body];
      } catch (e) {}
      return [];
    }
    return el.childNodes;
  }

  function renderChildren(el, ctx) {
    let s = '';
    for (const c of childrenOf(el)) {
      if (stopped) break;
      s += renderNode(c, ctx);
    }
    return s;
  }

  function block(s) {
    s = s.trim();
    return s ? '\n\n' + s + '\n\n' : '';
  }

  /** 压成单行（用于标题、表格单元格） */
  function oneLine(s) {
    return s.replace(/\u0001/g, ' ').replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }

  function renderCode(el) {
    let lang = '';
    const codeEl = el.querySelector('code');
    const cls = String(el.className || '') + ' ' + String((codeEl && codeEl.className) || '');
    const m = /(?:lang(?:uage)?-)([\w+#-]+)/.exec(cls);
    if (m) lang = m[1];
    const text = codeText(el)
      .replace(/\u00a0/g, ' ').replace(/^\n+/, '').replace(/\s+$/, '');
    if (!text.trim()) return '';
    const fence = text.includes('```') ? '~~~~' : '```';
    outLen += text.length;
    codes.push(fence + lang + '\n' + text + '\n' + fence);
    return '\n\n\u0002' + (codes.length - 1) + '\u0002\n\n';
  }

  // 代码块里的行号栏、复制按钮等
  const CODE_NOISE = /(^|[\s_-])(line-?numbers?(-rows)?|linenos?|gutter|hljs-ln-numbers|ln-num|copy)($|[\s_-])/i;

  /**
   * 代码文本：按行拆成 div 的编辑器（CodeMirror、Shiki）和用 <br> 换行的高亮器都能正确换行，
   * 也不会像 innerText 那样在「div + br」的结构里每行多出一个空行。
   */
  function codeText(root) {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) {
        out += n.nodeValue;
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toUpperCase();
      if (tag === 'BR') {
        out += '\n';
        return;
      }
      if (tag === 'BUTTON' || tag === 'STYLE' || tag === 'SCRIPT') return;
      if (CODE_NOISE.test(String(n.className || ''))) return;
      const blockish = tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'TR';
      if (blockish && out && !out.endsWith('\n')) out += '\n';
      for (const c of n.childNodes) walk(c);
      if (blockish && out && !out.endsWith('\n')) out += '\n';
    };
    walk(root);
    return out;
  }

  function renderList(el, ctx) {
    const ordered = el.tagName.toUpperCase() === 'OL';
    let i = parseInt(el.getAttribute('start') || '1', 10) || 1;
    const items = [];
    for (const c of childrenOf(el)) {
      if (stopped) break;
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toUpperCase();
      if (tag !== 'LI') {
        const s = renderNode(c, ctx).trim();
        if (s) items.push(s);
        continue;
      }
      const st = styleOf(c);
      const skipLi = shouldSkip(c, st, ctx.inDetails);
      if (skipLi === true) continue;
      let liCtx = ctx;
      if (skipLi === 'hidden') {
        if (!ctx.codeOnly && !c.querySelector('pre')) continue;
        liCtx = { ...ctx, codeOnly: true };
      }
      const marker = ordered ? i++ + '. ' : '- ';
      let body = renderChildren(c, liCtx).trim().replace(/\n{2,}/g, '\n');
      if (!body) continue;
      const pad = PAD.repeat(marker.length);
      body = body.split('\n').map((line, k) => (k === 0 ? marker + line : pad + line)).join('\n');
      items.push(body);
    }
    return items.length ? '\n\n' + items.join('\n') + '\n\n' : '';
  }

  function renderTable(el, ctx) {
    // 嵌套表格多半是排版用的表格，按普通块处理
    if (el.querySelector('table')) return block(renderChildren(el, ctx));
    const rows = [];
    el.querySelectorAll('tr').forEach((tr) => {
      if (tr.closest('table') !== el) return;
      const st = styleOf(tr);
      if (st && st.display === 'none') return;
      const cells = [];
      let isHead = tr.parentElement && tr.parentElement.tagName.toUpperCase() === 'THEAD';
      for (const td of tr.children) {
        const tag = td.tagName.toUpperCase();
        if (tag !== 'TD' && tag !== 'TH') continue;
        const text = oneLine(renderChildren(td, ctx)).replace(/\|/g, '\\|');
        cells.push(text);
        const span = Math.min(parseInt(td.getAttribute('colspan') || '1', 10) || 1, 20);
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.length) rows.push({ cells, isHead: isHead || [...tr.children].every((c) => c.tagName.toUpperCase() === 'TH') });
    });
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((r) => r.cells.length));
    // 单列表格或只有一行：当作普通段落
    if (cols < 2 || rows.length < 2) {
      return block(rows.map((r) => r.cells.filter(Boolean).join(' ')).join('\n'));
    }
    const caption = el.querySelector('caption');
    const pad = (r) => r.concat(Array(cols - r.length).fill(''));
    const lines = [];
    let head = rows[0];
    let rest = rows.slice(1);
    if (!head.isHead) {
      // 没有表头：用空表头，避免把第一行数据当表头
      head = { cells: Array(cols).fill('') };
      rest = rows;
    }
    lines.push('| ' + pad(head.cells).join(' | ') + ' |');
    lines.push('|' + ' --- |'.repeat(cols));
    for (const r of rest) lines.push('| ' + pad(r.cells).join(' | ') + ' |');
    const capText = caption ? oneLine(caption.textContent || '') : '';
    return '\n\n' + (capText ? '**' + capText + '**\n\n' : '') + lines.join('\n') + '\n\n';
  }

  function renderElement(el, ctx) {
    const tag = el.tagName.toUpperCase();
    const st = styleOf(el);
    const skip = shouldSkip(el, st, ctx.inDetails);
    if (skip === 'hidden') {
      // 文档站常把示例代码折叠在「显示代码」后面：隐藏区域里只取代码块
      if (ctx.codeOnly) {
        /* 已在隐藏区域内 */
      } else if (el.querySelector('pre')) {
        ctx = { ...ctx, codeOnly: true };
      } else {
        return '';
      }
    } else if (skip) {
      return '';
    }
    if (ctx.codeOnly && tag !== 'PRE') return block(renderChildren(el, ctx));
    if (!ctx.noLinks && LINKY_TAGS[tag] && isLinkDense(el)) ctx = { ...ctx, noLinks: true };

    // KaTeX / MathML：取 TeX 源码
    if (el.classList && el.classList.contains('katex')) {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) return ' $' + ann.textContent.trim() + '$ ';
    }
    if (tag === 'MATH') {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      const tex = (ann && ann.textContent) || el.getAttribute('alttext');
      if (tex) return ' $' + tex.trim() + '$ ';
    }

    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const t = oneLine(renderChildren(el, ctx)).replace(/^#+\s*/, '');
        return t ? '\n\n' + '#'.repeat(+tag[1]) + ' ' + t + '\n\n' : '';
      }
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'PRE':
        return renderCode(el);
      case 'CODE':
      case 'KBD':
      case 'SAMP': {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) return '';
        outLen += t.length;
        return t.includes('`') ? '`` ' + t + ' ``' : '`' + t + '`';
      }
      case 'UL':
      case 'OL':
        return renderList(el, ctx);
      case 'TABLE':
        return renderTable(el, ctx);
      case 'BLOCKQUOTE': {
        const inner = renderChildren(el, ctx).trim().replace(/\n\s*\n(\s*\n)+/g, '\n\n');
        if (!inner) return '';
        // 代码块占位符不加引用前缀，否则放回代码后只有第一行带「>」
        const quoted = inner.split('\n').map((l) => (/^\u0002\d+\u0002$/.test(l) ? l : l ? '> ' + l : '>'));
        return '\n\n' + quoted.join('\n') + '\n\n';
      }
      case 'STRONG':
      case 'B': {
        const t = renderChildren(el, ctx);
        return t.trim() && !t.includes('\n') ? '**' + t.trim() + '**' : t;
      }
      case 'EM':
      case 'I': {
        const t = renderChildren(el, ctx);
        return t.trim() && !t.includes('\n') ? '*' + t.trim() + '*' : t;
      }
      case 'DEL':
      case 'S':
        return '~~' + renderChildren(el, ctx).trim() + '~~';
      case 'A': {
        const inner = renderChildren(el, ctx);
        const rawHref = el.getAttribute('href') || '';
        const text = inner.trim();
        if (!text) return '';
        // 「跳到正文」之类的无障碍跳转链接
        if (/^#/.test(rawHref) && /^(skip to|jump to|跳到|跳转到|跳至)/i.test(text)) return '';
        const href = linkUrl(rawHref, el);
        // 链接密集区域里只保留外站链接（如新闻列表的原文地址），站内导航链接去掉地址
        if (ctx.noLinks && (!href || href.startsWith('/'))) return inner;
        // 包着块级内容的链接（卡片）或页内锚点：只保留内容
        if (!href || inner.includes('\n') || /^#/.test(rawHref)) return inner;
        if (href === text || href === 'mailto:' + text) return '<' + href + '>';
        return '[' + text + '](' + href + ')';
      }
      case 'IMG': {
        // 只保留 alt 文字；图片地址对文字问答没用，还很占 token
        const alt = (el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
        return alt ? '![' + escapeInline(alt) + ']' : '';
      }
      case 'DT':
        return block('**' + oneLine(renderChildren(el, ctx)) + '**');
      case 'SUMMARY':
        return block('**' + oneLine(renderChildren(el, ctx)) + '**');
      case 'DETAILS':
        return block(renderChildren(el, { ...ctx, inDetails: true }));
      case 'SUP': {
        const t = renderChildren(el, ctx).trim();
        return t ? '^' + t : '';
      }
      default: {
        const inner = renderChildren(el, ctx);
        return isBlock(el, st) ? block(inner) : inner;
      }
    }
  }

  function renderNode(node, ctx) {
    if (stopped) return '';
    if (node.nodeType === 3) {
      if (ctx.codeOnly) return '';
      const t = node.nodeValue.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[\s\u00a0]+/g, ' ');
      outLen += t.length;
      if (outLen > LIMIT * 1.2) stopped = true;
      return t;
    }
    if (node.nodeType === 1) return renderElement(node, ctx);
    if (node.nodeType === 11) return renderChildren(node, ctx); // document fragment / shadow root
    return '';
  }

  /** 整理空白：压缩空格、去掉行首空白和多余空行，再放回列表缩进和代码块 */
  function normalize(md) {
    md = md
      .split('\n')
      .map((line) => line.replace(/^[ \t]+/, '').replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, ''))
      .join('\n')
      .replace(/\u0001/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
    md = md.replace(/\u0002(\d+)\u0002/g, (_, i) => codes[+i]);
    return md.trim();
  }

  let text = '';
  try {
    rootTotal = root ? textStats(root).total : 0;
    text = root ? normalize(renderNode(root, { inDetails: false })) : '';
  } catch (e) {
    // 兜底：转换出错时退回纯文本
    text = ((document.body && document.body.innerText) || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  let truncated = stopped;
  if (text.length > LIMIT) {
    // 在段落边界截断
    const cut = text.lastIndexOf('\n\n', LIMIT);
    text = text.slice(0, cut > LIMIT * 0.8 ? cut : LIMIT);
    truncated = true;
  }

  let description = '';
  try {
    const m = document.querySelector('meta[name="description"], meta[property="og:description"]');
    description = (m && m.content) || '';
  } catch (e) {}

  return {
    title: document.title || '',
    url: location.href || '',
    description: description,
    selection: selection,
    text: text,
    format: 'markdown',
    truncated: truncated,
    length: text.length,
  };

  /**
   * 飞书 / Lark 云文档（新版 docx，含知识库 wiki 里的文档）抓取。
   *
   * 文档由「块」组成：每个块是带 data-block-type / data-record-id 的元素，子块嵌在父块里。
   * 编辑器只渲染视口附近的块，所以这里从头滚到尾，每滚一屏记录一次当前渲染出来的块：
   *  - 每个块记下类型、父块和自身内容（文字、列表标记、代码、表格等，不含子块）；
   *  - 每个父块的子块顺序按每屏看到的顺序合并（新出现的块插到它在屏幕上前一个块的后面）。
   * 滚完后恢复原来的滚动位置，再按树结构拼成 Markdown。
   * 必须自包含（会被 executeScript 注入），不能引用外部变量。
   */
  async function extractFeishuDoc(page, limit, scrollAll) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MAX_MS = 90000; // 最长滚动时间
    const t0 = Date.now();

    // 滚动容器：页面块向上第一个可滚动的祖先
    let sc = page.parentElement;
    while (sc && sc !== document.body) {
      const st = getComputedStyle(sc);
      if (/(auto|scroll)/.test(st.overflowY) && sc.scrollHeight > sc.clientHeight + 10) break;
      sc = sc.parentElement;
    }
    if (!sc || sc === document.body) sc = document.scrollingElement || document.documentElement;

    const nodes = new Map(); // recordId -> { type, own, parent }
    const kids = new Map(); // parentId -> [childId...]
    const ROOT = '__root__';
    let chars = 0;

    const idOf = (el) => el.getAttribute('data-record-id') || el.getAttribute('data-block-id');
    /** 最近的祖先块（不含自身） */
    const parentBlock = (el) => (el.parentElement ? el.parentElement.closest('[data-block-type]') : null);

    // ---- 行内文字 → Markdown ----
    function inlineOf(zone) {
      const lines = [];
      zone.querySelectorAll('.ace-line').forEach((line) => {
        if (line.closest('.zone-container') !== zone) return;
        lines.push(inlineNode(line).replace(/\s+$/, ''));
      });
      if (!lines.length) lines.push(inlineNode(zone));
      return lines.join('\n').replace(/[\u200b\ufeff]/g, '');
    }
    function inlineNode(n) {
      if (n.nodeType === 3) return n.nodeValue;
      if (n.nodeType !== 1) return '';
      if (n.hasAttribute('data-zero-space') || n.hasAttribute('data-enter')) return '';
      const tag = n.tagName;
      if (tag === 'SVG' || tag === 'svg' || tag === 'STYLE' || tag === 'SCRIPT') return '';
      let inner = '';
      for (const c of n.childNodes) inner += inlineNode(c);
      if (!inner.trim()) return inner;
      if (tag === 'A') {
        const href = n.getAttribute('href') || n.getAttribute('data-href') || '';
        if (/^https?:/i.test(href)) return '[' + inner.trim() + '](' + href.replace(/[\s()]/g, encodeURIComponent) + ')';
        return inner;
      }
      const cls = String(n.className || '');
      if (/inline-code/.test(cls)) return '`' + inner + '`';
      const style = n.getAttribute('style') || '';
      if (/font-weight:\s*(bold|[6-9]00)/.test(style) && !inner.includes('\n')) return '**' + inner.trim() + '**';
      if (/font-style:\s*italic/.test(style) && !inner.includes('\n')) return '*' + inner.trim() + '*';
      if (/line-through/.test(style)) return '~~' + inner.trim() + '~~';
      return inner;
    }
    /** 块自己的文字区（不含子块里的） */
    function ownZone(b) {
      for (const z of b.querySelectorAll('.zone-container')) {
        if (z.closest('[data-block-type]') === b) return z;
      }
      return null;
    }
    function ownText(b) {
      const z = ownZone(b);
      return z ? inlineOf(z).replace(/\*\*\*\*/g, '').trim() : '';
    }

    // ---- 表格：整个表格作为一个节点渲染 ----
    function tableMd(b) {
      const rows = new Map();
      b.querySelectorAll('tr').forEach((tr) => {
        if (tr.closest('[data-block-type="table"]') !== b) return;
        const idx = tr.hasAttribute('data-index') ? +tr.getAttribute('data-index') : rows.size;
        if (rows.has(idx)) return;
        const cells = [];
        tr.querySelectorAll('td, th').forEach((td) => {
          if (td.closest('tr') !== tr) return;
          const parts = [];
          td.querySelectorAll('.zone-container').forEach((z) => {
            const t = inlineOf(z).replace(/\s*\n\s*/g, ' ').trim();
            if (t) parts.push(t);
          });
          cells.push(parts.join('<br>').replace(/\|/g, '\\|'));
          const span = Math.min(parseInt(td.getAttribute('colspan') || '1', 10) || 1, 20);
          for (let k = 1; k < span; k++) cells.push('');
        });
        if (cells.length) rows.set(idx, cells);
      });
      const list = [...rows.keys()].sort((a, c) => a - c).map((k) => rows.get(k));
      if (!list.length) return '';
      const cols = Math.max(...list.map((r) => r.length));
      const pad = (r) => r.concat(Array(cols - r.length).fill(''));
      const out = ['| ' + pad(list[0]).join(' | ') + ' |', '|' + ' --- |'.repeat(cols)];
      for (const r of list.slice(1)) out.push('| ' + pad(r).join(' | ') + ' |');
      return out.join('\n');
    }

    /** 块自身的内容（不含子块）。返回 null 表示没有自身内容 */
    function ownContent(b, type) {
      switch (type) {
        case 'table':
          return tableMd(b);
        case 'code': {
          const z = ownZone(b);
          const lines = [];
          if (z) z.querySelectorAll('.ace-line').forEach((l) => lines.push(l.textContent.replace(/[\u200b\ufeff]/g, '')));
          const langEl = b.querySelector('[class*="code-block-header"] [class*="lang"], [class*="language"]');
          const lang = langEl ? langEl.textContent.trim().toLowerCase().replace(/[^\w+#-]/g, '') : '';
          return { lang, code: lines.join('\n') };
        }
        case 'ordered': {
          const o = b.querySelector('.order');
          return { mark: o && o.closest('[data-block-type]') === b ? o.textContent.trim() : '1.', text: ownText(b) };
        }
        case 'todo': {
          const box = b.querySelector('[class*="checkbox"], [role="checkbox"]');
          const done = !!(box && (/checked|done/.test(String(box.className)) || box.getAttribute('aria-checked') === 'true'));
          return { done, text: ownText(b) };
        }
        case 'callout': {
          const emo = b.querySelector('.callout-block-emoji');
          return { emoji: emo ? emo.textContent.trim() : '', text: ownText(b) };
        }
        case 'image': {
          const cap = b.querySelector('[class*="caption"]');
          return cap ? cap.textContent.trim() : '';
        }
        case 'file': {
          const nameEl = b.querySelector('[class*="file-name"], [class*="filename"], [class*="title"]');
          return nameEl ? nameEl.textContent.trim() : '';
        }
        case 'iframe': {
          const f = b.querySelector('iframe');
          return f ? f.getAttribute('src') || '' : '';
        }
        default:
          return ownText(b);
      }
    }

    // 表格、代码块的内容由自身完整渲染，里面的子块不再单独记录
    const LEAF_TYPES = { table: 1, code: 1, sheet: 1, bitable: 1, mindnote: 1, diagram: 1, board: 1, whiteboard: 1 };

    function record() {
      const seenParents = new Map(); // parentId -> 本屏看到的子块顺序
      let added = 0;
      page.querySelectorAll('[data-block-type]').forEach((b) => {
        if (b === page) return;
        const type = b.getAttribute('data-block-type');
        const pb = parentBlock(b);
        if (!pb) return;
        // 在表格、代码块等叶子块内部的块跳过
        for (let a = pb; a && a !== page; a = parentBlock(a)) {
          if (LEAF_TYPES[a.getAttribute('data-block-type')]) return;
        }
        const id = idOf(b);
        if (!id) return;
        const pid = pb === page ? ROOT : idOf(pb);
        const own = ownContent(b, type);
        const size = JSON.stringify(own || '').length;
        const old = nodes.get(id);
        if (!old) {
          nodes.set(id, { type, own, parent: pid, size });
          chars += size;
          added++;
        } else if (size > old.size) {
          chars += size - old.size;
          old.own = own;
          old.size = size;
        }
        if (!seenParents.has(pid)) seenParents.set(pid, []);
        seenParents.get(pid).push(id);
      });
      seenParents.forEach((obs, pid) => {
        if (!kids.has(pid)) kids.set(pid, []);
        mergeOrder(kids.get(pid), obs);
      });
      return added;
    }

    /** 把本屏看到的顺序合并进已知顺序：新块插到它在本屏前一个已知块之后 */
    function mergeOrder(list, obs) {
      let pos = -1;
      for (let k = 0; k < obs.length; k++) {
        const id = obs[k];
        const i = list.indexOf(id);
        if (i >= 0) {
          pos = i;
          continue;
        }
        if (pos < 0) {
          // 本屏开头的新块：插到本屏第一个已知块之前
          const next = obs.slice(k + 1).find((x) => list.includes(x));
          pos = next ? list.indexOf(next) - 1 : list.length - 1;
        }
        list.splice(pos + 1, 0, id);
        pos++;
      }
    }

    if (!scrollAll) {
      record();
      return finish(false, 0);
    }

    // ---- 从头滚到尾 ----
    const origTop = sc.scrollTop;
    let steps = 0;
    let truncated = false;
    sc.scrollTop = 0;
    await sleep(400);
    let bottomHits = 0;
    while (true) {
      record();
      steps++;
      if (chars > limit) {
        truncated = true;
        break;
      }
      if (Date.now() - t0 > MAX_MS) {
        truncated = true;
        break;
      }
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (atBottom) {
        // 到底后再等一下：图片加载可能把高度撑大，或者还有块在渲染
        if (++bottomHits >= 2) break;
        await sleep(500);
        continue;
      }
      bottomHits = 0;
      // 每次滚一屏（留 40px 重叠）。飞书会在视口外多渲染一些块，实测一屏一步不会漏
      sc.scrollTop += Math.max(200, sc.clientHeight - 40);
      // 等编辑器渲染新块：先等两帧（标签页在后台时 rAF 不触发，所以最多等 100ms），
      // 再每 60ms 看一次，连续两次没有变化就继续；网络慢时块内容会晚到，最多等 1.5 秒
      await Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(100)]);
      let sig = '';
      for (let w = 0; w < 25; w++) {
        await sleep(60);
        const now = page.querySelectorAll('[data-block-type]').length + ':' + page.textContent.length;
        if (now === sig) break;
        sig = now;
      }
    }
    sc.scrollTop = origTop;
    return finish(truncated, steps);

    // ---- 拼成 Markdown ----
    function finish(truncated, steps) {
      const titleEl = page.querySelector('.page-block-content, h1');
      const title = titleEl ? titleEl.textContent.replace(/[\u200b\ufeff]/g, '').trim() : '';
      const out = [];
      if (title) out.push('# ' + title);

      const indent = (s, pad) => s.split('\n').map((l) => (l ? pad + l : l)).join('\n');
      const quote = (s) => s.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');

      const LIST_TYPES = { bullet: 1, ordered: 1, todo: 1 };
      /** 子块依次渲染；相邻的列表项之间只空一行换行（紧凑列表），其它块之间空一行 */
      function renderChildren(id, depth) {
        const list = kids.get(id) || [];
        let out = '';
        let prevList = false;
        for (const cid of list) {
          const s = renderNode(cid, depth);
          if (!s) continue;
          const isList = !!LIST_TYPES[(nodes.get(cid) || {}).type];
          if (out) out += isList && prevList ? '\n' : '\n\n';
          out += s;
          prevList = isList;
        }
        return out;
      }

      function renderNode(id, depth) {
        const n = nodes.get(id);
        if (!n) return '';
        const own = n.own;
        const t = n.type;
        const childMd = () => renderChildren(id, depth + 1);
        let m;
        if ((m = /^heading(\d)$/.exec(t))) {
          const text = String(own || '').replace(/\n+/g, ' ').replace(/^\*\*(.*)\*\*$/, '$1').trim();
          const head = text ? '#'.repeat(Math.min(+m[1] + 1, 6)) + ' ' + text : '';
          const c = childMd(); // 折叠标题下的内容
          return [head, c].filter(Boolean).join('\n\n');
        }
        switch (t) {
          case 'text':
            return [own, childMd()].filter(Boolean).join('\n\n');
          case 'bullet':
          case 'ordered':
          case 'todo': {
            const text = t === 'bullet' ? own : own.text;
            const mark = t === 'bullet' ? '-' : t === 'ordered' ? own.mark || '1.' : own.done ? '- [x]' : '- [ ]';
            const pad = ' '.repeat(mark.length + 1);
            let s = mark + ' ' + indent(String(text || ''), pad).trimStart();
            const c = renderChildren(id, depth + 1);
            if (c) s += '\n' + indent(c, pad);
            return s;
          }
          case 'code': {
            const code = own.code || '';
            if (!code.trim()) return '';
            const fence = code.includes('```') ? '~~~~' : '```';
            return fence + (own.lang || '') + '\n' + code + '\n' + fence;
          }
          case 'quote':
            return quote([own, childMd()].filter(Boolean).join('\n\n'));
          case 'quote_container':
            return quote(childMd());
          case 'callout': {
            const body = [own.text, childMd()].filter(Boolean).join('\n\n');
            return body ? quote((own.emoji ? own.emoji + ' ' : '') + body) : '';
          }
          case 'divider':
            return '---';
          case 'table':
            return own || '';
          case 'image':
            return '![图片' + (own ? '：' + own : '') + ']';
          case 'file':
            return '[附件' + (own ? '：' + own : '') + ']';
          case 'iframe':
            return own ? '[嵌入网页](' + own + ')' : '[嵌入网页]';
          case 'sheet':
            return '[内嵌电子表格：无法读取内容]';
          case 'bitable':
          case 'base_refer':
            return '[内嵌多维表格：无法读取内容]';
          case 'mindnote':
          case 'diagram':
          case 'board':
          case 'whiteboard':
            return '[内嵌画板 / 思维导图：无法读取内容]';
          default:
            // grid、grid_column、view、synced_source 等容器，以及未知类型：自身文字 + 子块
            return [typeof own === 'string' ? own : '', childMd()].filter(Boolean).join('\n\n');
        }
      }

      out.push(renderChildren(ROOT, 0));
      let text = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > limit) {
        text = text.slice(0, limit);
        truncated = true;
      }
      return { text, truncated, steps, blocks: nodes.size };
    }
  }
}
