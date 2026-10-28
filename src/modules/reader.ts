import { config } from "../../package.json";
import { getAskPopupState, openAskPopup, toggleAskPopup } from "./popup";
import { getNativeString } from "../utils/language";
import { createReaderToolbar, readerHostWindow } from "../utils/readerToolbar";

/**
 * Reader 相关：选中文本捕获、PDF 顶栏按钮、右键菜单、iframe 键盘挂载。
 * 全部用 Zotero 官方 API（Zotero.Reader / Zotero.Notifier / DOM）。
 */

let readerRegistered = false;
let toolbarRegistered = false;
let toolbar: ReturnType<typeof createReaderToolbar> | undefined;

const onTextSelection = (event: any) => {
  try {
    if (event.reader) attachToReader(event.reader, 2);
    if (event.doc) attachToReaderDoc(event.doc, event.reader);
    const text = event.params?.annotation?.text;
    if (typeof text === "string" && text.trim())
      cacheSelection(text.trim(), event.reader);
    const item = event.reader?._item;
    if (item) addon.data.readerTitle = item.getField("title") || "";
  } catch (e) {}
};

export function registerReader() {
  if (readerRegistered) return;
  // 官方事件：用户选中 PDF 文字时触发，缓存选中文本 + 挂载 iframe 键盘
  try {
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      onTextSelection,
      config.addonID,
    );
    readerRegistered = true;
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerReader: " + e));
  }
}

const onRenderToolbar = (event: any) => {
  try {
    toolbar?.attach(event);
    if (event.reader) attachToReader(event.reader, 2);
  } catch (error) {
    Zotero.logError(error instanceof Error ? error : new Error(String(error)));
  }
};

/** Use the official reader toolbar slot, with a toolbar-only startup fallback. */
export function registerToolbar() {
  if (toolbarRegistered) return;
  toolbar = createReaderToolbar({
    toggle: toggleAskPopup,
    state: getAskPopupState,
    title: () => getNativeString("native-reader-title"),
    reportError: (error) =>
      Zotero.logError(
        error instanceof Error ? error : new Error(String(error)),
      ),
  });
  try {
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      onRenderToolbar,
      config.addonID,
    );
    toolbarRegistered = true;
    // 对已打开的 reader 补注入按钮
    try {
      const readers: any = (Zotero.Reader as any)._readers;
      if (readers && readers.forEach) {
        readers.forEach((reader: any) => {
          if (reader) {
            toolbar?.attach({ reader });
            attachToReader(reader, 4);
          }
        });
      }
    } catch (e) {}
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerToolbar: " + e));
  }
}

/**
 * 条目右键菜单。优先用 ztoolkit.Menu.register（模板自带 toolkit，Zotero 9 兼容），
 * 失败时回退原生 XUL 注入。
 */
export function registerContextMenu(win: Window) {
  try {
    if (win.closed) return;
    const doc = win.document;
    if (!doc) return;
    if (
      doc.getElementById("askgpt-menu-item") ||
      doc.getElementById("zotero-itemmenu-askgpt")
    )
      return;
    const itemMenu = doc.getElementById("zotero-itemmenu");
    if (!itemMenu) {
      // 最多重试 5 次（约 8 秒），避免无意义循环
      const attempts = Number((win as any).__askgptMenuRetries || 0);
      if (attempts < 5) {
        (win as any).__askgptMenuRetries = attempts + 1;
        const previous = menuRetries.get(win);
        if (previous) clearTimeout(previous);
        menuRetries.set(
          win,
          setTimeout(
            () => {
              menuRetries.delete(win);
              if (!win.closed) registerContextMenu(win);
            },
            1000 + attempts * 500,
          ),
        );
      }
      return;
    }
    const retry = menuRetries.get(win);
    if (retry) clearTimeout(retry);
    menuRetries.delete(win);
    delete (win as any).__askgptMenuRetries;

    try {
      // Passing "item" would resolve the toolkit's global document, which can
      // belong to a different window. Bind registration to this actual popup.
      const registered = ztoolkit.Menu.register(itemMenu as XUL.MenuPopup, {
        tag: "menuitem",
        id: "zotero-itemmenu-askgpt",
        label: getNativeString("native-item-menu"),
        commandListener: () => openAskPopup({ window: win }),
      });
      if (registered !== false && doc.getElementById("zotero-itemmenu-askgpt"))
        return;
    } catch (e) {
      Zotero.logError(new Error("AskGPT registerContextMenu (toolkit): " + e));
    }
    // The toolkit may have inserted a node before a later operation failed.
    if (doc.getElementById("zotero-itemmenu-askgpt")) return;
    // 原生 XUL 回退：仅在指定窗口的真实条目菜单中添加。
    const sep = doc.createXULElement("menuseparator");
    sep.id = "askgpt-menu-sep";
    const item = doc.createXULElement("menuitem");
    item.id = "askgpt-menu-item";
    item.setAttribute("label", getNativeString("native-item-menu"));
    item.addEventListener("command", () => openAskPopup({ window: win }));
    itemMenu.append(sep, item);
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerContextMenu (native): " + e));
  }
}

