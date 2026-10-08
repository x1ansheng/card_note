/* ==================================================================
   render.js —— Markdown / 公式 / 代码 / 折叠小节 渲染引擎
   依赖：marked、katex、highlight.js（都在 web/lib 里，离线可用）
   ================================================================== */
(function (global) {
  'use strict';

  var PH = '\u0001';           // 占位符分隔符（正文里不可能出现）
  var RE_TOKEN = /\u0001T(\d+)\u0001/g;

  var KATEX_MACROS = {
    '\\dd': '\\mathrm{d}',
    '\\ee': '\\mathrm{e}',
    '\\ii': '\\mathrm{j}',
    '\\R': '\\mathbb{R}',
    '\\C': '\\mathbb{C}',
    '\\Z': '\\mathbb{Z}',
    '\\deg': '^{\\circ}',
    '\\T': '^{\\mathsf{T}}',
    '\\Laplace': '\\mathcal{L}',
    '\\Fourier': '\\mathcal{F}'
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------------- 1. 先把「不能被 Markdown 碰」的片段抽出来 ---------------- */
  function tokenize(src) {
    var store = [];
    function add(html) { store.push(html); return PH + 'T' + (store.length - 1) + PH; }
    var text = String(src == null ? '' : src).replace(/\r\n/g, '\n');

    // 围栏代码块
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)(?:\n?```|$)/g, function (m, lang, code) {
      var cls = lang.trim() ? ' class="language-' + escapeHtml(lang.trim().split(/\s+/)[0]) + '"' : '';
      return '\n\n' + add('<pre><code' + cls + '>' + escapeHtml(code.replace(/\n+$/, '')) + '</code></pre>') + '\n\n';
    });
    // 缩进式代码块（4 空格）
    text = text.replace(/(?:^(?: {4}|\t).*\n?)+/gm, function (m) {
      var code = m.replace(/^(?: {4}|\t)/gm, '').replace(/\n+$/, '');
      if (!code.trim()) return m;
      return '\n\n' + add('<pre><code>' + escapeHtml(code) + '</code></pre>') + '\n\n';
    });
    // 行内代码
    text = text.replace(/`([^`\n]+)`/g, function (m, code) {
      return add('<code>' + escapeHtml(code) + '</code>');
    });
    // 独立公式 $$...$$
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function (m, tex) {
      return '\n\n' + add(renderMath(tex, true)) + '\n\n';
    });
    // \[ ... \]
    text = text.replace(/\\\[([\s\S]+?)\\\]/g, function (m, tex) {
      return '\n\n' + add(renderMath(tex, true)) + '\n\n';
    });
    // 行内公式 $...$ 与 \( ... \)
    text = text.replace(/(?<!\\)\$(?!\s)([^\n$]{1,400}?)(?<!\s)\$/g, function (m, tex) {
      if (/[\u4e00-\u9fa5，。；：！？、“”（）]/.test(tex)) return m;   // 中文句子里的 $ 当成钱数，不是公式
      return add(renderMath(tex, false));
    });
    text = text.replace(/\\\(([\s\S]+?)\\\)/g, function (m, tex) {
      return add(renderMath(tex, false));
    });
    return { text: text, store: store };
  }

  /* ---------------- 2. 公式 ---------------- */
  function renderMath(tex, display) {
    var src = String(tex).replace(/^\n+|\n+$/g, '');
    if (global.katex) {
      try {
        return global.katex.renderToString(src, {
          displayMode: !!display,
          throwOnError: false,
          strict: 'ignore',
          trust: false,
          macros: Object.assign({}, KATEX_MACROS)
        });
      } catch (e) { /* 落到下面 */ }
    }
    return '<code class="math-fallback">' + escapeHtml((display ? '$$' : '$') + src + (display ? '$$' : '$')) + '</code>';
  }

  /* ---------------- 3. 主渲染 ---------------- */
  function toHtml(md) {
    var t = tokenize(md);
    var html;
    if (global.marked) {
      var opts = { gfm: true, breaks: true, pedantic: false };
      html = (global.marked.parse ? global.marked.parse(t.text, opts) : global.marked(t.text, opts));
    } else {
      html = '<pre>' + escapeHtml(t.text) + '</pre>';
    }
    return { html: html, store: t.store };
  }

  /** 把占位符替换成真实节点（在 DOM 里做，避免 <p> 里塞 <pre> 这类非法嵌套） */
  function restore(root, store) {
    if (!store || !store.length) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) { if (n.nodeValue.indexOf(PH) >= 0) nodes.push(n); }
    nodes.forEach(function (node) {
      var textVal = node.nodeValue;
      RE_TOKEN.lastIndex = 0;
      if (!RE_TOKEN.test(textVal)) return;
      RE_TOKEN.lastIndex = 0;
      var frag = document.createDocumentFragment();
      var last = 0, m;
      while ((m = RE_TOKEN.exec(textVal))) {
        if (m.index > last) frag.appendChild(document.createTextNode(textVal.slice(last, m.index)));
        var html = store[+m[1]];
        if (html == null) { frag.appendChild(document.createTextNode(m[0])); }
        else {
          var holder = document.createElement('div');
          holder.innerHTML = html;
          while (holder.firstChild) frag.appendChild(holder.firstChild);
        }
        last = m.index + m[0].length;
      }
      if (last < textVal.length) frag.appendChild(document.createTextNode(textVal.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });

    // 拆掉包裹块级元素的 <p>，删掉空段落
    Array.prototype.slice.call(root.querySelectorAll('p')).forEach(function (p) {
      var kids = Array.prototype.slice.call(p.childNodes);
      var hasBlock = kids.some(function (k) {
        return k.nodeType === 1 && /^(PRE|DIV|TABLE|UL|OL|BLOCKQUOTE)$/.test(k.tagName);
      });
      if (hasBlock && !kids.some(function (k) { return k.nodeType === 3 && k.nodeValue.trim(); })) {
        var parent = p.parentNode;
        kids.forEach(function (k) { parent.insertBefore(k, p); });
        parent.removeChild(p);
      } else if (!p.textContent.trim() && !p.querySelector('img,.katex')) {
        p.parentNode.removeChild(p);
      }
    });
  }

  /* ---------------- 4. 后处理 ---------------- */
  function postProcess(root, opts) {
    opts = opts || {};

    // 任务列表
    Array.prototype.slice.call(root.querySelectorAll('li > input[type=checkbox]')).forEach(function (cb) {
      cb.disabled = true;
      var li = cb.closest('li');
      if (li && li.parentNode) li.parentNode.classList.add('task-list');
    });

    // 相对路径图片 → 通过本地服务读取
    if (opts.basePath != null) {
      Array.prototype.slice.call(root.querySelectorAll('img')).forEach(function (img) {
        var raw = img.getAttribute('src') || '';
        img.setAttribute('src', resolveAsset(raw, opts.basePath));
        img.setAttribute('loading', 'lazy');
      });
    }

    // 代码高亮
    if (global.hljs) {
      Array.prototype.slice.call(root.querySelectorAll('pre code')).forEach(function (el) {
        try { global.hljs.highlightElement(el); } catch (e) { /* ignore */ }
      });
    }

    // 折叠小节
    if (opts.collapsible !== false) makeCollapsible(root);
  }

  function resolveAsset(src, basePath) {
    if (!src || /^(https?:|data:|blob:|\/\/|#)/i.test(src)) return src;
    if (src.charAt(0) === '/') return src;
    var segs = String(basePath || '').split('/').filter(Boolean).concat(decodeURIComponent(src).split('/'));
    var out = [];
    segs.forEach(function (s) {
      if (s === '..') out.pop();
      else if (s !== '.' && s !== '') out.push(s);
    });
    return '/files/' + out.map(encodeURIComponent).join('/');
  }

  /* ---------------- 5. 折叠小节 ---------------- */
  var ARROW_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

  function makeCollapsible(root) {
    var kids = Array.prototype.slice.call(root.children);
    var i = 0;
    while (i < kids.length) {
      var el = kids[i];
      var m = /^H([1-6])$/.exec(el.tagName);
      if (!m) { i++; continue; }
      var level = +m[1];
      if (level > 3) { i++; continue; }

      var j = i + 1;
      while (j < kids.length) {
        var mm = /^H([1-6])$/.exec(kids[j].tagName);
        if (mm && +mm[1] <= level) break;
        j++;
      }
      var group = kids.slice(i + 1, j);
      if (group.length) {
        var wrap = document.createElement('div');
        wrap.className = 'sec-wrap';
        var inner = document.createElement('div');
        inner.className = 'sec-inner';
        group.forEach(function (node) { inner.appendChild(node); });
        wrap.appendChild(inner);
        el.parentNode.insertBefore(wrap, el.nextSibling);

        el.classList.add('sec-head', 'collapsible');
        var arrow = document.createElement('span');
        arrow.className = 'sec-arrow';
        arrow.innerHTML = ARROW_SVG;
        el.insertBefore(arrow, el.firstChild);
        (function (head, box) {
          head.addEventListener('click', function (ev) { ev.stopPropagation(); toggleSection(head, box); });
        })(el, wrap);
      }
      i = j;
    }
  }

  function toggleSection(head, box) {
    var folded = box.classList.toggle('folded');
    head.classList.toggle('folded', folded);
    return !folded;
  }

  /* ---------------- 6. 对外接口 ---------------- */
  function renderMarkdown(md, container, opts) {
    opts = opts || {};
    var out = toHtml(md);
    container.classList.add('md');
    container.innerHTML = out.html;
    restore(container, out.store);
    postProcess(container, opts);
    return container;
  }

  /** 纯字符串版本（用于摘要 / 复制） */
  function toPlainText(md) {
    var out = toHtml(md);
    var div = document.createElement('div');
    div.innerHTML = out.html;
    restore(div, out.store);
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function countWords(md) {
    var s = toPlainText(md);
    var cn = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    var en = (s.match(/[a-zA-Z]+/g) || []).length;
    return { cn: cn, en: en, total: cn + en, chars: s.length };
  }

  function foldAll(root, folded) {
    Array.prototype.slice.call(root.querySelectorAll('.sec-head.collapsible')).forEach(function (h) {
      var box = h.nextElementSibling;
      if (box && box.classList.contains('sec-wrap')) {
        box.classList.toggle('folded', folded);
        h.classList.toggle('folded', folded);
      }
    });
  }

  global.NoteRender = {
    renderMarkdown: renderMarkdown,
    toPlainText: toPlainText,
    countWords: countWords,
    foldAll: foldAll,
    escapeHtml: escapeHtml,
    resolveAsset: resolveAsset,
    KATEX_MACROS: KATEX_MACROS
  };
})(window);
