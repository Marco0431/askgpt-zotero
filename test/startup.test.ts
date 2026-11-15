import { assert } from "chai";

describe("AskGPT startup in the isolated Zotero profile", function () {
  it("leaves installation and debug protocols unregistered", function () {
    const handler = Services.io.getProtocolHandler("zotero").wrappedJSObject;
    const registered = Object.keys(handler._extensions);
    assert.notInclude(registered, "zotero://plugin");
    assert.notInclude(registered, "zotero://ztoolkit-debug");
  });

  it("registers one labeled AskGPT command in the item menu", function () {
    const doc = Zotero.getMainWindow().document;
    const commands = doc.querySelectorAll(
      "#zotero-itemmenu > #zotero-itemmenu-askgpt",
    );
    assert.lengthOf(commands, 1);
    assert.equal(commands[0].localName, "menuitem");
    assert.isNotEmpty(commands[0].getAttribute("label"));
  });
});
