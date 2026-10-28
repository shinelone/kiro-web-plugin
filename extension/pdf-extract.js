// PDF 文本提取适配器（ES module）。
// 用打包进扩展的 pdf.js(legacy) 提取 PDF 文字，挂一个 window.extractPdfText 供 sidepanel.js 调用。
//
// 以 ES module 方式加载，因为 pdfjs-dist 的 legacy 构建是 .mjs。
// worker 文件也一起打包，workerSrc 指向扩展内的 URL（MV3 下不能用远程脚本）。

import * as pdfjsLib from './vendor/pdfjs/pdf.min.mjs';

// 指向打包的 worker
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
  'vendor/pdfjs/pdf.worker.min.mjs'
);

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

  let out = '';
  let truncated = false;

  for (let p = 1; p <= pagesToRead; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // 把 text item 拼回带换行的文本：按 item 的 y 坐标换行
    let lastY = null;
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) {
        pageText += '\n';
      } else if (pageText && !pageText.endsWith(' ')) {
        pageText += ' ';
      }
      pageText += item.str;
      lastY = y;
    }
    out += pageText.trim() + '\n\n';

    if (out.length > LIMIT) {
      out = out.slice(0, LIMIT);
      truncated = true;
      break;
    }
    // 及时释放页面资源
    page.cleanup();
  }

  if (pagesToRead < totalPages) truncated = true;

  // 压缩多余空白
  out = out
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

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
    length: out.length,
    truncated: truncated,
    pages: totalPages,
    parsedPages: pagesToRead,
    isPdf: true,
  };
}

// 挂到全局，供非 module 的 sidepanel.js 调用
window.extractPdfText = extractPdfText;
// 标记已就绪
window.__pdfExtractReady = true;
