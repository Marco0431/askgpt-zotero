import { config } from "../../package.json";
import { openAskPopup } from "./popup";

/**
 * Reader 相关：选中文本捕获、PDF 顶栏按钮、右键菜单、iframe 键盘挂载。
 * 全部用 Zotero 官方 API（Zotero.Reader / Zotero.Notifier / DOM）。
 */

export function registerReader() {
  // 官方事件：用户选中 PDF 文字时触发，缓存选中文本 + 挂载 iframe 键盘
  try {
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      (event: any) => {
        try {
          if (event.reader) attachToReader(event.reader, 2);
          if (event.doc) attachToReaderDoc(event.doc);

          const text = (event.params?.annotation?.text) || "";
          if (typeof text === "string" && text.trim()) {
            addon.data.readerSelection = text.trim();
            // 关键：实时推送选中给面板（pdf.js 的 selectionchange 不一定触发，
            // renderTextSelectionPopup 是官方可靠事件，必须在这里也推送）
            notifyPopupSelection(text.trim());
          }
          try {
            const item = event.reader?._item;
            if (item) addon.data.readerTitle = item.getField("title") || "";
          } catch (e) {}
        } catch (e) {}
      },
      config.addonID,
    );
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerReader: " + e));
  }
}

/**
 * PDF 阅读器顶部工具栏按钮（像 PapersGPT 那样的 AI 按钮）。
 * 注意：renderToolbar 回调参数是 { reader }（没有 doc/append），
 * 需要从 reader._iframeWindow 拿到文档后注入按钮。
 */
export function registerToolbar() {
  try {
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      (event: any) => {
        try {
          const reader = event?.reader;
          if (!reader) return;
          injectToolbarButton(reader);
        } catch (e) {}
      },
      config.addonID,
    );
    // 对已打开的 reader 补注入按钮
    try {
      const readers: any = (Zotero.Reader as any)._readers;
      if (readers && readers.forEach) {
        readers.forEach((reader: any) => {
          if (reader) injectToolbarButton(reader);
        });
      }
    } catch (e) {}
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerToolbar: " + e));
  }
}

function injectToolbarButton(reader: any) {
  try {
    // 优先真实视图层：reader._internalReader._primaryView._iframeWindow（pdf.js 实际视图）
    let viewWin: any = null;
    try {
      viewWin =
        reader?._internalReader?._primaryView?._iframeWindow ||
        reader._iframeWindow;
    } catch (e) {
      viewWin = reader._iframeWindow;
    }
    if (!viewWin || !viewWin.document) return;
    const doc = viewWin.document;
    if (doc.getElementById("askgpt-toolbar-button")) return;

    const btn = doc.createElement("button");
    btn.id = "askgpt-toolbar-button";
    btn.textContent = "AI";
    btn.title = "AskGPT：就选中文字或本篇文献提问";
    btn.setAttribute(
      "style",
      "position:fixed;top:8px;right:96px;z-index:2147483647;" +
        "padding:4px 12px;border-radius:12px;" +
        "border:1px solid #6d5cff;background:linear-gradient(135deg,#4f7bff,#6d5cff);" +
        "color:#fff;font-size:13px;font-weight:600;cursor:pointer;" +
        "pointer-events:auto;",
    );
    // 用 mousedown 触发（pdf.js 视图层可能拦截 click）
    const fire = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        openAskPopup();
      } catch (e) {
        Zotero.logError(new Error("AskGPT toolbar button: " + e));
      }
    };
    btn.addEventListener("click", fire);
    btn.addEventListener("mousedown", fire);
    btn.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        fire(ev);
      }
    });

    // 挂到视图层 body 顶部（fixed 悬浮，不依赖工具栏容器）
    (doc.body || doc.documentElement).appendChild(btn);
  } catch (e) {}
}

/**
 * 条目右键菜单。优先用 ztoolkit.Menu.register（模板自带 toolkit，Zotero 9 兼容），
 * 失败时回退原生 XUL 注入。
 */
