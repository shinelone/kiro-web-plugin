// PDF 文本提取适配器（ES module）。
// 用打包进扩展的 pdf.js(legacy) 提取 PDF 文字，挂一个 window.extractPdfText 供 sidepanel.js 调用。
//
// 以 ES module 方式加载，因为 pdfjs-dist 的 legacy 构建是 .mjs。
// worker 文件也一起打包，workerSrc 指向扩展内的 URL（MV3 下不能用远程脚本）。
//
// 输出 Markdown：
//  - 每页开头加一行「[第 N 页]」，回答时可以引用页码；
//  - 按坐标还原阅读顺序，能识别双栏排版（先左栏、后右栏，跨栏的标题/摘要按位置插入）；
//  - 字号明显大于正文的短行当作标题；
//  - 去掉每页重复出现的页眉页脚和单独的页码。

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

// 指向打包的 worker
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  'vendor/pdfjs/pdf.worker.min.mjs'
);

// CJK 部首补充区（U+2E80–U+2EFF）没有 NFKC 映射，常见的几个手动换回简体字
const RADICAL_MAP = {
  '\u2eaf': '纟', '\u2eb0': '纟', '\u2ec4': '西', '\u2ec5': '见', '\u2ec6': '角', '\u2ec7': '角',
  '\u2ec8': '讠', '\u2ec9': '贝', '\u2ecb': '车', '\u2ed0': '钅', '\u2ed3': '长', '\u2ed4': '门',
  '\u2ed8': '青', '\u2eda': '页', '\u2edb': '风', '\u2edc': '飞', '\u2edf': '饣', '\u2ee0': '饣',
  '\u2ee2': '马', '\u2ee5': '鱼', '\u2ee6': '鸟', '\u2ee8': '麦', '\u2ee9': '黄', '\u2eeb': '齐',
  '\u2eec': '齐', '\u2eed': '齿', '\u2eee': '齿', '\u2eef': '龙', '\u2ef0': '龙', '\u2ef1': '龟',
  '\u2ef2': '龟', '\u2ef3': '龟',
};
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 把一页的 text item 组成「行段」：同一基线、水平上连续的文字 */
function pageSegments(items) {
  const glyphs = [];
  for (const it of items) {
    if (!('str' in it) || !it.transform) continue;
    const t = it.transform;
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue; // 旋转文字（水印、侧边标注）
    const size = Math.hypot(t[2], t[3]) || it.height || 0;
    if (!it.str.trim()) continue;
    // 康熙部首（U+2F00 起）等兼容字形换回常用汉字：Chrome 打印的 PDF 里「入门」常被编码成「⼊⻔」
    const str = it.str.replace(/[\u2e80-\u2fdf]/g, (c) => RADICAL_MAP[c] || c.normalize('NFKC'));
    glyphs.push({ x0: t[4], x1: t[4] + (it.width || 0), y: t[5], size, str });
  }
  // 先按 y 从上到下聚成行，行内再按 x 从左到右
  glyphs.sort((a, b) => b.y - a.y);
  const rows = [];
  for (const g of glyphs) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - g.y) <= Math.max(row.size, g.size) * 0.4) {
      row.items.push(g);
      row.size = Math.max(row.size, g.size);
    } else {
      rows.push({ y: g.y, size: g.size, items: [g] });
    }
  }
  const ordered = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    let last = null;
    for (const g of row.items) {
      // 同一位置重复绘制的文字（模拟粗体、描边）只保留一份
      if (last && last.str === g.str && Math.abs(last.x0 - g.x0) < g.size * 0.3) continue;
      ordered.push({ ...g, y: row.y });
      last = g;
    }
  }

  const segs = [];
  let cur = null;
  for (const g of ordered) {
    if (!g.str.trim()) continue;
    const sameLine = cur && g.y === cur.y;
    const gap = cur ? g.x0 - cur.x1 : 0;
    // 同一行里水平间距过大（超过约 1.5 个字宽）视为分栏/表格的另一段
    if (sameLine && gap < Math.max(g.size, cur.size) * 1.5) {
      const needSpace =
        gap > g.size * 0.15 && !cur.text.endsWith(' ') && !g.str.startsWith(' ') &&
        !(CJK.test(cur.text.slice(-1)) && CJK.test(g.str[0]));
      cur.text += (needSpace ? ' ' : '') + g.str;
      cur.x1 = Math.max(cur.x1, g.x1);
      cur.size = Math.max(cur.size, g.size);
      cur.chars += g.str.length;
    } else {
      cur = { x0: g.x0, x1: g.x1, y: g.y, size: g.size, text: g.str, chars: g.str.length };
      segs.push(cur);
    }
  }
  for (const s of segs) s.text = s.text.replace(/\s+/g, ' ').trim();
  return segs.filter((s) => s.text);
}

