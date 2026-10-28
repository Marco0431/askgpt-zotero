import { config } from "../../package.json";
import { getSourceMode, readAttachmentContext } from "./fulltext";
import { getNativeString } from "../utils/language";

export type PopupOptions = { reader?: any; window?: Window };
type PanelState = {
  visible: boolean;
  loading: boolean;
  reader: any;
  generation: number;
  source: string;
  pending?: Promise<void>;
  cancelLoad?: () => void;
  cleanup: Array<() => void>;
};
const panels = new Map<Window, PanelState>();

export function getAskPopupState(win: Window) {
  const state = panels.get(win);
  return {
    visible: state?.visible || false,
    loading: state?.loading || false,
    reader: state?.reader || null,
  };
}

function publishPanelState(win: Window) {
  const detail = getAskPopupState(win);
  try {
    const event = win.document.createEvent("CustomEvent");
    event.initCustomEvent("askgpt-panel-state", false, false, detail);
    win.document.dispatchEvent(event);
  } catch (e) {}
}

function resolvePopupTarget(options: PopupOptions) {
  const win: any =
    options.window || options.reader?._window || Zotero.getMainWindow();
  let reader = options.reader;
  if (!reader && win?.Zotero_Tabs?.selectedID != null) {
    try {
      reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    } catch (e) {}
  }
  return { win: win as Window, reader: reader || null };
}

function panelAPI(win: Window): any {
  try {
    return (
      (win.document.getElementById("askgpt-panel-frame") as HTMLIFrameElement)
        ?.contentWindow as any
    )?.AskGPTPopup;
  } catch (e) {
    return null;
  }
}

function focusPanel(win: Window) {
  try {
    const frame = win.document.getElementById(
      "askgpt-panel-frame",
    ) as HTMLIFrameElement;
    const input = frame?.contentDocument?.getElementById("input");
    const settings = frame?.contentDocument?.getElementById("settings");
    if (settings && !settings.classList.contains("hidden")) return;
    (input as HTMLElement)?.focus();
  } catch (e) {}
}

function readSelection(reader: any, host: Window) {
  if (reader) {
    try {
      const selected = String(
        reader?._internalReader?._primaryView?._iframeWindow
          ?.getSelection?.()
          ?.toString() ||
          reader?._iframeWindow?.getSelection?.()?.toString() ||
          "",
      ).trim();
      if (selected) return selected;
    } catch (e) {}
    return addon.data.readerSelectionItemID ===
      (reader.itemID || reader._item?.id)
      ? addon.data.readerSelection || ""
      : "";
  }
  try {
    return (host.getSelection()?.toString() || "").trim();
  } catch (e) {
    return "";
  }
}

