import { assert } from "chai";

describe("AskGPT startup in the isolated Zotero profile", function () {
  it("subscribes to Zotero tab changes for newly opened readers", function () {
    assert.isNotEmpty((Zotero as any).AskGPT.data.notifierID);
  });

  it("leaves installation and debug protocols unregistered", function () {
    const handler = Services.io.getProtocolHandler("zotero").wrappedJSObject;
    const registry = handler._extensions;
    for (const name of ["zotero://plugin", "zotero://ztoolkit-debug"]) {
      assert.notInclude(Object.keys(registry), name);
      // Some Zotero versions reserve the name with an inert getter.
      assert.isUndefined(registry[name]);
    }
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
