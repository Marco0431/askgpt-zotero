import { initLocale } from "./utils/locale";
import { registerPrefs, handlePrefsEvent, savePrefs } from "./modules/prefs";
import {
  registerReader,
  registerToolbar,
  registerContextMenu,
  unregisterContextMenu,
  attachToReader,
  registerNotifier,
  unregisterReader,
} from "./modules/reader";
import { openAskPopup, hideAskPopup, disposeAskPopup } from "./modules/popup";
import { clearFullTextCache } from "./modules/fulltext";
import { runGeckoDiagnostics } from "./modules/diag";

const windowCleanups = new Map<Window, () => void>();

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPrefs();

  registerReader();

  registerToolbar();

  registerNotifier();

  // 把 hidePopup 挂到实例上，供面板 iframe 的 Esc 调用
  (addon as any).hidePopup = hideAskPopup;

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  addon.data.initialized = true;
  // 一次性 Gecko 行为自检（结果写进 prefs，用于远程定位渲染类报错）
  runGeckoDiagnostics();
  ztoolkit.log("AskGPT started");
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  if (windowCleanups.has(win)) return;

  registerContextMenu(win);

  // 对已有 reader 补挂载（重试等待 iframe 就绪）
  try {
    const tabID = win.Zotero_Tabs && win.Zotero_Tabs.selectedID;
    if (tabID != null) {
      try {
        const reader = Zotero.Reader.getByTabID(tabID);
        if (reader) attachToReader(reader, 8);
      } catch (e) {}
    }
  } catch (e) {}

  // Ctrl+K 快捷键（主窗口文档级，PDF iframe 内由 reader.ts 挂载）
  const onKeyDown = (ev: KeyboardEvent) => {
    const k = ev.key || "";
    if (k.toLowerCase() !== "k") return;
    if (!ev.ctrlKey && !ev.metaKey) return;
    if (ev.shiftKey || ev.altKey) return;
    const target = ev.target as HTMLElement | null;
    const tag = ((target && target.tagName) || "").toUpperCase();
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      (target && target.isContentEditable)
    ) {
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.repeat) return;
    void openAskPopup({ window: win });
  };
  win.document.addEventListener("keydown", onKeyDown, true);
  windowCleanups.set(win, () =>
    win.document.removeEventListener("keydown", onKeyDown, true),
  );
}

async function onMainWindowUnload(win: Window): Promise<void> {
  windowCleanups.get(win)?.();
  windowCleanups.delete(win);
  disposeAskPopup(win);
  unregisterReader(win);
  unregisterContextMenu(win);
}

function onShutdown(): void {
  for (const [win, cleanup] of windowCleanups) {
    cleanup();
    unregisterContextMenu(win);
  }
  windowCleanups.clear();
  unregisterReader();
  disposeAskPopup();
  clearFullTextCache();
  ztoolkit.unregisterAll();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify: async () => {},
  onPrefsEvent: async (type: string, data: { [key: string]: any }) => {
    if (type === "save") savePrefs(data.window);
    else handlePrefsEvent(type, data);
  },
  onShortcuts: () => {},
  onDialogEvents: () => {},
};