export async function toggleAskPopup(options: PopupOptions = {}) {
  const { win, reader } = resolvePopupTarget(options);
  if (!win) return;
  const state = panels.get(win);
  if (state?.visible && state.reader === reader) {
    hideAskPopup({ window: win });
    return;
  }
  await openAskPopup({ window: win, reader });
}

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
export async function openAskPopup(options: PopupOptions = {}) {
  const { win: mainWin, reader } = resolvePopupTarget(options);
  if (!mainWin) return;

  let state = panels.get(mainWin);
  if (!state) {
    state = {
      visible: false,
      loading: false,
      reader: null,
      generation: 0,
      source: "",
      cleanup: [],
    };
    panels.set(mainWin, state);
    // An iframe that loads before its first context must not inherit another
    // window's compatibility snapshot from addon.data.popupState.
    (mainWin as any).__askgptPopupState = null;
  }
  const wasVisible = state.visible;
  const pane: any = (mainWin as any).ZoteroPane;
  const source = JSON.stringify([
    reader?.itemID || reader?._item?.id || null,
    reader
      ? []
      : (pane?.getSelectedItems?.() || []).map((item: any) => item.id),
    getSourceMode(),
  ]);
  const sameSource = state.source === source && state.reader === reader;

  // 立即创建/显示面板（同步，不等待附件读取）
  try {
    ensurePanel(mainWin);
  } catch (e) {
    Zotero.logError(new Error("AskGPT ensurePanel: " + e));
    return;
  }
  state.visible = true;
  state.reader = reader;
  publishPanelState(mainWin);

  if (sameSource && state.pending) {
    focusPanel(mainWin);
    return state.pending;
  }
  // Repeated shortcuts only focus an already loaded panel. Reopening a hidden
  // panel still checks the attachment cache for changed files.
  if (sameSource && wasVisible && !state.loading) {
    focusPanel(mainWin);
    return;
  }
  const current = state;
  current.cancelLoad?.();
  const generation = ++current.generation;
  current.source = source;
  current.loading = true;
  panelAPI(mainWin)?.cancelRequests?.();
  publishPanelState(mainWin);
  const isCurrent = () =>
    panels.get(mainWin) === current &&
    current.generation === generation &&
    current.visible;
  const cancelled = new Promise<null>((resolve) => {
    current.cancelLoad = () => resolve(null);
  });

  const pending = (async () => {
    await Promise.resolve();
    if (!isCurrent()) return;
    let selection = "";
    try {
      selection = readSelection(reader, mainWin);

      // 2) 先推一个"正在读取全文"的即时状态，面板立刻有反馈
      pushPanel(mainWin, {
        loading: true,
        selection,
        itemTitle: "",
        contextText: "",
        contextLabel: "",
        session: null,
      });

      // 3) 读整篇文献（PDF 全文 / HTML 译文 / Markdown 源）
      const ctx = await Promise.race([
        readAttachmentContext({ reader, window: mainWin }),
        cancelled,
      ]);
      if (!isCurrent()) return;
      selection = readSelection(reader, mainWin);
      const contextText = ctx ? ctx.text : "";
      const contextLabel = ctx ? ctx.label : "";
      const contextPath = ctx ? ctx.path : "";
      const contextChars = ctx ? ctx.chars : 0;
      const truncated = ctx ? ctx.truncated : false;
      const itemTitle =
        (ctx && ctx.title) || reader?._item?.getField?.("title") || "";
      if (itemTitle) addon.data.readerTitle = itemTitle;

      // 4) 会话 key：同一篇文献始终同一个会话（换选中段落不清空历史）
      const sessionKey = contextPath
        ? "file:" + contextPath
        : "source:" + source;

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
      focusPanel(mainWin);
    } catch (e) {
      if (!isCurrent()) return;
      Zotero.logError(new Error("AskGPT openAskPopup: " + e));
      // 出错也要让面板可用（退回选中文字模式）
      pushPanel(mainWin, {
        loading: false,
        selection,
        itemTitle: "",
        contextText: "",
        contextLabel: "",
        session: null,
      });
    } finally {
      if (
        panels.get(mainWin) === current &&
        current.generation === generation
      ) {
        current.pending = undefined;
        current.cancelLoad = undefined;
        current.loading = false;
        publishPanelState(mainWin);
      }
    }
  })();
  current.pending = pending;
  return pending;
}

/**
 * 同步创建/显示面板（幂等：已存在则直接显示）。
 * 不依赖附件读取，点击图标立即可见。
 */