/** 按阅读顺序排列行段：识别双栏 */
function readingOrder(segs, pageWidth) {
  if (segs.length < 6 || !pageWidth) return segs;
  const mid = pageWidth / 2;
  const tol = pageWidth * 0.03;
  let left = 0;
  let right = 0;
  let span = 0;
  for (const s of segs) {
    s.col = s.x1 <= mid + tol ? 'L' : s.x0 >= mid - tol ? 'R' : 'S';
    if (s.col === 'L') left += s.chars;
    else if (s.col === 'R') right += s.chars;
    else span += s.chars;
  }
  const total = left + right + span;
  const twoCol = total > 0 && left > total * 0.2 && right > total * 0.2 && span < total * 0.3;
  if (!twoCol) return segs;

  // 跨栏的行（标题、摘要、通栏图表说明）把页面切成若干区块，区块内先左栏后右栏
  const sorted = segs.slice().sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const out = [];
  let L = [];
  let R = [];
  const flush = () => {
    out.push(...L, ...R);
    L = [];
    R = [];
  };
  for (const s of sorted) {
    if (s.col === 'S') {
      flush();
      out.push(s);
    } else if (s.col === 'L') L.push(s);
    else R.push(s);
  }
  flush();
  return out;
}

/** 正文字号：按字符数加权的众数 */
function bodyFontSize(pages) {
  const hist = new Map();
  for (const p of pages) {
    for (const s of p.segs) {
      const k = Math.round(s.size * 2) / 2;
      hist.set(k, (hist.get(k) || 0) + s.chars);
    }
  }
  let best = 0;
  let bestN = -1;
  hist.forEach((n, k) => {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  });
  return best || 10;
}

/** 找出页眉页脚：在多数页面的首尾行重复出现的文字（数字归一化后比较） */
function runningLines(pages) {
  const drop = new Set();
  if (pages.length < 4) return drop;
  const norm = (t) => t.replace(/\d+/g, '#').trim();
  const count = new Map();
  for (const p of pages) {
    const edge = new Set();
    const segs = p.segs;
    for (const s of segs.slice(0, 2).concat(segs.slice(-2))) edge.add(norm(s.text));
    edge.forEach((k) => count.set(k, (count.get(k) || 0) + 1));
  }
  count.forEach((n, k) => {
    if (n >= pages.length * 0.5 && k.length <= 120) drop.add(k);
  });
  return drop;
}

// 和正文同字号、但看起来是章节标题的短行：「3.1 Encoder」「第二章 总则」「一、背景」「Abstract」
const NUM_HEADING = /^(?:(\d+(?:\.\d+)*)\.?\s+[A-Z\u4e00-\u9fff]|第[一二三四五六七八九十百\d]+([章节部分篇])|[一二三四五六七八九十]+、)/;
const NAMED_HEADING = /^(?:abstract|introduction|references|bibliography|acknowledge?ments?|conclusions?|related work|appendix|摘\s*要|参考文献|引\s*言|结\s*论|致\s*谢|附\s*录)$/i;

/** 同字号标题的层级；不是标题返回 0 */
function inlineHeadingLevel(s, lineWidth) {
  const t = s.text;
  if (t.length > 80 || /[.。,，;；:：]$/.test(t)) return 0;
  if (NAMED_HEADING.test(t)) return 2;
  if (s.x1 - s.x0 > lineWidth * 0.75) return 0; // 几乎占满一行的多半是正文或列表项
  const m = NUM_HEADING.exec(t);
  if (!m) return 0;
  if (m[1]) return Math.min(1 + m[1].split('.').length, 4);
  if (m[2]) return m[2] === '章' || m[2] === '篇' || m[2] === '部分' ? 2 : 3;
  return 2;
}

