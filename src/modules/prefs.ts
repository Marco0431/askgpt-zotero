import { config } from "../../package.json";
import {
  getInterfaceLanguage,
  getNativeString,
  InterfaceLanguage,
  refreshNativeLanguage,
  resolveInterfaceLocale,
} from "../utils/language";

let prompts: { localize(value: string, locale: string): string } | undefined;

function localizePrompt(value: string, language: InterfaceLanguage) {
  if (!prompts) {
    const scope: any = { window: {} };
    Services.scriptloader.loadSubScript(
      `chrome://${config.addonRef}/content/scripts/prompts.js`,
      scope,
    );
    prompts = scope.window.AskGPTPrompts;
  }
  return prompts!.localize(value, resolveInterfaceLocale(language));
}

/**
 * 设置页注册：Zotero → 设置 → AskGPT
 * 照模板 BasicExampleFactory.registerPrefs 的模式
 */
export function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: "AskGPT",
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

/**
 * 设置页事件（preferences.xhtml 的 onload 调用）
 */
export function handlePrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "language-saved") {
    refreshNativeLanguage();
    return;
  }
  if (type === "language") {
    const win = data.window as Window | undefined;
    if (win) {
      const value = (
        win.document.getElementById(
          "askgpt-language-input",
        ) as HTMLSelectElement
      )?.value;
      applyPrefsLanguage(
        win.document,
        value === "zh-CN" || value === "en-US" ? value : "auto",
      );
    }
    return;
  }
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
      set("askgpt-language-input", getInterfaceLanguage());
      set(
        "askgpt-base-input",
        Zotero.Prefs.get(ADDN + "baseURL") || "https://api.deepseek.com",
      );
      set("askgpt-key-input", Zotero.Prefs.get(ADDN + "apiKey") || "");
      set(
        "askgpt-model-input",
        Zotero.Prefs.get(ADDN + "model") || "deepseek-chat",
      );
      set("askgpt-temp-input", Zotero.Prefs.get(ADDN + "temperature") ?? 0.3);
      set("askgpt-sys-input", Zotero.Prefs.get(ADDN + "systemPrompt") || "");
      const web = doc.getElementById("askgpt-web-input");
      if (web)
        (web as HTMLInputElement).checked =
          Zotero.Prefs.get(ADDN + "nativeSearch") === true;
      applyPrefsLanguage(doc, getInterfaceLanguage());
    } catch (e) {
      Zotero.logError(new Error("AskGPT prefs load: " + e));
    }
  }
}

function applyPrefsLanguage(doc: Document, language: InterfaceLanguage) {
  for (const node of doc.querySelectorAll("[data-askgpt-l10n]")) {
    const text = getNativeString(
      node.getAttribute("data-askgpt-l10n") || "",
      language,
    );
    const attribute = node.getAttribute("data-askgpt-l10n-attr");
    if (attribute) node.setAttribute(attribute, text);
    else node.textContent = text;
  }
  const status = doc.getElementById("askgpt-prefs-status");
  if (status) status.textContent = "";
  const prompt = doc.getElementById(
    "askgpt-sys-input",
  ) as HTMLTextAreaElement | null;
  if (prompt) prompt.value = localizePrompt(prompt.value, language);
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
    const language = val("askgpt-language-input");
    Zotero.Prefs.set(
      ADDN + "language",
      language === "zh-CN" || language === "en-US" ? language : "auto",
    );
    Zotero.Prefs.set(ADDN + "baseURL", val("askgpt-base-input").trim());
    Zotero.Prefs.set(ADDN + "apiKey", val("askgpt-key-input").trim());
    Zotero.Prefs.set(ADDN + "model", val("askgpt-model-input").trim());
    const t = parseFloat(val("askgpt-temp-input"));
    if (!isNaN(t)) Zotero.Prefs.set(ADDN + "temperature", t);
    const web = doc.getElementById("askgpt-web-input") as HTMLInputElement;
    if (web) Zotero.Prefs.set(ADDN + "nativeSearch", web.checked);
    Zotero.Prefs.set(ADDN + "systemPrompt", val("askgpt-sys-input"));
    applyPrefsLanguage(doc, getInterfaceLanguage());
    const status = doc.getElementById("askgpt-prefs-status");
    if (status) status.textContent = getNativeString("pref-saved");
    refreshNativeLanguage();
  } catch (e) {
    Zotero.logError(new Error("AskGPT prefs save: " + e));
  }
}
