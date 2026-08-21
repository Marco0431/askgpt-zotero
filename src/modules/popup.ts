import { config } from "../../package.json";

/**
 * 打开 AskGPT 提问面板。
 *
 * 面板 = Zotero 主窗口内的浮动 iframe（不新建独立窗口）：
 * - iframe 是主窗口 DOM 的一部分 → 永远不被主窗口盖住（无需置顶 hack）
 * - 无窗口标题栏 → 界面更干净
 * - 与主进程同窗口 → 实时选中同步直接调用，无需 windowtype 匹配
 *
 * 会话模型：每个"上下文来源"（一篇文章/一个附件）独立一个会话，
 * 会话历史存在主进程 addon.data.sessions[sessionKey]（面板关闭再开不丢）。
 */
export async function openAskPopup() {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  // 立即创建/显示面板（同步，不等待附件读取）
  try {
    ensurePanel(mainWin);
  } catch (e) {
    Zotero.logError("AskGPT ensurePanel: " + e);
    return;
  }

  // 后台填充上下文：先读选中（快），再读附件（慢，带缓存）
  try {
    // 1. 收集选中文字（优先 reader 缓存，纯同步）
    let selection: string = addon.data.readerSelection || "";
    if (!selection) {
      try {
        const tabID = mainWin.Zotero_Tabs?.selectedID;
        if (tabID != null) {
          const reader = Zotero.Reader.getByTabID(tabID);
          const sel = reader?._iframeWindow?.getSelection?.().toString().trim();
          if (sel) selection = sel;
        }
      } catch (e) {}
    }
    if (!selection) {
      try {
        selection = mainWin.getSelection().toString().trim();
      } catch (e) {}
    }

    // 2. 无选中文字 → 读附件全文（后台，不阻塞面板显示）
    let contextText = "";
    let contextLabel = "";
    let contextKey = "";
    if (!selection) {
      const ctx = await readAttachmentContext();
      if (ctx && ctx.text) {
        contextText = ctx.text;
        contextLabel = ctx.label;
        contextKey = ctx.path || "";
      }
    }

    // 3. 确定会话 key
    const sessionKey = contextKey
      ? "file:" + contextKey
      : "sel:" + (selection || "").slice(0, 200);

    // 4. 初始化主进程会话存储
    const g: any = Zotero[config.addonInstance];
    if (!g.data.sessions) g.data.sessions = {};
    const session = g.data.sessions[sessionKey] || {
      key: sessionKey,
      contextText,
      contextLabel,
      selection,
      itemTitle: addon.data.readerTitle || "",
      base: null,
      history: [],
    };
    if (session.contextText !== contextText) {
      session.contextText = contextText;
      session.contextLabel = contextLabel;
      session.selection = selection;
      session.itemTitle = addon.data.readerTitle || "";
      session.base = null;
      session.history = [];
    }
    g.data.sessions[sessionKey] = session;

    // 5. 存共享状态（面板 iframe 通过 frameElement.ownerGlobal.Zotero 读取）
    g.data.popupState = {
      sessionKey,
      selection,
      itemTitle: session.itemTitle,
      contextText: session.contextText,
      contextLabel: session.contextLabel,
      session,
    };

    // 6. 存共享状态（面板 iframe 通过 frameElement.ownerGlobal.Zotero 读取）
    g.data.popupState = {
      sessionKey,
      selection,
      itemTitle: session.itemTitle,
      contextText: session.contextText,
      contextLabel: session.contextLabel,
      session,
    };

    // 7. 刷新面板状态（面板已由 ensurePanel 同步显示，这里只推送最新上下文）
    refreshPanel(mainWin, sessionKey, selection, session);
  } catch (e) {
    Zotero.logError("AskGPT openAskPopup: " + e);
  }
}

/**
 * 同步创建/显示面板（幂等：已存在则直接显示）。
 * 不依赖附件读取，点击图标立即可见。
 */
