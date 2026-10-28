import { config } from "../../package.json";

export type InterfaceLanguage = "auto" | "zh-CN" | "en-US";

const localizations = new Map<string, Localization>();

export function getInterfaceLanguage(): InterfaceLanguage {
  const value = Zotero.Prefs.get("extensions.askgpt.language");
  return value === "zh-CN" || value === "en-US" ? value : "auto";
}

export function resolveInterfaceLocale(
  language: InterfaceLanguage = getInterfaceLanguage(),
): "zh-CN" | "en-US" {
  const value = language === "auto" ? Zotero.locale || "en-US" : language;
  return /^zh(?:-|_|$)/i.test(value) ? "zh-CN" : "en-US";
}

/** Explicit locales affect this plugin's strings without changing Zotero. */
export function getNativeString(
  key: string,
  language: InterfaceLanguage = getInterfaceLanguage(),
): string {
  const locale = resolveInterfaceLocale(language);
  let localization = localizations.get(locale);
  if (!localization) {
    const Constructor =
      typeof Localization === "undefined"
        ? ztoolkit.getGlobal("Localization")
        : Localization;
    localization = new Constructor(
      [`${config.addonRef}-preferences.ftl`],
      true,
      undefined,
      [locale],
    );
    localizations.set(locale, localization);
  }
  return localization.formatValueSync(`${config.addonRef}-${key}`) || key;
}

export function refreshNativeLanguage() {
  const documents = new Set<Document>(
    Zotero.getMainWindows().map((win) => win.document),
  );
  const readers = (Zotero.Reader as any)._readers;
  readers?.forEach((reader: any) => {
    for (const win of [
      reader?._window,
      reader?._iframeWindow,
      reader?._internalReader?._primaryView?._iframeWindow,
      reader?._internalReader?._secondaryView?._iframeWindow,
    ]) {
      if (win?.document) documents.add(win.document);
    }
  });
  const labels = [
    ["zotero-itemmenu-askgpt", "native-item-menu", "label"],
    ["askgpt-menu-item", "native-item-menu", "label"],
    ["askgpt-toolbar-button", "native-reader-title", "title"],
    ["askgpt-panel-close", "native-close", "title"],
    ["askgpt-panel-close", "native-close", "aria-label"],
    ["askgpt-panel-resize", "native-resize", "title"],
    ["askgpt-panel-resize-r", "native-resize", "title"],
    ["askgpt-panel-resize-b", "native-resize", "title"],
  ];
  for (const doc of documents) {
    for (const [id, key, attribute] of labels) {
      doc.getElementById(id)?.setAttribute(attribute, getNativeString(key));
    }
  }
}