export function unregisterContextMenu(win: Window) {
  try {
    const retry = menuRetries.get(win);
    if (retry) clearTimeout(retry);
    menuRetries.delete(win);
    delete (win as any).__askgptMenuRetries;
    const doc = win.document;
    if (!doc) return;
    for (const id of [
      "askgpt-menu-sep",
      "askgpt-menu-item",
      "zotero-itemmenu-askgpt",
    ]) {
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
interface ReaderDocumentBinding {
  reader: any;
  dispose: () => void;
}
const readerDocuments = new Map<Document, ReaderDocumentBinding>();
const readerRetries = new Map<any, ReturnType<typeof setTimeout>>();
const menuRetries = new Map<Window, ReturnType<typeof setTimeout>>();

function cacheSelection(text: string, reader: any) {
  const itemID = reader?.itemID ?? reader?._item?.id;
  if (!reader || itemID === undefined) return;
  addon.data.readerSelection = text;
  addon.data.readerSelectionItemID = itemID;
  notifyPopupSelection(text, reader);
}

export function attachToReaderDoc(doc: Document, reader?: any): boolean {
  if (!doc) return false;
  const previous = readerDocuments.get(doc);
  if (previous) {
    if (reader) previous.reader = reader;
    return true;
  }
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removed = false;
    const onKey = (event: KeyboardEvent) =>
      onKeyDown(event, binding.reader, doc);
    const onSelection = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (removed) return;
        try {
          const selected = (doc.getSelection?.()?.toString() || "").trim();
          if (selected) cacheSelection(selected, binding.reader);
        } catch (e) {}
      }, 250);
    };
    const dispose = () => {
      if (removed) return;
      removed = true;
      if (timer) clearTimeout(timer);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("selectionchange", onSelection, true);
      doc.defaultView?.removeEventListener("pagehide", dispose);
      readerDocuments.delete(doc);
    };
    const binding = { reader, dispose };
    readerDocuments.set(doc, binding);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("selectionchange", onSelection, true);
    doc.defaultView?.addEventListener("pagehide", dispose);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 事件驱动：把新的选中内容推送给面板 iframe（若有）。
 * 面板是主窗口 DOM 内的 iframe，直接通过 frameElement 访问，无需窗口枚举。
 */
export function notifyPopupSelection(sel: string, reader?: any) {
  try {
    const host = readerHostWindow(reader);
    if (!host) return;
    const state = getAskPopupState(host);
    // During a source switch the iframe can still hold the previous session.
    if (!state.visible || state.loading || state.reader !== reader) return;
    const panel = host.document.getElementById(
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
  const previous = readerRetries.get(reader);
  if (previous) clearTimeout(previous);
  readerRetries.delete(reader);
  const retries = Math.max(1, maxRetries || 4);
  let attempt = 0;
  const tryOnce = () => {
    readerRetries.delete(reader);
    attempt++;
    try {
      if (reader._isTabClosed || reader._window?.closed) return;
      const documents = [
        reader._iframeWindow?.document,
        reader._internalReader?._primaryView?._iframeWindow?.document,
        reader._internalReader?._secondaryView?._iframeWindow?.document,
      ].filter(Boolean);
      for (const doc of documents) attachToReaderDoc(doc, reader);
      toolbar?.attach({ reader });
      if (documents.length && reader._internalReader) return;
    } catch (e) {}
    if (attempt < retries) {
      readerRetries.set(reader, setTimeout(tryOnce, 400 + attempt * 300));
    }
  };
  tryOnce();
}

function onKeyDown(ev: KeyboardEvent, reader?: any, doc?: Document) {
  if (ev.repeat || ev.isComposing || ev.defaultPrevented) return;
  const k = ev.key || "";
  if (k.toLowerCase() !== "k") return;
  if (!ev.ctrlKey && !ev.metaKey) return;
  if (ev.shiftKey || ev.altKey) return;
  const target = ev.target as HTMLElement | null;
  const tag = target?.tagName?.toUpperCase() || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  const host = readerHostWindow(reader, doc);
  if (host)
    void openAskPopup({ reader, window: host }).catch((error) =>
      Zotero.logError(error),
    );
}

/** Remove per-window bindings, or all reader hooks when the plugin shuts down. */
export function unregisterReader(win?: Window) {
  toolbar?.remove(win);
  for (const [doc, binding] of readerDocuments) {
    if (!win || readerHostWindow(binding.reader, doc) === win)
      binding.dispose();
  }
  for (const [reader, timer] of readerRetries) {
    if (!win || readerHostWindow(reader) === win) {
      clearTimeout(timer);
      readerRetries.delete(reader);
    }
  }
  for (const [window, timer] of menuRetries) {
    if (!win || window === win) {
      clearTimeout(timer);
      menuRetries.delete(window);
    }
  }
  if (win) return;
  if (readerRegistered)
    Zotero.Reader.unregisterEventListener(
      "renderTextSelectionPopup",
      onTextSelection,
    );
  if (toolbarRegistered)
    Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
  readerRegistered = false;
  toolbarRegistered = false;
  toolbar?.destroy();
  toolbar = undefined;
  if (addon.data.notifierID) {
    Zotero.Notifier.unregisterObserver(addon.data.notifierID);
    addon.data.notifierID = undefined;
  }
}

export function registerNotifier() {
  if (addon.data.notifierID) return;
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
