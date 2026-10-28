import { assert } from "chai";
import {
  createReaderToolbar,
  readerHostWindow,
} from "../src/utils/readerToolbar";

describe("AskGPT reader toolbar", function () {
  function document(toolbar = true) {
    return new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
        (toolbar
          ? '<div class="toolbar"><div class="end"><div class="custom-sections"></div></div></div>'
          : "") +
        "</body></html>",
      "application/xhtml+xml",
    );
  }

  function host() {
    const doc = document(false);
    const listeners = new Map<string, Set<any>>();
    return {
      document: doc,
      closed: false,
      addEventListener(type: string, listener: any) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(listener);
      },
      removeEventListener(type: string, listener: any) {
        listeners.get(type)?.delete(listener);
      },
      emit(type: string) {
        for (const listener of Array.from(listeners.get(type) || []))
          listener();
      },
      listeners,
    } as any;
  }

  function event(doc: Document, type: string, values = {}) {
    const result = doc.createEvent("Event");
    result.initEvent(type, true, true);
    for (const [key, value] of Object.entries(values))
      Object.defineProperty(result, key, { value });
    return result;
  }

  function harness() {
    const window = host();
    const doc = document();
    const primaryDoc = document(false);
    const reader = {
      itemID: 123,
      _window: window,
      _iframeWindow: { document: doc },
      _internalReader: {
        _primaryView: { _iframeWindow: { document: primaryDoc } },
      },
    };
    let state = { visible: false, loading: false, reader };
    let complete: () => void = () => {};
    const calls: any[] = [];
    const errors: unknown[] = [];
    let reject = false;
    const controller = createReaderToolbar({
      title: () => "AskGPT: ask about this paper",
      state: () => state,
      toggle: async (source) => {
        calls.push(source);
        if (reject) throw new Error("mock load failure");
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      },
      reportError: (error) => errors.push(error),
    });
    const append = (node: Node) =>
      doc.querySelector(".custom-sections")!.appendChild(node);
    const attach = () => controller.attach({ reader, doc, append })!;
    function publish(next: Partial<typeof state>) {
      state = { ...state, ...next };
      window.document.dispatchEvent(
        event(window.document, "askgpt-panel-state", { detail: state }),
      );
    }
    return {
      window,
      doc,
      primaryDoc,
      reader,
      controller,
      calls,
      errors,
      attach,
      publish,
      complete: () => complete(),
      fail: () => {
        reject = true;
      },
    };
  }

  it("uses the official synchronous slot and replaces an old PDF overlay", function () {
    const ui = harness();
    const legacy = ui.primaryDoc.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    );
    legacy.id = "askgpt-toolbar-button";
    ui.primaryDoc.documentElement.appendChild(legacy);
    const button = ui.attach();
    assert.equal(
      button.parentElement,
      ui.doc.querySelector(".custom-sections"),
    );
    assert.equal(button.textContent, "AskGPT");
    assert.equal(
      button.tabIndex,
      -1,
      "Participates in Zotero's arrow-key toolbar navigation",
    );
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.notInclude(button.getAttribute("style") || "", "fixed");
    assert.isNull(ui.primaryDoc.getElementById("askgpt-toolbar-button"));
    ui.controller.destroy();
  });

  it("does not place a fallback entry over a document without a toolbar", function () {
    const ui = harness();
    ui.reader._iframeWindow.document = document(false);
    assert.isNull(ui.controller.attach({ reader: ui.reader }));
    assert.isNull(
      ui.reader._iframeWindow.document.getElementById("askgpt-toolbar-button"),
    );
    ui.reader._iframeWindow.document = ui.doc;
    const button = ui.controller.attach({ reader: ui.reader });
    assert.equal(
      button!.parentElement,
      ui.doc.querySelector(".custom-sections"),
    );
    ui.controller.destroy();
  });

  it("activates once for mouse or native keyboard click and disables concurrent activation", async function () {
    const ui = harness();
    const button = ui.attach();
    button.dispatchEvent(event(ui.doc, "mousedown"));
    assert.lengthOf(ui.calls, 0);
    button.dispatchEvent(event(ui.doc, "click"));
    button.dispatchEvent(event(ui.doc, "click"));
    assert.lengthOf(ui.calls, 1);
    assert.strictEqual(ui.calls[0].reader, ui.reader);
    assert.strictEqual(ui.calls[0].window, ui.window);
    assert.isTrue(button.disabled);
    assert.equal(button.getAttribute("aria-busy"), "true");
    ui.publish({ visible: true });
    ui.complete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.isFalse(button.disabled);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    for (const key of ["Enter", " "]) {
      const before = ui.calls.length;
      button.dispatchEvent(event(ui.doc, "keydown", { key, repeat: false }));
      assert.lengthOf(
        ui.calls,
        before,
        "Keyboard activation is left to native button click",
      );
      button.dispatchEvent(event(ui.doc, "click", { detail: 0 }));
      assert.lengthOf(ui.calls, before + 1);
      ui.complete();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const repeated = event(ui.doc, "keydown", { key, repeat: true });
      button.dispatchEvent(repeated);
      assert.isTrue(repeated.defaultPrevented);
    }
    ui.controller.destroy();
  });

  it("survives toolbar rerenders without duplicate listeners and follows its reader state", function () {
    const ui = harness();
    const button = ui.attach();
    ui.doc.querySelector(".custom-sections")!.replaceChildren();
    assert.strictEqual(ui.attach(), button);
    assert.lengthOf(ui.doc.querySelectorAll("#askgpt-toolbar-button"), 1);
    ui.publish({ visible: true, loading: true });
    assert.isTrue(button.disabled);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    ui.publish({ reader: { itemID: 456 } as any });
    assert.isFalse(button.disabled);
    assert.equal(button.getAttribute("aria-expanded"), "false");
    ui.publish({ reader: ui.reader, loading: false, visible: false });
    assert.equal(button.getAttribute("aria-expanded"), "false");
    ui.controller.destroy();
  });

  it("restores activation after failure and ignores callbacks after window cleanup", async function () {
    const ui = harness();
    const button = ui.attach();
    ui.fail();
    button.dispatchEvent(event(ui.doc, "click"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.lengthOf(ui.errors, 1);
    assert.isFalse(button.disabled);
    ui.window.emit("unload");
    assert.isNull(ui.doc.getElementById("askgpt-toolbar-button"));
    button.dispatchEvent(event(ui.doc, "click"));
    assert.lengthOf(ui.calls, 1);
    assert.equal(ui.window.listeners.get("unload").size, 0);
    ui.controller.destroy();
    assert.isNull(ui.attach());
  });

  it("cleans only the requested window and initializes existing open-panel state", function () {
    const ui = harness();
    ui.publish({ visible: true });
    const button = ui.attach();
    assert.equal(button.getAttribute("aria-expanded"), "true");
    const secondWindow = host();
    const secondDoc = document();
    const secondReader = {
      _window: secondWindow,
      _iframeWindow: { document: secondDoc },
    };
    const second = ui.controller.attach({ reader: secondReader })!;
    ui.controller.remove(ui.window);
    assert.isFalse(button.isConnected);
    assert.isTrue(second.isConnected);
    ui.controller.destroy();
    assert.isFalse(second.isConnected);
    assert.strictEqual(
      readerHostWindow({ _iframe: { ownerGlobal: secondWindow } }),
      secondWindow,
    );
    assert.isNull(
      readerHostWindow({
        get _window() {
          throw new Error("dead object");
        },
      }),
    );
  });
});
