/**
 * AskGPT 弹窗逻辑 —— 轻量 agent：
 *   - 轻量级 system prompt（参考开源 agent 通用写法：角色 + 能力边界 + 工具规则 + 输出约束）
 *   - Native web search through the configured provider's Responses API
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
  const i18n = window.AskGPTI18n;
  const t = (key, variables) => i18n.t(key, variables);

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
  function localizedSystemPrompt(value, language = i18n.locale()) {
    return window.AskGPTPrompts.localize(value, language);
  }
  function savedSystemPrompt() {
    return localizedSystemPrompt(
      getPref("systemPrompt", ""),
      i18n.resolveLanguage(getPref("language", "auto")),
    );
  }

  /* ---------- 状态 ---------- */
  let messages = []; // 本次会话追加的消息（不含前缀）
  let sessionBase = null; // 固定前缀 [system, 全文]（来自主进程会话）
  let sessionKey = ""; // 当前文章会话的 key（附件路径 / 选中文字指纹）
  let controller = null; // AbortController 用于停止
  let busy = false;
  let pendingImages = [];
  let readingImages = false;
  let imageRevision = 0;
  let connectionController = null;
  let fetchedModels = [];
  let modelsConfig = "";
  let queuedRefresh = null;
  const client = window.AskGPTClient;
  const nativeSearch = window.AskGPTNativeSearch;

  // 整篇文献（主进程读取后推送过来）——始终作为固定前缀发送
  let paperText = "";
  let paperLabel = "";
  let paperChars = 0;
  let paperTruncated = false;
  let paperTitle = "";
  let paperLoading = false;
  // 当前选中段落——只作为「本次问题的焦点」，不会顶掉全文
  let focusSel = "";
  // 前缀是从哪份文本建的（全文晚到时要作废重建）
  let sessionBaseText = "";

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
    if (((session && session.key) || "") !== sessionKey) clearAttachments();
    // 从主进程会话恢复：前缀 + 历史
    sessionKey = (session && session.key) || "";
    sessionBase = (session && session.base) || null;
    sessionBaseText = sessionBase
      ? (session && session.baseText) || (session && session.contextText) || ""
      : "";
    messages = (session && session.history) || [];
    // Apply the saved language/prompt to resumed sessions without rewriting history.
    if (sessionBase?.[0]?.role === "system") {
      sessionBase = [
        {
          ...sessionBase[0],
          content: savedSystemPrompt(),
        },
        ...sessionBase.slice(1),
      ];
    }
    // 主进程会话里带着上次读到的全文（面板重开时不必等重新读盘）
    if (!paperText && session && session.contextText) {
      paperText = session.contextText;
      paperLabel = session.contextLabel || "";
      paperChars = paperText.length;
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
          m.q ||
            (Array.isArray(m.content)
              ? m.content
                  .filter((part) => part?.type === "text")
                  .map((part) => part.text)
                  .join("\n")
              : m.content) ||
            "",
          false,
          m.focus ? t("chat.focusTag") : "",
          imageParts(m.content),
        );
      } else if (m.role === "assistant" && m.content) {
        const ui = appendMessage("assistant", "", false);
        renderAssistant(ui, m.content, m.citations || [], false);
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
    const sysText = savedSystemPrompt();
    return [
      { role: "system", content: sysText },
      {
        role: "user",
        content: t("prompt.paper", { text: contextText }),
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
    btnSettings: $("btn-settings"),
    ctxBadge: $("ctx-badge"),
    ctxText: $("ctx-text"),
    focusBadge: $("focus-badge"),
    focusLabel: $("focus-label"),
    focusClear: $("focus-clear"),
    input: $("input"),
    btnSend: $("btn-send"),
    btnStop: $("btn-stop"),
    messages: $("messages"),
    emptyTip: $("empty-tip"),
    statusline: $("statusline"),
    // 设置项
    setLanguage: $("set-language"),
    setBase: $("set-base"),
    setKey: $("set-key"),
    setModel: $("set-model"),
    setTemp: $("set-temp"),
    setSys: $("set-sys"),
    setCtxSrc: $("set-ctx-src"),
    setLastErr: $("set-lasterr"),
    btnClearErr: $("btn-clear-err"),
    setWeb: $("set-web"),
    setFontSize: $("set-fontsize"),
    setPanelW: $("set-panel-w"),
    setPanelH: $("set-panel-h"),
    saveStatus: $("save-status"),
  };

  /* ---------- 外观：字体大小 / 面板大小（改完立即生效，不用重启） ---------- */
  const FS_MIN = 10;
  const FS_MAX = 22;
  const PANEL_W_MIN = 420;
  const PANEL_W_MAX = 1600;
  const PANEL_H_MIN = 360;
  const PANEL_H_MAX = 1600;
  /** 默认尺寸：宽而短（900×520）——一开面板就能一边读文献一边提问 */
  const DEFAULT_PANEL_SIZE = { w: 900, h: 520 };
  /** 尺寸自适应断点（与 popup.css 里的 media query 数值保持一致） */
  const BP_NARROW_W = 560; // < 560：模型/状态徽章只留短文案
  const BP_WIDE_W = 1100; // > 1100：气泡限制最大宽度并居中
  const BP_SHORT_H = 560; // < 560：顶部栏 / 徽章 / chips 压紧
  const BP_TINY_H = 440; // < 440：隐藏 chips 行

  function clampNum(v, min, max, fallback) {
    const n = parseFloat(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /** 字体大小 = 一个 CSS 变量，整面板都跟着缩放（实时） */
  function applyFontSize(px) {
    const size = clampNum(px, FS_MIN, FS_MAX, 14);
    try {
      document.documentElement.style.setProperty("--ag-fs", size + "px");
    } catch (e) {}
    return size;
  }

  /** 解析 "900x520" / {width,height} / JSON 形式的面板尺寸设置（非法值 / 非正数返回 null） */
  function parsePanelSize(raw) {
    const ok = (w, h) => isFinite(w) && isFinite(h) && w > 0 && h > 0;
    try {
      if (raw && typeof raw === "object") {
        const w = parseFloat(raw.w != null ? raw.w : raw.width);
        const h = parseFloat(raw.h != null ? raw.h : raw.height);
        return ok(w, h) ? { w: w, h: h } : null;
      }
      const s = String(raw == null ? "" : raw).trim();
      if (s.charAt(0) === "{") {
        const o = JSON.parse(s);
        const w = parseFloat(o.w != null ? o.w : o.width);
        const h = parseFloat(o.h != null ? o.h : o.height);
        return ok(w, h) ? { w: w, h: h } : null;
      }
      const m = s.match(/(-?\d+(?:\.\d+)?)\s*[x×,;\s]\s*(-?\d+(?:\.\d+)?)/i);
      if (m) {
        const w = parseFloat(m[1]);
        const h = parseFloat(m[2]);
        return ok(w, h) ? { w: w, h: h } : null;
      }
    } catch (e) {}
    return null;
  }

  /** 面板 iframe（面板本身就是主窗口里的 iframe，可直接改自己的尺寸） */
  function getPanelFrame() {
    try {
      const fe = window.frameElement;
      if (fe && fe.style) return fe;
    } catch (e) {}
    return null;
  }

  /**
   * 按当前 iframe 尺寸切布局适配类（CSS media query 之外，再给 JS 一个统一判断口）。
   * 主窗口拖右下角把手改尺寸 → iframe 触发 resize 事件 → 这里重新判定。
   */
  function syncViewportClasses(size) {
    const root = document.documentElement;
    const w = Math.round(
      (size && isFinite(size.w) && size.w) ||
        window.innerWidth ||
        DEFAULT_PANEL_SIZE.w,
    );
    const h = Math.round(
      (size && isFinite(size.h) && size.h) ||
        window.innerHeight ||
        DEFAULT_PANEL_SIZE.h,
    );
    const narrow = w < BP_NARROW_W;
    const wide = w > BP_WIDE_W;
    const short = h < BP_SHORT_H;
    const tiny = h < BP_TINY_H;
    root.classList.toggle("ag-narrow", narrow);
    root.classList.toggle("ag-wide", wide);
    root.classList.toggle("ag-short", short);
    root.classList.toggle("ag-tiny", tiny);
    root.setAttribute("data-ag-size", w + "x" + h);
    return { w: w, h: h, narrow: narrow, wide: wide, short: short, tiny: tiny };
  }

  /**
   * 主窗口拖缩放把手时主动通知面板（不依赖 iframe 的 resize 事件：
   * 部分环境/无头浏览器里 iframe 尺寸变了但不派发 resize）。
   */
  function notifyPanelSize(w, h) {
    const info = syncViewportClasses({ w: w, h: h });
    updateContextBadges();
    if (settingsOpen()) {
      const active = document.activeElement;
      if (active !== el.setPanelW && active !== el.setPanelH) {
        el.setPanelW.value = String(Math.round(info.w));
        el.setPanelH.value = String(Math.round(info.h));
      }
    }
    return info;
  }

  function applyPanelSize(w, h) {
    const fe = getPanelFrame();
    if (!fe) return null;
    let W = clampNum(w, PANEL_W_MIN, PANEL_W_MAX, DEFAULT_PANEL_SIZE.w);
    let H = clampNum(h, PANEL_H_MIN, PANEL_H_MAX, DEFAULT_PANEL_SIZE.h);
    // 不要让面板超出 Zotero 主窗口（宽 −40 / 高 −80）
    try {
      const win = fe.ownerGlobal || window.parent;
      if (win && win.innerWidth) {
        W = Math.min(W, Math.max(PANEL_W_MIN, win.innerWidth - 40));
      }
      if (win && win.innerHeight) {
        H = Math.min(H, Math.max(PANEL_H_MIN, win.innerHeight - 80));
      }
    } catch (e) {}
    W = Math.round(W);
    H = Math.round(H);
    fe.style.width = W + "px";
    fe.style.height = H + "px";
    syncViewportClasses({ w: W, h: H });
    return { w: W, h: H };
  }

  /** 应用 + 持久化面板尺寸（设置保存与外部调用共用同一条链路） */
  function setPanelSize(w, h) {
    const applied = applyPanelSize(w, h);
    if (!applied) return null;
    setPref("panelSize", applied.w + "x" + applied.h);
    if (el.setPanelW) el.setPanelW.value = String(applied.w);
    if (el.setPanelH) el.setPanelH.value = String(applied.h);
    return applied;
  }

  /* ---------- 设置 ---------- */
  function applyLanguage(value) {
    const prompt = el.setSys.value;
    i18n.setLanguage(value);
    i18n.apply();
    el.setLanguage.value = i18n.language();
    el.setSys.value = localizedSystemPrompt(prompt);
    $("btn-toggle-key").textContent = t(
      el.setKey.type === "password" ? "connection.show" : "connection.hide",
    );
    el.btnSend.textContent = t(busy ? "chat.sending" : "chat.send");
    $("model-hint").textContent = fetchedModels.length
      ? t("model.fetchedHint", { count: fetchedModels.length })
      : t("model.hint");
    const placeholder = $("set-model-select").querySelector('option[value=""]');
    if (placeholder)
      placeholder.textContent = t(
        fetchedModels.length ? "model.chooseOrType" : "model.select",
      );
    if (!getPref("lastError", "") && el.setLastErr)
      el.setLastErr.value = t("diagnostics.none");
    updateContextBadges();
    renderAttachments();
    if (statusMessage)
      el.statusline.textContent = t(statusMessage.key, statusMessage.variables);
    if (connectionMessage)
      $("connection-status").textContent = t(
        connectionMessage.key,
        connectionMessage.variables,
      );
  }

  function loadSettings() {
    applyLanguage(getPref("language", "auto"));
    // 每次读设置前先按当前 iframe 尺寸判定一次适配档位（决定徽章用长文案还是短文案）
    syncViewportClasses();
    // 读设置时顺手清洗：老版本粘贴进来带换行/零宽字符的值会自动修好并写回
    const rawBase = String(
      getPref("baseURL", "https://api.deepseek.com") || "",
    );
    const rawKey = String(getPref("apiKey", "") || "");
    const rawModel = String(getPref("model", "deepseek-chat") || "");
    const cleanBase = stripInvisible(rawBase);
    const cleanKey = stripInvisible(rawKey);
    const cleanModel = stripInvisible(rawModel);
    if (cleanBase !== rawBase) setPref("baseURL", cleanBase);
    if (cleanKey !== rawKey) setPref("apiKey", cleanKey);
    if (cleanModel !== rawModel) setPref("model", cleanModel);
    el.setBase.value = cleanBase;
    el.setKey.value = cleanKey;
    el.setModel.value = cleanModel;
    if (modelsConfig && modelsConfig !== connectionKey()) invalidateModels();
    else $("set-model-select").value = cleanModel;
    el.setTemp.value = getPref("temperature", 0.3);
    el.setSys.value = localizedSystemPrompt(getPref("systemPrompt", ""));
    el.setCtxSrc.value = getPref("contextSource", "auto");
    el.setWeb.checked = getPref("nativeSearch", false) === true;
    // 外观：字号立即生效；面板尺寸只在设置里展示（保存后才调整）
    const fs = applyFontSize(getPref("fontSize", 14));
    el.setFontSize.value = String(fs);
    const size = parsePanelSize(getPref("panelSize", "")) || DEFAULT_PANEL_SIZE;
    const frameSize = measurePanelFrame();
    const shown = frameSize || size;
    el.setPanelW.value = String(Math.round(shown.w));
    el.setPanelH.value = String(Math.round(shown.h));
    if (el.setLastErr) {
      el.setLastErr.value = String(
        getPref("lastError", "") || t("diagnostics.none"),
      );
    }
    updateBadge();
  }

  /** 当前 iframe 的真实尺寸（拖拽/上次设置后的实际值） */
  function measurePanelFrame() {
    const fe = getPanelFrame();
    if (!fe) return null;
    try {
      const r = fe.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        return { w: r.width, h: r.height };
      }
    } catch (e) {}
    return null;
  }

  function saveSettings() {
    try {
      client.buildEndpoint(el.setBase.value);
      if (!stripInvisible(el.setModel.value).trim()) {
        throw new Error(t("model.required"));
      }
    } catch (error) {
      el.saveStatus.textContent = client.safeErrorMessage(
        error,
        el.setKey.value,
      );
      return;
    }
    const config = connectionConfig();
    setPref("baseURL", config.baseURL);
    setPref("apiKey", config.apiKey);
    setPref("model", config.model);
    setPref("temperature", clampNum(el.setTemp.value, 0, 2, 0.3));
    setPref("systemPrompt", el.setSys.value);
    setPref("language", i18n.language());
    try {
      getAskGPT()?.hooks?.onPrefsEvent("language-saved", {});
    } catch (_) {}
    setPref("contextSource", el.setCtxSrc.value || "auto");
    setPref("nativeSearch", el.setWeb.checked);
    // 外观：字号 + 面板尺寸（都立即生效）
    const fs = applyFontSize(el.setFontSize.value);
    setPref("fontSize", fs);
    setPanelSize(el.setPanelW.value, el.setPanelH.value);
    // 回填清洗后的值，让用户看到实际会用的内容
    el.setBase.value = stripInvisible(el.setBase.value);
    el.setKey.value = stripInvisible(el.setKey.value);
    el.setModel.value = stripInvisible(el.setModel.value);
    sessionBase = null;
    persistSession();
    updateBadge();
    closeSettings();
    setStatusKey("settings.saved");
  }
  function updateBadge() {
    el.modelBadge.textContent = stripInvisible(el.setModel.value) || "…";
  }

  function connectionConfig() {
    return {
      baseURL: stripInvisible(el.setBase.value).trim(),
      apiKey: stripInvisible(el.setKey.value).trim(),
      model: stripInvisible(el.setModel.value).trim(),
    };
  }

  function connectionKey() {
    const config = connectionConfig();
    return JSON.stringify([config.baseURL, config.apiKey]);
  }

  let connectionMessage = null;
  let statusMessage = null;
  function connectionStatus(text, state) {
    connectionMessage = null;
    const status = $("connection-status");
    status.textContent = text;
    status.dataset.state = state || "";
  }

  function connectionStatusKey(key, variables, state) {
    connectionStatus(t(key, variables), state);
    connectionMessage = { key, variables };
  }

  function cancelConnection() {
    if (connectionController) connectionController.abort();
    connectionController = null;
    $("btn-fetch-models").disabled = false;
    $("btn-test-connection").disabled = false;
    $("btn-test-search").disabled = false;
  }

  function invalidateModels() {
    cancelConnection();
    fetchedModels = [];
    modelsConfig = "";
    $("askgpt-model-list").replaceChildren();
    $("set-model-select").classList.add("hidden");
    $("model-hint").textContent = t("model.hint");
    connectionStatus("");
  }

  async function checkConnection(kind) {
    cancelConnection();
    const current = new AbortController();
    connectionController = current;
    const config = connectionConfig();
    const key = connectionKey();
    $("btn-fetch-models").disabled = true;
    $("btn-test-connection").disabled = true;
    $("btn-test-search").disabled = true;
    connectionStatusKey(
      kind === "models"
        ? "connection.fetching"
        : kind === "search"
          ? "search.testing"
          : "connection.testing",
    );
    try {
      if (kind === "models") {
        const models = await client.fetchModels(config, {
          signal: current.signal,
        });
        if (connectionController !== current) return;
        fetchedModels = models;
        modelsConfig = key;
        const select = $("set-model-select");
        const list = $("askgpt-model-list");
        select.replaceChildren();
        list.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = t("model.chooseOrType");
        select.appendChild(placeholder);
        for (const model of models) {
          const option = document.createElement("option");
          option.value = model.id;
          option.textContent = model.id;
          list.appendChild(option.cloneNode(true));
          select.appendChild(option);
        }
        select.value = models.some((m) => m.id === config.model)
          ? config.model
          : "";
        select.classList.remove("hidden");
        $("model-hint").textContent = t("model.fetchedHint", {
          count: models.length,
        });
        connectionStatusKey("connection.modelsReady", {}, "success");
      } else if (kind === "search") {
        const result = await nativeSearch.test(config, {
          signal: current.signal,
        });
        if (connectionController !== current) return;
        if (!result.searched) throw new Error(t("search.unverified"));
        connectionStatusKey(
          "search.verified",
          { model: config.model },
          "success",
        );
      } else {
        const result = await client.testConnection(config, {
          signal: current.signal,
        });
        if (connectionController !== current) return;
        connectionStatusKey(
          "connection.success",
          { model: config.model, ms: Math.round(result.elapsedMs) },
          "success",
        );
      }
    } catch (error) {
      if (connectionController !== current) return;
      connectionStatus(client.safeErrorMessage(error, config.apiKey), "error");
    } finally {
      if (connectionController === current) cancelConnection();
    }
  }

  function imageParts(content) {
    return Array.isArray(content)
      ? content
          .filter(
            (part) =>
              part?.type === "image_url" &&
              typeof part.image_url?.url === "string",
          )
          .map((part) => ({ url: part.image_url.url }))
      : [];
  }

  function renderAttachments() {
    const list = $("attachment-list");
    list.replaceChildren();
    $("attachments").classList.toggle("hidden", pendingImages.length === 0);
    pendingImages.forEach((image, index) => {
      const item = document.createElement("div");
      item.className = "attachment-preview";
      const preview = document.createElement("img");
      preview.src = image.url;
      preview.alt = image.name || t("image.pending");
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.setAttribute(
        "aria-label",
        t("image.remove", { name: image.name || index + 1 }),
      );
      remove.addEventListener("click", () => {
        pendingImages.splice(index, 1);
        renderAttachments();
      });
      item.append(preview, remove);
      list.appendChild(item);
    });
  }

  function clearAttachments() {
    imageRevision++;
    pendingImages = [];
    renderAttachments();
    $("image-input").value = "";
  }

  async function addImages(files) {
    if (busy || readingImages) return;
    const batch = Array.from(files);
    if (!batch.length) return;
    const revision = imageRevision;
    readingImages = true;
    el.btnSend.disabled = true;
    $("btn-attach").disabled = true;
    try {
      client.validateImageBatch(batch, pendingImages);
      const images = await Promise.all(
        batch.map((file) => client.readImage(file)),
      );
      if (revision !== imageRevision) return;
      pendingImages.push(...images);
      renderAttachments();
      setStatusKey("image.added");
    } catch (error) {
      if (revision === imageRevision) setStatus(client.safeErrorMessage(error));
    } finally {
      readingImages = false;
      el.btnSend.disabled = busy;
      $("btn-attach").disabled = busy;
      $("image-input").value = "";
    }
  }

  /* ---------- 上下文来源（整篇文献 + 选中段落） ---------- */
  // 主进程契约：refresh(payload)
  //   payload = { loading, selection, itemTitle, contextText, contextLabel,
  //               contextChars, truncated, session }
  // 兼容旧调用：若传入字符串，直接当作 selection
  function getHostWindow() {
    try {
      return (
        window.frameElement?.ownerDocument?.defaultView ||
        window.frameElement?.ownerGlobal ||
        window.opener ||
        Zotero?.getMainWindow?.() ||
        null
      );
    } catch {
      return null;
    }
  }
  function getPopupState() {
    try {
      const host = getHostWindow();
      if (
        host &&
        Object.prototype.hasOwnProperty.call(host, "__askgptPopupState")
      ) {
        return host.__askgptPopupState;
      }
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
    if (busy) {
      queuedRefresh = payload || getPopupState();
      const next = queuedRefresh;
      if (
        next &&
        typeof next === "object" &&
        (next.loading ||
          (Object.prototype.hasOwnProperty.call(next, "session") &&
            ((next.session && next.session.key) || "") !== sessionKey))
      )
        stop();
      return;
    }
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

    // 主进程打开面板会先发 loading/null，尚未确定是否切换文献。
    if (loading && !session) {
      paperLoading = true;
      updateContextBadges();
      return;
    }
    // 不同文献必须先清上下文，避免尚未读到全文时带上上一篇内容。
    if (((session && session.key) || "") !== sessionKey) {
      paperText = "";
      paperLabel = "";
      paperChars = 0;
      paperTruncated = false;
      paperTitle = "";
      focusSel = "";
      sessionBase = null;
      sessionBaseText = "";
    }
    // 同一文献 loading 阶段保留已读取的内容，界面不闪。
    if (contextText) {
      if (contextText !== paperText) {
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

    // 先恢复会话（可能带回上次的全文），再刷新顶部状态徽章
    loadSession(session);
    updateContextBadges();
  }

  /** 「整篇文献 + 选中段落」的状态 → 顶部两个极简徽章（不再有大卡片） */
  function updateContextBadges() {
    // 窄面板（< 560px）：徽章只留短文案，避免把顶部栏挤爆
    const narrow = document.documentElement.classList.contains("ag-narrow");
    // 徽章文字写在内部 span 里（外层是 inline-flex，直接放文本节点在窄面板里
    // 不会正常省略号截断，会顶出横向滚动条）
    const setBadgeText = (t) => {
      const target = el.ctxText || el.ctxBadge;
      target.textContent = t;
    };
    // 1) 整篇文献徽章：正常=绿、读不到=黄、读取中=灰
    if (paperLoading && !paperText) {
      setBadgeText(t(narrow ? "context.loadingShort" : "context.loading"));
      el.ctxBadge.className = "ctx-badge loading";
    } else if (paperText) {
      setBadgeText(
        t(narrow ? "context.fullShort" : "context.full", {
          count: formatChars(paperChars),
          source: paperLabel ? " · " + paperLabel : "",
          truncated: paperTruncated ? t("context.truncated") : "",
        }),
      );
      el.ctxBadge.className = "ctx-badge";
    } else if (focusSel) {
      setBadgeText(narrow ? t("context.selectedShort") : t("context.selected"));
      el.ctxBadge.className = "ctx-badge warn";
    } else {
      setBadgeText(narrow ? t("context.noneShort") : t("context.none"));
      el.ctxBadge.className = "ctx-badge warn";
    }
    el.ctxBadge.classList.remove("hidden");
    el.ctxBadge.title = [
      paperTitle ? "📄 " + paperTitle : "",
      paperText
        ? t("context.fullTitle", {
            count: paperChars.toLocaleString(i18n.locale()),
            source: paperLabel ? " · " + paperLabel : "",
            truncated: paperTruncated ? t("context.truncated") : "",
          })
        : t("context.noneTitle"),
    ]
      .filter(Boolean)
      .join("\n");

    // 2) 选中段落徽章（本次提问的焦点，可一键清除）
    el.focusBadge.classList.toggle("hidden", !focusSel);
    if (focusSel) {
      el.focusLabel.textContent = t("context.focus", {
        count: formatChars(focusSel.length),
      });
      el.focusBadge.title = t("context.focusTitle", {
        text: focusSel.slice(0, 200) + (focusSel.length > 200 ? "…" : ""),
      });
    }
  }

  /** 12345 → "12.3k"，便于把字数塞进小徽章 */
  function formatChars(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (v / 1000).toFixed(1) + "k";
    return v.toLocaleString(i18n.locale());
  }

  /* ---------- 渲染（轻量 markdown） ---------- */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * AI 回答渲染：优先用 mathrender.js（markdown-it + KaTeX，随插件离线打包），
   * 渲染不可用时保留完整源码，避免降级处理改坏内容或链接属性。
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
    return `<pre class="md-code">${escapeHtml(String(text || ""))}</pre>`;
  }
  function appendMessage(role, text, isStream, tag, images) {
    el.emptyTip.style.display = "none";
    const wrap = document.createElement("div");
    wrap.className = `msg ${role}` + (isStream ? " streaming" : "");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") {
      setHtmlSafe(bubble, renderMarkdown(text) || "…");
      enhanceScripts(bubble);
    } else {
      bubble.textContent = text;
      if (images && images.length) {
        const gallery = document.createElement("div");
        gallery.className = "message-images";
        for (const image of images) {
          if (!/^data:image\/(png|jpeg|webp);base64,/i.test(image.url || ""))
            continue;
          const preview = document.createElement("img");
          preview.src = image.url;
          preview.alt = image.name || t("image.sent");
          gallery.appendChild(preview);
        }
        bubble.appendChild(gallery);
      }
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

  function safeSources(citations) {
    return nativeSearch.safeCitations(citations || []);
  }

  const externalLinks = new WeakSet();
  function openExternalLink(link, url) {
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (externalLinks.has(link)) return;
    externalLinks.add(link);
    link.addEventListener("click", (event) => {
      if (Zotero && typeof Zotero.launchURL === "function") {
        event.preventDefault();
        Zotero.launchURL(url);
      }
    });
  }

  function sourceLink(source, label, className) {
    const link = document.createElement("a");
    link.textContent = label;
    link.title = source.title || source.url;
    link.className = className;
    openExternalLink(link, source.url);
    return link;
  }

  function inlineCitationPositions(text, citations) {
    if (!citations.length) return [];
    // Provider offsets refer to Markdown source. Never inject marker text into
    // a formula, code, or link destination. Ambiguous locations retain their
    // clickable source below instead of risking the source grammar.
    const blocks = [];
    const delimiters = /\$\$|\\\[|\\\]/g;
    let open = null;
    let match;
    while ((match = delimiters.exec(text))) {
      if (!open && match[0] !== "\\]")
        open = { start: match.index, token: match[0] };
      else if (
        open &&
        ((open.token === "$$" && match[0] === "$$") ||
          (open.token === "\\[" && match[0] === "\\]"))
      ) {
        blocks.push({ start: open.start, end: delimiters.lastIndex });
        open = null;
      }
    }
    if (open) blocks.push({ start: open.start, end: text.length });
    return citations
      .map((source, index) => ({ source, index }))
      .filter(({ source }) => {
        const offset = source.endIndex;
        if (!Number.isInteger(offset) || offset < 0 || offset > text.length)
          return false;
        if (
          blocks.some((block) => offset >= block.start && offset <= block.end)
        )
          return false;
        const separator = text.lastIndexOf("\n\n", Math.max(0, offset - 1));
        const start = separator < 0 ? 0 : separator + 2;
        const end = text.indexOf("\n\n", offset);
        const paragraph = text.slice(start, end < 0 ? text.length : end);
        if (/[`$]|~{3}|\\[()[\]]/.test(paragraph)) return false;
        const before = text.slice(start, offset);
        return (
          !/\]\([^\n)]*$/.test(before) &&
          !/(?:https?:\/\/|www\.)\S*$/i.test(before)
        );
      });
  }

  function renderAssistant(ui, text, citations, streaming) {
    if (!ui) return;
    const sources = safeSources(citations);
    const unique = [
      ...new Map(sources.map((source) => [source.url, source])).values(),
    ];
    const numbers = new Map(
      unique.map((source, index) => [source.url, index + 1]),
    );
    // Insert inert markers before Markdown rendering, then turn only text nodes
    // into links. Provider titles/URLs never enter HTML or Markdown source.
    let marked = String(text || "");
    const inserts = inlineCitationPositions(marked, sources).sort(
      (a, b) => b.source.endIndex - a.source.endIndex,
    );
    for (const { source, index } of inserts) {
      marked =
        marked.slice(0, source.endIndex) +
        `⟦ASKGPT-CITE-${index}⟧` +
        marked.slice(source.endIndex);
    }
    // Hide provider-internal citation tokens; links above and the source list
    // carry the actual citations. Never remove ordinary claim text.
    marked = marked.replace(/\uE200cite\uE202[^\uE201]*\uE201/g, "");
    setHtmlSafe(
      ui.bubble,
      renderMarkdown(marked) +
        (streaming ? '<span class="cursor"></span>' : ""),
    );
    if (inserts.length) {
      const walker = document.createTreeWalker(ui.bubble, 4);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const value = node.nodeValue || "";
        const regex = /⟦ASKGPT-CITE-(\d+)⟧/g;
        let match,
          from = 0;
        const fragment = document.createDocumentFragment();
        while ((match = regex.exec(value))) {
          fragment.appendChild(
            document.createTextNode(value.slice(from, match.index)),
          );
          const source = sources[Number(match[1])];
          if (source) {
            const label = `[${numbers.get(source.url)}]`;
            // Markdown can put a citation inside existing link text. Keep that
            // anchor valid; the numbered source below remains a clickable link.
            if (
              !node.parentElement?.closest(
                "pre,code,.katex,.ag-math-block,.ag-math-inline",
              )
            ) {
              fragment.appendChild(
                node.parentElement?.closest("a")
                  ? document.createTextNode(label)
                  : sourceLink(source, label, "citation-link"),
              );
            }
          }
          from = regex.lastIndex;
        }
        if (from) {
          fragment.appendChild(document.createTextNode(value.slice(from)));
          node.parentNode.replaceChild(fragment, node);
        }
      }
    }
    // Providers may also include Markdown citations (for example xAI's [[1]]).
    // Open ordinary web links outside the plugin, keeping this chat in place.
    for (const link of ui.bubble.querySelectorAll("a[href]")) {
      const [source] = safeSources([{ url: link.getAttribute("href") }]);
      if (source) openExternalLink(link, source.url);
    }
    enhanceScripts(ui.bubble);
    ui.wrap.querySelector(".answer-sources")?.remove();
    if (unique.length) {
      const container = document.createElement("section");
      container.className = "answer-sources";
      const heading = document.createElement("div");
      heading.textContent = t("search.sources");
      heading.setAttribute("data-i18n", "search.sources");
      const list = document.createElement("ol");
      for (const source of unique) {
        const item = document.createElement("li");
        item.appendChild(
          sourceLink(
            source,
            source.title || new URL(source.url).hostname,
            "source-link",
          ),
        );
        list.appendChild(item);
      }
      container.append(heading, list);
      ui.wrap.appendChild(container);
    }
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

  /* ---------- 设置值清洗（防止非法字符触发 Gecko NS_ERROR_DOM_SYNTAX_ERR） ---------- */
  // 粘贴 API Key / 接口地址时最容易带进来看不见的字符：换行、制表符、零宽字符、BOM……
  // 这些字符进到请求头 / URL 里，Gecko 会直接抛 "An invalid or illegal string was specified"。
  const INVISIBLE_CHARS =
    /[\u0000-\u0020\u007f-\u009f\u00a0\u200b-\u200f\u2028\u2029\u2060\ufeff]/g;

  /** 去掉所有空白与不可见字符（API Key / 模型名这类不该有空格的值） */
  function stripInvisible(s) {
    return String(s == null ? "" : s).replace(INVISIBLE_CHARS, "");
  }

  /** 去掉控制字符但保留换行/制表（正文文本用） */
  function stripControl(s) {
    return String(s == null ? "" : s).replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufeff]/g,
      "",
    );
  }

  /* ---------- 错误上报：任何异常都写进 prefs，方便远程定位 ---------- */
  function diagnosticText(value) {
    let result = String(value || "");
    // Redact every active key before truncating, including a draft key while
    // an earlier request can still reference the saved configuration.
    const keys = new Set([
      String(getPref("apiKey", "") || ""),
      el.setKey.value,
    ]);
    for (const key of Array.from(keys)) keys.add(stripInvisible(key));
    for (const key of keys) {
      if (!key) continue;
      result = result.split(key).join("[API Key hidden]");
      try {
        result = result.split(encodeURIComponent(key)).join("[API Key hidden]");
      } catch {}
    }
    return client.safeErrorMessage(result);
  }
  function reportPanelError(stage, err) {
    try {
      const e = err || {};
      const msg = diagnosticText(
        (e && (e.name ? e.name + ": " + e.message : e.message || e)) || e,
      );
      const stack = diagnosticText(
        String((e && e.stack) || "")
          .split("\n")
          .slice(0, 6)
          .join(" | "),
      );
      const info = `[${stage}] ${msg}${stack ? " @ " + stack : ""}`.slice(
        0,
        1500,
      );
      const stamped = new Date().toISOString() + " " + info;
      setPref("lastError", stamped);
      try {
        if (el && el.setLastErr) el.setLastErr.value = stamped;
      } catch (e0) {}
      if (Zotero && Zotero.logError) {
        Zotero.logError(new Error("[AskGPT] " + info));
      }
      setStatusKey("error.recorded", { message: msg });
    } catch (e2) {}
  }

  /**
   * 安全的 HTML 插入。
   * 面板是 XHTML（XML）文档，直接 `innerHTML = 片段` 在某些情况下会被 Gecko 拒绝，
   * 抛 NS_ERROR_DOM_SYNTAX_ERR —— 就是 "An invalid or illegal string was specified"。
   * 这里失败时改用 HTML 解析器解析 + importNode 搬进来，既不受 XML 良构限制，
   * 也不会让 AI 回答中途断掉；两条路都失败才退化成纯文本。
   */
  function setHtmlSafe(target, html) {
    const src = String(html == null ? "" : html);
    if (!target) return false;
    try {
      target.innerHTML = src;
      return true;
    } catch (e) {
      try {
        const doc = new DOMParser().parseFromString(
          "<body><div id='ag-safe-root'>" + src + "</div></body>",
          "text/html",
        );
        const root = doc.getElementById("ag-safe-root");
        if (!root) throw e;
        while (target.firstChild) target.removeChild(target.firstChild);
        const frag = document.createDocumentFragment();
        for (const node of Array.from(root.childNodes)) {
          frag.appendChild(document.importNode(node, true));
        }
        target.appendChild(frag);
        reportPanelError("html-insert:fallback", e);
        return true;
      } catch (e2) {
        reportPanelError("html-insert", e2);
        try {
          target.textContent = src.replace(/<[^>]*>/g, " ");
        } catch (e3) {}
        return false;
      }
    }
  }

  /* ---------- 流式请求（OpenAI 兼容） ---------- */
  function buildEndpoint() {
    return client.buildEndpoint(el.setBase.value);
  }

  // 解析 SSE 流
  async function streamChat(payload, onDelta, signal) {
    const endpoint = buildEndpoint();
    const key = stripInvisible(el.setKey.value);
    const headers = {
      "Content-Type": "application/json",
    };
    if (key) headers.Authorization = "Bearer " + key;
    let reader;
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      const failure = new Error("Request cancelled");
      failure.name = "AbortError";
      rejectAbort(failure);
    };
    aborted.catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    const wait = (operation) => Promise.race([operation, aborted]);
    try {
      if (signal.aborted) {
        abort();
        await aborted;
      }
      let resp;
      try {
        resp = await wait(
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal,
            redirect: "error",
          }),
        );
      } catch (e) {
        // Gecko 在 URL / 请求头含非法字符串时抛的就是这个（DOMException 12）
        const em = String((e && e.name + ": " + e.message) || e);
        if (/invalid or illegal string|NS_ERROR_DOM_SYNTAX_ERR/i.test(em)) {
          throw new Error(t("error.illegalConfig", { endpoint }));
        }
        throw e;
      }
      if (!resp.ok) {
        let detail = "";
        try {
          const raw = await wait(resp.text());
          let j;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = { error: { message: raw } };
          }
          detail = j.error && (j.error.message || JSON.stringify(j.error));
        } catch (e) {
          if (e.name === "AbortError") throw e;
        }
        throw new Error(
          client.safeErrorMessage(
            new Error(`HTTP ${resp.status}: ${detail || ""}`),
            key,
          ),
        );
      }
      reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let toolCalls = {}; // index -> {name, arguments}
      let reasoning = ""; // DeepSeek 思考模式：reasoning_content 需原样回传
      let streamEnded = false;

      while (!streamEnded) {
        const { done, value } = await wait(reader.read());
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
    } finally {
      signal.removeEventListener("abort", abort);
      if (reader) {
        try {
          Promise.resolve(reader.cancel()).catch(() => {});
        } catch {}
        try {
          reader.releaseLock?.();
        } catch {}
      }
    }
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
    // Older sessions can contain local search tool rounds. Retain their readable
    // conversation without replaying obsolete function calls or UI metadata.
    return (list || [])
      .filter(
        (m) => ["system", "user", "assistant"].includes(m.role) && m.content,
      )
      .map((m) => {
        const out = { role: m.role, content: m.content };
        if (m.role === "assistant" && typeof out.content === "string") {
          const urls = [...new Set(safeSources(m.citations).map((s) => s.url))];
          // Annotation-only URLs must remain available to follow-up questions
          // such as "compare the first source", without replaying tool IDs.
          if (urls.length) {
            out.content +=
              "\n\n" +
              t("search.sources") +
              ":\n" +
              urls.map((url, index) => `[${index + 1}] ${url}`).join("\n");
          }
        }
        if (m.reasoning_content) out.reasoning_content = m.reasoning_content;
        return out;
      });
  }

  /* ---------- Chat completions / native search ---------- */
  async function send(questionText) {
    if (busy || readingImages || settingsOpen()) return;
    if (paperLoading) {
      setStatusKey("context.wait");
      return;
    }
    let q = (questionText != null ? questionText : el.input.value).trim();
    if (!q && !pendingImages.length) return;
    if (!q) q = t("image.analyze");
    try {
      buildEndpoint();
      if (!stripInvisible(el.setModel.value).trim())
        throw new Error(t("model.requiredSettings"));
      if (el.setWeb.checked) nativeSearch.validateConfig(connectionConfig());
    } catch (error) {
      setStatus(client.safeErrorMessage(error, el.setKey.value));
      return;
    }
    if (!paperText && !focusSel && !pendingImages.length && !messages.length) {
      setStatusKey("context.required");
      return;
    }
    const modelInfo =
      modelsConfig === connectionKey()
        ? fetchedModels.find((m) => m.id === el.setModel.value.trim())
        : null;
    const hasImages =
      pendingImages.length ||
      messages.some((m) => imageParts(m.content).length);
    if (
      hasImages &&
      modelInfo &&
      modelInfo.inputModalities &&
      !modelInfo.inputModalities.includes("image")
    ) {
      setStatusKey("image.unsupported");
      return;
    }

    // 会话已由 refresh/init 绑定（sessionKey/sessionBase），直接继续追加问题
    if (!sessionBase) {
      // 弹窗刚打开但前缀还没建（理论上 refresh 已建），兜底重建
      sessionBase = buildSessionBase() || [
        {
          role: "system",
          content: savedSystemPrompt(),
        },
      ];
    }

    busy = true;
    el.btnSend.disabled = true;
    el.btnSend.textContent = t("chat.sending");
    el.btnStop.classList.remove("hidden");
    el.btnSettings.disabled = true;
    $("btn-new").disabled = true;
    $("btn-attach").disabled = true;
    el.input.value = "";
    const focus = (focusSel || "").trim();
    const sentImages = pendingImages.slice();
    clearAttachments();
    appendMessage(
      "user",
      q,
      false,
      focus ? t("chat.focusTag") : "",
      sentImages,
    );
    setStatusKey("chat.thinking");

    controller = new AbortController();

    // 追加本次问题（不动前缀，保持缓存命中）。
    // 选中段落作为「焦点」随问题一起发，全文仍在前缀里。
    const userContent = focus ? t("prompt.focus", { focus, question: q }) : q;
    messages.push({
      role: "user",
      content: sentImages.length
        ? [
            { type: "text", text: userContent },
            ...sentImages.map((image) => ({
              type: "image_url",
              image_url: { url: image.url },
            })),
          ]
        : userContent,
      q,
      focus: focus || undefined,
    });

    // 整个对话流程共用一个 assistant 气泡，避免工具轮产生空消息
    let ui = null;
    let acc = "";
    let accReasoning = ""; // Preserve chat-completions reasoning when required by the provider.
    let citations = [];
    let searched = false;
    let searchCount = 0;
    let rafId = null;
    let lastStreamRender = 0;
    const renderAcc = () => {
      rafId = null;
      if (!ui) return;
      const now = Date.now();
      // KaTeX + Markdown 全量重渲染较贵，流式期间按 ~140ms 节流
      const remaining = 140 - (now - lastStreamRender);
      if (remaining > 0) {
        rafId = { raf: false, id: setTimeout(renderAcc, remaining) };
        return;
      }
      lastStreamRender = now;
      try {
        renderAssistant(ui, acc, citations, true);
        el.messages.scrollTop = el.messages.scrollHeight;
      } catch (e) {
        // 渲染失败绝不打断回答
        reportPanelError("stream-render", e);
      }
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
        try {
          renderAssistant(ui, acc, citations, false);
        } catch (e) {
          reportPanelError("final-render", e);
        }
        ui.wrap.classList.remove("streaming");
      }
    };

    try {
      const config = connectionConfig();
      const onDelta = (delta) => {
        acc += delta;
        ensureBubble();
        if (rafId === null) rafId = scheduleFrame(renderAcc);
      };
      const history = sanitizeMessages(
        sessionBase ? [...sessionBase, ...messages] : messages,
      );
      if (el.setWeb.checked) {
        const result = await nativeSearch.stream(config, {
          messages: history,
          signal: controller.signal,
          onDelta,
          onStatus: (event) => {
            if (event.type === "search") {
              searched = true;
              searchCount = event.searchCount || searchCount || 1;
              setStatusKey(
                event.status === "completed"
                  ? "search.answering"
                  : "search.runningNative",
              );
            }
          },
          onAnnotations: (sources) => {
            citations = sources;
            if (ui && rafId === null) rafId = scheduleFrame(renderAcc);
          },
        });
        acc = result.text;
        citations = result.citations;
        searched = result.searched;
        searchCount = result.searchCount;
        ensureBubble();
      } else {
        const result = await streamChat(
          {
            model: config.model,
            temperature: clampNum(el.setTemp.value, 0, 2, 0.3),
            stream: true,
            messages: history,
          },
          onDelta,
          controller.signal,
        );
        accReasoning = result.reasoning;
        if (result.toolCalls.length)
          throw new Error(t("search.unexpectedTool"));
        if (!acc.trim()) throw new Error(t("search.emptyAnswer"));
      }
      finishRender();
      const finalMsg = { role: "assistant", content: acc };
      if (accReasoning) finalMsg.reasoning_content = accReasoning;
      if (el.setWeb.checked)
        Object.assign(finalMsg, { citations, searched, searchCount });
      messages.push(finalMsg);
      persistSession();
      if (el.setWeb.checked)
        setStatusKey(searched ? "search.used" : "search.notUsed");
      else setStatus("");
    } catch (e) {
      if (e.name === "AbortError") {
        setStatusKey("chat.stopped");
        // 保留已输出的内容，移除游标
        finishRender();
        // 停止也保存已有内容
        if (acc) {
          const stopMsg = { role: "assistant", content: acc };
          if (accReasoning) stopMsg.reasoning_content = accReasoning;
          Object.assign(stopMsg, { citations, searched, searchCount });
          messages.push(stopMsg);
        }
        persistSession();
      } else {
        finishRender();
        if (ui) ui.wrap.classList.add("incomplete");
        const message = client.safeErrorMessage(e, el.setKey.value);
        setStatusKey("error.chat", {
          message,
          imageHint: hasImages ? t("image.errorHint") : "",
        });
        if (Zotero && Zotero.logError) Zotero.logError(new Error(message));
        persistSession();
      }
    } finally {
      busy = false;
      el.btnSend.disabled = false;
      el.btnSend.textContent = t("chat.send");
      el.btnStop.classList.add("hidden");
      el.btnSettings.disabled = false;
      $("btn-new").disabled = false;
      $("btn-attach").disabled = false;
      if (queuedRefresh) {
        const next = queuedRefresh;
        queuedRefresh = null;
        refresh(next);
      }
    }
  }

  function setStatus(text) {
    statusMessage = null;
    el.statusline.textContent = text || "";
  }
  function setStatusKey(key, variables) {
    setStatus(t(key, variables));
    statusMessage = { key, variables };
  }

  /* ---------- 存为 Zotero 笔记 ---------- */
  // 取最后一条 AI 回答（.msg.assistant .bubble 的纯文本）与其对应问题，
  // 组装成 HTML 笔记（标题 h1 + 正文 p，换行转 <br/>），存为选中条目的子笔记或独立笔记。
  async function saveLastAnswerAsNote() {
    const z = getZotero();
    if (!z) {
      setStatusKey("note.noZotero");
      return;
    }
    const assistantMsgs = el.messages.querySelectorAll(".msg.assistant");
    const lastAssistant = assistantMsgs.length
      ? assistantMsgs[assistantMsgs.length - 1]
      : null;
    if (!lastAssistant) {
      setStatusKey("note.noAnswer");
      return;
    }
    const bubble = lastAssistant.querySelector(".bubble");
    const answer = stripControl(bubble ? bubble.textContent : "").trim();
    if (!answer) {
      setStatusKey("note.noAnswer");
      return;
    }
    // Pair the answer with its preceding question, including when a later
    // request failed or was cancelled before it produced an assistant message.
    let userMessage = lastAssistant.previousElementSibling;
    while (userMessage && !userMessage.matches(".msg.user")) {
      userMessage = userMessage.previousElementSibling;
    }
    let question = "";
    if (userMessage) {
      question = stripControl(userMessage.textContent).trim();
    }
    const qChars = Array.from(question);
    const qShort =
      qChars.length > 40 ? qChars.slice(0, 40).join("") + "…" : question;

    // 组装笔记 HTML：所有用户内容先转义（& < >），防注入
    let html =
      "<h1>" +
      escapeHtml(t("note.heading")) +
      escapeHtml(qShort) +
      "</h1>" +
      "<p>" +
      escapeHtml(answer).replace(/\n/g, "<br/>") +
      "</p>";
    const sources = Array.from(
      lastAssistant.querySelectorAll(".answer-sources a"),
    ).map((link) => ({
      url: link.getAttribute("href"),
      title: link.textContent,
    }));
    const safe = safeSources(sources);
    if (safe.length) {
      html +=
        "<h2>" +
        escapeHtml(t("search.sources")) +
        "</h2><ul>" +
        safe
          .map(
            (source) =>
              '<li><a href="' +
              escapeHtml(source.url) +
              '">' +
              escapeHtml(source.title || source.url) +
              "</a></li>",
          )
          .join("") +
        "</ul>";
    }

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
        setStatusKey("note.savedParent", { title: parentTitle });
      } else {
        // 无选中条目：存为本文库独立笔记
        note.libraryID = z.Libraries.userLibraryID;
        note.setNote(html);
        await note.saveTx();
        setStatusKey("note.saved");
      }
    } catch (e) {
      setStatusKey("note.error", { message: (e && e.message) || e });
      try {
        z.logError(e);
      } catch (e2) {}
    }
  }

  function stop() {
    if (controller) controller.abort();
  }
  function cancelRequests() {
    stop();
    cancelConnection();
  }

  function clearConversation() {
    if (busy) return;
    clearAttachments();
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
      if (newSel === (focusSel || "").trim()) return;
      focusSel = newSel;
      updateContextBadges();
      persistSession();
      setStatus("");
    } catch (e) {}
  }

  /** 面板内框选文字（AI 回答 / 设置外任意处）→ 作为本次提问的选中段落 */
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
      updateContextBadges();
      persistSession();
    } catch (e) {}
  }

  /* ---------- 设置面板开/关 ---------- */
  function setChatInert(inert) {
    for (const node of $("app").children) {
      if (node !== el.settings) node.inert = inert;
    }
  }
  function openSettings() {
    if (busy) return;
    el.settings.classList.remove("hidden");
    setChatInert(true);
    if (el.btnSettings) el.btnSettings.classList.add("active");
    // 每次打开都重读设置，避免显示上次编辑后的过期值
    loadSettings();
    el.saveStatus.textContent = "";
    connectionStatus("");
    el.setBase.focus();
  }
  function closeSettings() {
    cancelConnection();
    el.settings.classList.add("hidden");
    setChatInert(false);
    if (el.btnSettings) el.btnSettings.classList.remove("active");
    el.setKey.type = "password";
    $("btn-toggle-key").textContent = t("connection.show");
    $("btn-toggle-key").setAttribute("aria-pressed", "false");
    loadSettings();
    el.input.focus();
  }
  function toggleSettings() {
    if (el.settings.classList.contains("hidden")) openSettings();
    else closeSettings();
  }
  function settingsOpen() {
    return !el.settings.classList.contains("hidden");
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    el.setLanguage.addEventListener("change", () => {
      applyLanguage(el.setLanguage.value);
      el.saveStatus.textContent = "";
    });
    $("btn-fetch-models").addEventListener("click", () =>
      checkConnection("models"),
    );
    $("btn-test-connection").addEventListener("click", () =>
      checkConnection("test"),
    );
    $("btn-test-search").addEventListener("click", () =>
      checkConnection("search"),
    );
    [el.setBase, el.setKey].forEach((input) =>
      input.addEventListener("input", invalidateModels),
    );
    el.setModel.addEventListener("input", () => {
      cancelConnection();
      connectionStatus("");
      $("set-model-select").value = el.setModel.value;
    });
    $("set-model-select").addEventListener("change", (event) => {
      if (event.target.value) el.setModel.value = event.target.value;
      cancelConnection();
      connectionStatus("");
    });
    $("btn-toggle-key").addEventListener("click", () => {
      const show = el.setKey.type === "password";
      el.setKey.type = show ? "text" : "password";
      $("btn-toggle-key").textContent = show
        ? t("connection.hide")
        : t("connection.show");
      $("btn-toggle-key").setAttribute("aria-pressed", String(show));
    });
    $("btn-attach").addEventListener("click", () => $("image-input").click());
    $("image-input").addEventListener("change", (event) =>
      addImages(event.target.files),
    );
    el.input.addEventListener("paste", (event) => {
      const files = Array.from(event.clipboardData?.items || [])
        .filter(
          (item) => item.kind === "file" && item.type.startsWith("image/"),
        )
        .map((item) => item.getAsFile())
        .filter(Boolean);
      if (files.length) {
        event.preventDefault();
        void addImages(files);
      }
    });
    $("btn-send").addEventListener("click", () => send());
    // ⚙ 打开设置；保存应用配置，取消 / × / Esc 恢复已保存配置。
    if (el.btnSettings) {
      el.btnSettings.addEventListener("click", toggleSettings);
    }
    ["btn-settings-close", "btn-settings-close2"].forEach((id) => {
      const btn = $(id);
      if (btn) btn.addEventListener("click", closeSettings);
    });
    $("btn-new").addEventListener("click", clearConversation);
    $("askgpt-save-btn").addEventListener("click", saveLastAnswerAsNote);
    $("btn-save").addEventListener("click", saveSettings);
    el.btnStop.addEventListener("click", stop);
    el.input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    // 面板里框选文字（AI 回答里）→ 自动成为「选中段落」
    document.addEventListener("mouseup", () => {
      // 等浏览器把选区更新完
      setTimeout(capturePanelSelection, 0);
    });
    if (el.focusClear) {
      el.focusClear.addEventListener("click", () => {
        focusSel = "";
        updateContextBadges();
        persistSession();
      });
    }
    if (el.btnClearErr) {
      el.btnClearErr.addEventListener("click", () => {
        setPref("lastError", "");
        if (el.setLastErr) el.setLastErr.value = t("diagnostics.none");
      });
    }
    // iframe 尺寸变化（主窗口拖右下角把手 / 设置里改面板大小）→ 重新判定适配档位
    if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", () => {
        syncViewportClasses();
        updateContextBadges();
        // 设置开着时顺带刷新「面板大小」里显示的实时尺寸（正在输入时不动它）
        if (settingsOpen()) {
          const fe = measurePanelFrame();
          const active = document.activeElement;
          if (fe && active !== el.setPanelW && active !== el.setPanelH) {
            el.setPanelW.value = String(Math.round(fe.w));
            el.setPanelH.value = String(Math.round(fe.h));
          }
        }
      });
    }
    document.querySelectorAll(".chip").forEach((c) => {
      c.addEventListener("click", () => send(c.dataset.q));
    });
    // Esc：设置开着时只关设置；否则隐藏整个面板
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (settingsOpen()) {
        ev.preventDefault();
        ev.stopPropagation();
        closeSettings();
        return;
      }
      try {
        const g = getAskGPT();
        cancelRequests();
        if (g && g.hidePopup) g.hidePopup({ window: getHostWindow() });
      } catch (e) {}
    });
  }

  /* ---------- 对外接口（供 index.js 复用窗口时调用） ---------- */
  window.AskGPTPopup = {
    refresh,
    send,
    clearConversation,
    cancelRequests,
    saveNote: saveLastAnswerAsNote,
    updateLiveSelection,
    capturePanelSelection,
    // 外观 / 尺寸（设置面板、主窗口与测试共用同一条链路）
    parsePanelSize,
    applyPanelSize,
    setPanelSize,
    notifyPanelSize,
    getPanelSize: measurePanelFrame,
    syncViewportClasses,
    defaultPanelSize: DEFAULT_PANEL_SIZE,
    sizeBreakpoints: {
      narrowW: BP_NARROW_W,
      wideW: BP_WIDE_W,
      shortH: BP_SHORT_H,
      tinyH: BP_TINY_H,
      minW: PANEL_W_MIN,
      minH: PANEL_H_MIN,
      maxW: PANEL_W_MAX,
      maxH: PANEL_H_MAX,
    },
    // 调试用：渲染器是否就绪（markdown-it / KaTeX 是否加载成功）
    rendererReady() {
      const R = window.AskGPTRender;
      return R && R.ready ? R.ready : { markdown: false, katex: false };
    },
  };

  // 启动
  document.addEventListener("DOMContentLoaded", () => {
    window.addEventListener("unload", cancelRequests, { once: true });
    // 任何未捕获异常 / Promise 拒绝都记录（含阶段与堆栈），方便远程定位
    window.addEventListener("error", (ev) => {
      reportPanelError(
        "window.onerror",
        (ev && (ev.error || ev.message)) || "unknown",
      );
    });
    window.addEventListener("unhandledrejection", (ev) => {
      reportPanelError(
        "unhandledrejection",
        (ev && ev.reason) || "unknown rejection",
      );
    });
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
        setStatusKey("render.missing", { names: miss.join(" / ") });
      }
    } catch (e) {}
  });
})();
