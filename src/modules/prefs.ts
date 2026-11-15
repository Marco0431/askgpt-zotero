import { config } from "../../package.json";
import {
  getInterfaceLanguage,
  getNativeString,
  InterfaceLanguage,
  refreshNativeLanguage,
  resolveInterfaceLocale,
} from "../utils/language";

type PreferenceScripts = {
  AskGPTClient: {
    providerOrigin(base: string): string | null;
    cleanConnectionValue(value: string): string;
  };
  AskGPTPrompts: { localize(value: string, locale: string): string };
  AskGPTSettings: {
    snapshot(prefs: typeof Zotero.Prefs): string;
    bindProviderKey(
      base: HTMLInputElement,
      key: HTMLInputElement,
    ): () => string;
    saveConnection(
      prefs: typeof Zotero.Prefs,
      values: {
        baseURL: string;
        apiKey: string;
        model: string;
        temperature: string;
      },
      expected: string | undefined,
    ): void;
  };
};
let scripts: PreferenceScripts | undefined;
const openForms = new WeakMap<
  Document,
  { snapshot: string; readKey: () => string }
>();

function preferenceScripts(): PreferenceScripts {
  if (!scripts) {
    const scope = {
      window: {} as PreferenceScripts,
      URL: Zotero.getMainWindow?.()?.URL ?? URL,
    };
    for (const name of ["prompts", "client", "settings"]) {
      Services.scriptloader.loadSubScript(
        `chrome://${config.addonRef}/content/scripts/${name}.js`,
        scope,
      );
    }
    scripts = scope.window;
  }
  return scripts;
}

/**
 * 设置页注册：Zotero → 设置 → AskGPT
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
    // Match the reader panel's effective settings. Edits persist on Save.
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
      const settings = preferenceScripts().AskGPTSettings;
      openForms.set(doc, {
        snapshot: settings.snapshot(Zotero.Prefs),
        readKey: settings.bindProviderKey(
          doc.getElementById("askgpt-base-input"),
          doc.getElementById("askgpt-key-input"),
        ),
      });
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
  if (prompt)
    prompt.value = preferenceScripts().AskGPTPrompts.localize(
      prompt.value,
      resolveInterfaceLocale(language),
    );
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
    const choice = val("askgpt-language-input");
    const language = choice === "zh-CN" || choice === "en-US" ? choice : "auto";
    const { AskGPTClient: client, AskGPTSettings: settings } =
      preferenceScripts();
    const baseURL = client.cleanConnectionValue(val("askgpt-base-input"));
    const model = client.cleanConnectionValue(val("askgpt-model-input"));
    // providerOrigin checks the same endpoint builder used to issue requests.
    const origin = client.providerOrigin(baseURL);
    if (!origin || !model) {
      const status = doc.getElementById("askgpt-prefs-status");
      if (status)
        status.textContent = getNativeString(
          !origin ? "pref-invalid-address" : "pref-model-required",
          language,
        );
      return;
    }
    const form = openForms.get(doc);
    settings.saveConnection(
      Zotero.Prefs,
      {
        baseURL,
        apiKey: form?.readKey().trim() || "",
        model,
        temperature: val("askgpt-temp-input"),
      },
      form?.snapshot,
    );
    Zotero.Prefs.set(ADDN + "language", language);
    const web = doc.getElementById("askgpt-web-input") as HTMLInputElement;
    if (web) Zotero.Prefs.set(ADDN + "nativeSearch", web.checked);
    Zotero.Prefs.set(ADDN + "systemPrompt", val("askgpt-sys-input"));
    if (form) form.snapshot = settings.snapshot(Zotero.Prefs);
    applyPrefsLanguage(doc, getInterfaceLanguage());
    const status = doc.getElementById("askgpt-prefs-status");
    if (status) status.textContent = getNativeString("pref-saved");
    refreshNativeLanguage();
  } catch (e) {
    const status = win.document.getElementById("askgpt-prefs-status");
    if ((e as Error)?.name === "StaleAskGPTSettings") {
      if (status) status.textContent = getNativeString("pref-changed");
      return;
    }
    if (status) status.textContent = getNativeString("pref-save-failed");
    Zotero.logError(new Error("AskGPT could not save preferences"));
  }
}
