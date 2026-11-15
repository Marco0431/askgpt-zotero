import { assert } from "chai";
import { createPrefs } from "../.scaffold/test-fixtures/host-modules";

describe("AskGPT native connection preferences", function () {
  it("loads the previously active provider and saves decimal settings and credential removal only on Save", async function () {
    const source = await Zotero.File.getResourceAsync(
      "chrome://askgpt/content/preferences.xhtml",
    );
    const doc = new DOMParser().parseFromString(
      '<window xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul" xmlns:html="http://www.w3.org/1999/xhtml">' +
        source +
        "</window>",
      "application/xml",
    );
    assert.isNull(doc.querySelector("parsererror"));
    assert.isNull(
      doc.querySelector("[preference]"),
      "Draft inputs must not write to a second preference branch",
    );
    const prefix = "extensions.askgpt.";
    const active = new Map<string, any>([
      [prefix + "baseURL", "https://active.example.test"],
      [prefix + "model", "active-model"],
      [prefix + "apiKey", "active-fixture-key"],
      [prefix + "temperature", 1],
    ]);
    const duplicate = new Map<string, any>([
      [prefix + "baseURL", "https://unused.example.test"],
      [prefix + "apiKey", "older-unused-key"],
    ]);
    const prefs = {
      get: (key: string, global = false) =>
        (global ? duplicate : active).get(key),
      clear: (key: string, global = false) =>
        (global ? duplicate : active).delete(key),
      set: (key: string, value: unknown) => {
        const prior = active.get(key);
        if (prior !== undefined) assert.equal(typeof prior, typeof value);
        active.set(key, value);
      },
    };
    const module = createPrefs({
      Zotero: {
        Prefs: prefs,
        logError: (error: Error) => {
          throw error;
        },
      },
      getInterfaceLanguage: () => "en-US",
      resolveInterfaceLocale: () => "en-US",
      getNativeString: (key: string) => key,
      refreshNativeLanguage: () => {},
    });
    const field = (id: string) =>
      doc.getElementById("askgpt-" + id + "-input") as HTMLInputElement;
    const load = () =>
      module.handlePrefsEvent("load", { window: { document: doc } });
    load();
    assert.equal(field("base").value, "https://active.example.test");
    assert.equal(field("key").value, "active-fixture-key");
    assert.equal(field("model").value, "active-model");
    assert.equal(field("temp").value, "1");
    assert.isTrue(duplicate.has(prefix + "apiKey"));
    field("key").value = "";
    field("temp").value = "0.35";
    module.savePrefs({ document: doc });
    assert.equal(active.get(prefix + "temperature"), "0.35");
    assert.equal(active.get(prefix + "apiKey"), "");
    assert.isFalse(duplicate.has(prefix + "apiKey"));
    assert.equal(active.get(prefix + "systemPrompt"), field("sys").value);
    load();
    assert.equal(field("temp").value, "0.35");
    assert.equal(field("key").value, "");
  });
});
