/**
 * 页面内容抽取函数。
 * 这个函数会被 chrome.scripting.executeScript 注入到目标页面中执行，
 * 因此它必须是自包含的（不能引用外部变量）。
 * 返回 { title, url, selection, text }。
 */
function extractPageContent(maxChars) {
  // 默认抓取上限大幅提高，以便支持长页面分块；仍设硬上限防止极端页面占用过多内存
  const LIMIT = maxChars || 200000;

  // 1) 优先使用用户选中的文字
  let selection = '';
  try {
    selection = (window.getSelection && window.getSelection().toString()) || '';
    selection = selection.trim();
  } catch (e) {
    selection = '';
  }

  // 2) 抽取正文：克隆 body，移除噪音节点，取可见文本
  function getMainText() {
    const noiseSelectors = [
      'script',
      'style',
      'noscript',
      'template',
      'svg',
      'canvas',
      'iframe',
      'nav',
      'footer',
      'header',
      'aside',
      '[aria-hidden="true"]',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
    ];

    // 优先挑选语义化的主内容容器
    const candidates = [
      document.querySelector('main'),
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.querySelector('#content'),
      document.querySelector('.content'),
      document.body,
    ].filter(Boolean);

    const root = candidates[0] || document.body;
    if (!root) return '';

    const clone = root.cloneNode(true);
    noiseSelectors.forEach((sel) => {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    });

    // innerText 能较好地反映可见文本与换行
    let text = clone.innerText || clone.textContent || '';
    // 压缩多余空白
    text = text
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text;
  }

  let text = getMainText();
  let truncated = false;
  if (text.length > LIMIT) {
    text = text.slice(0, LIMIT);
    truncated = true;
  }

  // 元信息：meta description
  let description = '';
  try {
    const m = document.querySelector('meta[name="description"]');
    description = (m && m.content) || '';
  } catch (e) {}

  return {
    title: document.title || '',
    url: location.href || '',
    description: description,
    selection: selection,
    text: text,
    truncated: truncated,
    length: text.length,
  };
}