function ensurePanel(mainWin: Window) {
  const PANEL_PREF = "extensions.askgpt.panelPos";
  const SIZE_PREF = "extensions.askgpt.panelSize";
  const doc: any = (mainWin as any).document;
  const state = panels.get(mainWin)!;
  const listen = (target: any, type: string, handler: any) => {
    target.addEventListener(type, handler);
    state.cleanup.push(() => target.removeEventListener(type, handler));
  };
  const frame = doc.getElementById(
    "askgpt-panel-frame",
  ) as HTMLIFrameElement | null;
  let wrap = doc.getElementById("askgpt-panel-wrap") as HTMLDivElement;

  // 面板尺寸可配置（设置里改完保存会立即改 iframe；这里兜底/应用外部改动）
  const size = readPanelSize(SIZE_PREF, mainWin);

  if (wrap) {
    // 已存在：直接显示，并同步最新尺寸（含上次拖缩放把手改出的尺寸）
    wrap.style.display = "flex";
    wrap.style.zIndex = "2147483647";
    wrap.style.width = size.width + "px";
    if (frame) {
      frame.style.width = size.width + "px";
      frame.style.height = size.height + "px";
      // 上次记住了「又大又靠下」的尺寸时，别让它超出可视区（把手会被顶出窗外）
      keepPanelInView(mainWin, wrap, size, PANEL_PREF);
    }
    return wrap;
  }

  // 读取上次位置（默认右侧偏下）
  let saved: any = null;
  try {
    const raw = Zotero.Prefs.get(PANEL_PREF);
    if (raw) saved = JSON.parse(String(raw));
  } catch (e) {}
  const validPosition =
    Number.isFinite(saved?.left) && Number.isFinite(saved?.top);
  const initLeft = validPosition ? saved.left : null;
  const initTop = validPosition ? saved.top : null;

  wrap = doc.createElement("div");
  wrap.id = "askgpt-panel-wrap";
  wrap.setAttribute(
    "style",
    "position:fixed;z-index:2147483647;" +
      (initLeft != null
        ? "left:" + initLeft + "px;top:" + initTop + "px;"
        : "right:24px;top:120px;") +
      "width:" +
      size.width +
      "px;" +
      "display:flex;flex-direction:column;border-radius:12px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.28);overflow:hidden;",
  );

  // 拖拽标题栏（只留一条细栏，把高度让给对话区）
  const bar = doc.createElement("div");
  bar.id = "askgpt-panel-bar";
  bar.setAttribute(
    "style",
    "height:22px;background:#171d28;color:#fff;display:flex;" +
      "align-items:center;justify-content:space-between;padding:0 8px;" +
      "cursor:move;user-select:none;font:11px sans-serif;",
  );
  const label = doc.createElement("span");
  label.textContent = "✎ AskGPT";
  const closeBtn = doc.createElement("button");
  closeBtn.id = "askgpt-panel-close";
  closeBtn.textContent = "✕";
  closeBtn.setAttribute(
    "style",
    "cursor:pointer;padding:0;width:26px;height:22px;border:0;background:transparent;color:inherit;font-size:14px;line-height:1;",
  );
  closeBtn.title = getNativeString("native-close");
  closeBtn.setAttribute("aria-label", closeBtn.title);
  closeBtn.type = "button";
  closeBtn.addEventListener("click", () => hideAskPopup({ window: mainWin }));
  bar.appendChild(label);
  bar.appendChild(closeBtn);

  // iframe 内容区（懒加载：src 设置后浏览器异步加载，不阻塞面板显示）
  const panel = doc.createElement("iframe");
  panel.id = "askgpt-panel-frame";
  panel.src = "chrome://askgpt/content/popup.xhtml";
  panel.setAttribute(
    "style",
    "width:" +
      size.width +
      "px;height:" +
      size.height +
      "px;border:none;background:#fff;display:block;",
  );

  wrap.appendChild(bar);
  wrap.appendChild(panel);
  doc.documentElement!.appendChild(wrap);

  // 缩放把手（右下角为主，另加右边缘 / 下边缘）：
  // 放在主窗口的 wrap 里而不是 iframe 内部 —— 否则鼠标一移出 iframe 就丢事件。
  // 拖动时给 iframe 关掉 pointer-events，鼠标事件全程留在主窗口。
  ensurePanelStyle(doc);
  let resizing: ResizeDir | null = null;
  let rzStartX = 0,
    rzStartY = 0,
    rzBaseW = 0,
    rzBaseH = 0;
  let lastSize = { w: size.width, h: size.height };

  const applyPanelMetrics = (w: number, h: number) => {
    // wrap 宽度 = iframe 宽度；wrap 高度不写死（= 22px 拖动条 + iframe 高度）
    wrap.style.width = w + "px";
    panel.style.width = w + "px";
    panel.style.height = h + "px";
    lastSize = { w, h };
    // 主动通知面板重新判定布局适配档位（不依赖 iframe 自身 resize 事件）
    try {
      const iw: any = panel.contentWindow;
      if (iw && iw.AskGPTPopup && iw.AskGPTPopup.notifyPanelSize) {
        iw.AskGPTPopup.notifyPanelSize(w, h);
      }
    } catch (e) {}
  };

  const HANDLES: Array<{ id: string; dir: ResizeDir }> = [
    { id: "askgpt-panel-resize", dir: "corner" },
    { id: "askgpt-panel-resize-r", dir: "r" },
    { id: "askgpt-panel-resize-b", dir: "b" },
  ];
  for (const def of HANDLES) {
    const handle = doc.createElement("div");
    handle.id = def.id;
    handle.setAttribute("data-dir", def.dir);
    handle.title = getNativeString("native-resize");
    handle.addEventListener("mousedown", (e: MouseEvent) => {
      if (e.button !== 0) return;
      resizing = def.dir;
      rzStartX = e.screenX;
      rzStartY = e.screenY;
      const rect = wrap.getBoundingClientRect();
      const frameH = panel.getBoundingClientRect().height;
      rzBaseW = rect.width;
      rzBaseH =
        frameH > 0 ? frameH : parseFloat(panel.style.height) || rect.height;
      e.preventDefault();
      e.stopPropagation();
      // 拖动期间 iframe 不再吃鼠标事件，避免鼠标移到 iframe 上时丢 mousemove/mouseup
      panel.style.pointerEvents = "none";
      doc.documentElement.classList.add("askgpt-resizing", "ag-rz-" + def.dir);
    });
    wrap.appendChild(handle);
  }

  // 拖拽逻辑：拖 bar 移动 wrap；拖把手缩放 wrap + iframe；松手各自记忆
  let dragging = false;
  let startX = 0,
    startY = 0,
    baseLeft = 0,
    baseTop = 0;
  bar.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0 || closeBtn.contains(e.target as Node)) return;
    dragging = true;
    startX = e.screenX;
    startY = e.screenY;
    const rect = wrap.getBoundingClientRect();
    baseLeft = rect.left;
    baseTop = rect.top;
    panel.style.pointerEvents = "none";
    e.preventDefault();
  });
  listen(mainWin, "mousemove", (e: MouseEvent) => {
    if (resizing) {
      const next = computeResizedPanel(
        { w: rzBaseW, h: rzBaseH },
        { dx: e.screenX - rzStartX, dy: e.screenY - rzStartY },
        resizing,
        {
          width: (mainWin as any).innerWidth || 1200,
          height: (mainWin as any).innerHeight || 900,
        },
      );
      applyPanelMetrics(next.w, next.h);
      return;
    }
    if (!dragging) return;
    wrap.style.left = baseLeft + (e.screenX - startX) + "px";
    wrap.style.top = baseTop + (e.screenY - startY) + "px";
    wrap.style.right = "auto";
  });
  const finishInteraction = () => {
    panel.style.pointerEvents = "";
    if (resizing) {
      resizing = null;
      panel.style.pointerEvents = "";
      doc.documentElement.classList.remove(
        "askgpt-resizing",
        "ag-rz-corner",
        "ag-rz-r",
        "ag-rz-b",
      );
      // 松手才写 prefs（拖动过程实时生效但不落盘，避免高频写配置）
      try {
        Zotero.Prefs.set(SIZE_PREF, lastSize.w + "x" + lastSize.h);
      } catch (e) {}
      keepPanelInView(
        mainWin,
        wrap,
        { width: lastSize.w, height: lastSize.h },
        PANEL_PREF,
      );
      return;
    }
    if (!dragging) return;
    dragging = false;
    keepPanelInView(
      mainWin,
      wrap,
      {
        width: wrap.getBoundingClientRect().width,
        height: panel.getBoundingClientRect().height,
      },
      PANEL_PREF,
    );
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
  };
  listen(mainWin, "mouseup", finishInteraction);
  listen(mainWin, "blur", finishInteraction);
  state.cleanup.push(finishInteraction);
  listen(mainWin, "resize", () => {
    if (!state.visible) return;
    const next = readPanelSize(SIZE_PREF, mainWin);
    applyPanelMetrics(next.width, next.height);
    keepPanelInView(mainWin, wrap, next, PANEL_PREF);
  });
  listen(mainWin, "unload", () => disposeAskPopup(mainWin));

  // iframe 加载完成后自动读取最新 popupState 刷新（若 openAskPopup 在后台填充中）
  panel.addEventListener("load", () => {
    try {
      const ps = (mainWin as any).__askgptPopupState;
      if (!ps) return;
      const iw = panel.contentWindow as any;
      if (iw && iw.AskGPTPopup && iw.AskGPTPopup.refresh) {
        iw.AskGPTPopup.refresh(ps);
        if (state.visible) focusPanel(mainWin);
      }
    } catch (e) {}
  });

  keepPanelInView(mainWin, wrap, size, PANEL_PREF);
  return wrap;
}

