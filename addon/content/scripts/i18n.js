/* global window, document */
/* Explicit UI translations; document and conversation content are never translated. */
(function () {
  "use strict";
  const dictionaries = { "zh-CN": {}, "en-US": {} };
  function register(values) {
    for (const language of Object.keys(dictionaries)) {
      Object.assign(dictionaries[language], values[language] || {});
    }
  }
  let zotero = null;
  try {
    zotero =
      window.frameElement?.ownerGlobal?.Zotero ||
      window.opener?.Zotero ||
      window.Zotero;
  } catch {
    // A standalone preview may not have a host window.
  }
  if (!zotero) {
    try {
      zotero =
        window.Services?.wm?.getMostRecentWindow("navigator:browser")?.Zotero;
    } catch {
      // The browser language remains available as a fallback.
    }
  }
  let selected = "auto";
  function setLanguage(value) {
    selected = ["auto", "zh-CN", "en-US"].includes(value) ? value : "auto";
    return locale();
  }
  function resolveLanguage(value = selected) {
    if (value === "zh-CN" || value === "en-US") return value;
    const hostLanguage =
      zotero?.locale || window.navigator?.language || "en-US";
    return /^zh(?:-|_|$)/i.test(String(hostLanguage)) ? "zh-CN" : "en-US";
  }
  function locale() {
    return resolveLanguage();
  }
  try {
    setLanguage(zotero?.Prefs?.get("extensions.askgpt.language"));
  } catch {
    // Auto is the default when preferences are unavailable.
  }
  function t(key, variables = {}) {
    const value =
      dictionaries[locale()][key] ?? dictionaries["en-US"][key] ?? key;
    return value.replace(/\{(\w+)\}/g, (token, name) =>
      Object.prototype.hasOwnProperty.call(variables, name)
        ? String(variables[name])
        : token,
    );
  }
  const attributes = ["title", "placeholder", "aria-label", "data-q", "alt"];
  function apply(root = document) {
    const selector = [
      "[data-i18n]",
      ...attributes.map((name) => `[data-i18n-${name}]`),
    ].join(",");
    const nodes = Array.from(root.querySelectorAll(selector));
    if (root.matches?.(selector)) nodes.unshift(root);
    for (const node of nodes) {
      if (node.hasAttribute("data-i18n"))
        node.textContent = t(node.getAttribute("data-i18n"));
      for (const name of attributes) {
        const key = node.getAttribute(`data-i18n-${name}`);
        if (key) node.setAttribute(name, t(key));
      }
    }
    if (root === document)
      document.documentElement.setAttribute("lang", locale());
  }
  const entries = [
    ["page.title", "AskGPT · 文献问答", "AskGPT · Paper chat"],
    ["model.current", "当前模型", "Current model"],
    ["focus.clear", "清除选中段落", "Clear selected passage"],
    [
      "note.saveTitle",
      "把最后一条 AI 回答存为 Zotero 笔记",
      "Save the last AI answer as a Zotero note",
    ],
    ["note.save", "存为笔记", "Save note"],
    ["chat.new", "新对话", "New conversation"],
    ["settings.title", "设置", "Settings"],
    [
      "settings.subtitle",
      "连接你的模型，按你的习惯阅读。",
      "Connect your model and read your way.",
    ],
    [
      "settings.closeTitle",
      "取消并返回对话（Esc）",
      "Cancel and return to chat (Esc)",
    ],
    ["settings.close", "取消并返回对话", "Cancel and return to chat"],
    ["language.label", "界面语言 / Language", "Language / 界面语言"],
    ["language.auto", "跟随 Zotero", "Follow Zotero"],
    [
      "language.hint",
      "选择后立即预览，保存后生效。自定义提示词和已有对话保持原样。",
      "Preview immediately; save to keep your choice. Custom prompts and existing messages stay unchanged.",
    ],
    ["connection.title", "模型连接", "Model connection"],
    [
      "connection.hint",
      "支持 OpenAI 兼容接口。获取模型或测试连接时使用下方填写的配置。",
      "Use an OpenAI-compatible API. Model discovery and connection tests use the values below.",
    ],
    ["connection.base", "API 地址", "API URL"],
    [
      "connection.baseHint",
      "可填写服务地址、带 /v1 的地址或完整的 /chat/completions 地址。",
      "Enter a service URL, a URL ending in /v1, or a full /chat/completions endpoint.",
    ],
    [
      "connection.keyPlaceholder",
      "粘贴 API Key，本地服务可留空",
      "Paste an API key; local services may not need one",
    ],
    ["connection.show", "显示", "Show"],
    ["connection.hide", "隐藏", "Hide"],
    ["model.label", "模型", "Model"],
    [
      "model.placeholder",
      "输入模型 ID，或从接口获取",
      "Enter a model ID, or fetch models",
    ],
    ["model.fetch", "获取模型", "Fetch models"],
    ["model.selectLabel", "选择获取到的模型", "Choose a fetched model"],
    ["model.select", "选择模型", "Choose a model"],
    [
      "model.chooseOrType",
      "选择一个模型，或在上方手动填写",
      "Choose a model, or enter its ID above",
    ],
    [
      "model.hint",
      "可直接输入模型 ID；部分服务不提供模型列表。",
      "You can enter a model ID manually; some services do not provide a model list.",
    ],
    [
      "model.fetchedHint",
      "已获取 {count} 个模型。图片能力取决于所选模型；连接测试仅测试文字。",
      "Fetched {count} models. Image support depends on the model; the connection test checks text only.",
    ],
    ["connection.test", "测试连接", "Test connection"],
    [
      "connection.testHint",
      "测试可能产生模型或搜索费用，不包含你的论文、对话或图片。",
      "Tests may incur model or search charges. They contain no paper, conversation, or images.",
    ],
    ["reading.title", "阅读与回答", "Reading and answers"],
    ["reading.subtitle", "上下文和提示词", "Context and prompts"],
    [
      "reading.source",
      "文献来源（下次打开面板生效）",
      "Document source (next time the panel opens)",
    ],
    ["reading.auto", "当前正在阅读的附件", "Currently open attachment"],
    ["reading.pdf", "优先使用原始 PDF", "Prefer the original PDF"],
    [
      "reading.translation",
      "优先使用译文附件",
      "Prefer a translated attachment",
    ],
    ["reading.web", "原生联网搜索", "Native web search"],
    [
      "reading.webHint",
      "复用当前 API 和 Key，由模型服务商执行搜索并提供来源。需要支持原生搜索的模型与接口，可能额外计费；建议先测试。",
      "Uses your current API and key. The provider runs searches and supplies sources. A compatible model and API are required; search may cost extra. Test it first.",
    ],
    [
      "reading.temperature",
      "回答随机度（0–2，仅普通对话）",
      "Temperature (0–2, standard chat only)",
    ],
    ["reading.prompt", "系统提示词", "System prompt"],
    ["appearance.title", "外观", "Appearance"],
    ["appearance.subtitle", "字号与面板尺寸", "Font and panel size"],
    ["appearance.font", "字体大小", "Font size"],
    ["appearance.defaultFont", "14 px（默认）", "14 px (default)"],
    ["appearance.size", "面板宽 × 高", "Panel width × height"],
    ["appearance.width", "面板宽度", "Panel width"],
    ["appearance.height", "面板高度", "Panel height"],
    ["diagnostics.title", "诊断", "Diagnostics"],
    ["diagnostics.subtitle", "查看最近一次错误", "View the latest error"],
    ["diagnostics.label", "最近一次面板错误", "Latest panel error"],
    ["diagnostics.clear", "清除记录", "Clear log"],
    ["diagnostics.none", "（无）", "(none)"],
    [
      "settings.privacy",
      "设置保存在本机。提问时，文献内容、对话和附加图片会发送到你配置的 API。连接测试不包含论文、对话或图片。",
      "Settings are stored locally. Questions send document content, conversation history, and attached images to your configured API. Connection tests contain no paper, conversation, or images.",
    ],
    ["settings.cancel", "取消", "Cancel"],
    ["settings.save", "保存并返回", "Save and return"],
    ["chip.explain", "解释这段话", "Explain passage"],
    [
      "chip.explainQuestion",
      "请用中文详细解释这段话的核心内容，并说明其在该文献中的作用",
      "Explain the key ideas in this passage in detail and describe its role in the paper.",
    ],
    ["chip.translate", "翻译成中文", "Translate to English"],
    [
      "chip.translateQuestion",
      "请把这段话翻译成中文，尽量贴合学术语境",
      "Translate this passage into English, preserving its academic meaning.",
    ],
    ["chip.summarize", "总结要点", "Summarize"],
    [
      "chip.summarizeQuestion",
      "请总结这段话的主要观点，并给出三点要点",
      "Summarize the main argument of this passage in three key points.",
    ],
    ["chip.critique", "批判性评价", "Critique"],
    [
      "chip.critiqueQuestion",
      "请从批判性角度评价这段话，指出可能的局限或值得推敲之处",
      "Critically evaluate this passage and identify possible limitations or points that deserve closer scrutiny.",
    ],
    ["chip.search", "联网扩展阅读", "Search related work"],
    [
      "chip.searchQuestion",
      "关于这段话，联网搜索一下相关的最新研究或概念，并简要说明联系",
      "Search the web for recent research or concepts related to this passage, and briefly explain the connections.",
    ],
    [
      "chat.empty",
      "选一段文字，问一个问题。也可以添加论文截图一起讨论。",
      "Select a passage and ask a question. You can also add a paper screenshot to discuss.",
    ],
    ["image.pending", "待发送图片", "Pending image"],
    [
      "image.hint",
      "需要支持图片的模型；发送后图片会随对话提供给当前 API。",
      "Requires a model that supports images. Sent images are included in the conversation shared with your API.",
    ],
    [
      "image.addTitle",
      "添加图片（也可粘贴截图）",
      "Add images (or paste a screenshot)",
    ],
    ["image.add", "添加图片", "Add images"],
    ["image.button", "＋ 图片", "＋ Image"],
    ["image.remove", "移除图片 {name}", "Remove image {name}"],
    ["image.sent", "已发送图片", "Sent image"],
    [
      "input.placeholder",
      "输入问题，或粘贴截图…",
      "Ask a question, or paste a screenshot…",
    ],
    ["input.label", "问题", "Question"],
    ["chat.stop", "停止", "Stop"],
    ["chat.send", "发送", "Send"],
    ["chat.sending", "发送中…", "Sending…"],
    ["chat.focusTag", "含选中段落", "Includes selected passage"],
    ["settings.saved", "设置已保存。", "Settings saved."],
    [
      "model.required",
      "请选择模型，或手动输入模型 ID。",
      "Choose a model or enter a model ID.",
    ],
    [
      "model.requiredSettings",
      "请在设置中选择或填写模型。",
      "Choose or enter a model in Settings.",
    ],
    ["connection.fetching", "正在获取可用模型…", "Fetching available models…"],
    ["connection.testing", "正在测试连接…", "Testing connection…"],
    [
      "connection.modelsReady",
      "模型列表已更新，请选择模型后测试连接。",
      "Model list updated. Choose a model, then test the connection.",
    ],
    [
      "connection.success",
      "连接成功 · {model} · {ms} ms。点击“保存并返回”应用配置。",
      "Connected · {model} · {ms} ms. Click Save and return to apply these settings.",
    ],
    [
      "image.added",
      "图片已添加，发送前可以预览或移除。",
      "Images added. Preview or remove them before sending.",
    ],
    ["context.loadingShort", "⏳ 读取全文…", "⏳ Loading…"],
    ["context.loading", "⏳ 正在读取全文…", "⏳ Loading full text…"],
    ["context.fullShort", "📄 {count} 字", "📄 {count} chars"],
    [
      "context.full",
      "📄 整篇文献 {count} 字{source}{truncated}",
      "📄 Full text · {count} chars{source}{truncated}",
    ],
    ["context.truncated", "（已截断）", " (truncated)"],
    ["context.selectedShort", "⚠ 仅选中段落", "⚠ Selection only"],
    [
      "context.selected",
      "⚠ 未读到全文 · 仅发选中段落",
      "⚠ No full text · sending selection only",
    ],
    ["context.noneShort", "⚠ 无上下文", "⚠ No context"],
    ["context.none", "⚠ 无文献上下文", "⚠ No document context"],
    [
      "context.fullTitle",
      "整篇文献始终作为会话前缀发送（{count} 字{source}{truncated}）",
      "Full text is included as the conversation prefix ({count} characters{source}{truncated})",
    ],
    [
      "context.noneTitle",
      "未读到文献全文（扫描版 PDF / 未选中条目？）——本次只发送选中段落",
      "Full text is unavailable (scanned PDF or no selected item?). Only the selected passage will be sent.",
    ],
    ["context.focus", "🎯 选中 {count} 字", "🎯 {count} selected chars"],
    [
      "context.focusTitle",
      "本次提问会带上这段选中文字：\n{text}",
      "This question will include the selected passage:\n{text}",
    ],
    [
      "error.recorded",
      "出错了（已记录）：{message}",
      "Error (logged): {message}",
    ],
    [
      "error.illegalConfig",
      "接口地址或 API Key 含非法字符（多半是粘贴时带进了换行/零宽字符）。清洗后仍失败，请到设置里重新粘贴。当前地址：{endpoint}",
      "The API URL or key contains invalid characters, possibly pasted line breaks or invisible characters. Cleaning did not resolve the error; paste the values again in Settings. URL: {endpoint}",
    ],
    [
      "context.wait",
      "正在确定文献上下文，请稍后再发送。",
      "Loading document context. Please try again in a moment.",
    ],
    ["image.analyze", "请分析这些图片。", "Please analyze these images."],
    [
      "context.required",
      "先打开文献、选择文字或添加图片，再开始提问。",
      "Open a paper, select text, or add images before asking a question.",
    ],
    [
      "image.unsupported",
      "这个模型声明不支持图片，请更换支持图片的模型，或移除图片并新建对话。",
      "This model reports no image support. Choose an image-capable model, or remove the images and start a new conversation.",
    ],
    ["chat.thinking", "思考中…", "Thinking…"],
    [
      "search.runningNative",
      "模型正在联网搜索…",
      "The model is searching the web…",
    ],
    [
      "search.answering",
      "搜索完成，正在整理回答…",
      "Search completed. Preparing the answer…",
    ],
    ["search.test", "测试原生搜索", "Test native search"],
    [
      "search.testing",
      "正在验证原生搜索能力…",
      "Verifying native search support…",
    ],
    ["search.sources", "来源", "Sources"],
    [
      "search.used",
      "本次回答已使用原生联网搜索。",
      "This answer used native web search.",
    ],
    [
      "search.notUsed",
      "本次回答未调用联网搜索。",
      "Web search was not used for this answer.",
    ],
    [
      "search.unverified",
      "接口返回了回答，但没有确认执行原生搜索。请检查接口与模型是否支持。",
      "The API returned an answer but did not confirm a native search. Check the API and model support.",
    ],
    [
      "search.unexpectedTool",
      "模型返回了未支持的工具调用。请检查所选模型或开启兼容的原生搜索。",
      "The model returned an unsupported tool call. Check the model or enable compatible native search.",
    ],
    [
      "search.emptyAnswer",
      "接口没有返回回答，请检查模型设置后重试。",
      "The API returned no answer. Check the model settings and retry.",
    ],
    [
      "search.verified",
      "原生搜索已验证 · {model}。服务商已实际执行搜索；勾选“原生联网搜索”并保存后启用。",
      "Native search verified · {model}. The provider performed a search. Enable Native web search and save to use it.",
    ],
    ["chat.stopped", "已停止。", "Stopped."],
    [
      "error.chat",
      "出错了：{message}{imageHint}",
      "Error: {message}{imageHint}",
    ],
    [
      "image.errorHint",
      " 图片输入需要接口和模型都支持；可更换模型后重试。",
      " Both the API and model must support image input; try another model.",
    ],
    ["note.noZotero", "无法连接 Zotero", "Cannot connect to Zotero"],
    ["note.noAnswer", "还没有可保存的回答", "There is no answer to save yet"],
    ["note.heading", "AskGPT 问答：", "AskGPT Q&A: "],
    [
      "note.savedParent",
      "✓ 已保存到 Zotero 笔记（父条目：{title}）",
      "✓ Saved as a Zotero note under: {title}",
    ],
    ["note.saved", "✓ 已保存为独立笔记", "✓ Saved as a standalone note"],
    ["note.error", "保存失败：{message}", "Could not save: {message}"],
    [
      "render.missing",
      "渲染依赖未加载：{names}（公式会以源码显示）",
      "Rendering dependencies did not load: {names} (formulas will display as source)",
    ],
    [
      "prompt.paper",
      "【文献原文】\n```\n{text}\n```\n\n请记住以上文献内容。我后续的每一个问题都基于这篇文献，你只需针对我的问题作答，不需要重复说明上下文。",
      "[Paper text]\n```\n{text}\n```\n\nUse this paper as context for my subsequent questions. Answer the question without repeating the context.",
    ],
    [
      "prompt.focus",
      "【选中段落】\n{focus}\n\n【我的问题】\n{question}",
      "[Selected passage]\n{focus}\n\n[My question]\n{question}",
    ],
  ];
  for (const [key, zh, en] of entries) {
    dictionaries["zh-CN"][key] = zh;
    dictionaries["en-US"][key] = en;
  }
  window.AskGPTI18n = {
    t,
    locale,
    resolveLanguage,
    language: () => selected,
    setLanguage,
    apply,
    register,
  };
})();
