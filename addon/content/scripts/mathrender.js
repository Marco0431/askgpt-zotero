/**
 * AskGPT 渲染层（离线，无外部依赖）。
 *
 * - Markdown：markdown-it（随插件打包，addon/content/vendor/markdown-it.min.js）
 * - 数学公式：KaTeX（随插件打包，addon/content/vendor/katex/），
 *   支持 $$...$$、\[...\]、\(...\)、$...$
 * - 数学公式由 markdown-it token 规则处理，代码、链接属性不经过文本替换
 * - 兜底：vendor 不可用时保留转义后的完整源码；KaTeX 采用有界缓存和渲染预算
 *
 * 对外接口（window.AskGPTRender）：
 *   renderMarkdown(text)        → AI 回答的 HTML（Markdown + 公式）
 *   renderPlainWithMath(text)   → 纯文本预览的 HTML（只渲染公式，其余原样）
 *   enhanceScripts(rootEl)      → 对已插入 DOM 的文本做裸 ^/_ 上下标兜底渲染
 *   ready                       → { markdown: boolean, katex: boolean }
 */
(function () {
  "use strict";

  var MAX_MATH_RENDER = 600;
  var MAX_KATEX_CALLS = 128;
  var MAX_TEX_LENGTH = 8192;
  var MAX_NEW_TEX_CHARS = 32000;
  var MAX_BLOCK_SCAN_CHARS = 64000;
  var MAX_OUTPUT_HTML = 1500000;
  var MAX_CACHE_ENTRIES = 600;
  var MAX_CACHE_CHARS = 2000000;
  var MAX_CACHE_ITEM_CHARS = 128000;
  var mathCache = new Map();
  var cacheChars = 0;
  var cacheRenderer = null;

  function hasMd() {
    return typeof window.markdownit === "function";
  }
  function hasKatex() {
    return !!(
      window.katex && typeof window.katex.renderToString === "function"
    );
  }
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function budget() {
    return {
      mathCount: 0,
      calls: 0,
      texChars: 0,
      htmlChars: 0,
      blockScanChars: 0,
    };
  }
  function renderMath(token, env) {
    var limits = env.askgptMath || (env.askgptMath = budget());
    var tex = token.content;
    var display = token.type === "ag_math_block" || token.meta.display;
    var className = display ? "ag-math-block" : "ag-math-inline";
    var raw = token.meta.raw;
    var fallback =
      '<span class="' +
      className +
      ' ag-math-source">' +
      escapeHtml(raw) +
      "</span>";
    limits.mathCount++;
    if (
      !hasKatex() ||
      limits.mathCount > MAX_MATH_RENDER ||
      tex.length > MAX_TEX_LENGTH
    )
      return fallback;
    var renderer = window.katex.renderToString;
    // A vendor arriving late or being replaced must not reuse stale/fallback HTML.
    if (renderer !== cacheRenderer) {
      mathCache.clear();
      cacheChars = 0;
      cacheRenderer = renderer;
    }
    var key = (display ? "display:" : "inline:") + tex;
    var html = mathCache.get(key);
    if (html !== undefined) {
      mathCache.delete(key);
      mathCache.set(key, html);
    } else {
      if (
        limits.calls >= MAX_KATEX_CALLS ||
        limits.texChars + tex.length > MAX_NEW_TEX_CHARS
      )
        return fallback;
      limits.calls++;
      limits.texChars += tex.length;
      try {
        html = renderer.call(window.katex, tex, {
          displayMode: !!display,
          throwOnError: true,
          strict: false,
          trust: false,
          maxSize: 20,
          maxExpand: 1000,
          output: "html",
        });
      } catch (_) {
        html = "";
      }
      if (typeof html !== "string") return fallback;
      // Cache invalid TeX as a sentinel; preserve each occurrence's original delimiters.
      if (html.includes('class="katex-error"')) html = "";
      if (html.length <= MAX_CACHE_ITEM_CHARS) {
        mathCache.set(key, html);
        cacheChars += html.length;
        while (
          mathCache.size > MAX_CACHE_ENTRIES ||
          cacheChars > MAX_CACHE_CHARS
        ) {
          var oldest = mathCache.keys().next().value;
          cacheChars -= mathCache.get(oldest).length;
          mathCache.delete(oldest);
        }
      }
    }
    if (!html || limits.htmlChars + html.length > MAX_OUTPUT_HTML)
      return fallback;
    limits.htmlChars += html.length;
    return '<span class="' + className + '">' + html + "</span>";
  }
  function escaped(src, pos) {
    var count = 0;
    while (pos > 0 && src.charAt(--pos) === "\\") count++;
    return count % 2 === 1;
  }
  function closingAt(src, delimiter, start, end) {
    var pos = start;
    while ((pos = src.indexOf(delimiter, pos)) !== -1 && pos < end) {
      if (!escaped(src, pos)) return pos;
      pos += delimiter.length;
    }
    return -1;
  }
  function mathInline(state, silent) {
    var start = state.pos;
    var head = state.src.slice(start, start + 2);
    var open =
      head === "\\(" || head === "\\[" || head === "$$"
        ? head
        : state.src.charAt(start) === "$"
          ? "$"
          : "";
    if (!open) return false;
    var close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open;
    var contentStart = start + open.length;
    if (open === "$" && /\s/.test(state.src.charAt(contentStart))) return false;
    var end = closingAt(state.src, close, contentStart, state.posMax);
    if (open === "$" && end !== -1) {
      // Standard dollar-math boundaries avoid interpreting prices as formulas.
      if (
        /\s/.test(state.src.charAt(end - 1)) ||
        /\d/.test(state.src.charAt(end + 1)) ||
        state.src.slice(contentStart, end).includes("\n")
      )
        return false;
    }
    if (end === -1) {
      if (open === "$") return false;
      // A streaming formula is still source text; preserve its backslashes and body.
      if (!silent) {
        var unfinished = state.push("text", "", 0);
        unfinished.content = state.src.slice(start, state.posMax);
      }
      state.pos = state.posMax;
      return true;
    }
    var content = state.src.slice(contentStart, end).trim();
    if (!content) return false;
    if (!silent) {
      var token = state.push("ag_math_inline", "", 0);
      token.content = content;
      token.markup = open;
      token.meta = {
        raw: state.src.slice(start, end + close.length),
        display: open === "$$" || open === "\\[",
      };
    }
    state.pos = end + close.length;
    return true;
  }
  function mathBlock(state, startLine, endLine, silent) {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    var start = state.bMarks[startLine] + state.tShift[startLine];
    var open = state.src.slice(start, start + 2);
    if (open !== "$$" && open !== "\\[") return false;
    var close = open === "$$" ? "$$" : "\\]";
    var limits = state.env.askgptMath || (state.env.askgptMath = budget());
    if (limits.blockScanChars >= MAX_BLOCK_SCAN_CHARS) return false;
    var first = state.src.slice(start + 2, state.eMarks[startLine]);
    var lastLine = startLine;
    var end = closingAt(first, close, 0, first.length);
    var pieces = [];
    limits.blockScanChars += first.length + 1;
    if (end !== -1) {
      if (first.slice(end + 2).trim()) return false;
      pieces.push(first.slice(0, end));
    } else {
      pieces.push(first);
      for (lastLine = startLine + 1; lastLine < endLine; lastLine++) {
        // Paragraph terminator checks revisit candidate openers. Share a per-render
        // scan budget so many unfinished display formulas cannot cause quadratic work.
        if (limits.blockScanChars >= MAX_BLOCK_SCAN_CHARS) return false;
        if (
          state.sCount[lastLine] < state.blkIndent &&
          !state.isEmpty(lastLine)
        )
          break;
        var line = state.getLines(
          lastLine,
          lastLine + 1,
          state.blkIndent,
          false,
        );
        limits.blockScanChars += line.length + 1;
        end = closingAt(line, close, 0, line.length);
        if (end !== -1) {
          if (line.slice(end + 2).trim()) return false;
          pieces.push(line.slice(0, end));
          break;
        }
        pieces.push(line);
      }
      if (end === -1 || lastLine >= endLine) return false;
    }
    var content = pieces.join("\n").trim();
    if (!content) return false;
    if (silent) return true;
    var token = state.push("ag_math_block", "", 0);
    token.block = true;
    token.content = content;
    token.markup = open;
    token.map = [startLine, lastLine + 1];
    token.meta = {
      raw: state
        .getLines(startLine, lastLine + 1, state.blkIndent, false)
        .trim(),
      display: true,
    };
    state.line = lastLine + 1;
    return true;
  }
  function installMath(md) {
    md.inline.ruler.before("escape", "askgpt_math", mathInline);
    md.block.ruler.before("fence", "askgpt_math", mathBlock, {
      alt: ["paragraph", "reference", "blockquote", "list"],
    });
    md.renderer.rules.ag_math_inline = function (tokens, index, options, env) {
      return renderMath(tokens[index], env);
    };
    md.renderer.rules.ag_math_block = function (tokens, index, options, env) {
      return renderMath(tokens[index], env) + "\n";
    };
    var plainText = md.renderer.renderInlineAsText;
    md.renderer.renderInlineAsText = function (tokens, options, env) {
      return plainText.call(
        this,
        tokens.map(function (token) {
          return token.type === "ag_math_inline"
            ? { type: "text", content: token.meta.raw }
            : token;
        }),
        options,
        env,
      );
    };
  }
  var mdInstance = null;
  var plainInstance = null;
  var mdFactory = null;
  function getMd(plain) {
    if (!hasMd()) return null;
    if (mdFactory !== window.markdownit) {
      mdFactory = window.markdownit;
      mdInstance = plainInstance = null;
    }
    if (plain ? plainInstance : mdInstance)
      return plain ? plainInstance : mdInstance;
    var md = plain
      ? window.markdownit("zero", { html: false, breaks: true })
      : window.markdownit({ html: false, linkify: true, breaks: true });
    if (plain)
      md.enable(["paragraph", "code", "fence", "text", "newline", "backticks"]);
    installMath(md);
    if (plain) {
      // Preserve code delimiters/indentation too: a plain preview must not rewrite source.
      ["code", "fence"].forEach(function (name) {
        var originalRule = md.block.ruler.__rules__.find(function (rule) {
          return rule.name === name;
        });
        var original = originalRule.fn;
        md.block.ruler.at(
          name,
          function (state, start, end, silent) {
            var count = state.tokens.length;
            var matched = original(state, start, end, silent);
            if (matched && !silent && state.tokens.length > count)
              state.tokens[state.tokens.length - 1].meta = {
                raw: state.getLines(start, state.line, state.blkIndent, false),
              };
            return matched;
          },
          { alt: originalRule.alt },
        );
      });
      var backticks = md.inline.ruler.__rules__.find(function (rule) {
        return rule.name === "backticks";
      }).fn;
      md.inline.ruler.at("backticks", function (state, silent) {
        var start = state.pos;
        var count = state.tokens.length;
        var matched = backticks(state, silent);
        if (matched && !silent && state.tokens.length > count)
          state.tokens[state.tokens.length - 1].meta = {
            raw: state.src.slice(start, state.pos),
          };
        return matched;
      });
      var source = function (tokens, index) {
        return escapeHtml(
          tokens[index].meta?.raw || tokens[index].content,
        ).replace(/\n/g, "<br/>\n");
      };
      md.renderer.rules.code_inline = source;
      md.renderer.rules.code_block = source;
      md.renderer.rules.fence = source;
      md.renderer.rules.paragraph_open = function () {
        return "";
      };
      md.renderer.rules.paragraph_close = function () {
        return "<br/>\n";
      };
      plainInstance = md;
    } else {
      var inlineCode = md.renderer.rules.code_inline;
      md.renderer.rules.code_inline = function (
        tokens,
        index,
        options,
        env,
        renderer,
      ) {
        tokens[index].attrJoin("class", "md-inline-code");
        return inlineCode(tokens, index, options, env, renderer);
      };
      ["code_block", "fence"].forEach(function (name) {
        var original = md.renderer.rules[name];
        md.renderer.rules[name] = function (
          tokens,
          index,
          options,
          env,
          renderer,
        ) {
          return original(tokens, index, options, env, renderer).replace(
            "<pre",
            '<pre class="md-code"',
          );
        };
      });
      mdInstance = md;
    }
    return md;
  }
  function renderMarkdown(text) {
    var source = String(text || "");
    if (!source.trim()) return "";
    var md = getMd(false);
    return md
      ? md.render(source, { askgptMath: budget() })
      : '<pre class="md-code">' + escapeHtml(source) + "</pre>";
  }
  /** Plain preview: preserve Markdown source, except explicitly delimited mathematics. */
  function renderPlainWithMath(text) {
    var source = String(text || "");
    if (!source) return "";
    var md = getMd(true);
    return md
      ? md.render(source, { askgptMath: budget() })
      : escapeHtml(source).replace(/\n/g, "<br/>\n");
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
      while (p) {
        var tag = p.tagName ? p.tagName.toLowerCase() : "";
        if (
          tag === "code" ||
          tag === "pre" ||
          tag === "a" ||
          tag === "sup" ||
          tag === "sub"
        ) {
          skip = true;
          break;
        }
        if (
          p.classList &&
          (p.classList.contains("katex") ||
            p.classList.contains("ag-math-inline") ||
            p.classList.contains("ag-math-block"))
        ) {
          skip = true;
          break;
        }
        if (p === root) break;
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