/* ==== 面板尺寸：默认值 + 纯函数（.scaffold/tmp/test_resize.cjs 会抽取这段做单测） ==== */
/** 面板默认尺寸：宽而短（一开就适合读文献 + 提问，不占满半个屏幕） */
const PANEL_DEFAULT_W = 900;
const PANEL_DEFAULT_H = 520;
/** 面板尺寸硬边界（与面内 popup.js 的夹取一致） */
const PANEL_MIN_W = 420;
const PANEL_MIN_H = 360;
const PANEL_MAX = 1600;
const PANEL_VIEW_MARGIN_X = 40; // 宽最多 = 主窗口宽 − 40
const PANEL_VIEW_MARGIN_Y = 80; // 高最多 = 主窗口高 − 80

/** 主窗口可视区内允许的最大面板尺寸 */
export function panelSizeLimits(view: { width: number; height: number }) {
  return {
    maxW: Math.max(
      PANEL_MIN_W,
      Math.min(PANEL_MAX, (view.width || 1200) - PANEL_VIEW_MARGIN_X),
    ),
    maxH: Math.max(
      PANEL_MIN_H,
      Math.min(PANEL_MAX, (view.height || 900) - PANEL_VIEW_MARGIN_Y),
    ),
  };
}

/**
 * 把一次缩放拖拽的位移换算成新的面板尺寸（纯函数，便于单测）。
 * dir: "corner" 右下角（宽高都变）/ "r" 右边缘（只变宽）/ "b" 下边缘（只变高）。
 */
