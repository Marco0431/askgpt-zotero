import { assert } from "chai";

describe("AskGPT popup XHTML", function () {
  it("parses as XML and keeps the diagnostic field read-only", async function () {
    const source = await Zotero.File.getResourceAsync(
      "chrome://askgpt/content/popup.xhtml",
    );
    const doc = new DOMParser().parseFromString(
      source,
      "application/xhtml+xml",
    );

    assert.isNull(
      doc.querySelector("parsererror"),
      doc.documentElement.textContent || "popup.xhtml must be well-formed XML",
    );
    const errorField = doc.querySelector<HTMLTextAreaElement>("#set-lasterr");
    assert.isNotNull(errorField);
    assert.isTrue(errorField!.readOnly);
  });
});
