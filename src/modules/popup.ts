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
    Zotero.logError(new Error("AskGPT ensurePanel: " + e));
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
          const sel = (
            reader?._iframeWindow?.getSelection?.()?.toString() || ""
          ).trim();
          if (sel) selection = sel;
        }
      } catch (e) {}
    }
    if (!selection) {
      try {
        selection = (mainWin.getSelection()?.toString() || "").trim();
      } catch (e) {}
    }

    // 2. 读附件全文（优先整篇论文，选中文字作为定位附加）
    let contextText = "";
    let contextLabel = "";
    let contextKey = "";
    const ctx = await readAttachmentContext();
    if (ctx && ctx.text) {
      contextText = selection
        ? `【选中段落】\n${selection}\n\n【论文全文】\n${ctx.text}`
        : ctx.text;
      contextLabel = ctx.label;
      contextKey = ctx.path || "";
    } else if (selection) {
      // 无附件可读（如 PDF 未导出文本）：退回到选中文字
      contextText = selection;
    }

    // 3. 确定会话 key
    const sessionKey = contextKey
      ? "file:" + contextKey
      : "sel:" + (selection || "").slice(0, 200);

    // 4. 初始化主进程会话存储
    const g: any = (Zotero as any)[config.addonInstance];
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
    Zotero.logError(new Error("AskGPT openAskPopup: " + e));
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
    if (raw) saved = JSON.parse(String(raw));
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
  mainWin.document.documentElement!.appendChild(wrap);

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
    const wrap = mainWin.document.getElementById(
      "askgpt-panel-wrap",
    ) as HTMLElement | null;
    if (wrap) wrap.style.display = "none";
  } catch (e) {}
}

/**
 * 读取当前选中条目的 HTML/MD/TXT 附件全文（md 优先，html 次之，txt 兜底）。
 * 带本地缓存：同一会话内相同路径不重复读文件。
 */
const fulltextCache: { [path: string]: { text: string; label: string } } = {};

async function readAttachmentContext(): Promise<{
  text: string;
  label: string;
  path: string;
} | null> {
  try {
    const pane = Zotero.getActiveZoteroPane();
    if (!pane) return null;
    const items = pane.getSelectedItems();
    if (!items || !items.length) return null;

    const candidates: any[] = [];
    const first: any = items[0];
    if (first.isAttachment) {
      candidates.push(first);
    } else if (typeof first.getAttachments === "function") {
      const attachIDs = first.getAttachments() || [];
      for (let i = 0; i < Math.min(10, attachIDs.length); i++) {
        const child = Zotero.Items.get(attachIDs[i]);
        if (child && (child as any).isAttachment) candidates.push(child);
      }
    }
    if (!candidates.length) return null;

    const pick = (ext: string) =>
      ext === "md" || ext === "markdown"
        ? 0
        : ext === "html" || ext === "htm"
          ? 1
          : ext === "txt" || ext === "text"
            ? 2
            : -1;

    const readable = candidates
      .map((c) => {
        let p: string | null = null;
        try {
          p = c.getFilePath();
        } catch (e) {}
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
      chosen.pri === 0
        ? "Markdown 附件"
        : chosen.pri === 1
          ? "HTML 附件"
          : "TXT 附件";

    const raw = await Zotero.File.getContentsAsync(chosen.path, "utf-8");
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw != null) {
      // BufferSource（Uint8Array）→ 转字符串
      text = new TextDecoder("utf-8").decode(raw as BufferSource);
    } else {
      return null;
    }

    if (chosen.pri === 1) {
      // HTML 附件：优先使用伴生的 Markdown 源（公式为完整 LaTeX，上下标完好）
      const mdText = await tryReadSiblingMd(chosen.path);
      if (mdText != null) {
        text = mdToPlain(mdText);
      } else {
        text = htmlToPlain(text);
      }
    }

    if (text.length > 120000) {
      text = text.slice(0, 120000) + "\n...[截断]...";
    }

    const result = { text, label, path: chosen.path };
    fulltextCache[chosen.path] = result;
    return result;
  } catch (e) {
    return null;
  }
}

/**
 * 查找 HTML 附件同目录下的伴生 Markdown 源（译文工具生成的 HTML 通常带 md 源，
 * md 里公式是完整 LaTeX，上下标信息不丢失）。
 * 候选规则：
 *   1. 去掉 .html 后缀换 .md（同名不同扩展名）
 *   2. 去掉 "_离线" 等后缀后再换 .md（如 XXX_中文翻译_离线.html → XXX_中文翻译.md）
 */
async function tryReadSiblingMd(htmlPath: string): Promise<string | null> {
  const base = htmlPath.replace(/\.html?$/i, "");
  const cands = [
    base + ".md",
    base.replace(/_离线$/, "") + ".md",
    base.replace(/\.(zh|cn|translated|离线)[^/\\]*$/i, "") + ".md",
  ];
  for (const p of cands) {
    if (p === htmlPath) continue;
    try {
      const raw = await Zotero.File.getContentsAsync(p, "utf-8");
      if (raw == null) continue;
      return typeof raw === "string"
        ? raw
        : new TextDecoder("utf-8").decode(raw as BufferSource);
    } catch (e) {
      /* 文件不存在，继续下一个候选 */
    }
  }
  return null;
}

/** HTML 纯文本提取（无伴生 md 时的兜底） */
function htmlToPlain(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Markdown → 纯文本（保留 LaTeX 公式 $...$ / $$...$$ / \begin{}..\end{}，
 * 剥离 base64 图片、链接、代码、HTML 标签）。
 */
function mdToPlain(md: string): string {
  return (
    md
      // 行内/块级 base64 图片（译文工具会把公式图嵌入 md）整体删除
      .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/g, " ")
      // 普通图片语法删除
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      // 链接保留文字
      .replace(/\[([^\]]*)\]\((?:https?:|ftp:)?\/\/[^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 删掉 svg/图片相关 HTML 标签（md 里偶尔残留）
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<img[^>]*>/gi, " ")
      // 删除围栏代码块与行内代码标记（保留代码内容本身）
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`\n]+)`/g, "$1")
      // 删除 markdown 标题/强调/引用标记
      .replace(/^\s*#{1,6}\s*/gm, "")
      .replace(/(\*\*|__)([^*\n]+)\1/g, "$2")
      .replace(/(\*|_)([^*\n]+)\1/g, "$2")
      .replace(/^\s*>\s?/gm, "")
      // 删除 HTML 标签（其余残留）
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      // 表格分隔行
      .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