export function computeResizedPanel(
  base: { w: number; h: number },
  delta: { dx: number; dy: number },
  dir: "corner" | "r" | "b",
  view: { width: number; height: number },
) {
  const { maxW, maxH } = panelSizeLimits(view);
  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  const w = dir === "b" ? base.w : clamp(base.w + delta.dx, PANEL_MIN_W, maxW);
  const h = dir === "r" ? base.h : clamp(base.h + delta.dy, PANEL_MIN_H, maxH);
  return { w: Math.round(w), h: Math.round(h) };
}

/** 解析 "900x520" / {w,h} / {width,height} 形式的面板尺寸（非法值 / 非正数返回 null） */
export function parsePanelSize(raw: any): { w: number; h: number } | null {
  const ok = (w: number, h: number) =>
    isFinite(w) && isFinite(h) && w > 0 && h > 0;
  try {
    if (raw && typeof raw === "object") {
      const w = parseFloat(raw.w ?? raw.width);
      const h = parseFloat(raw.h ?? raw.height);
      return ok(w, h) ? { w, h } : null;
    }
    const s = String(raw ?? "").trim();
    if (s.startsWith("{")) {
      const o = JSON.parse(s);
      const w = parseFloat(o.w ?? o.width);
      const h = parseFloat(o.h ?? o.height);
      return ok(w, h) ? { w, h } : null;
    }
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*[x×,;\s]\s*(-?\d+(?:\.\d+)?)/i);
    if (m) {
      const w = parseFloat(m[1]);
      const h = parseFloat(m[2]);
      return ok(w, h) ? { w, h } : null;
    }
  } catch (e) {}
  return null;
}

