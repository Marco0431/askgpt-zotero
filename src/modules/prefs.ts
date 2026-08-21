import { config } from "../../package.json";

/**
 * 设置页注册：Zotero → 设置 → AskGPT
 * 照模板 BasicExampleFactory.registerPrefs 的模式
 */
export function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

/**
 * 设置页事件（preferences.xhtml 的 onload 调用）
 */
export function handlePrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    // 初始化设置页字段（preference 绑定已自动读写，这里兜底）
    try {
      const win = data.window;
      if (!win) return;
      const doc = win.document;
      const set = (id: string, v: string | number | boolean) => {
        const el = doc.getElementById(id);
        if (el) el.value = v;
      };
      const ADDN = "extensions.askgpt.";
      set("askgpt-base-input", Zotero.Prefs.get(ADDN + "baseURL") || "https://api.deepseek.com");
      set("askgpt-key-input", Zotero.Prefs.get(ADDN + "apiKey") || "");
      set("askgpt-model-input", Zotero.Prefs.get(ADDN + "model") || "deepseek-chat");
      set("askgpt-temp-input", Zotero.Prefs.get(ADDN + "temperature") ?? 0.3);
      const web = doc.getElementById("askgpt-web-input");
      if (web) (web as HTMLInputElement).checked = Zotero.Prefs.get(ADDN + "webSearch") !== false;
    } catch (e) {
      Zotero.logError(new Error("AskGPT prefs load: " + e));
    }
  }
}

/**
 * 设置页保存按钮（oncommand 调用）
 */
export function savePrefs(win: Window) {
  try {
    const doc = win.document;
    const val = (id: string) => {
      const el = doc.getElementById(id);
      return el ? (el as HTMLInputElement).value : "";
    };
    const ADDN = "extensions.askgpt.";
    Zotero.Prefs.set(ADDN + "baseURL", val("askgpt-base-input").trim());
    Zotero.Prefs.set(ADDN + "apiKey", val("askgpt-key-input").trim());
    Zotero.Prefs.set(ADDN + "model", val("askgpt-model-input").trim());
    const t = parseFloat(val("askgpt-temp-input"));
    if (!isNaN(t)) Zotero.Prefs.set(ADDN + "temperature", t);
    const web = doc.getElementById("askgpt-web-input") as HTMLInputElement;
    if (web) Zotero.Prefs.set(ADDN + "webSearch", web.checked);
    const status = doc.getElementById("askgpt-prefs-status");
    if (status) status.setAttribute("value", "✓ 已保存");
  } catch (e) {
    Zotero.logError(new Error("AskGPT prefs save: " + e));
  }
}