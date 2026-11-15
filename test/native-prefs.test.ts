import { assert } from "chai";
import { createPrefs } from "../.scaffold/test-fixtures/host-modules";

describe("AskGPT native connection preferences", function () {
  it("loads the previously active provider and saves decimal settings and credential removal only on Save", async function () {
    const source = await Zotero.File.getResourceAsync(
      "chrome://askgpt/content/preferences.xhtml",
    );
    // Zotero uses its privileged XUL parser for registered plugin panes.
    const win = Zotero.getMainWindow();
    const doc = win.document.importNode(
      win.MozXULElement.parseXULToFragment(source),
      true,
    );
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
    const second = win.document.importNode(
      win.MozXULElement.parseXULToFragment(source),
      true,
    );
    module.handlePrefsEvent("load", { window: { document: second } });
    load();
    assert.equal(field("base").value, "https://active.example.test");
    assert.equal(field("key").value, "active-fixture-key");
    assert.equal(field("model").value, "active-model");
    assert.equal(field("temp").value, "1");
    assert.isTrue(duplicate.has(prefix + "apiKey"));
    const previous = Array.from(active);
    field("temp").value = "0.7";
    field("base").value = "https://";
    module.savePrefs({ document: doc });
    assert.deepEqual(Array.from(active), previous);
    assert.equal(field("key").value, "active-fixture-key");
    assert.equal(
      doc.getElementById("askgpt-prefs-status")?.textContent,
      "pref-invalid-address",
    );
    field("base").value = "https://new.example.test";
    field("model").value = "  \u200b ";
    module.savePrefs({ document: doc });
    assert.deepEqual(Array.from(active), previous);
    assert.isTrue(duplicate.has(prefix + "apiKey"));
    assert.equal(
      doc.getElementById("askgpt-prefs-status")?.textContent,
      "pref-model-required",
    );
    load();
    field("key").value = "";
    field("temp").value = "0.35";
    module.savePrefs({ document: doc });
    assert.equal(active.get(prefix + "temperature"), "0.35");
    assert.equal(active.get(prefix + "apiKey"), "");
    assert.isFalse(duplicate.has(prefix + "apiKey"));
    assert.equal(active.get(prefix + "systemPrompt"), field("sys").value);
    module.savePrefs({ document: second });
    assert.equal(
      second.getElementById("askgpt-prefs-status")?.textContent,
      "pref-changed",
    );
    assert.equal(active.get(prefix + "apiKey"), "");
    assert.equal(active.get(prefix + "temperature"), "0.35");
    load();
    assert.equal(field("temp").value, "0.35");
    assert.equal(field("key").value, "");
    active.set(prefix + "apiKey", "active-fixture-key");
    load();
    field("base").value = "https://ACTIVE.example.test:443/another/path";
    module.savePrefs({ document: doc });
    assert.equal(active.get(prefix + "apiKey"), "active-fixture-key");
    field("base").value = "https://new.example.test/";
    module.savePrefs({ document: doc });
    assert.equal(active.get(prefix + "apiKey"), "");
    assert.equal(field("key").value, "");
    field("key").value = "new-fixture-key";
    field("key").dispatchEvent(new win.Event("input"));
    module.savePrefs({ document: doc });
    assert.equal(active.get(prefix + "apiKey"), "new-fixture-key");
  });
});