export function registerContextMenu(win: Window) {
  try {
    // 方案 A：ztoolkit.Menu.register（官方 toolkit 封装，自动处理菜单注入时机）
    ztoolkit.Menu.register("item", {
      tag: "menuitem",
      id: "zotero-itemmenu-askgpt",
      label: "AskGPT：对本条目提问",
      commandListener: () => openAskPopup(),
    });
    return;
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerContextMenu (toolkit): " + e));
  }

  // 方案 B：原生 XUL 注入（带限次重试，避免 zotero-itemmenu 不存在时无限循环）
  try {
    const doc = win.document;
    if (!doc) return;
    if (doc.getElementById("askgpt-menu-item")) return;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      // 最多重试 5 次（约 8 秒），避免无意义循环
      const attempts = Number((win as any).__askgptMenuRetries || 0);
      if (attempts < 5) {
        (win as any).__askgptMenuRetries = attempts + 1;
        setTimeout(() => registerContextMenu(win), 1000 + attempts * 500);
      }
      return;
    }
    const sep = doc.createXULElement("menuseparator");
    sep.id = "askgpt-menu-sep";
    const item = doc.createXULElement("menuitem");
    item.id = "askgpt-menu-item";
    item.setAttribute("label", "AskGPT：对本条目提问");
    item.addEventListener("command", () => openAskPopup());
    itemMenu.append(sep, item);
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerContextMenu (native): " + e));
  }
}

export function unregisterContextMenu(win: Window) {
  try {
    const doc = win.document;
    if (!doc) return;
    for (const id of ["askgpt-menu-sep", "askgpt-menu-item", "zotero-itemmenu-askgpt"]) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
  } catch (e) {}
}

/**
 * 把 Ctrl+K 监听挂到 reader iframe 文档（带重试）。
 * 同时监听 selectionchange：选中变化时防抖更新 addon.data.readerSelection，
 * 并主动推送给已打开的弹窗（事件驱动，弹窗不再轮询）。
 */
let _selectionDebounceTimer: any = null;

export function attachToReaderDoc(doc: Document): boolean {
  if (!doc) return false;
  if ((doc as any).__askgptReaderAttached) return true;
  try {
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener(
      "selectionchange",
      () => {
        // 防抖：选中拖选过程会高频触发，稳定 250ms 后再处理
        if (_selectionDebounceTimer) clearTimeout(_selectionDebounceTimer);
        _selectionDebounceTimer = setTimeout(() => {
          try {
            const sel = (doc.getSelection?.()?.toString() || "").trim();
            if (sel && sel !== addon.data.readerSelection) {
              addon.data.readerSelection = sel;
              notifyPopupSelection(sel);
            }
          } catch (e) {}
        }, 250);
      },
      true,
    );
    (doc as any).__askgptReaderAttached = true;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 事件驱动：把新的选中内容推送给面板 iframe（若有）。
 * 面板是主窗口 DOM 内的 iframe，直接通过 frameElement 访问，无需窗口枚举。
 */
export function notifyPopupSelection(sel: string) {
  try {
    const mainWin = Zotero.getMainWindow();
    if (!mainWin) return;
    const panel = mainWin.document.getElementById(
      "askgpt-panel-frame",
    ) as HTMLIFrameElement;
    if (!panel || panel.style.display === "none") return;
    const iw = panel.contentWindow as any;
    if (iw && iw.AskGPTPopup && iw.AskGPTPopup.updateLiveSelection) {
      iw.AskGPTPopup.updateLiveSelection(sel);
    }
  } catch (e) {}
}

export function attachToReader(reader: any, maxRetries?: number) {
  if (!reader) return;
  try {
    if (attachToReaderDoc(reader._iframeWindow?.document)) return;
  } catch (e) {}
  const retries = maxRetries || 4;
  let attempt = 0;
  const tryOnce = () => {
    attempt++;
    try {
      if (attachToReaderDoc(reader._iframeWindow?.document)) return;
    } catch (e) {}
    if (attempt < retries) {
      setTimeout(tryOnce, 400 + attempt * 300);
    }
  };
  tryOnce();
}

function onKeyDown(ev: KeyboardEvent) {
  const k = ev.key || "";
  if (k.toLowerCase() !== "k") return;
  if (!ev.ctrlKey && !ev.metaKey) return;
  if (ev.shiftKey || ev.altKey) return;
  const tag = (ev.target && (ev.target as HTMLElement).tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || (ev.target as HTMLElement).isContentEditable) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  openAskPopup();
}

export function registerNotifier() {
  try {
    addon.data.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: (event: string, type: string, ids: Array<string | number>) => {
          if (type === "reader" || type === "tab") {
            for (const tabID of ids || []) {
              try {
                const reader = Zotero.Reader.getByTabID(tabID as string);
                if (reader) attachToReader(reader, 4);
              } catch (e) {}
            }
          }
        },
      },
      ["reader", "tab"] as unknown as _ZoteroTypes.Notifier.Type[],
    );
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerNotifier: " + e));
  }
}