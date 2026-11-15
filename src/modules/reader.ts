import { config } from "../../package.json";
import {
  getAskPopupState,
  openAskPopup,
  toggleAskPopup,
  updateAskPopupSelection,
} from "./popup";
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
    if (event.reader) attachToReader(event.reader);
    if (event.doc) attachToReaderDoc(event.doc, event.reader);
    const text = event.params?.annotation?.text;
    if (typeof text === "string" && text.trim())
      cacheSelection(text.trim(), event.reader);
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
    if (event.reader) attachToReader(event.reader);
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
            attachToReader(reader);
          }
        });
      }
    } catch (e) {}
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerToolbar: " + e));
  }
}

/** Add the AskGPT command to this window's item context menu. */
export function registerContextMenu(win: Window) {
  try {
    if (win.closed) return;
    const doc = win.document;
    if (!doc) return;
    if (doc.getElementById("zotero-itemmenu-askgpt")) return;
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

    const item = doc.createXULElement("menuitem");
    item.id = "zotero-itemmenu-askgpt";
    item.setAttribute("label", getNativeString("native-item-menu"));
    item.addEventListener("command", () => openAskPopup({ window: win }));
    itemMenu.append(item);
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
    doc.getElementById("zotero-itemmenu-askgpt")?.remove();
  } catch (e) {}
}

/**
 * 把 Ctrl+K 监听挂到 reader iframe 文档。
 * 同时监听 selectionchange，防抖后将当前阅读器的选区通知面板。
 */
interface ReaderDocumentBinding {
  reader: any;
  dispose: () => void;
}
const readerDocuments = new Map<Document, ReaderDocumentBinding>();
const pendingReaders = new Map<any, symbol>();
const menuRetries = new Map<Window, ReturnType<typeof setTimeout>>();

function cacheSelection(text: string, reader: any) {
  const itemID = reader?.itemID ?? reader?._item?.id;
  if (!reader || itemID === undefined) return;
  const host = readerHostWindow(reader);
  if (host) updateAskPopupSelection(host, reader, text);
}

function attachViewDocuments(reader: any, loadedFrame?: EventTarget | null) {
  const internal = reader?._internalReader;
  for (const view of [internal?._primaryView, internal?._secondaryView]) {
    if (!view || (loadedFrame && loadedFrame !== view._iframe)) continue;
    const doc = view._iframe?.contentDocument || view._iframeWindow?.document;
    if (doc && doc.documentURI !== "about:blank")
      attachToReaderDoc(doc, reader);
  }
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
    const isReaderDocument = reader && reader._iframeWindow?.document === doc;
    // PDF.js signals its parent document when the viewer starts. Split and
    // reloaded views send the same signal with a new underlying document.
    const onViewerReady = () => attachViewDocuments(binding.reader);
    const onFrameLoad = (event: Event) => {
      if ((event.target as Element)?.localName === "iframe")
        attachViewDocuments(binding.reader, event.target);
    };
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
      doc.removeEventListener("webviewerloaded", onViewerReady);
      doc.removeEventListener("load", onFrameLoad, true);
      if (isReaderDocument) pendingReaders.delete(binding.reader);
      doc.defaultView?.removeEventListener("pagehide", dispose);
      readerDocuments.delete(doc);
    };
    const binding = { reader, dispose };
    readerDocuments.set(doc, binding);
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("selectionchange", onSelection, true);
    if (isReaderDocument) {
      doc.addEventListener("webviewerloaded", onViewerReady);
      doc.addEventListener("load", onFrameLoad, true);
    }
    doc.defaultView?.addEventListener("pagehide", dispose);
    return true;
  } catch (e) {
    return false;
  }
}

export function attachToReader(reader: any) {
  if (!reader) return;
  try {
    if (reader._isTabClosed || reader._window?.closed) return;
    const doc = reader._iframeWindow?.document;
    if (doc) attachToReaderDoc(doc, reader);
    attachViewDocuments(reader);
    toolbar?.attach({ reader });
    if (
      reader._internalReader ||
      !reader._initPromise ||
      pendingReaders.has(reader)
    )
      return;
    const token = Symbol();
    pendingReaders.set(reader, token);
    void reader._initPromise.then(
      () => {
        if (pendingReaders.get(reader) !== token) return;
        pendingReaders.delete(reader);
        // Zotero resolves _initPromise after creating its internal reader.
        if (reader._internalReader) attachToReader(reader);
      },
      () => {
        if (pendingReaders.get(reader) === token) pendingReaders.delete(reader);
      },
    );
  } catch (e) {}
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
  for (const reader of pendingReaders.keys())
    if (!win || readerHostWindow(reader) === win) pendingReaders.delete(reader);
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
          if (type !== "tab") return;
          if (event === "close") {
            for (const reader of pendingReaders.keys())
              if (ids.includes(reader.tabID)) pendingReaders.delete(reader);
          } else if (
            event === "add" ||
            event === "select" ||
            event === "load"
          ) {
            for (const tabID of ids || []) {
              try {
                const reader = Zotero.Reader.getByTabID(tabID as string);
                if (reader) attachToReader(reader);
              } catch (e) {}
            }
          }
        },
      },
      ["tab"],
    );
  } catch (e) {
    Zotero.logError(new Error("AskGPT registerNotifier: " + e));
  }
}
