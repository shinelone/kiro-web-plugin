'use strict';

/**
 * 轻量、安全的 Markdown → HTML 渲染器。
 *
 * 设计目标：
 * - 零依赖，自包含（Chrome 扩展 MV3 不允许远程脚本）。
 * - 先对所有文本做 HTML 转义，再逐步注入受控标签，杜绝 XSS。
 * - 支持流式：未闭合的代码围栏也会被当作代码块渲染（中间态友好）。
 *
 * 支持语法：
 * - 标题 #..######
 * - 围栏代码块 ```lang ... ```（含未闭合）
 * - 行内代码 `code`
 * - 粗体 **x** / __x__，斜体 *x* / _x_，删除线 ~~x~~
 * - 链接 [text](url)（仅 http/https/mailto）
 * - 无序列表 - / * / +，有序列表 1.
 * - 引用 >
 * - 表格 | a | b |
 * - 分隔线 --- / *** / ___
 */

(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 仅允许安全协议的链接
  function safeUrl(url) {
    const u = url.trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^[^:]+$/.test(u) || /^[./#?]/.test(u)) return u; // 相对地址/锚点
    return '#';
  }

  // 行内语法（输入已是转义后的 HTML 安全文本）
  function renderInline(text) {
    let s = text;

    // 行内代码优先，用占位符保护，避免内部被其它规则破坏
    const codeSpans = [];
    s = s.replace(/`([^`]+?)`/g, (_, code) => {
      codeSpans.push(code);
      return '\u0000CODE' + (codeSpans.length - 1) + '\u0000';
    });

    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, txt, url) => {
      return (
        '<a href="' +
        escapeHtml(safeUrl(url)) +
        '" target="_blank" rel="noopener noreferrer">' +
        txt +
        '</a>'
      );
    });

    // 粗体 + 斜体组合 ***x***
    s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // 粗体
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
    // 斜体
    s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, '$1<em>$2</em>');
    // 删除线
    s = s.replace(/~~([^~]+?)~~/g, '<del>$1</del>');

    // 还原行内代码
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => {
      return '<code class="md-inline-code">' + codeSpans[+i] + '</code>';
    });

    return s;
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|')) l = l.slice(0, -1);
    return l.split('|').map((c) => c.trim());
  }

  function render(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    // 列表堆栈处理
    let listStack = []; // { type: 'ul'|'ol' }

    function closeLists(toDepth) {
      while (listStack.length > toDepth) {
        const l = listStack.pop();
        out.push(l.type === 'ol' ? '</ol>' : '</ul>');
      }
    }

    while (i < lines.length) {
      let line = lines[i];

      // 围栏代码块
      const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);
      if (fence) {
        closeLists(0);
        const lang = fence[1] || '';
        const codeLines = [];
        i++;
        let closed = false;
        while (i < lines.length) {
          if (/^\s*```+\s*$/.test(lines[i])) {
            closed = true;
            i++;
            break;
          }
          codeLines.push(lines[i]);
          i++;
        }
        const code = escapeHtml(codeLines.join('\n'));
        out.push(
          '<div class="md-code-block" data-lang="' +
            escapeHtml(lang) +
            '">' +
            '<div class="md-code-head"><span class="md-code-lang">' +
            (escapeHtml(lang) || 'code') +
            '</span>' +
            '<button class="md-copy-btn" type="button" title="复制代码">复制</button></div>' +
            '<pre><code>' +
            code +
            '</code></pre>' +
            '</div>'
        );
        // closed 变量保留语义；未闭合时也已按代码块渲染（流式友好）
        void closed;
        continue;
      }

      // 空行
      if (/^\s*$/.test(line)) {
        closeLists(0);
        i++;
        continue;
      }

      // 分隔线
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        closeLists(0);
        out.push('<hr class="md-hr" />');
        i++;
        continue;
      }

      // 标题
      const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) {
        closeLists(0);
        const level = h[1].length;
        out.push(
          '<h' + level + ' class="md-h md-h' + level + '">' +
            renderInline(escapeHtml(h[2].trim())) +
            '</h' + level + '>'
        );
        i++;
        continue;
      }

      // 引用
      if (/^\s*>\s?/.test(line)) {
        closeLists(0);
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push(
          '<blockquote class="md-quote">' +
            renderInline(escapeHtml(quote.join('\n'))).replace(/\n/g, '<br/>') +
            '</blockquote>'
        );
        continue;
      }

      // 表格：当前行像表格行，且下一行是分隔行
      if (
        /\|/.test(line) &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      ) {
        closeLists(0);
        const header = splitRow(line);
        i += 2; // 跳过表头和分隔行
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let t = '<table class="md-table"><thead><tr>';
        header.forEach((c) => {
          t += '<th>' + renderInline(escapeHtml(c)) + '</th>';
        });
        t += '</tr></thead><tbody>';
        rows.forEach((r) => {
          t += '<tr>';
          for (let c = 0; c < header.length; c++) {
            t += '<td>' + renderInline(escapeHtml(r[c] || '')) + '</td>';
          }
          t += '</tr>';
        });
        t += '</tbody></table>';
        out.push(t);
        continue;
      }

      // 列表项
      const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
      const ol = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const type = ol ? 'ol' : 'ul';
        if (listStack.length === 0 || listStack[listStack.length - 1].type !== type) {
          // 简化：不做多级嵌套缩进，按首个类型开列表
          if (listStack.length === 0) {
            listStack.push({ type });
            out.push(type === 'ol' ? '<ol class="md-list">' : '<ul class="md-list">');
          } else if (listStack[listStack.length - 1].type !== type) {
            closeLists(0);
            listStack.push({ type });
            out.push(type === 'ol' ? '<ol class="md-list">' : '<ul class="md-list">');
          }
        }
        const content = (ul ? ul[2] : ol[2]).trim();
        out.push('<li>' + renderInline(escapeHtml(content)) + '</li>');
        i++;
        continue;
      }

      // 普通段落：把连续的非空、非特殊行合并
      closeLists(0);
      const para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*```+/.test(lines[i]) &&
        !/^\s*#{1,6}\s/.test(lines[i]) &&
        !/^\s*>\s?/.test(lines[i]) &&
        !/^(\s*)[-*+]\s+/.test(lines[i]) &&
        !/^(\s*)\d+[.)]\s+/.test(lines[i]) &&
        !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push(
          '<p class="md-p">' +
            renderInline(escapeHtml(para.join('\n'))).replace(/\n/g, '<br/>') +
            '</p>'
        );
      }
    }

    closeLists(0);
    return out.join('');
  }

  global.renderMarkdown = render;
})(typeof window !== 'undefined' ? window : this);