function ensurePanel(mainWin: Window) {
  const PANEL_PREF = "extensions.askgpt.panelPos";
  let wrap = mainWin.document.getElementById(
    "askgpt-panel-wrap",
  ) as HTMLDivElement;

  if (wrap) {
    // 已存在：直接显示
    wrap.style.display = "flex";
    wrap.style.zIndex = "2147483647";
    return wrap;
  }

  // 读取上次位置（默认右侧偏下）
  let saved: any = null;
  try {
    const raw = Zotero.Prefs.get(PANEL_PREF);
    if (raw) saved = JSON.parse(raw);
  } catch (e) {}
  const initLeft = saved && saved.left != null ? saved.left : null;
  const initTop = saved && saved.top != null ? saved.top : null;

  wrap = mainWin.document.createElement("div");
  wrap.id = "askgpt-panel-wrap";
  wrap.setAttribute(
    "style",
    "position:fixed;z-index:2147483647;" +
      (initLeft != null
        ? "left:" + initLeft + "px;top:" + initTop + "px;"
        : "right:24px;top:120px;") +
      "display:flex;flex-direction:column;border-radius:12px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.28);overflow:hidden;",
  );

  // 拖拽标题栏
  const bar = mainWin.document.createElement("div");
  bar.id = "askgpt-panel-bar";
  bar.setAttribute(
    "style",
    "height:28px;background:#171d28;color:#fff;display:flex;" +
      "align-items:center;justify-content:space-between;padding:0 10px;" +
      "cursor:move;user-select:none;font:12px sans-serif;",
  );
  const label = mainWin.document.createElement("span");
  label.textContent = "✎ AskGPT";
  const closeBtn = mainWin.document.createElement("span");
  closeBtn.textContent = "✕";
  closeBtn.setAttribute(
    "style",
    "cursor:pointer;padding:0 6px;opacity:.8;font-size:13px;",
  );
  closeBtn.title = "关闭";
  closeBtn.addEventListener("click", () => hideAskPopup());
  bar.appendChild(label);
  bar.appendChild(closeBtn);

  // iframe 内容区（懒加载：src 设置后浏览器异步加载，不阻塞面板显示）
  const panel = mainWin.document.createElement("iframe");
  panel.id = "askgpt-panel-frame";
  panel.src = "chrome://askgpt/content/popup.xhtml";
  panel.setAttribute(
    "style",
    "width:540px;height:600px;border:none;background:#fff;display:block;",
  );

  wrap.appendChild(bar);
  wrap.appendChild(panel);
  mainWin.document.documentElement.appendChild(wrap);

  // 拖拽逻辑：拖 bar 移动 wrap，松手保存位置
  let dragging = false;
  let startX = 0,
    startY = 0,
    baseLeft = 0,
    baseTop = 0;
  bar.addEventListener("mousedown", (e: MouseEvent) => {
    dragging = true;
    startX = e.screenX;
    startY = e.screenY;
    const rect = wrap.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    e.preventDefault();
  });
  mainWin.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    wrap.style.left = baseLeft + (e.screenX - startX) + "px";
    wrap.style.top = baseTop + (e.screenY - startY) + "px";
    wrap.style.right = "auto";
  });
  mainWin.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    try {
      const rect = wrap.getBoundingClientRect();
      Zotero.Prefs.set(
        PANEL_PREF,
        JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }),
      );
    } catch (e) {}
  });

  // iframe 加载完成后自动读取最新 popupState 刷新（若 openAskPopup 在后台填充中）
  panel.addEventListener("load", () => {
    try {
      const g: any = Zotero[config.addonInstance];
      const ps = g.data.popupState;
      if (!ps) return;
      const iw = panel.contentWindow as any;
      if (iw && iw.AskGPTPopup && iw.AskGPTPopup.refresh) {
        iw.AskGPTPopup.refresh(ps);
      }
    } catch (e) {}
  });

  return wrap;
}

/**
 * 推送最新状态到面板 iframe（幂等，可重复调用）
 */
function refreshPanel(
  mainWin: Window,
  sessionKey: string,
  selection: string,
  session: any,
) {
  try {
    const panel = mainWin.document.getElementById(
      "askgpt-panel-frame",
    ) as HTMLIFrameElement;
    if (!panel) return;
    const iw = panel.contentWindow as any;
    if (iw && iw.AskGPTPopup && iw.AskGPTPopup.refresh) {
      iw.AskGPTPopup.refresh({
        sessionKey,
        selection,
        itemTitle: session.itemTitle,
        contextText: session.contextText,
        contextLabel: session.contextLabel,
        session,
      });
    }
  } catch (e) {}
}

/**
 * 隐藏面板（Esc 或关闭按钮调用）
 */
export function hideAskPopup() {
  try {
    const mainWin = Zotero.getMainWindow();
    if (!mainWin) return;
    const wrap = mainWin.document.getElementById("askgpt-panel-wrap");
    if (wrap) wrap.style.display = "none";
  } catch (e) {}
}

/**
 * 读取当前选中条目的 HTML/MD/TXT 附件全文（md 优先，html 次之，txt 兜底）。
 * 带本地缓存：同一会话内相同路径不重复读文件。
 */
let fulltextCache: { [path: string]: { text: string; label: string } } = {};

async function readAttachmentContext(): Promise<{ text: string; label: string; path: string } | null> {
  try {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return null;
    const items = pane.getSelectedItems();
    if (!items || !items.length) return null;

    const candidates: any[] = [];
    const first = items[0];
    if (first.isAttachment) {
      candidates.push(first);
    } else if (typeof first.getAttachments === "function") {
      const attachIDs = first.getAttachments() || [];
      for (let i = 0; i < Math.min(10, attachIDs.length); i++) {
        const child = Zotero.Items.get(attachIDs[i]);
        if (child && child.isAttachment) candidates.push(child);
      }
    }
    if (!candidates.length) return null;

    const pick = (ext: string) =>
      ext === "md" || ext === "markdown" ? 0
      : ext === "html" || ext === "htm" ? 1
      : ext === "txt" || ext === "text" ? 2
      : -1;

    const readable = candidates
      .map((c) => {
        let p: string | null = null;
        try { p = c.getFilePath(); } catch (e) {}
        if (!p) return null;
        const ext = (p.split(".").pop() || "").toLowerCase();
        const pri = pick(ext);
        if (pri < 0) return null;
        return { path: p, pri };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.pri - b.pri);

    const chosen = readable[0];
    if (!chosen) return null;

    // 本地全文缓存命中
    if (fulltextCache[chosen.path]) {
      return { ...fulltextCache[chosen.path], path: chosen.path };
    }

    const label =
      chosen.pri === 0 ? "Markdown 附件"
      : chosen.pri === 1 ? "HTML 附件"
      : "TXT 附件";

    let text = await Zotero.File.getContentsAsync(chosen.path, "utf-8");
    if (typeof text !== "string") return null;

    if (chosen.pri === 1) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    if (text.length > 80000) {
      text = text.slice(0, 80000) + "\n...[截断]...";
    }

    const result = { text, label, path: chosen.path };
    fulltextCache[chosen.path] = result;
    return result;
  } catch (e) {
    return null;
  }
}