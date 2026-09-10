import { config } from "../../package.json";
import { readAttachmentContext } from "./fulltext";

/**
 * 打开 AskGPT 提问面板。
 *
 * 面板 = Zotero 主窗口内的浮动 iframe（不新建独立窗口）：
 * - iframe 是主窗口 DOM 的一部分 → 永远不被主窗口盖住（无需置顶 hack）
 * - 无窗口标题栏 → 界面更干净
 * - 与主进程同窗口 → 实时选中同步直接调用，无需 windowtype 匹配
 *
 * 上下文模型（重点）：
 * - **整篇文献**是固定前缀（system + 全文），同一篇文献反复提问前缀不变 → API 前缀缓存持续命中；
 * - 在 PDF/译文里**选中的段落**只是附加在本次提问前，用来告诉模型"我在看哪一段"，
 *   不会把全文丢掉，也不会因为换选中而清空会话历史。
 *
 * 会话存在主进程 addon.data.sessions[sessionKey]（面板关闭再开不丢）。
 */
export async function openAskPopup() {
  const mainWin = Zotero.getMainWindow();
  if (!mainWin) return;

  // 立即创建/显示面板（同步，不等待附件读取）
  try {
    ensurePanel(mainWin);
  } catch (e) {
    Zotero.logError(new Error("AskGPT ensurePanel: " + e));
    return;
  }

  const mainDoc: any = (mainWin as any).document;

  try {
    // 1) 收集选中文字（优先 reader 缓存，纯同步）
    let selection: string = addon.data.readerSelection || "";
    if (!selection) {
      try {
        const tabID = (mainWin as any).Zotero_Tabs?.selectedID;
        if (tabID != null) {
          const reader: any = Zotero.Reader.getByTabID(tabID);
          const sel = (
            reader?._iframeWindow?.getSelection?.()?.toString() || ""
          ).trim();
          if (sel) selection = sel;
        }
      } catch (e) {}
    }
    if (!selection) {
      try {
        selection = ((mainWin as any).getSelection()?.toString() || "").trim();
      } catch (e) {}
    }
    if (selection) addon.data.readerSelection = selection;

    // 2) 先推一个"正在读取全文"的即时状态，面板立刻有反馈
    pushPanel(mainWin, {
      loading: true,
      selection,
      itemTitle: addon.data.readerTitle || "",
      contextText: "",
      contextLabel: "",
      session: null,
    });

    // 3) 读整篇文献（PDF 全文 / HTML 译文 / Markdown 源）
    const ctx = await readAttachmentContext();
    const contextText = ctx ? ctx.text : "";
    const contextLabel = ctx ? ctx.label : "";
    const contextPath = ctx ? ctx.path : "";
    const contextChars = ctx ? ctx.chars : 0;
    const truncated = ctx ? ctx.truncated : false;
    const itemTitle = (ctx && ctx.title) || addon.data.readerTitle || "";
    if (itemTitle) addon.data.readerTitle = itemTitle;

    // 4) 会话 key：同一篇文献始终同一个会话（换选中段落不清空历史）
    const sessionKey = contextPath
      ? "file:" + contextPath
      : "sel:" + (selection || "").slice(0, 200);

    const g: any = (Zotero as any)[config.addonInstance];
    if (!g.data.sessions) g.data.sessions = {};
    const session: any = g.data.sessions[sessionKey] || {
      key: sessionKey,
      contextText,
      contextLabel,
      selection,
      itemTitle,
      base: null,
      history: [],
    };
    // 只有全文真的变了才丢弃已构建的前缀（历史保留）
    if (session.contextText !== contextText) {
      session.contextText = contextText;
      session.contextLabel = contextLabel;
      session.base = null;
    }
    session.selection = selection;
    session.itemTitle = itemTitle;
    session.chars = contextChars;
    session.truncated = truncated;
    session.hasFullText = !!contextText;
    g.data.sessions[sessionKey] = session;

    // 5) 推送最新状态给面板
    pushPanel(mainWin, {
      loading: false,
      sessionKey,
      selection,
      itemTitle: session.itemTitle,
      contextText,
      contextLabel,
      contextChars,
      truncated,
      session,
    });
  } catch (e) {
    Zotero.logError(new Error("AskGPT openAskPopup: " + e));
    // 出错也要让面板可用（退回选中文字模式）
    pushPanel(mainWin, {
      loading: false,
      selection: addon.data.readerSelection || "",
      itemTitle: addon.data.readerTitle || "",
      contextText: "",
      contextLabel: "",
      session: null,
    });
  }
  void mainDoc;
}

