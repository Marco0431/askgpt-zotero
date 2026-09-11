/**
 * 一次性诊断：确认 Gecko 在 XML（XHTML）文档里对 innerHTML 的处理方式。
 *
 * 背景：面板 popup.xhtml 是 XHTML（XML）文档；如果直接把 HTML 片段塞给 innerHTML
 * 在某些情况下会被 Gecko 拒绝（NS_ERROR_DOM_SYNTAX_ERR，
 * 报错文本就是 "An invalid or illegal string was specified"）。
 * 这里把实测结果写进 prefs（extensions.askgpt.diag），出问题时可以直接读出来定位。
 */
export function runGeckoDiagnostics(): void {
  try {
    const win: any = Zotero.getMainWindow();
    const doc: any = win && win.document;
    if (!doc) return;

    const version = String((Zotero as any).version || "");
    // 同一个 Zotero 版本只测一次
    try {
      const prev = String(Zotero.Prefs.get("extensions.askgpt.diag") || "");
      if (prev && prev.includes('"zotero":"' + version + '"')) return;
    } catch (e) {}

    const NS = "http://www.w3.org/1999/xhtml";
    const xmlDoc: any = doc.implementation.createDocument(NS, "html", null);

    // 1) XML 文档里直接 innerHTML 一个 HTML 片段
    let innerHtmlXmlDoc: string;
    try {
      const div = xmlDoc.createElementNS(NS, "div");
      div.innerHTML = "<p>a</p><br><hr>";
      innerHtmlXmlDoc = "ok";
    } catch (e: any) {
      innerHtmlXmlDoc = "throw " + (e?.name || "") + ": " + (e?.message || e);
    }

    // 2) 解析器 + importNode 的兜底路径
    let domParserFallback: string;
    try {
      const parsed: any = new DOMParser().parseFromString(
        "<div id='ag-diag-root'><p>a</p><br><hr></div>",
        "text/html",
      );
      const root: any = parsed.getElementById("ag-diag-root");
      const target: any = xmlDoc.createElementNS(NS, "div");
      const frag: any = xmlDoc.createDocumentFragment();
      for (const node of Array.from(root.childNodes)) {
        frag.appendChild(xmlDoc.importNode(node, true));
      }
      target.appendChild(frag);
      domParserFallback = "ok " + target.childNodes.length;
    } catch (e: any) {
      domParserFallback = "throw " + (e?.name || "") + ": " + (e?.message || e);
    }

    Zotero.Prefs.set(
      "extensions.askgpt.diag",
      JSON.stringify({
        at: new Date().toISOString(),
        zotero: version,
        innerHtmlXmlDoc,
        domParserFallback,
      }),
    );
  } catch (e) {
    Zotero.logError(new Error("AskGPT runGeckoDiagnostics: " + e));
  }
}