/** 把一页的行段拼成 Markdown 段落 */
function renderPage(p, bodySize, drop) {
  const norm = (t) => t.replace(/\d+/g, '#').trim();
  const segs = p.segs;
  const lines = [];
  let para = '';
  let prev = null;
  let heading = null; // { level, text, size }

  const flushPara = () => {
    if (para.trim()) lines.push(para.trim());
    para = '';
  };
  const flushHeading = () => {
    if (heading) lines.push('#'.repeat(heading.level) + ' ' + heading.text.trim());
    heading = null;
  };

  // 典型行宽：取宽度的 80 分位，双栏时约等于栏宽
  const widths = segs.map((x) => x.x1 - x.x0).sort((a, b) => a - b);
  const lineWidth = widths.length ? widths[Math.floor(widths.length * 0.8)] : 0;
  // 典型行距：相邻两行 y 差的中位数，用来区分「换行」和「换段」（中文网页打印的行距常有 1.8 倍字号）
  const gaps = [];
  for (let k = 1; k < segs.length; k++) {
    const d = segs[k - 1].y - segs[k].y;
    if (d > segs[k].size * 0.8 && d < segs[k].size * 3) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const lineGap = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : 0;

  segs.forEach((s, i) => {
    const edge = i < 2 || i >= segs.length - 2;
    if (edge && (drop.has(norm(s.text)) || /^[-–—\s]*\d{1,4}[-–—\s]*$/.test(s.text))) return;

    const ratio = s.size / bodySize;
    const isHeading = ratio >= 1.2 && s.text.length <= 150 && !/[.。;；,，]$/.test(s.text);
    if (isHeading) {
      const level = ratio >= 1.7 ? 1 : ratio >= 1.4 ? 2 : 3;
      if (heading && heading.level === level && Math.abs(heading.size - s.size) < 0.6 && prev && prev.y - s.y < s.size * 2) {
        heading.text += (CJK.test(heading.text.slice(-1)) ? '' : ' ') + s.text; // 跨行的标题
      } else {
        flushPara();
        flushHeading();
        heading = { level, text: s.text, size: s.size };
      }
      prev = s;
      return;
    }
    flushHeading();

    const inlineLevel = inlineHeadingLevel(s, lineWidth);
    if (inlineLevel) {
      flushPara();
      lines.push('#'.repeat(inlineLevel) + ' ' + s.text);
      prev = s;
      return;
    }

    // 段落分隔：行距明显变大、换栏（y 回升）或字号变化
    const newPara =
      !prev ||
      prev.y - s.y > (lineGap ? lineGap * 1.35 : Math.max(s.size, prev.size) * 1.8) ||
      s.y > prev.y ||
      // 上一行明显没写满：上一段已经结束
      (lineWidth && prev.x1 - prev.x0 < lineWidth * 0.8 && /[.。!！?？:：」”"）)]$/.test(prev.text)) ||
      (lineWidth && prev.x1 - prev.x0 < lineWidth * 0.5) ||
      Math.abs(s.size - prev.size) > 1;
    if (newPara) {
      flushPara();
      para = s.text;
    } else if (/[A-Za-z]-$/.test(para) && /^[a-z]/.test(s.text)) {
      para = para.slice(0, -1) + s.text; // 行尾连字符断词
    } else if (CJK.test(para.slice(-1)) && CJK.test(s.text[0])) {
      para += s.text;
    } else {
      para += ' ' + s.text;
    }
    prev = s;
  });
  flushPara();
  flushHeading();
  return lines.join('\n\n');
}

/**
 * 下载并提取 PDF 文本。
 * @param {string} url  PDF 的地址
 * @param {number} maxChars 文本上限（与网页抓取保持一致，默认 20 万字）
 * @param {number} maxPages 最多解析页数（防止超大 PDF 卡死）
 * @returns {Promise<{title,url,text,length,truncated,pages,parsedPages}>}
 */
async function extractPdfText(url, maxChars, maxPages) {
  const LIMIT = maxChars || 200000;
  const PAGE_LIMIT = maxPages || 300;

  // 取 PDF 字节
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('下载 PDF 失败: HTTP ' + resp.status);
  const buf = await resp.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    // 关闭字体/网络相关的额外请求，提取纯文本足够
    disableFontFace: true,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;

  const totalPages = pdf.numPages;
  const pagesToRead = Math.min(totalPages, PAGE_LIMIT);

  // 第一遍：取出每页的行段
  const pages = [];
  let rawChars = 0;
  let truncated = false;
  for (let p = 1; p <= pagesToRead; p++) {
    const page = await pdf.getPage(p);
    const width = page.getViewport({ scale: 1 }).width;
    const content = await page.getTextContent();
    const segs = readingOrder(pageSegments(content.items), width);
    pages.push({ n: p, segs });
    page.cleanup();
    rawChars += segs.reduce((n, s) => n + s.text.length + 1, 0);
    if (rawChars > LIMIT) {
      truncated = true;
      break;
    }
  }
  if (pages.length < totalPages) truncated = true;

  // 第二遍：统计正文字号和页眉页脚，再拼成 Markdown
  const bodySize = bodyFontSize(pages);
  const drop = runningLines(pages);
  let out = '';
  for (const p of pages) {
    const md = renderPage(p, bodySize, drop);
    out += '[第 ' + p.n + ' 页]\n\n' + (md || '（本页没有可提取的文字）') + '\n\n';
  }
  out = out.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > LIMIT) {
    out = out.slice(0, LIMIT);
    truncated = true;
  }
  // 全是「没有可提取的文字」：扫描版
  if (!out.replace(/\[第 \d+ 页\]|（本页没有可提取的文字）|\s/g, '')) out = '';

  // 标题：优先 PDF 元数据，其次从 URL 猜
  let title = '';
  try {
    const meta = await pdf.getMetadata();
    title = (meta && meta.info && meta.info.Title) || '';
  } catch (e) {}
  if (!title) {
    try {
      title = decodeURIComponent(url.split('/').pop() || '') || 'PDF 文档';
    } catch (e) {
      title = 'PDF 文档';
    }
  }

  return {
    title: title,
    url: url,
    description: '',
    selection: '',
    text: out,
    format: 'markdown',
    length: out.length,
    truncated: truncated,
    pages: totalPages,
    parsedPages: pages.length,
    isPdf: true,
  };
}

// 挂到全局，供非 module 的 sidepanel.js 调用
window.extractPdfText = extractPdfText;
// 标记已就绪
window.__pdfExtractReady = true;
