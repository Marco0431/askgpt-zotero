/**
 * AskGPT 弹窗逻辑 —— 轻量 agent：
 *   - 轻量级 system prompt（参考开源 agent 通用写法：角色 + 能力边界 + 工具规则 + 输出约束）
 *   - 支持 Web search tool：模型请求 web_search → 本地执行联网搜索 → 结果回填 → 继续生成
 *   - OpenAI 兼容 chat/completions，流式输出，function calling
 *   - 全部设置存在 Zotero.Prefs，纯本地
 */
(function () {
  "use strict";

  /* ---------- Zotero / 环境 ---------- */
  function getZotero() {
    // iframe 面板：frameElement.ownerGlobal 是 Zotero 主窗口
    try {
      const owner =
        window.frameElement && window.frameElement.ownerGlobal
          ? window.frameElement.ownerGlobal
          : null;
      if (owner && owner.Zotero) return owner.Zotero;
    } catch (e) {}
    // 旧独立窗口：opener 即主窗口
    try {
      if (window.opener && window.opener.Zotero) return window.opener.Zotero;
    } catch (e) {}
    try {
      const mediator =
        window.Services?.wm ||
        Services.wm ||
        Components?.classes?.[
          "@mozilla.org/appshell/window-browser;1"
        ]?.getService(Components.interfaces.nsIWindowMediator);
      const win = mediator.getMostRecentWindow("navigator:browser");
      if (win && win.Zotero) return win.Zotero;
    } catch (e) {}
    return null;
  }
  const Zotero = getZotero();
  const ADDN = "extensions.askgpt.";

  function getPref(name, def) {
    try {
      const v = Zotero.Prefs.get(ADDN + name);
      if (v === undefined || v === null || v === "") {
        return typeof def !== "undefined" ? def : v;
      }
      return v;
    } catch (e) {
      return typeof def !== "undefined" ? def : "";
    }
  }
  function setPref(name, val) {
    try {
      Zotero.Prefs.set(ADDN + name, val);
    } catch (e) {}
  }

  /* ---------- 默认系统提示词（agent 风格，可被设置覆盖） ---------- */
  const DEFAULT_SYSTEM_PROMPT = `你是一个帮助我精读文献的轻量级研究助手（agent）。我会把**整篇文献全文**作为上下文发给你，并在提问时用【选中段落】标出我正在看的部分。

## 你的能力
1. 问答：基于整篇文献作答（解释概念、概括方法、分析结果、评价局限、翻译等）。重点关注【选中段落】，但可以引用全文任何位置。
2. 联网检索：你可以调用工具 web_search(query) 搜索互联网，用来核实事实、查找相关背景/最新研究/术语解释。

## 工具使用规则
- 需要最新或外部信息、原文里没有提到的内容、或者我明确说"搜索一下"时，调用 web_search。
- web_search 一次只查一个主题，query 用简洁关键词（中英文均可）。
- 检索结果只是参考资料，不要虚构；无法确认的信息要明说。

## 回答要求
- 一律用简体中文回答，除非我明确要求其他语言。
- 公式一律用 LaTeX 书写：行内用 \\(...\\)，独立成行用 $$...$$。
- 先基于原文作答，再补充你自己的知识或检索结果。
- 引用原文时用引号并说明位置（第几节 / 第几个公式）。
- 结构化输出：可用小标题、列表；不要空话套话。`;

  /* ---------- web_search 工具实现（无需 API Key 的公开搜索引擎） ---------- */
  async function webSearch(query) {
    const results = [];
    try {
      // 使用 DuckDuckGo HTML 接口，无需 Key，轻量
      const url =
        "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      const html = await resp.text();
      // 用正则尽可能简单抽取结果条目
      const re =
        /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) !== null && results.length < 5) {
        let link = m[1];
        // 解码 DuckDuckGo 跳转链接
        const uddg = link.match(/uddg=([^&]+)/);
        if (uddg) link = decodeURIComponent(uddg[1]);
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        const snippet = m[3].replace(/<[^>]+>/g, "").trim();
        if (title) results.push({ title, url: link, snippet });
      }
    } catch (e) {
      if (Zotero && Zotero.logError) {
        Zotero.logError(`AskGPT web_search 失败: ${e}`);
      }
    }
    return results;
  }

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "在互联网上检索信息，用于核实事实、查找相关背景、最新研究或术语解释。输入需要搜索的关键词。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词，简洁准确，中英文均可",
            },
          },
          required: ["query"],
        },
      },
    },
  ];

  /* ---------- 状态 ---------- */
  let messages = []; // 本次会话追加的消息（不含前缀）
  let sessionBase = null; // 固定前缀 [system, 全文]（来自主进程会话）
  let sessionKey = ""; // 当前文章会话的 key（附件路径 / 选中文字指纹）
  let controller = null; // AbortController 用于停止
  let busy = false;

  // 整篇文献（主进程读取后推送过来）——始终作为固定前缀发送
  let paperText = "";
  let paperLabel = "";
  let paperChars = 0;
  let paperTruncated = false;
  let paperTitle = "";
  let paperLoading = false;
  // 当前选中段落——只作为「本次问题的焦点」，不会顶掉全文
  let focusSel = "";
  // 前缀是从哪份文本建的（全文晚到 / 被编辑过时要作废重建）
  let sessionBaseText = "";
  // 全文预览缓存（避免每次选中变化都重渲染 10 万字）
  let fullRenderKey = "";
  let lastStreamRender = 0;

  /* ---------- 主进程会话存取 ---------- */
  // 会话存在 Zotero.AskGPT.data.sessions[sessionKey]，面板隐藏再开不丢。
  // 面板是主窗口内的 iframe，通过 frameElement.ownerGlobal 拿主窗口的 Zotero。
  function getAskGPT() {
    try {
      // iframe 内：frameElement.ownerGlobal 是 Zotero 主窗口
      const owner =
        window.frameElement && window.frameElement.ownerGlobal
          ? window.frameElement.ownerGlobal
          : null;
      if (owner && owner.Zotero && owner.Zotero.AskGPT) {
        return owner.Zotero.AskGPT;
      }
      // 兜底：独立窗口模式（旧）
      if (
        window.opener &&
        window.opener.Zotero &&
        window.opener.Zotero.AskGPT
      ) {
        return window.opener.Zotero.AskGPT;
      }
      if (Zotero && Zotero.AskGPT) return Zotero.AskGPT;
      return null;
    } catch (e) {
      return null;
    }
  }
  function loadSession(session) {
    // 从主进程会话恢复：前缀 + 历史
    sessionKey = (session && session.key) || "";
    sessionBase = (session && session.base) || null;
    sessionBaseText = sessionBase
      ? (session && session.baseText) || (session && session.contextText) || ""
      : "";
    messages = (session && session.history) || [];
    // 主进程会话里带着上次读到的全文（面板重开时不必等重新读盘）
    if (!paperText && session && session.contextText) {
      paperText = session.contextText;
      paperLabel = session.contextLabel || "";
      paperChars = paperText.length;
      fullRenderKey = "";
    }
    if (!paperTitle && session && session.itemTitle) {
      paperTitle = session.itemTitle;
    }
    // 恢复 UI 历史（user/assistant 气泡，跳过 tool 轮）
    el.messages.innerHTML = "";
    el.emptyTip.style.display = messages.length ? "none" : "";
    for (const m of messages) {
      if (m.role === "user") {
        appendMessage(
          "user",
          m.q || m.content || "",
          false,
          m.focus ? "含选中段落" : "",
        );
      } else if (m.role === "assistant" && m.content) {
        const ui = appendMessage("assistant", m.content, false);
        if (ui && ui.bubble) ui.bubble.innerHTML = renderMarkdown(m.content);
      }
    }
    el.messages.scrollTop = el.messages.scrollHeight;
    // 前缀重建（同文章会话恢复后前缀应保持）
    if (!sessionBase) {
      sessionBase = buildSessionBaseFromState(session);
      if (session) session.base = sessionBase;
    }
  }
  function persistSession() {
    const g = getAskGPT();
    if (!g || !g.data || !sessionKey) return;
    if (!g.data.sessions) g.data.sessions = {};
    // 合并写回：主进程在同一个 session 上还存了 contextText / selection 等字段，
    // 不能被面板覆盖掉
    const prev = g.data.sessions[sessionKey] || {};
    const patch = {
      key: sessionKey,
      base: sessionBase,
      baseText: sessionBaseText,
      history: messages,
      selection: focusSel,
      itemTitle: paperTitle || prev.itemTitle || "",
      chars: paperChars,
      truncated: paperTruncated,
      hasFullText: !!paperText,
    };
    // 没读到全文时不要把主进程写好的 contextText 抹掉
    if (paperText) {
      patch.contextText = paperText;
      patch.contextLabel = paperLabel;
    }
    g.data.sessions[sessionKey] = Object.assign({}, prev, patch);
  }
  function buildSessionBaseFromState(session) {
    const contextText =
      (session && session.contextText) || paperText || focusSel || "";
    if (!contextText) return null;
    return makeSessionBase(contextText);
  }
  /** 固定前缀 = system + 整篇文献（同一篇文献反复提问前缀不变 → API 前缀缓存命中） */
  function makeSessionBase(contextText) {
    sessionBaseText = contextText;
    const sysText = el.setSys.value.trim() || DEFAULT_SYSTEM_PROMPT;
    return [
      { role: "system", content: sysText },
      {
        role: "user",
        content:
          `【文献原文】\n\`\`\`\n${contextText}\n\`\`\`\n\n` +
          `请记住以上文献内容。我后续的每一个问题都基于这篇文献，你只需针对我的问题作答，不需要重复说明上下文。`,
      },
    ];
  }
  function buildSessionBase() {
    // 固定前缀一律用整篇文献（而不是当前显示的选中文字）：
    // 同一篇文献反复提问前缀不变 → API 前缀缓存持续命中
    let contextText = paperText || focusSel || "";
    contextText = (contextText || "").trim();
    if (!contextText) return null;
    return makeSessionBase(contextText);
  }

  function sessionFingerprint() {
    // 上下文的指纹：用整篇文献的前 200 字符 + 长度
    const t = paperText || focusSel || "";
    return t.slice(0, 200) + ":" + t.length;
  }

  /* ---------- DOM ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    modelBadge: $("model-badge"),
    settings: $("settings"),
    ctxText: $("context-text"),
    ctxItem: $("context-item"),
    ctxEdit: $("context-edit"),
    ctxCollapse: $("ctx-collapse"),
    ctxMeta: $("context-meta"),
    ctxWarn: $("context-warn"),
    ctxFocus: $("context-focus"),
    ctxFocusWrap: $("context-focus-wrap"),
    ctxFullLabel: $("context-full-label"),
    ctxHint: $("context-hint"),
    tagPaper: $("tag-paper"),
    tagFocus: $("tag-focus"),
    focusClear: $("focus-clear"),
    input: $("input"),
    btnSend: $("btn-send"),
    btnStop: $("btn-stop"),
    messages: $("messages"),
    emptyTip: $("empty-tip"),
    statusline: $("statusline"),
    // 设置项
    setBase: $("set-base"),
    setKey: $("set-key"),
    setModel: $("set-model"),
    setTemp: $("set-temp"),
    setSys: $("set-sys"),
    setCtxSrc: $("set-ctx-src"),
    setWeb: $("set-web"),
    saveStatus: $("save-status"),
  };

  /* ---------- 设置 ---------- */
  function loadSettings() {
    el.setBase.value = getPref("baseURL", "https://api.deepseek.com");
    el.setKey.value = getPref("apiKey", "");
    el.setModel.value = getPref("model", "deepseek-chat");
    el.setTemp.value = getPref("temperature", 0.3);
    let sys = String(getPref("systemPrompt", DEFAULT_SYSTEM_PROMPT) || "");
    // 老版本的默认提示词没有「整篇文献 + LaTeX 输出」要求，自动升级；
    // 用户自己改过的提示词（不含老默认特征句）保持不动
    if (sys.includes("你的任务基于我提供的") && !sys.includes("整篇文献全文")) {
      sys = DEFAULT_SYSTEM_PROMPT;
      setPref("systemPrompt", sys);
    }
    el.setSys.value = sys;
    el.setCtxSrc.value = getPref("contextSource", "auto");
    el.setWeb.checked = getPref("webSearch", true) !== false;
    updateBadge();
  }
  function saveSettings() {
    setPref("baseURL", el.setBase.value.trim());
    setPref("apiKey", el.setKey.value.trim());
    setPref("model", el.setModel.value.trim());
    setPref("temperature", parseFloat(el.setTemp.value) || 0.3);
    setPref("systemPrompt", el.setSys.value);
    setPref("contextSource", el.setCtxSrc.value || "auto");
    setPref("webSearch", el.setWeb.checked);
    el.saveStatus.textContent = "✓ 已保存（来源改动下次打开面板生效）";
    setTimeout(() => (el.saveStatus.textContent = ""), 1500);
    updateBadge();
  }
  function updateBadge() {
    el.modelBadge.textContent = el.setModel.value.trim() || "…";
  }

  /* ---------- 上下文来源（整篇文献 + 选中段落） ---------- */
  // 主进程契约：refresh(payload)
  //   payload = { loading, selection, itemTitle, contextText, contextLabel,
  //               contextChars, truncated, session }
  // 兼容旧调用：若传入字符串，直接当作 selection
  function getPopupState() {
    try {
      return (
        (Zotero &&
          Zotero.AskGPT &&
          Zotero.AskGPT.data &&
          Zotero.AskGPT.data.popupState) ||
        null
      );
    } catch (e) {
      return null;
    }
  }

  function refresh(payload) {
    let selection = "";
    let itemTitle = "";
    let contextText = "";
    let contextLabel = "";
    let contextChars = 0;
    let truncated = false;
    let loading = false;
    let session = null;

    const ps = getPopupState();

    if (typeof payload === "string") {
      selection = payload;
      itemTitle = (ps && ps.itemTitle) || "";
      session = (ps && ps.session) || null;
    } else if (payload && typeof payload === "object") {
      selection = payload.selection || "";
      itemTitle = payload.itemTitle || "";
      contextText = payload.contextText || "";
      contextLabel = payload.contextLabel || "";
      contextChars = payload.contextChars || contextText.length;
      truncated = !!payload.truncated;
      loading = !!payload.loading;
      session = payload.session || null;
    } else if (ps) {
      // 无参调用：回退到主进程共享状态
      if (typeof ps.selection === "string") selection = ps.selection;
      if (typeof ps.itemTitle === "string") itemTitle = ps.itemTitle;
      if (typeof ps.contextText === "string") contextText = ps.contextText;
      if (typeof ps.contextLabel === "string") contextLabel = ps.contextLabel;
      if (ps.contextChars) contextChars = ps.contextChars;
      if (ps.truncated) truncated = true;
      if (ps.loading) loading = true;
      if (ps.session) session = ps.session;
    }

    // 整篇文献：读到才更新；loading 阶段保留上一次的内容，界面不闪
    if (contextText) {
      if (contextText !== paperText) {
        fullRenderKey = "";
        // 全文晚到或被替换：之前可能用选中段落建过前缀，作废重建（历史保留）
        if (sessionBase && sessionBaseText && sessionBaseText !== contextText) {
          sessionBase = null;
          sessionBaseText = "";
        }
      }
      paperText = contextText;
      paperLabel = contextLabel || paperLabel;
      paperChars = contextChars || contextText.length;
      paperTruncated = truncated;
    }
    if (itemTitle) paperTitle = itemTitle;
    paperLoading = loading;
    if (selection) focusSel = String(selection).trim();

    // 先恢复会话（可能带回上次的全文），再刷新上下文卡片
    loadSession(session);
    updateContextView();
  }

  /** 把「整篇文献 + 选中段落」的状态画到上下文卡片 */
  function updateContextView() {
    el.tagPaper.classList.toggle("hidden", !paperText);
    el.tagFocus.classList.toggle("hidden", !focusSel);
    if (focusSel) {
      const n = focusSel.length;
      el.tagFocus.textContent =
        "选中段落 " + (n > 999 ? Math.round(n / 1000) + "k" : n) + " 字";
    }

    if (paperLoading) {
      el.ctxMeta.textContent = "⏳ 正在读取整篇文献…";
    } else if (paperText) {
      el.ctxMeta.textContent =
        (paperLabel ? paperLabel + " · " : "") +
        paperChars.toLocaleString() +
        " 字" +
        (paperTruncated ? "（已截断）" : "");
    } else {
      el.ctxMeta.textContent = "";
    }

    el.ctxItem.textContent = paperTitle ? "📄 " + paperTitle : "";

    if (!paperLoading && !paperText) {
      el.ctxWarn.textContent =
        "未读到文献全文（扫描版 PDF / 未选中条目？）——本次只会发送选中段落。";
      el.ctxWarn.classList.remove("hidden");
    } else {
      el.ctxWarn.classList.add("hidden");
    }

    // 当前选中段落
    el.ctxFocusWrap.classList.toggle("hidden", !focusSel);
    if (focusSel) el.ctxFocus.innerHTML = renderContextText(focusSel);

    // 全文预览：内容变了才重渲染（十万字重排很贵，选中变化时不做）
    const key = paperText
      ? paperText.length + ":" + paperText.slice(0, 48)
      : "";
    if (key !== fullRenderKey) {
      fullRenderKey = key;
      setContextText(paperText || focusSel || "");
    }

    el.ctxFullLabel.textContent = paperText
      ? "全文（已作为上下文发送给 AI）"
      : focusSel
        ? "选中段落（作为上下文发送）"
        : "上下文";
  }

  /* ---------- 渲染（轻量 markdown） ---------- */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // LaTeX 风格上下标（^x / ^{x} / _x / _{x}）→ 视觉上标/下标
  function applyScripts(t) {
    t = t.replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>");
    t = t.replace(/\^([^\s^{}()（）,;；。，]+)/g, "<sup>$1</sup>");
    t = t.replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>");
    t = t.replace(/_([^\s_{}()（）,;；。，]+)/g, "<sub>$1</sub>");
    return t;
  }
  // 上下文原文区渲染：真公式（KaTeX）+ 其余原样；渲染器不可用时退回上下标兜底
  function renderContextText(text) {
    const R = window.AskGPTRender;
    if (R && R.renderPlainWithMath) {
      try {
        return R.renderPlainWithMath(text || "");
      } catch (e) {}
    }
    return applyScripts(escapeHtml(text || ""));
  }
  function setContextText(text) {
    el.ctxText.innerHTML = renderContextText(text);
    el.ctxText.title = text || "";
  }

  /**
   * AI 回答渲染：优先用 mathrender.js（markdown-it + KaTeX，随插件离线打包），
   * 拿不到（vendor 没加载）时退回内置的极简渲染，保证不白屏。
   */
  function renderMarkdown(text) {
    const R = window.AskGPTRender;
    if (R && R.renderMarkdown) {
      try {
        return R.renderMarkdown(text || "");
      } catch (e) {
        if (Zotero && Zotero.logError) Zotero.logError(e);
      }
    }
    return renderMarkdownFallback(text);
  }

  function renderMarkdownFallback(text) {
    let src = String(text || "").replace(/\r\n?/g, "\n");
    const codeBlocks = [];
    const inlineCodes = [];
    const formulas = [];
    let body = src;
    // 1. 代码块占位（内部语法不被后续正则破坏）
    body = body.replace(/```(\w*)[^\n]*\n?([\s\S]*?)```/g, (_m, lang, code) => {
      codeBlocks.push(`<pre class="md-code">${escapeHtml(code.trim())}</pre>`);
      return "@@CB" + (codeBlocks.length - 1) + "@@";
    });
    // 2. 行内代码占位（避免上下标转换破坏代码内容）
    body = body.replace(/`([^`\n]+)`/g, (_m, c) => {
      inlineCodes.push(`<span class="md-inline-code">${escapeHtml(c)}</span>`);
      return "@@IC" + (inlineCodes.length - 1) + "@@";
    });
    // 3. 归一化标题写法（代码已占位，改不到代码内容）：模型常把 ### 写在同一行 / 缩进 4 空格
    body = body
      .replace(/^[ \t]{2,}(#{1,6}[ \t])/gm, "$1")
      .replace(/([^\n#\\])([ \t]*)(#{2,6})(?=[ \t]|\d|$)/g, "$1\n$3")
      .replace(/(^|\n)(#{1,6})(?=[^ \t\n#])/g, "$1$2 ")
      .replace(/\u00a0/g, " ");
    // 4. 块级公式 $$...$$ 占位
    body = body.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner) => {
      formulas.push(
        `<div class="md-formula">${applyScripts(escapeHtml(inner.trim()))}</div>`,
      );
      return "@@FB" + (formulas.length - 1) + "@@";
    });
    // 4. 转义
    let t = escapeHtml(body);
    // 5. 表格（表头 + 分隔行 + 数据行）
    t = t.replace(/((?:^\|[^\n]*\|\n?)+)/gm, (block) => {
      const rows = block
        .trim()
        .split("\n")
        .map((r) => r.trim());
      if (rows.length < 2) return block;
      const hasSep = rows[1] && /^\|[\s:|-]*\|$/.test(rows[1]);
      if (!hasSep) return block;
      const mk = (r, isHead) => {
        const tag = isHead ? "th" : "td";
        return (
          "<tr>" +
          r
            .slice(1, -1)
            .split("|")
            .map((c) => `<${tag}>${c.trim() || "&nbsp;"}</${tag}>`)
            .join("") +
          "</tr>"
        );
      };
      return (
        "<table><thead>" +
        mk(rows[0], true) +
        "</thead><tbody>" +
        rows
          .slice(2)
          .map((r) => mk(r, false))
          .join("") +
        "</tbody></table>\n"
      );
    });
    // 6. 水平线
    t = t.replace(/^-\s*$/gm, "<hr/>");
    // 7. 标题
    t = t.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    t = t.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    t = t.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    // 8. 引用
    t = t.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
    // 9. 行内公式 $...$
    t = t.replace(/\$([^$\n]+)\$/g, (_m, inner) => applyScripts(inner));
    // 10. 删除线
    t = t.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    // 11. 链接
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank">$1</a>',
    );
    // 12. 粗体 / 斜体 / 上下标
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    t = applyScripts(t);
    // 13. 列表（裸 li，CSS 自绘圆点）
    t = t.replace(/(^|\n)-\s+(.*)/g, "$1<li>$2</li>");
    t = t.replace(/(^|\n)[ ]?(\d+)[.、]\s+(.*)/g, "$1<li>$3</li>");
    // 14. 还原占位（行内代码 / 代码块 / 块级公式）
    t = t.replace(/@@IC(\d+)@@/g, (_m, i) => inlineCodes[+i]);
    t = t.replace(/@@CB(\d+)@@/g, (_m, i) => codeBlocks[+i]);
    t = t.replace(/@@FB(\d+)@@/g, (_m, i) => formulas[+i]);
    return t;
  }
  function appendMessage(role, text, isStream, tag) {
    el.emptyTip.style.display = "none";
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}` + (isStream ? " streaming" : "");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") {
      bubble.innerHTML = renderMarkdown(text) || "…";
      enhanceScripts(bubble);
    } else {
      bubble.textContent = text;
    }
    wrap.appendChild(bubble);
    if (tag) {
      const t = document.createElement("span");
      t.className = "msg-tag";
      t.textContent = tag;
      wrap.appendChild(t);
    }
    el.messages.appendChild(wrap);
    el.messages.scrollTop = el.messages.scrollHeight;
    return { wrap, bubble };
  }

  /** 裸上下标兜底（F_t / J^T）；KaTeX 已渲染的部分会自动跳过 */
  function enhanceScripts(root) {
    const R = window.AskGPTRender;
    if (R && R.enhanceScripts) {
      try {
        R.enhanceScripts(root);
      } catch (e) {}
    }
  }

  /* ---------- 流式请求（OpenAI 兼容） ---------- */
  function buildEndpoint() {
    let base = (el.setBase.value || "https://api.deepseek.com")
      .trim()
      .replace(/\/+$/, "");
    // 若 base 已经以 /chat/completions 结尾则直接用
    if (base.endsWith("/chat/completions")) return base;
    // OpenAI 兼容接口统一补 /v1：硅基流动等厂商必须 /v1/chat/completions，
    // DeepSeek 官方 /v1 路径同样支持（默认 https://api.deepseek.com → /v1/chat/completions）
    if (base.endsWith("/v1")) return base + "/chat/completions";
    return base + "/v1/chat/completions";
  }

  // 解析 SSE 流
  async function streamChat(payload, onDelta, signal) {
    const endpoint = buildEndpoint();
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + el.setKey.value.trim(),
    };
    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    if (!resp.ok) {
      let detail = "";
      try {
        const j = await resp.json();
        detail = j.error && (j.error.message || JSON.stringify(j.error));
      } catch (e) {
        detail = await resp.text();
      }
      throw new Error(`HTTP ${resp.status}: ${detail || ""}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let toolCalls = {}; // index -> {name, arguments}
    let reasoning = ""; // DeepSeek 思考模式：reasoning_content 需原样回传
    let streamEnded = false;

    while (!streamEnded) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          streamEnded = true;
          break;
        }
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          continue;
        }
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        if (delta.content) onDelta(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            toolCalls[i] = toolCalls[i] || { name: "", arguments: "" };
            if (tc.function) {
              if (tc.function.name) toolCalls[i].name += tc.function.name;
              if (tc.function.arguments)
                toolCalls[i].arguments += tc.function.arguments;
            }
          }
        }
      }
    }
    const calls = Object.keys(toolCalls)
      .sort((a, b) => a - b)
      .map((k) => ({
        name: toolCalls[k].name,
        arguments: toolCalls[k].arguments,
      }));
    return { toolCalls: calls, reasoning };
  }

  /** rAF 节流（环境缺少 rAF 时退回 setTimeout，避免整条回答失败） */
  function scheduleFrame(fn) {
    if (typeof window.requestAnimationFrame === "function") {
      return { raf: true, id: window.requestAnimationFrame(fn) };
    }
    return { raf: false, id: setTimeout(fn, 16) };
  }
  function cancelFrame(handle) {
    if (!handle) return;
    if (handle.raf && typeof window.cancelAnimationFrame === "function") {
      window.cancelAnimationFrame(handle.id);
    } else {
      clearTimeout(handle.id);
    }
  }

  /** 只保留 OpenAI 兼容接口认识的字段（q / focus 这类 UI 字段不能发出去） */
  function sanitizeMessages(list) {
    return (list || []).map((m) => {
      const out = { role: m.role };
      if (m.content !== undefined) out.content = m.content;
      if (m.tool_calls) out.tool_calls = m.tool_calls;
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
      if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
      return out;
    });
  }

  /* ---------- 主循环：问答 + 工具 ---------- */
  async function send(questionText) {
    if (busy) return;
    const q = (questionText != null ? questionText : el.input.value).trim();
    if (!q) return;
    if (!el.setKey.value.trim()) {
      setStatus("请先在上方 ⚙ 设置里填写 API Key");
      return;
    }
    if (!paperText && !focusSel) {
      setStatus("没有上下文：先在 Zotero 里打开文献（或选中条目）再提问");
      return;
    }

    // 会话已由 refresh/init 绑定（sessionKey/sessionBase），直接继续追加问题
    if (!sessionBase) {
      // 弹窗刚打开但前缀还没建（理论上 refresh 已建），兜底重建
      sessionBase = buildSessionBase();
    }

    busy = true;
    el.btnSend.disabled = true;
    el.btnSend.textContent = "发送中…";
    el.btnStop.classList.remove("hidden");
    el.input.value = "";
    const focus = (focusSel || "").trim();
    appendMessage("user", q, false, focus ? "含选中段落" : "");
    setStatus("思考中…");

    controller = new AbortController();

    // 追加本次问题（不动前缀，保持缓存命中）。
    // 选中段落作为「焦点」随问题一起发，全文仍在前缀里。
    const userContent = focus
      ? `【选中段落】\n${focus}\n\n【我的问题】\n${q}`
      : q;
    messages.push({
      role: "user",
      content: userContent,
      q,
      focus: focus || undefined,
    });

    const maxIter = 4;
    // 整个对话流程共用一个 assistant 气泡，避免工具轮产生空消息
    let ui = null;
    let acc = "";
    let accReasoning = ""; // DeepSeek 思考模式：累积并随消息回传
    let rafId = null;
    const renderAcc = () => {
      rafId = null;
      if (!ui) return;
      const now = Date.now();
      // KaTeX + Markdown 全量重渲染较贵，流式期间按 ~140ms 节流
      if (now - lastStreamRender < 140) return;
      lastStreamRender = now;
      ui.bubble.innerHTML =
        renderMarkdown(acc) + '<span class="cursor"></span>';
      el.messages.scrollTop = el.messages.scrollHeight;
    };
    const ensureBubble = () => {
      if (!ui) ui = appendMessage("assistant", "", true);
      return ui;
    };
    // 流结束/停止时：取消未执行的渲染任务并输出最终结果（不带游标）
    const finishRender = () => {
      if (rafId !== null) {
        cancelFrame(rafId);
        rafId = null;
      }
      if (ui) {
        ui.bubble.innerHTML = renderMarkdown(acc);
        enhanceScripts(ui.bubble);
        ui.wrap.classList.remove("streaming");
      }
    };

    try {
      // 请求消息 = 固定前缀（system+全文） + 会话追加的问题
      const model = el.setModel.value.trim() || "deepseek-chat";
      const temperature = parseFloat(el.setTemp.value) || 0.3;
      const useTools = el.setWeb.checked !== false;

      for (let iter = 0; iter < maxIter; iter++) {
        const onDelta = (d) => {
          acc += d;
          ensureBubble();
          // rAF 节流：一个动画帧内只渲染一次，避免每 token 全量重渲染
          if (rafId === null) {
            rafId = scheduleFrame(renderAcc);
          }
        };

        const payload = {
          model,
          temperature,
          stream: true,
          messages: sanitizeMessages(
            sessionBase ? [...sessionBase, ...messages] : messages,
          ),
        };
        if (useTools) payload.tools = TOOLS;

        const { toolCalls, reasoning } = await streamChat(
          payload,
          onDelta,
          controller.signal,
        );
        if (reasoning) accReasoning += reasoning;

        // 处理完所有 delta 后，渲染最终结果并去掉游标
        finishRender();

        if (toolCalls && toolCalls.length) {
          // 模型要调用工具
          setStatus(`正在联网搜索（第 ${iter + 1} 轮）…`);
          // 记录 assistant 的 tool_call 请求
          const assistantMsg = {
            role: "assistant",
            content: acc || null,
            tool_calls: toolCalls.map((tc, i) => ({
              id: `call_${i}_${iter}`,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments || "{}" },
            })),
          };
          if (accReasoning) assistantMsg.reasoning_content = accReasoning;
          messages.push(assistantMsg);

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            let result;
            try {
              const args = JSON.parse(tc.arguments || "{}");
              if (tc.name === "web_search") {
                const res = await webSearch(args.query || "");
                result = res.length
                  ? res
                      .map((r) => `- ${r.title} | ${r.url} | ${r.snippet}`)
                      .join("\n")
                  : "未搜索到结果，请尝试更换关键词。";
              } else {
                result = `未知工具: ${tc.name}`;
              }
            } catch (e) {
              result = "工具执行出错: " + e;
            }
            messages.push({
              role: "tool",
              tool_call_id: `call_${i}_${iter}`,
              content: result,
            });
            setStatus(`已获取 ${toolCalls.length} 项联网结果，继续…`);
          }
          // 进入下一轮，让模型基于工具结果继续生成
          continue;
        }

        // 正常结束：把回答写入会话历史并持久化
        const finalMsg = { role: "assistant", content: acc };
        if (accReasoning) finalMsg.reasoning_content = accReasoning;
        messages.push(finalMsg);
        persistSession();
        setStatus("");
        return;
      }
      setStatus("已达到最大工具调用次数。");
      persistSession();
    } catch (e) {
      if (e.name === "AbortError") {
        setStatus("已停止。");
        // 保留已输出的内容，移除游标
        finishRender();
        // 停止也保存已有内容
        if (acc) {
          const stopMsg = { role: "assistant", content: acc };
          if (accReasoning) stopMsg.reasoning_content = accReasoning;
          messages.push(stopMsg);
        }
        persistSession();
      } else {
        setStatus("出错了：" + (e.message || e));
        if (Zotero && Zotero.logError) Zotero.logError(e);
      }
    } finally {
      busy = false;
      el.btnSend.disabled = false;
      el.btnSend.textContent = "发送";
      el.btnStop.classList.add("hidden");
    }
  }

  function setStatus(t) {
    el.statusline.textContent = t || "";
  }

  /* ---------- 存为 Zotero 笔记 ---------- */
  // 取最后一条 AI 回答（.msg.assistant .bubble 的纯文本）与其对应问题，
  // 组装成 HTML 笔记（标题 h1 + 正文 p，换行转 <br/>），存为选中条目的子笔记或独立笔记。
  async function saveLastAnswerAsNote() {
    const z = getZotero();
    if (!z) {
      setStatus("无法连接 Zotero");
      return;
    }
    const assistantMsgs = el.messages.querySelectorAll(".msg.assistant");
    const lastAssistant = assistantMsgs.length
      ? assistantMsgs[assistantMsgs.length - 1]
      : null;
    if (!lastAssistant) {
      setStatus("还没有可保存的回答");
      return;
    }
    const bubble = lastAssistant.querySelector(".bubble");
    const answer = (bubble ? bubble.textContent : "").trim();
    if (!answer) {
      setStatus("还没有可保存的回答");
      return;
    }
    // 问题：最后一条用户消息的纯文本，取前 40 字
    const userMsgs = el.messages.querySelectorAll(".msg.user");
    let question = "";
    if (userMsgs.length) {
      question = (userMsgs[userMsgs.length - 1].textContent || "").trim();
    }
    const qChars = Array.from(question);
    const qShort =
      qChars.length > 40 ? qChars.slice(0, 40).join("") + "…" : question;

    // 组装笔记 HTML：所有用户内容先转义（& < >），防注入
    const html =
      "<h1>AskGPT 问答：" +
      escapeHtml(qShort) +
      "</h1>" +
      "<p>" +
      escapeHtml(answer).replace(/\n/g, "<br/>") +
      "</p>";

    try {
      const pane = z.getActiveZoteroPane();
      const items = pane ? pane.getSelectedItems() : [];
      const note = new z.Item("note");
      if (items.length) {
        // 存为选中条目（任意类型）的子笔记
        const parent = items[0];
        note.libraryID = parent.libraryID;
        note.parentID = parent.id;
        note.setNote(html);
        await note.saveTx();
        let parentTitle = String(parent.id);
        try {
          const t = parent.getDisplayTitle ? parent.getDisplayTitle() : null;
          parentTitle = t || parent.getField("title") || parent.id;
        } catch (e) {}
        setStatus("✓ 已保存到 Zotero 笔记（父条目：" + parentTitle + "）");
      } else {
        // 无选中条目：存为本文库独立笔记
        note.libraryID = z.Libraries.userLibraryID;
        note.setNote(html);
        await note.saveTx();
        setStatus("✓ 已保存为独立笔记");
      }
    } catch (e) {
      setStatus("保存失败：" + ((e && e.message) || e));
      try {
        z.logError(e);
      } catch (e2) {}
    }
  }

  function stop() {
    if (controller) controller.abort();
  }

  function clearConversation() {
    el.messages.innerHTML = "";
    el.emptyTip.style.display = "";
    messages = [];
    sessionBase = null;
    // 同步清主进程会话（该文章的缓存重置）
    const g = getAskGPT();
    if (g && g.data && g.data.sessions && sessionKey) {
      delete g.data.sessions[sessionKey];
    }
    setStatus("");
  }

  /* ---------- 实时选中同步（事件驱动） ---------- */
  // 主进程 selectionchange 防抖后主动调用本方法，弹窗无需轮询。
  //
  // 关键语义：选中只是「本次提问的焦点」，不会顶掉整篇文献，
  // 也不会清空会话历史（旧版本在这里把上下文换成选中文字，
  // 于是"整篇论文从没进过上下文"）。
  function updateLiveSelection(newSel) {
    try {
      newSel = (newSel || "").toString().trim();
      if (!newSel) return;
      // 用户手动编辑原文框时不覆盖
      const editing = el.ctxEdit && el.ctxEdit.style.display !== "none";
      if (editing) return;
      if (newSel === (focusSel || "").trim()) return;
      focusSel = newSel;
      updateContextView();
      persistSession();
      setStatus("");
    } catch (e) {}
  }

  /** 面板内框选文字（上下文卡片 / AI 回答里）→ 作为本次提问的选中段落 */
  function capturePanelSelection() {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      if (!sel || sel.isCollapsed) return;
      const text = (sel.toString() || "").trim();
      if (!text || text.length > 8000) return;
      const node = sel.anchorNode;
      const host =
        node && node.nodeType === 1 ? node : node ? node.parentElement : null;
      if (host && host.closest) {
        if (host.closest("#input, #settings, input, textarea, #statusline")) {
          return;
        }
      }
      if (text === (focusSel || "").trim()) return;
      focusSel = text;
      updateContextView();
      persistSession();
    } catch (e) {}
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $("btn-send").addEventListener("click", () => send());
    $("btn-settings").addEventListener("click", () => {
      el.settings.classList.toggle("hidden");
    });
    $("btn-new").addEventListener("click", clearConversation);
    $("askgpt-save-btn").addEventListener("click", saveLastAnswerAsNote);
    $("btn-save").addEventListener("click", saveSettings);
    el.btnStop.addEventListener("click", stop);
    el.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
      }
    });
    // 面板里框选文字（上下文卡片 / AI 回答）→ 自动成为「选中段落」
    document.addEventListener("mouseup", () => {
      // 等浏览器把选区更新完
      setTimeout(capturePanelSelection, 0);
    });
    if (el.focusClear) {
      el.focusClear.addEventListener("click", () => {
        focusSel = "";
        updateContextView();
        persistSession();
      });
    }
    document.querySelectorAll(".chip").forEach((c) => {
      c.addEventListener("click", () => send(c.dataset.q));
    });
    el.ctxCollapse.addEventListener("click", () => {
      const body = $("context-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "" : "none";
      el.ctxCollapse.textContent = hidden ? "收起 ▴" : "展开 ▾";
    });
    el.ctxText.addEventListener("dblclick", () => {
      // 用 title（原始纯文本）填充编辑框，避免上下标标记丢失
      el.ctxEdit.value = el.ctxText.title || el.ctxText.textContent;
      el.ctxEdit.style.display = "";
      el.ctxText.style.display = "none";
      el.ctxEdit.focus();
    });
    el.ctxEdit.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        el.ctxEdit.style.display = "none";
        el.ctxText.style.display = "";
        // 手动编辑过的上下文就是要发给 AI 的上下文
        paperText = el.ctxEdit.value;
        paperChars = paperText.length;
        sessionBase = null;
        sessionBaseText = "";
        fullRenderKey = "";
        updateContextView();
        persistSession();
      }
    });
    // Esc 隐藏面板（调主进程隐藏 iframe）
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        try {
          const g = getAskGPT();
          if (g && g.hidePopup) g.hidePopup();
        } catch (e) {}
      }
    });
  }

  /* ---------- 对外接口（供 index.js 复用窗口时调用） ---------- */
  window.AskGPTPopup = {
    refresh,
    send,
    clearConversation,
    saveNote: saveLastAnswerAsNote,
    updateLiveSelection,
    capturePanelSelection,
    // 调试用：渲染器是否就绪（markdown-it / KaTeX 是否加载成功）
    rendererReady() {
      const R = window.AskGPTRender;
      return R && R.ready ? R.ready : { markdown: false, katex: false };
    },
  };

  // 启动
  document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    bindEvents();
    refresh();
    el.input.focus();
    // 渲染依赖自检：加载失败时提示（不至于静默退回极简渲染）
    try {
      const R = window.AskGPTRender;
      if (!R || !R.ready || !R.ready.katex || !R.ready.markdown) {
        const miss = [];
        if (!R || !R.ready || !R.ready.markdown) miss.push("markdown-it");
        if (!R || !R.ready || !R.ready.katex) miss.push("KaTeX");
        setStatus(
          "渲染依赖未加载：" + miss.join(" / ") + "（公式会以源码显示）",
        );
      }
    } catch (e) {}
  });
})();