/** Keep the title bar reachable after dragging or changing monitor geometry. */
export function clampPanelPosition(
  position: { left: number; top: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
) {
  const maxLeft = Math.max(4, view.width - size.width - 8);
  const maxTop = Math.max(4, view.height - size.height - 22 - 8);
  return {
    left: Math.round(
      Math.max(
        4,
        Math.min(maxLeft, Number.isFinite(position.left) ? position.left : 4),
      ),
    ),
    top: Math.round(
      Math.max(
        4,
        Math.min(maxTop, Number.isFinite(position.top) ? position.top : 4),
      ),
    ),
  };
}
/* ==== 面板尺寸：纯函数 END ==== */

type ResizeDir = "corner" | "r" | "b";

/**
 * 面板尺寸：可配置项 extensions.askgpt.panelSize，取值 "900x520"（也兼容 JSON）。
 * 默认 900×520（宽而短）；并夹在主窗口可视范围内（宽 −40 / 高 −80），避免超出屏幕。
 */
function readPanelSize(prefName: string, mainWin: Window) {
  let w = PANEL_DEFAULT_W;
  let h = PANEL_DEFAULT_H;
  try {
    const parsed = parsePanelSize(Zotero.Prefs.get(prefName));
    if (parsed) {
      w = parsed.w;
      h = parsed.h;
    }
  } catch (e) {}

  const clamp = (v: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, v));
  try {
    const win: any = mainWin;
    const { maxW, maxH } = panelSizeLimits({
      width: win.innerWidth || 1200,
      height: win.innerHeight || 900,
    });
    w = clamp(w, PANEL_MIN_W, maxW);
    h = clamp(h, PANEL_MIN_H, maxH);
  } catch (e) {
    w = clamp(w, PANEL_MIN_W, PANEL_MAX);
    h = clamp(h, PANEL_MIN_H, PANEL_MAX);
  }
  return { width: Math.round(w), height: Math.round(h) };
}

/**
 * 尺寸变化后把面板推回可视区：把手在右下角，面板如果探出窗外就够不着了。
 * 只在真的被推动时写回位置配置，避免覆盖用户自己拖出来的位置。
 */
function keepPanelInView(
  mainWin: any,
  wrap: HTMLElement,
  size: { width: number; height: number },
  posPref: string,
) {
  try {
    const vw = mainWin.innerWidth || 0;
    const vh = mainWin.innerHeight || 0;
    if (!vw || !vh) return;
    const rect = wrap.getBoundingClientRect();
    const { left, top } = clampPanelPosition(rect, size, {
      width: vw,
      height: vh,
    });
    if (left === Math.round(rect.left) && top === Math.round(rect.top)) return;
    wrap.style.left = Math.round(left) + "px";
    wrap.style.top = Math.round(top) + "px";
    wrap.style.right = "auto";
    Zotero.Prefs.set(
      posPref,
      JSON.stringify({ left: Math.round(left), top: Math.round(top) }),
    );
  } catch (e) {}
}

