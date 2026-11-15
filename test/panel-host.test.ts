import { assert } from "chai";

/* eslint mocha/no-exports: "off", mocha/consistent-spacing-between-blocks: "off" -- The local runner registers tests through an injected module factory. */

// The local preview runner compiles the actual popup.ts module and injects only
// its host services/dependencies. These cases never replace real Zotero globals.
export function registerPanelHostTests(loadModule: (environment: any) => any) {
  describe("AskGPT isolated panel host", function () {
    const tick = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    function event(
      doc: Document,
      type: string,
      values: Record<string, unknown> = {},
    ) {
      const result = doc.createEvent("Event");
      result.initEvent(type, true, true);
      for (const [key, value] of Object.entries(values))
        Object.defineProperty(result, key, { value });
      return result;
    }

    function makeHost() {
      const doc = new DOMParser().parseFromString(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body/></html>',
        "application/xhtml+xml",
      );
      const listeners = new Map<string, Set<(value: any) => void>>();
      const refreshes: any[] = [];
      const selections: string[] = [];
      let frameDocumentURI = "chrome://askgpt/content/popup.xhtml";
      let cancellations = 0;
      let focuses = 0;
      const win: any = {
        document: doc,
        innerWidth: 1200,
        innerHeight: 900,
        focus() {
          focuses++;
        },
        getSelection: () => ({ toString: () => "" }),
        addEventListener(type: string, listener: (value: any) => void) {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)!.add(listener);
        },
        removeEventListener(type: string, listener: (value: any) => void) {
          listeners.get(type)?.delete(listener);
        },
        emit(type: string, payload = {}) {
          for (const listener of Array.from(listeners.get(type) || []))
            listener(payload);
        },
      };
      const create = doc.createElement.bind(doc);
      Object.defineProperty(doc, "createElement", {
        value: (tag: string) => {
          const element = create(tag) as HTMLElement;
          // Detached native documents have no layout. Supply deterministic host
          // geometry while retaining real elements, event bubbling, and styles.
          Object.defineProperty(element, "getBoundingClientRect", {
            value: () => {
              const frame = element.querySelector(
                "iframe",
              ) as HTMLElement | null;
              const width =
                parseFloat(element.style.width) ||
                (frame ? parseFloat(frame.style.width) : 0) ||
                0;
              const height =
                parseFloat(element.style.height) ||
                (frame ? (parseFloat(frame.style.height) || 0) + 22 : 0);
              const explicitLeft = parseFloat(element.style.left);
              const left = Number.isFinite(explicitLeft)
                ? explicitLeft
                : win.innerWidth -
                  width -
                  (parseFloat(element.style.right) || 0);
              const top = parseFloat(element.style.top) || 0;
              return {
                x: left,
                y: top,
                left,
                top,
                width,
                height,
                right: left + width,
                bottom: top + height,
              };
            },
          });
          if (tag === "iframe") {
            const frameDoc = new DOMParser().parseFromString(
              '<html xmlns="http://www.w3.org/1999/xhtml"><body><input id="input"/><section id="settings" class="hidden"/></body></html>',
              "application/xhtml+xml",
            );
            Object.defineProperty(frameDoc, "documentURI", {
              get: () => frameDocumentURI,
            });
            Object.defineProperties(element, {
              contentDocument: { value: frameDoc },
              contentWindow: {
                value: {
                  AskGPTPopup: {
                    refresh: (payload: any) => refreshes.push(payload),
                    updateLiveSelection: (text: string) =>
                      selections.push(text),
                    cancelRequests: () => {
                      cancellations++;
                    },
                    notifyPanelSize: () => {},
                  },
                },
              },
            });
          }
          return element;
        },
      });
      return {
        win,
        doc,
        refreshes,
        selections,
        focuses: () => focuses,
        setFrameDocumentURI: (uri: string) => {
          frameDocumentURI = uri;
        },
        listeners,
        cancellations: () => cancellations,
      };
    }

    function harness() {
      const prefs = new Map<string, unknown>();
      const writes: Array<[string, unknown]> = [];
      const errors: unknown[] = [];
      const reads: Array<{
        reader: any;
        window: any;
        resolve: (value: any) => void;
      }> = [];
      const first = makeHost();
      let sourceMode = "auto";
      const addon = { data: { sessions: {} as Record<string, any> } };
      const Zotero = {
        AskGPT: addon,
        getMainWindow: () => first.win,
        Prefs: {
          get: (name: string) => prefs.get(name),
          set: (name: string, value: unknown) => {
            prefs.set(name, value);
            writes.push([name, value]);
          },
        },
        logError: (error: unknown) => errors.push(error),
      };
      const api = loadModule({
        Zotero,
        addon,
        getSourceMode: () => sourceMode,
        readAttachmentContext: (options: any) =>
          new Promise((resolve) => reads.push({ ...options, resolve })),
        getNativeString: (key: string) => key,
      });
      const reader = (itemID: number, host = first) => ({
        itemID,
        _item: { id: itemID, libraryID: 1, getField: () => "" },
        _window: host.win,
        _iframeWindow: {
          getSelection: () => ({ toString: () => `selection-${itemID}` }),
        },
      });
      const resolve = (
        index: number,
        text = `paper-${reads[index].reader.itemID}`,
      ) =>
        reads[index].resolve({
          text,
          path: `/${reads[index].reader.itemID}.pdf`,
          attachmentID: reads[index].reader.itemID,
          libraryID: reads[index].reader._item.libraryID,
          label: "PDF",
          chars: text.length,
          title: text,
          truncated: false,
        });
      return {
        first,
        api,
        prefs,
        writes,
        errors,
        reads,
        addon,
        reader,
        resolve,
        setSourceMode: (mode: string) => {
          sourceMode = mode;
        },
      };
    }

    it("coalesces repeated opens, focuses a loaded panel, and reloads a changed context source", async function () {
      const ui = harness();
      const reader = ui.reader(1);
      const first = ui.api.openAskPopup({ reader });
      const again = ui.api.openAskPopup({ reader });
      await tick();
      assert.lengthOf(ui.reads, 1);
      assert.equal(
        ui.first.doc.querySelectorAll("#askgpt-panel-wrap").length,
        1,
      );
      reader._iframeWindow.getSelection = () => ({
        toString: () => "latest selection after reading",
      });
      ui.resolve(0);
      await Promise.all([first, again]);
      assert.isFalse(ui.api.getAskPopupState(ui.first.win).loading);
      assert.equal(
        ui.first.win.__askgptPopupState.selection,
        "latest selection after reading",
      );
      const refreshCount = ui.first.refreshes.length;
      await ui.api.openAskPopup({ reader });
      assert.lengthOf(ui.reads, 1);
      assert.equal(
        ui.first.refreshes.length,
        refreshCount,
        "Focusing must not rebuild chat history",
      );
      ui.setSourceMode("translation");
      const changed = ui.api.openAskPopup({ reader });
      await tick();
      assert.lengthOf(ui.reads, 2);
      ui.resolve(1, "translated text");
      await changed;
      assert.equal(
        ui.first.win.__askgptPopupState.contextText,
        "translated text",
      );
      ui.api.disposeAskPopup();
      assert.lengthOf(ui.errors, 0);
    });

    it("takes the selection from the last active split view", async function () {
      const ui = harness();
      const reader = ui.reader(5);
      const view = (text: string) => ({
        _iframeWindow: { getSelection: () => text },
      });
      const secondary = view("selected in the right pane");
      Object.assign(reader, {
        _internalReader: {
          _primaryView: view("older selection in the left pane"),
          _secondaryView: secondary,
          _lastView: secondary,
        },
      });
      const open = ui.api.openAskPopup({ reader });
      await tick();
      ui.resolve(0);
      await open;
      assert.equal(
        ui.first.win.__askgptPopupState.selection,
        "selected in the right pane",
      );
      ui.api.disposeAskPopup();
    });

    it("remembers a collapsed selection only in its own reader window", async function () {
      const ui = harness();
      const other = makeHost();
      const first = ui.reader(5);
      const second = ui.reader(5, other);
      for (const reader of [first, second])
        reader._iframeWindow.getSelection = () => ({ toString: () => "" });
      ui.api.updateAskPopupSelection(
        ui.first.win,
        first,
        "first window selection",
      );
      const one = ui.api.openAskPopup({ reader: first });
      await tick();
      ui.resolve(0);
      await one;
      assert.equal(
        ui.first.win.__askgptPopupState.selection,
        "first window selection",
      );
      ui.api.hideAskPopup({ window: ui.first.win });
      const two = ui.api.openAskPopup({ reader: second });
      await tick();
      ui.resolve(1);
      await two;
      assert.equal(other.win.__askgptPopupState.selection, "");
      ui.api.disposeAskPopup();
    });

    it("delivers paper state only to the loaded AskGPT panel document", async function () {
      const ui = harness();
      const reader = ui.reader(1);
      ui.first.setFrameDocumentURI("about:blank");
      const pending = ui.api.openAskPopup({ reader });
      await tick();
      ui.resolve(0);
      await pending;
      const frame = ui.first.doc.getElementById("askgpt-panel-frame")!;
      frame.dispatchEvent(event(ui.first.doc, "load"));
      ui.api.updateAskPopupSelection(ui.first.win, reader, "selection");
      assert.isEmpty(ui.first.refreshes);
      assert.isEmpty(ui.first.selections);
      assert.notProperty(ui.addon.data, "popupState");

      ui.first.setFrameDocumentURI("chrome://askgpt/content/popup.xhtml");
      frame.dispatchEvent(event(ui.first.doc, "load"));
      ui.api.updateAskPopupSelection(ui.first.win, reader, "selection");
      assert.equal(ui.first.refreshes.at(-1).contextText, "paper-1");
      assert.deepEqual(ui.first.selections, ["selection"]);
      ui.api.disposeAskPopup();
    });

    it("separates paper sessions for different library items linked to the same file", async function () {
      const ui = harness();
      const keys = [];
      for (const id of [11, 22]) {
        const reader = ui.reader(id);
        reader._item.libraryID = id;
        const open = ui.api.openAskPopup({ reader });
        await tick();
        ui.reads.at(-1)!.resolve({
          text: "shared document",
          path: "/linked.pdf",
          label: "PDF",
          attachmentID: id,
          libraryID: id,
          chars: 15,
          title: "test",
          truncated: false,
        });
        await open;
        const session = ui.first.win.__askgptPopupState.session;
        assert.deepEqual(session.noteTarget, { itemID: id, libraryID: id });
        assert.isEmpty(session.history);
        session.history.push({ role: "user", content: "private to this item" });
        keys.push(session.key);
      }
      assert.notEqual(keys[0], keys[1]);
      ui.api.disposeAskPopup();
    });

    it("does not let an older paper read replace the newer reader", async function () {
      const ui = harness();
      const old = ui.api.openAskPopup({ reader: ui.reader(1) });
      await tick();
      const currentReader = ui.reader(2);
      const current = ui.api.openAskPopup({ reader: currentReader });
      await tick();
      ui.resolve(1, "CURRENT_PAPER");
      await current;
      const refreshCount = ui.first.refreshes.length;
      ui.resolve(0, "STALE_PAPER");
      await old;
      assert.equal(
        ui.first.win.__askgptPopupState.contextText,
        "CURRENT_PAPER",
      );
      assert.equal(ui.first.win.__askgptPopupState.selection, "selection-2");
      assert.equal(ui.api.getAskPopupState(ui.first.win).reader, currentReader);
      assert.equal(ui.first.refreshes.length, refreshCount);
      assert.deepEqual(Object.keys(ui.addon.data.sessions), [
        ui.first.win.__askgptPopupState.session.key,
      ]);
      ui.api.disposeAskPopup();
    });

    it("does not reopen or write stale state when a read finishes after hiding", async function () {
      const ui = harness();
      const pending = ui.api.openAskPopup({ reader: ui.reader(1) });
      await tick();
      ui.api.hideAskPopup({ window: ui.first.win });
      const refreshCount = ui.first.refreshes.length;
      const published = ui.first.win.__askgptPopupState;
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    "Hiding must release openAskPopup without waiting for the attachment read",
                  ),
                ),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer!);
      }
      ui.resolve(0);
      await tick();
      assert.isFalse(ui.api.getAskPopupState(ui.first.win).visible);
      assert.isFalse(ui.api.getAskPopupState(ui.first.win).loading);
      assert.equal(
        (ui.first.doc.getElementById("askgpt-panel-wrap") as HTMLElement).style
          .display,
        "none",
      );
      assert.equal(ui.first.refreshes.length, refreshCount);
      assert.strictEqual(ui.first.win.__askgptPopupState, published);
      assert.isEmpty(ui.addon.data.sessions);
      assert.isAtLeast(ui.first.cancellations(), 2);
      ui.api.disposeAskPopup();
    });

    it("reuses the visible panel even during loading, and moves ownership only after hiding", async function () {
      const ui = harness();
      const second = makeHost();
      const third = makeHost();
      Object.assign(ui.first.win, {
        STATE_MINIMIZED: 2,
        windowState: 2,
        restore() {
          ui.first.win.windowState = 3;
        },
      });
      const one = ui.api.openAskPopup({ reader: ui.reader(1) });
      const anotherReader = ui.reader(2, second);
      const two = ui.api.toggleAskPopup({ reader: anotherReader });
      const three = ui.api.openAskPopup({ reader: ui.reader(3, third) });
      await tick();
      assert.lengthOf(ui.reads, 1);
      ui.resolve(0, "FIRST_WINDOW_PAPER");
      await Promise.all([one, two, three]);
      assert.equal(ui.first.focuses(), 2);
      assert.equal(
        ui.first.win.windowState,
        3,
        "The owner should be visible again",
      );
      assert.isNull(second.doc.getElementById("askgpt-panel-frame"));
      assert.isNull(third.doc.getElementById("askgpt-panel-frame"));
      assert.equal(
        ui.first.win.__askgptPopupState.contextText,
        "FIRST_WINDOW_PAPER",
      );
      ui.api.disposeAskPopup(third.win);
      assert.isTrue(ui.api.getAskPopupState(ui.first.win).visible);
      ui.api.hideAskPopup({ window: ui.first.win });
      const reopened = ui.api.openAskPopup({ reader: anotherReader });
      await tick();
      ui.resolve(1, "SECOND_WINDOW_PAPER");
      await reopened;
      assert.isNull(ui.first.doc.getElementById("askgpt-panel-frame"));
      assert.equal(
        second.win.__askgptPopupState.contextText,
        "SECOND_WINDOW_PAPER",
      );
      assert.isTrue(ui.api.getAskPopupState(second.win).visible);
      ui.api.disposeAskPopup();
    });

    it("clamps negative saved positions and lets the close button click without dragging", async function () {
      const ui = harness();
      ui.prefs.set(
        "extensions.askgpt.panelPos",
        JSON.stringify({ left: -500, top: -250 }),
      );
      const pending = ui.api.openAskPopup({ reader: ui.reader(1) });
      await tick();
      const wrap = ui.first.doc.getElementById(
        "askgpt-panel-wrap",
      ) as HTMLElement;
      const frame = ui.first.doc.getElementById(
        "askgpt-panel-frame",
      ) as HTMLElement;
      assert.equal(wrap.style.left, "4px");
      assert.equal(wrap.style.top, "4px");
      const close = ui.first.doc.getElementById("askgpt-panel-close")!;
      const down = event(ui.first.doc, "mousedown", {
        button: 0,
        screenX: 10,
        screenY: 10,
      });
      close.dispatchEvent(down);
      ui.first.win.emit("mousemove", { screenX: 300, screenY: 300 });
      assert.isFalse(down.defaultPrevented);
      assert.notEqual(frame.style.pointerEvents, "none");
      assert.equal(wrap.style.left, "4px");
      close.dispatchEvent(event(ui.first.doc, "click"));
      assert.isFalse(ui.api.getAskPopupState(ui.first.win).visible);
      ui.resolve(0);
      await pending;
      ui.api.disposeAskPopup();
    });

    it("disposes host listeners and ignores a pending read after window teardown", async function () {
      const ui = harness();
      const pending = ui.api.openAskPopup({ reader: ui.reader(1) });
      await tick();
      assert.isAtLeast(
        Array.from(ui.first.listeners.values()).reduce(
          (sum, listeners) => sum + listeners.size,
          0,
        ),
        4,
      );
      ui.first.win.emit("unload");
      assert.isNull(ui.first.doc.getElementById("askgpt-panel-wrap"));
      assert.isNull(ui.first.doc.getElementById("askgpt-panel-style"));
      assert.notProperty(ui.first.win, "__askgptPopupState");
      assert.equal(
        Array.from(ui.first.listeners.values()).reduce(
          (sum, listeners) => sum + listeners.size,
          0,
        ),
        0,
      );
      ui.resolve(0);
      await pending;
      assert.notProperty(ui.first.win, "__askgptPopupState");
      assert.isEmpty(ui.addon.data.sessions);
    });
  });
}
