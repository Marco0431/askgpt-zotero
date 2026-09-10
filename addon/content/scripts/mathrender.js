/**
 * AskGPT 渲染层（离线，无外部依赖）。
 *
 * - Markdown：markdown-it（随插件打包，addon/content/vendor/markdown-it.min.js）
 * - 数学公式：KaTeX（随插件打包，addon/content/vendor/katex/），
 *   支持 $$...$$、\[...\]、\(...\)、$...$
 * - 代码块 / 行内代码先占位保护，不会被公式或强调语法破坏
 * - 兜底：若 vendor 脚本没加载成功，退回内置的极简 Markdown 渲染（不会白屏）
 *
 * 对外接口（window.AskGPTRender）：
 *   renderMarkdown(text)        → AI 回答的 HTML（Markdown + 公式）
 *   renderPlainWithMath(text)   → 纯文本预览的 HTML（只渲染公式，其余原样）
 *   enhanceScripts(rootEl)      → 对已插入 DOM 的文本做裸 ^/_ 上下标兜底渲染
 *   ready                       → { markdown: boolean, katex: boolean }
 */
(function () {
  "use strict";

  var PH = "@@AGMATH"; // 公式占位符前缀
  var MAX_MATH_RENDER = 600; // 单次预览最多渲染的公式数量（防极端长文档卡顿）

  function hasMd() {
    return typeof window.markdownit === "function";
  }
  function hasKatex() {
    return !!(
      window.katex && typeof window.katex.renderToString === "function"
    );
  }

  /* ------------------------------ 基础工具 ------------------------------ */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function katexHtml(tex, display) {
    if (!hasKatex()) return null;
    try {
      return window.katex.renderToString(tex, {
        displayMode: !!display,
        throwOnError: false,
        strict: false,
        trust: false,
        output: "html",
      });
    } catch (e) {
      return null;
    }
  }

  /**
   * 抽出文本里的数学公式，返回 { text, math:[{tex, display, html}] }，
   * 公式位置替换成占位符 @@AGMATH<i>@@（不含 < >，markdown-it 原样保留）。
   * 未闭合的公式（流式输出中途）保持原样，不会破坏排版。
   */
  function extractMath(src) {
    var math = [];
    var t = String(src || "");

    function push(tex, display) {
      var i = math.length;
      var html = katexHtml(tex, display);
      math.push({ tex: tex, display: !!display, html: html });
      return PH + i + "@@";
    }

    // 1) 块级：$$...$$ 、\[...\]
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, function (m, inner) {
      var s = inner.trim();
      return s ? "\n\n" + push(s, true) + "\n\n" : m;
    });
    t = t.replace(/\\\[([\s\S]+?)\\\]/g, function (m, inner) {
      var s = inner.trim();
      return s ? "\n\n" + push(s, true) + "\n\n" : m;
    });

    // 2) 行内：\(...\) 、$...$
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, function (m, inner) {
      var s = inner.trim();
      return s ? push(s, false) : m;
    });
    t = t.replace(/\$([^$\n]+?)\$/g, function (m, inner) {
      var s = inner.trim();
      // 明显不是公式的（纯中文句子）不处理
      if (!s || !/[\\^_{}=+\-*/a-zA-Z0-9]/.test(s)) return m;
      if (/^[\u4e00-\u9fa5\s，。；：、！？（）]+$/.test(s)) return m;
      return push(s, false);
    });

    return { text: t, math: math };
  }

  /** 把占位符换成 KaTeX 渲染结果（超出上限的保持 LaTeX 原文） */
  function fillMath(html, math) {
    var limit = Math.min(math.length, MAX_MATH_RENDER);
    var re = new RegExp(PH + "(\\d+)@@", "g");
    return html.replace(re, function (m, i) {
      var item = math[+i];
      if (!item) return m;
      if (!item.html || +i >= limit) return escapeHtml(item.tex);
      if (item.display) {
        return '<span class="ag-math-block">' + item.html + "</span>";
      }
      return '<span class="ag-math-inline">' + item.html + "</span>";
    });
  }

  /* --------------------------- 极简兜底渲染 --------------------------- */

  function fallbackMarkdown(text) {
    var t = escapeHtml(text || "");
    t = t.replace(
      /```(\w*)[^\n]*\n?([\s\S]*?)```/g,
      function (_m, _lang, code) {
        return '<pre class="md-code"><code>' + code.trim() + "</code></pre>";
      },
    );
    t = t.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
    t = t.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    t = t.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    t = t.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    t = t.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank">$1</a>',
    );
    t = t.replace(/(^|\n)-\s+(.*)/g, "$1<li>$2</li>");
    t = t.replace(/(^|\n)\s*(\d+)[.、]\s+(.*)/g, "$1<li>$3</li>");
    return t.replace(/\n/g, "<br/>");
  }

  /* ------------------------------ 对外接口 ------------------------------ */

  var mdInstance = null;
  function getMd() {
    if (!hasMd()) return null;
    if (!mdInstance) {
      mdInstance = window.markdownit({
        html: false, // 不信任模型输出里的 HTML
        linkify: true,
        breaks: true,
      });
    }
    return mdInstance;
  }

  /**
   * AI 回答渲染：真实 Markdown + 真实公式。
   */
  function renderMarkdown(text) {
    var src = String(text || "");
    if (!src.trim()) return "";

    // 1) 代码块 / 行内代码先占位（内部内容原样保留，且不参与公式解析）
    var codes = [];
    src = src.replace(
      /```(\w*)[^\n]*\n?([\s\S]*?)```/g,
      function (_m, lang, code) {
        codes.push(
          '<pre class="md-code"><code>' +
            escapeHtml(code.replace(/\n$/, "")) +
            "</code></pre>",
        );
        return "\n\n@@AGCODE" + (codes.length - 1) + "@@\n\n";
      },
    );
    src = src.replace(/`([^`\n]+)`/g, function (_m, code) {
      codes.push(
        '<code class="md-inline-code">' + escapeHtml(code) + "</code>",
      );
      return "@@AGCODE" + (codes.length - 1) + "@@";
    });

    // 2) 修正"看起来没渲染"的标题写法（模型常见的几种畸形写法）
    src = normalizeHeadings(src);

    // 3) 抽公式
    var ex = extractMath(src);
    var body = ex.text;

    // 4) markdown-it 渲染（不可用时退回极简渲染）
    var md = getMd();
    var html;
    if (md) {
      html = md.render(body);
    } else {
      html = fallbackMarkdown(body);
    }

    // 5) 还原代码
    html = html.replace(/@@AGCODE(\d+)@@/g, function (m, i) {
      return codes[+i] != null ? codes[+i] : m;
    });

    // 6) 还原公式
    html = fillMath(html, ex.math);

    // 7) 单独成段的块级公式去掉 <p> 包裹，避免多余空行
    html = html.replace(
      /<p>\s*(<span class="ag-math-block">[\s\S]*?<\/span>)\s*<\/p>/g,
      "$1",
    );

    return html;
  }

  /**
   * 标题写法归一化（在 markdown 解析前、代码块已占位后调用）：
   *   - 全角 ＃＃＃ → ###
   *   - 标题标记和正文挤在同一行（…：### 3. 特征）→ 拆行
   *   - 行首被缩进 2+ 空格的标题（会被 Markdown 当成代码块）→ 去掉缩进
   *   - `###3. 特征` / `###\u00a0特征`（缺空格）→ 补一个空格
   * 只在「2 个以上 # 且后面是空格/数字/中文数字」时才处理，避免误伤代码里的 #。
   */
  function normalizeHeadings(src) {
    var t = String(src || "").replace(/\r\n?/g, "\n");
    var HASH_TAIL = "(?=[ \\t]|$|\\d|[一二三四五六七八九十]|\\()";
    // 全角井号
    t = t.replace(/^[＃]{2,6}/gm, function (m) {
      return new Array(m.length + 1).join("#");
    });
    // 和正文挤在同一行
    t = t.replace(
      new RegExp("([^\\n#\\\\])([ \\t]*)(#{2,6})" + HASH_TAIL, "g"),
      "$1\n$3",
    );
    // 行首缩进（会被当成代码块）
    t = t.replace(new RegExp("^[ \\t]{2,}(#{1,6})" + HASH_TAIL, "gm"), "$1");
    // 缺空格 / nbsp
    t = t.replace(new RegExp("(^|\\n)(#{1,6})(?=[^ \\t\\n#])", "g"), "$1$2 ");
    t = t.replace(/\u00a0/g, " ");
    return t;
  }

  /**
   * 纯文本预览（选中段落 / 全文）：公式真渲染，markdown 标题标记去掉并加粗，
   * 其余原样转义（预览是"看原文"，不做完整 Markdown 解析）。
   */
  function renderPlainWithMath(text) {
    var src = normalizeHeadings(String(text || ""));
    var ex = extractMath(src);
    var html = escapeHtml(ex.text);
    html = html.replace(/^[ \t]*(#{1,6})[ \t]*(.+)$/gm, function (_m, _h, t) {
      return '<span class="ag-md-heading">' + t + "</span>";
    });
    html = fillMath(html, ex.math);
    return html.replace(/\n/g, "<br/>");
  }

  /**
   * 兜底：文本里没有用 $ 包裹的裸上下标（F_t、J^T、x_{k+1}）渲染成 <sup>/<sub>。
   * 只处理"看起来像公式"的文本节点，且跳过代码、链接、KaTeX 输出内部，
   * 避免把 snake_case 变量名之类的东西弄乱。
   */
  function enhanceScripts(root) {
    if (!root || !document.createTreeWalker) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var n;
    while ((n = walker.nextNode())) {
      var v = n.nodeValue;
      if (!v || !/[_^]/.test(v)) continue;
      var skip = false;
      var p = n.parentElement;
      while (p && p !== root) {
        var tag = p.tagName ? p.tagName.toLowerCase() : "";
        if (tag === "code" || tag === "pre" || tag === "a") {
          skip = true;
          break;
        }
        if (p.classList && p.classList.contains("katex")) {
          skip = true;
          break;
        }
        p = p.parentElement;
      }
      if (skip) continue;
      nodes.push(n);
    }
    for (var i = 0; i < nodes.length; i++) {
      var frag = buildScriptFragment(nodes[i].nodeValue);
      if (frag) nodes[i].parentNode.replaceChild(frag, nodes[i]);
    }
  }

  function buildScriptFragment(text) {
    var mathy = /[=^≈≤≥→∈∝×·⟨⟩]/.test(text);
    var braces = /[_^]\{/.test(text);
    if (!mathy && !braces) return null;
    var re = mathy
      ? /([_^])(\{[^{}\n]{1,24}\}|[A-Za-z0-9+-]{1,4})/g
      : /([_^])(\{[^{}\n]{1,24}\})/g;
    var out = [];
    var last = 0;
    var m;
    var found = false;
    while ((m = re.exec(text)) !== null) {
      var content = m[2].replace(/^\{|\}$/g, "");
      if (!content) continue;
      found = true;
      out.push(document.createTextNode(text.slice(last, m.index)));
      var tag = m[1] === "^" ? "sup" : "sub";
      var el = document.createElement(tag);
      el.textContent = content;
      out.push(el);
      last = m.index + m[0].length;
    }
    if (!found) return null;
    out.push(document.createTextNode(text.slice(last)));
    var frag = document.createDocumentFragment();
    for (var i = 0; i < out.length; i++) frag.appendChild(out[i]);
    return frag;
  }

  window.AskGPTRender = {
    renderMarkdown: renderMarkdown,
    renderPlainWithMath: renderPlainWithMath,
    enhanceScripts: enhanceScripts,
    escapeHtml: escapeHtml,
    ready: {
      get markdown() {
        return hasMd();
      },
      get katex() {
        return hasKatex();
      },
    },
  };
})();