/** 注入面板专用 CSS（把手外观 / 拖动中的光标与禁选中）；只注入一次 */
function ensurePanelStyle(doc: any) {
  try {
    if (doc.getElementById("askgpt-panel-style")) return;
    const style = doc.createElement("style");
    style.id = "askgpt-panel-style";
    style.textContent = [
      "#askgpt-panel-resize,#askgpt-panel-resize-r,#askgpt-panel-resize-b{" +
        "position:absolute;z-index:2147483000;background-repeat:no-repeat;}",
      // 右下角：低调的双斜纹握把（悬停变亮）
      "#askgpt-panel-resize{right:0;bottom:0;width:17px;height:17px;" +
        "cursor:nwse-resize;opacity:.6;border-bottom-right-radius:12px;" +
        "background-image:" +
        "linear-gradient(135deg,transparent 44%,rgba(226,232,255,.6) 44%,rgba(226,232,255,.6) 53%,transparent 53%)," +
        "linear-gradient(135deg,transparent 66%,rgba(226,232,255,.45) 66%,rgba(226,232,255,.45) 75%,transparent 75%);}",
      "#askgpt-panel-resize:hover{opacity:1;}",
      "#askgpt-panel-resize-r{right:0;top:22px;bottom:17px;width:5px;cursor:ew-resize;}",
      "#askgpt-panel-resize-b{left:0;right:17px;bottom:0;height:5px;cursor:ns-resize;}",
      "#askgpt-panel-resize-r:hover,#askgpt-panel-resize-b:hover{" +
        "background-color:rgba(109,132,255,.3);}",
      // 拖动中：全窗口改光标 + 禁止选中文字（含面板内文本）
      "html.askgpt-resizing,html.askgpt-resizing *{user-select:none !important;}",
      "html.askgpt-resizing.ag-rz-corner,html.askgpt-resizing.ag-rz-corner *{cursor:nwse-resize !important;}",
      "html.askgpt-resizing.ag-rz-r,html.askgpt-resizing.ag-rz-r *{cursor:ew-resize !important;}",
      "html.askgpt-resizing.ag-rz-b,html.askgpt-resizing.ag-rz-b *{cursor:ns-resize !important;}",
    ].join("\n");
    (doc.head || doc.documentElement).appendChild(style);
  } catch (e) {}
}

/** 把状态同时存到 addon.data.popupState 并推给面板 iframe（幂等） */
function pushPanel(mainWin: Window, payload: any) {
  (mainWin as any).__askgptPopupState = payload;
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
export function hideAskPopup(options: PopupOptions = {}) {
  try {
    const { win: mainWin } = resolvePopupTarget(options);
    if (!mainWin) return;
    const state = panels.get(mainWin);
    if (state) {
      state.visible = false;
      state.loading = false;
      state.generation++;
      state.pending = undefined;
      state.cancelLoad?.();
      state.cancelLoad = undefined;
    }
    panelAPI(mainWin)?.cancelRequests?.();
    const wrap = mainWin.document.getElementById(
      "askgpt-panel-wrap",
    ) as HTMLElement | null;
    if (wrap) wrap.style.display = "none";
    publishPanelState(mainWin);
  } catch (e) {}
}

/** Remove host listeners and DOM when a window or the plugin is unloaded. */
export function disposeAskPopup(win?: Window) {
  for (const target of win ? [win] : [...panels.keys()]) {
    hideAskPopup({ window: target });
    const state = panels.get(target);
    for (const cleanup of state?.cleanup || []) {
      try {
        cleanup();
      } catch (e) {}
    }
    panels.delete(target);
    try {
      delete (target as any).__askgptPopupState;
      target.document.getElementById("askgpt-panel-wrap")?.remove();
      target.document.getElementById("askgpt-panel-style")?.remove();
    } catch (e) {
      // A closing native window may already have detached its document.
    }
  }
}
