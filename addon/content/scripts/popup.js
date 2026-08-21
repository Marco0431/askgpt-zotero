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
        Components?.classes?.["@mozilla.org/appshell/window-browser;1"]?.getService(
          Components.interfaces.nsIWindowMediator
        );
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
  const DEFAULT_SYSTEM_PROMPT =
`你是一个帮助我精读文献的轻量级研究助手（agent）。你的任务基于我提供的"选中的文献原文"，回答我的问题。

## 你的能力
1. 问答：基于选中原文 + 你的知识，回答关于这篇文献的任何问题（解释概念、概括方法、分析结果、评价局限、翻译等）。
2. 联网检索：你可以调用工具 web_search(query) 搜索互联网，用来核实事实、查找相关背景/最新研究/术语解释。

## 工具使用规则
- 需要最新或外部信息、原文里没有提到的内容、或者我明确说"搜索一下"时，调用 web_search。
- web_search 一次只查一个主题，query 用简洁关键词（中英文均可）。
- 检索结果只是参考资料，不要虚构；无法确认的信息要明说。

## 回答要求
- 一律用简体中文回答，除非我明确要求其他语言。
- 先基于原文作答，再补充你自己的知识或检索结果。
- 引用原文时用引号并说明出处（如"原文第几部分"），能对应的话用我的原文原话。
- 结构化输出：可用小标题、列表；不要空话套话。
- 若你用到了联网搜索，在相关位置标注（来源: 网址）。`;

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
      if (window.opener && window.opener.Zotero && window.opener.Zotero.AskGPT) {
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
    messages = (session && session.history) || [];
    // 恢复 UI 历史（user/assistant 气泡，跳过 tool 轮）
    el.messages.innerHTML = "";
    el.emptyTip.style.display = messages.length ? "none" : "";
    for (const m of messages) {
      if (m.role === "user") {
        appendMessage("user", m.content || "");
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
    g.data.sessions[sessionKey] = {
      key: sessionKey,
      base: sessionBase,
      history: messages,
    };
  }
  function buildSessionBaseFromState(session) {
    const contextText = session && session.contextText ? session.contextText : "";
    if (!contextText) return null;
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
    // 从当前上下文构建固定前缀：system + 全文（或选中文字）
    let contextText = el.ctxEdit.style.display !== "none" ? el.ctxEdit.value : el.ctxText.textContent;
    contextText = (contextText || "").trim();
    if (!contextText) return null;
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

  function sessionFingerprint() {
    // 上下文的指纹：用当前显示的文本前 200 字符 + 长度
    const t =
      el.ctxEdit.style.display !== "none"
        ? el.ctxEdit.value
        : el.ctxText.textContent;
    return (t || "").slice(0, 200) + ":" + (t || "").length;
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
    setWeb: $("set-web"),
    saveStatus: $("save-status"),
  };

  /* ---------- 设置 ---------- */
  function loadSettings() {
    el.setBase.value = getPref("baseURL", "https://api.deepseek.com");
    el.setKey.value = getPref("apiKey", "");
    el.setModel.value = getPref("model", "deepseek-chat");
    el.setTemp.value = getPref("temperature", 0.3);
    el.setSys.value = getPref("systemPrompt", DEFAULT_SYSTEM_PROMPT);
    el.setWeb.checked = getPref("webSearch", true) !== false;
    updateBadge();
  }
  function saveSettings() {
    setPref("baseURL", el.setBase.value.trim());
    setPref("apiKey", el.setKey.value.trim());
    setPref("model", el.setModel.value.trim());
    setPref("temperature", parseFloat(el.setTemp.value) || 0.3);
    setPref("systemPrompt", el.setSys.value);
    setPref("webSearch", el.setWeb.checked);
    el.saveStatus.textContent = "✓ 已保存";
    setTimeout(() => (el.saveStatus.textContent = ""), 1500);
    updateBadge();
  }
  function updateBadge() {
    el.modelBadge.textContent = el.setModel.value.trim() || "…";
  }

  /* ---------- 选中文本 / 上下文来源 ---------- */
  // 新契约：refresh(payload)，payload = { selection, itemTitle, contextText, contextLabel }
  // 兼容旧调用：若传入字符串，直接当作 selection
  function refresh(payload) {
    let selection = "";
    let itemTitle = "";
    let contextText = "";
    let contextLabel = "";
    let session = null;

    if (typeof payload === "string") {
      selection = payload;
      itemTitle =
        (Zotero && Zotero.AskGPT && Zotero.AskGPT.data &&
          Zotero.AskGPT.data.popupState &&
          Zotero.AskGPT.data.popupState.itemTitle) || "";
      session =
        (Zotero && Zotero.AskGPT && Zotero.AskGPT.data &&
          Zotero.AskGPT.data.popupState &&
          Zotero.AskGPT.data.popupState.session) || null;
    } else if (payload && typeof payload === "object") {
      selection = payload.selection || "";
      itemTitle = payload.itemTitle || "";
      contextText = payload.contextText || "";
      contextLabel = payload.contextLabel || "";
      session = payload.session || null;
    } else if (Zotero && Zotero.AskGPT) {
      // 无参调用：回退到 Zotero.AskGPT.data.popupState（模板结构）
      const ps =
        Zotero.AskGPT.data && Zotero.AskGPT.data.popupState
          ? Zotero.AskGPT.data.popupState
          : null;
      if (ps) {
        if (typeof ps.selection === "string") selection = ps.selection;
        if (typeof ps.itemTitle === "string") itemTitle = ps.itemTitle;
        if (typeof ps.contextText === "string") contextText = ps.contextText;
        if (typeof ps.contextLabel === "string") contextLabel = ps.contextLabel;
        if (ps.session) session = ps.session;
      }
    }

    if (contextText) {
      // 无 PDF 选中时读到附件全文：显示全文并标注来源
      el.ctxText.textContent = contextText;
      el.ctxText.title = contextText;
      const parts = [];
      if (contextLabel) parts.push(contextLabel);
      if (itemTitle) parts.push(itemTitle);
      el.ctxItem.textContent = parts.length ? "来源：" + parts.join(" · ") : "";
    } else {
      // 默认：PDF 选中文字，来源为条目标题
      el.ctxText.textContent = selection;
      el.ctxText.title = selection;
      el.ctxItem.textContent = itemTitle || "";
    }

    // 绑定主进程会话：同一篇文章恢复历史（弹窗关闭再开不丢）
    loadSession(session);
  }

  /* ---------- 渲染（轻量 markdown） ---------- */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function renderMarkdown(text) {
    // 极简渲染：代码块、行内代码、粗体、列表、链接、（尽量保持原样）
    let t = escapeHtml(text || "");
    t = t.replace(/```([\s\S]*?)```/g, (_a, code) => `<code class="md-code">${code.trim()}</code>`);
    t = t.replace(/`([^`\n]+)`/g, (_a, c) => `<span class="md-inline-code">${c}</span>`);
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    t = t.replace(/(^|\n)- (.*)/g, "$1<li>$2</li>");
    t = t.replace(/(^|\n)  (\d+)[.、] (.*)/g, "$1<li>$3</li>");
    return t;
  }
  function appendMessage(role, text, isStream) {
    el.emptyTip.style.display = "none";
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}` + (isStream ? " streaming" : "");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") bubble.innerHTML = renderMarkdown(text) || "…";
    else bubble.textContent = text;
    wrap.appendChild(bubble);
    el.messages.appendChild(wrap);
    el.messages.scrollTop = el.messages.scrollHeight;
    return { wrap, bubble };
  }

  /* ---------- 流式请求（OpenAI 兼容） ---------- */
  function buildEndpoint() {
    let base = (el.setBase.value || "https://api.deepseek.com").trim().replace(/\/+$/, "");
    // 若 base 已经以 /chat/completions 结尾则直接用
    if (base.endsWith("/chat/completions")) return base;
    return base + "/chat/completions";
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
        if (delta.content) onDelta(delta.content);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index || 0;
            toolCalls[i] = toolCalls[i] || { name: "", arguments: "" };
            if (tc.function) {
              if (tc.function.name) toolCalls[i].name += tc.function.name;
              if (tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
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
    return { toolCalls: calls };
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
    if (!el.ctxText.textContent.trim() && !el.ctxEdit.value.trim()) {
      setStatus("当前没有上下文原文");
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
    appendMessage("user", q);
    setStatus("思考中…");

    controller = new AbortController();

    // 追加本次问题（不动前缀，保持缓存命中）
    messages.push({ role: "user", content: q });

    const maxIter = 4;
    // 整个对话流程共用一个 assistant 气泡，避免工具轮产生空消息
    let ui = null;
    let acc = "";
    let rafId = null;
    const renderAcc = () => {
      rafId = null;
      if (!ui) return;
      ui.bubble.innerHTML = renderMarkdown(acc) + '<span class="cursor"></span>';
      el.messages.scrollTop = el.messages.scrollHeight;
    };
    const ensureBubble = () => {
      if (!ui) ui = appendMessage("assistant", "", true);
      return ui;
    };
    // 流结束/停止时：取消未执行的渲染任务并输出最终结果（不带游标）
    const finishRender = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (ui) {
        ui.bubble.innerHTML = renderMarkdown(acc);
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
            rafId = window.requestAnimationFrame(renderAcc);
          }
        };

        const payload = {
          model,
          temperature,
          stream: true,
          messages: sessionBase ? [...sessionBase, ...messages] : messages,
        };
        if (useTools) payload.tools = TOOLS;

        const { toolCalls } = await streamChat(payload, onDelta, controller.signal);

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
          messages.push(assistantMsg);

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            let result;
            try {
              const args = JSON.parse(tc.arguments || "{}");
              if (tc.name === "web_search") {
                const res = await webSearch(args.query || "");
                result = res.length
                  ? res.map((r) => `- ${r.title} | ${r.url} | ${r.snippet}`).join("\n")
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
        messages.push({ role: "assistant", content: acc });
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
          messages.push({ role: "assistant", content: acc });
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
    const lastAssistant = assistantMsgs.length ? assistantMsgs[assistantMsgs.length - 1] : null;
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
    const qShort = qChars.length > 40 ? qChars.slice(0, 40).join("") + "…" : question;

    // 组装笔记 HTML：所有用户内容先转义（& < >），防注入
    const html =
      "<h1>AskGPT 问答：" + escapeHtml(qShort) + "</h1>" +
      "<p>" + escapeHtml(answer).replace(/\n/g, "<br/>") + "</p>";

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
  // 收到新选中：更新原文区 + 会话自动切到新选中（不用关窗重开）。
  function updateLiveSelection(newSel) {
    try {
      newSel = (newSel || "").toString().trim();
      if (!newSel) return;
      // 用户手动编辑原文框时不覆盖
      const editing = el.ctxEdit && el.ctxEdit.style.display !== "none";
      if (editing) return;
      const curText =
        el.ctxText && el.ctxText.textContent
          ? el.ctxText.textContent.trim()
          : "";
      if (newSel === curText) return;

      const g = getAskGPT();
      // 更新原文区（有选中就优先显示选中，覆盖附件全文模式）
      el.ctxText.textContent = newSel;
      el.ctxText.title = newSel;
      const title =
        (g && g.data && g.data.readerTitle
          ? g.data.readerTitle
          : ""
        ).toString();
      el.ctxItem.textContent = title;
      // 重建会话：新选中 = 新上下文
      messages = [];
      sessionBase = buildSessionBase();
      persistSession();
      setStatus("");
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
      el.ctxEdit.value = el.ctxText.textContent;
      el.ctxEdit.style.display = "";
      el.ctxText.style.display = "none";
      el.ctxEdit.focus();
    });
    el.ctxEdit.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        el.ctxEdit.style.display = "none";
        el.ctxText.style.display = "";
        el.ctxText.textContent = el.ctxEdit.value;
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
  };

  // 启动
  document.addEventListener("DOMContentLoaded", () => {
    loadSettings();
    bindEvents();
    refresh();
    el.input.focus();
  });
})();