/**
 * 同步创建/显示面板（幂等：已存在则直接显示）。
 * 不依赖附件读取，点击图标立即可见。
 */
function ensurePanel(mainWin: Window) {
  const PANEL_PREF = "extensions.askgpt.panelPos";
  const doc: any = (mainWin as any).document;
  let wrap = doc.getElementById("askgpt-panel-wrap") as HTMLDivElement;

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
    if (raw) saved = JSON.parse(String(raw));
  } catch (e) {}
  const initLeft = saved && saved.left != null ? saved.left : null;
  const initTop = saved && saved.top != null ? saved.top : null;

  wrap = doc.createElement("div");
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
  const bar = doc.createElement("div");
  bar.id = "askgpt-panel-bar";
  bar.setAttribute(
    "style",
    "height:28px;background:#171d28;color:#fff;display:flex;" +
      "align-items:center;justify-content:space-between;padding:0 10px;" +
      "cursor:move;user-select:none;font:12px sans-serif;",
  );
  const label = doc.createElement("span");
  label.textContent = "✎ AskGPT";
  const closeBtn = doc.createElement("span");
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
  const panel = doc.createElement("iframe");
  panel.id = "askgpt-panel-frame";
  panel.src = "chrome://askgpt/content/popup.xhtml";
  panel.setAttribute(
    "style",
    "width:540px;height:600px;border:none;background:#fff;display:block;",
  );

  wrap.appendChild(bar);
  wrap.appendChild(panel);
  doc.documentElement!.appendChild(wrap);

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
  (mainWin as any).addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    wrap.style.left = baseLeft + (e.screenX - startX) + "px";
    wrap.style.top = baseTop + (e.screenY - startY) + "px";
    wrap.style.right = "auto";
  });
  (mainWin as any).addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    try {
      const rect = wrap.getBoundingClientRect();
      Zotero.Prefs.set(
        PANEL_PREF,
        JSON.stringify({
          left: Math.round(rect.left),
          top: Math.round(rect.top),
        }),
      );
    } catch (e) {}
  });

  // iframe 加载完成后自动读取最新 popupState 刷新（若 openAskPopup 在后台填充中）
  panel.addEventListener("load", () => {
    try {
      const g: any = (Zotero as any)[config.addonInstance];
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

/** 把状态同时存到 addon.data.popupState 并推给面板 iframe（幂等） */
function pushPanel(mainWin: Window, payload: any) {
  const g: any = (Zotero as any)[config.addonInstance];
  g.data.popupState = payload;
  try {
    const panel = (mainWin as any).document.getElementById(
      "askgpt-panel-frame",
    ) as HTMLIFrameElement | null;
    if (!panel) return;
    const iw: any = panel.contentWindow;
    if (iw && iw.AskGPTPopup && iw.AskGPTPopup.refresh) {
      iw.AskGPTPopup.refresh(payload);
    }
  } catch (e) {}
}

/**
 * 隐藏面板（Esc 或关闭按钮调用）
 */
export function hideAskPopup() {
  try {
    const mainWin: any = Zotero.getMainWindow();
    if (!mainWin) return;
    const wrap = mainWin.document.getElementById(
      "askgpt-panel-wrap",
    ) as HTMLElement | null;
    if (wrap) wrap.style.display = "none";
  } catch (e) {}
}
