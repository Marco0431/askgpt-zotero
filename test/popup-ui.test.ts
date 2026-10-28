import { assert } from "chai";

describe("AskGPT settings and image interaction", function () {
  this.timeout(5000);

  const prefix = "extensions.askgpt.";
  const pngData =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=";
  // Fixture captured from v1.2.11 addon/prefs.js, not from the new prompt helper.
  const legacyPrefsPrompt = `你是一个帮助我精读文献的轻量级研究助手（agent）。我会把**整篇文献全文**作为上下文发给你，并在提问时用【选中段落】标出我正在看的部分。

## 你的能力
1. 问答：基于整篇文献作答（解释概念、概括方法、分析结果、评价局限、翻译等）。重点关注【选中段落】，但可以引用全文任何位置。
2. 联网检索：你可以调用工具 web_search(query) 搜索互联网，用来核实事实、查找相关背景/最新研究/术语解释。

## 工具使用规则
- 需要最新或外部信息、原文里没有提到的内容、或者我明确说"搜索一下"时，调用 web_search。
- web_search 一次只查一个主题，query 用简洁关键词（中英文均可）。
- 检索结果只是参考资料，不要虚构。

## 回答要求
- 一律用简体中文回答，除非我明确要求其他语言。
- 公式一律用 LaTeX 书写：行内用 \\(...\\)，独立成行用 $$...$$。
- 先基于原文作答，再补充你自己的知识或检索结果。
- 引用原文时用引号并说明位置（第几节 / 第几个公式）。
- 结构化输出：可用小标题、列表；不要空话套话。`;
  let source: string;

  before(async function () {
    source = await Zotero.File.getResourceAsync(
      "chrome://askgpt/content/popup.xhtml",
    );
  });

  function event(doc: Document, name: string) {
    const result = doc.createEvent("Event");
    result.initEvent(name, true, true);
    return result;
  }

  async function until(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 1500;
    while (!predicate() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.isTrue(predicate(), message);
  }

  function makeImage() {
    return new File(
      [Uint8Array.from(atob(pngData), (character) => character.charCodeAt(0))],
      "figure.png",
      { type: "image/png" },
    );
  }

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body };
  }

  function chatResponse() {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"A test answer."}}]}\n\ndata: [DONE]\n\n',
    );
    let read = false;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: bytes };
          },
        }),
      },
    };
  }

  function nativeResponse(
    citations: Array<{ url: string; title: string; endIndex?: number }> = [],
    searched = true,
    beforeRead: (index: number) => void = () => {},
    answerText = "A sourced answer.",
  ) {
    const annotations = citations.map((citation) => ({
      type: "url_citation",
      ...citation,
      start_index: 0,
      end_index: citation.endIndex ?? 8,
    }));
    const search = {
      id: "ws_test",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "test source" },
    };
    const message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answerText, annotations }],
    };
    const events: any[] = searched
      ? [
          {
            type: "response.web_search_call.in_progress",
            item_id: search.id,
            output_index: 0,
          },
          {
            type: "response.web_search_call.searching",
            item_id: search.id,
            output_index: 0,
          },
          {
            type: "response.web_search_call.completed",
            item_id: search.id,
            output_index: 0,
          },
        ]
      : [];
    events.push({
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: searched ? 1 : 0,
      content_index: 0,
      delta: message.content[0].text,
    });
    annotations.forEach((annotation, annotation_index) =>
      events.push({
        type: "response.output_text.annotation.added",
        item_id: message.id,
        output_index: searched ? 1 : 0,
        content_index: 0,
        annotation_index,
        annotation,
      }),
    );
    events.push({
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [...(searched ? [search] : []), message],
      },
    });
    let index = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          read: async () => {
            beforeRead(index);
            if (index === events.length) return { done: true };
            return {
              done: false,
              value: new TextEncoder().encode(
                "data: " + JSON.stringify(events[index++]) + "\n\n",
              ),
            };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    };
  }

  function harness(
    prompt: boolean | string = false,
    legacySearch = false,
    realRenderer = false,
  ) {
    // The real XHTML controls and scripts run against isolated host services.
    // No real Zotero preference, session, browser window, or network is used.
    const doc = new DOMParser().parseFromString(
      source,
      "application/xhtml+xml",
    );
    assert.isNull(doc.querySelector("parsererror"));
    const prefs = new Map<string, unknown>([
      [prefix + "baseURL", "https://saved.example.test/v1"],
      [prefix + "apiKey", "saved-test-key"],
      [prefix + "model", "saved-model"],
      [prefix + "webSearch", true],
      [prefix + "nativeSearch", false],
      [prefix + "systemPrompt", "Use the supplied context."],
    ]);
    if (prompt === true) prefs.delete(prefix + "systemPrompt");
    else if (typeof prompt === "string")
      prefs.set(prefix + "systemPrompt", prompt);
    if (legacySearch) prefs.delete(prefix + "nativeSearch");
    const writes: Array<[string, unknown]> = [];
    const requests: any[] = [];
    const logs: unknown[] = [];
    const notes: string[] = [];
    const launchedURLs: string[] = [];
    const hiddenWindows: any[] = [];
    const windowListeners = new Map<string, Array<(event: any) => void>>();
    const host = {
      locale: "zh-CN",
      Prefs: {
        get: (name: string) => prefs.get(name),
        set: (name: string, value: unknown) => {
          writes.push([name, value]);
          prefs.set(name, value);
        },
      },
      AskGPT: {
        data: { sessions: {} as Record<string, any>, popupState: null as any },
        hidePopup: (options: any) => hiddenWindows.push(options?.window),
      },
      logError: (error: unknown) => logs.push(error),
      launchURL: (url: string) => launchedURLs.push(url),
      getActiveZoteroPane: () => ({ getSelectedItems: () => [] }),
      Libraries: { userLibraryID: 1 },
      Item: class {
        libraryID = 0;
        private html = "";
        setNote(html: string) {
          this.html = html;
        }
        async saveTx() {
          notes.push(this.html);
        }
      },
    };
    const hostWindow: any = {
      Zotero: host,
      innerWidth: 1400,
      innerHeight: 1000,
    };
    const fakeWindow: any = {
      navigator: { language: "zh-CN" },
      innerWidth: 900,
      innerHeight: 520,
      frameElement: {
        ownerGlobal: hostWindow,
        ownerDocument: { defaultView: hostWindow },
        style: {},
        getBoundingClientRect: () => ({ width: 900, height: 520 }),
      },
      addEventListener: (name: string, listener: (event: any) => void) => {
        if (!windowListeners.has(name)) windowListeners.set(name, []);
        windowListeners.get(name)!.push(listener);
      },
      AskGPTRender: { ready: { markdown: true, katex: true } },
    };
    let transport = async (url: string, _options: any): Promise<any> => {
      if (url.endsWith("/models")) {
        return jsonResponse({
          data: [
            { id: "vision-model", input_modalities: ["text", "image"] },
            { id: "text-model", input_modalities: ["text"] },
          ],
        });
      }
      return chatResponse();
    };
    const fetchMock = (url: string, options: any) => {
      requests.push({ url, ...options });
      return transport(url, options);
    };
    fakeWindow.fetch = fetchMock;
    const scope: any = {
      window: fakeWindow,
      self: fakeWindow,
      globalThis: fakeWindow,
      document: doc,
      navigator: fakeWindow.navigator,
      URL,
      AbortController,
      FileReader,
      DOMParser,
      TextDecoder,
      NodeFilter: {
        SHOW_TEXT: 4,
        SHOW_ELEMENT: 1,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
        FILTER_SKIP: 3,
      },
      atob,
      setTimeout,
      clearTimeout,
      fetch: fetchMock,
    };
    if (realRenderer) {
      for (const path of [
        "vendor/markdown-it.min.js",
        "vendor/katex/katex.min.js",
        "scripts/mathrender.js",
      ])
        Services.scriptloader.loadSubScript(
          "chrome://askgpt/content/" + path,
          scope,
        );
    }
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/prompts.js",
      scope,
    );
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/i18n.js",
      scope,
    );
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/client.js",
      scope,
    );
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/native-search.js",
      scope,
    );
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/popup.js",
      scope,
    );
    doc.dispatchEvent(event(doc, "DOMContentLoaded"));
    const get = (id: string) => doc.getElementById(id) as any;
    const click = (id: string) => get(id).dispatchEvent(event(doc, "click"));
    const input = (id: string, value: string) => {
      get(id).value = value;
      get(id).dispatchEvent(event(doc, "input"));
    };
    async function attach(paste = false) {
      const file = makeImage();
      if (paste) {
        const pasted = event(doc, "paste");
        Object.defineProperty(pasted, "clipboardData", {
          value: {
            items: [{ kind: "file", type: file.type, getAsFile: () => file }],
          },
        });
        get("input").dispatchEvent(pasted);
        assert.isTrue(pasted.defaultPrevented);
      } else {
        // A synthetic file selection exercises the native change handler while
        // avoiding a platform file picker in headless Gecko.
        Object.defineProperty(get("image-input"), "files", {
          value: [file],
          configurable: true,
        });
        get("image-input").dispatchEvent(event(doc, "change"));
      }
      await until(
        () => !get("btn-send").disabled,
        "Image loading should finish",
      );
      assert.equal(doc.querySelectorAll(".attachment-preview").length, 1);
    }
    return {
      doc,
      prefs,
      writes,
      requests,
      logs,
      notes,
      launchedURLs,
      hiddenWindows,
      hostWindow,
      renderer: fakeWindow.AskGPTRender,
      emitWindow: (name: string, payload: any) => {
        for (const listener of windowListeners.get(name) || [])
          listener(payload);
      },
      host,
      get,
      click,
      input,
      attach,
      i18n: fakeWindow.AskGPTI18n,
      popup: fakeWindow.AskGPTPopup,
      setTransport: (next: typeof transport) => {
        transport = next;
      },
    };
  }

  it("fetches and tests draft settings without saving or sending paper context", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "Private paper must not enter connection tests.",
      session: { key: "paper-a", history: [] },
    });
    ui.click("btn-settings");
    ui.input("set-base", "https://draft.example.test/v2");
    ui.input("set-key", "draft-test-key");
    ui.click("btn-fetch-models");
    await until(
      () => !ui.get("btn-fetch-models").disabled,
      "Model discovery should finish",
    );
    assert.equal(ui.requests[0].url, "https://draft.example.test/v2/models");
    assert.isUndefined(ui.requests[0].body);
    assert.equal(ui.get("set-model-select").options.length, 3);
    assert.equal(
      ui.get("set-model-select").options[1].namespaceURI,
      "http://www.w3.org/1999/xhtml",
      "Discovered models must be real HTML option elements in the XML document",
    );
    assert.isFalse(ui.get("set-model-select").classList.contains("hidden"));
    ui.get("set-model-select").value = "vision-model";
    ui.get("set-model-select").dispatchEvent(event(ui.doc, "change"));
    assert.equal(ui.get("set-model").value, "vision-model");
    ui.setTransport(async () =>
      jsonResponse({
        choices: [{ message: { role: "assistant", content: "OK" } }],
      }),
    );
    ui.click("btn-test-connection");
    await until(
      () => !ui.get("btn-test-connection").disabled,
      "Connection test should finish",
    );
    const testRequest = JSON.parse(ui.requests[1].body);
    assert.equal(testRequest.model, "vision-model");
    assert.deepEqual(testRequest.messages, [
      { role: "user", content: "Reply with OK." },
    ]);
    assert.equal(testRequest.stream, false);
    assert.equal(ui.get("connection-status").dataset.state, "success");
    assert.lengthOf(ui.writes, 0);
    assert.equal(
      ui.prefs.get(prefix + "baseURL"),
      "https://saved.example.test/v1",
    );
    ui.input("set-temp", "0");
    ui.click("btn-save");
    assert.equal(
      ui.prefs.get(prefix + "baseURL"),
      "https://draft.example.test/v2",
    );
    assert.equal(ui.prefs.get(prefix + "apiKey"), "draft-test-key");
    assert.equal(ui.prefs.get(prefix + "model"), "vision-model");
    assert.equal(ui.prefs.get(prefix + "temperature"), 0);
    assert.isTrue(ui.get("settings").classList.contains("hidden"));
  });

  it("cancels pending discovery and discards unsaved edits", async function () {
    const ui = harness();
    ui.setTransport(async () => new Promise(() => {}));
    ui.click("btn-settings");
    ui.input("set-base", "https://discard.example.test/v1");
    ui.input("set-key", "discard-test-key");
    ui.click("btn-toggle-key");
    assert.equal(ui.get("set-key").type, "text");
    ui.click("btn-fetch-models");
    assert.lengthOf(ui.requests, 1);
    ui.click("btn-settings-close2");
    assert.isTrue(ui.requests[0].signal.aborted);
    assert.equal(ui.get("set-base").value, "https://saved.example.test/v1");
    assert.equal(ui.get("set-key").value, "saved-test-key");
    assert.equal(ui.get("set-key").type, "password");
    assert.lengthOf(ui.writes, 0);
    ui.click("btn-settings");
    assert.isFalse(ui.get("btn-fetch-models").disabled);
    assert.equal(ui.get("connection-status").textContent, "");
  });

  it("discards a temporary provider's model list when cancelling its settings", async function () {
    const ui = harness();
    ui.click("btn-settings");
    ui.click("btn-fetch-models");
    await until(
      () => !ui.get("btn-fetch-models").disabled,
      "Saved provider discovery should finish",
    );
    ui.input("set-base", "https://temporary.example.test/v1");
    ui.input("set-key", "temporary-test-key");
    ui.setTransport(async () =>
      jsonResponse({ data: [{ id: "temporary-provider-only-model" }] }),
    );
    ui.click("btn-fetch-models");
    await until(
      () => !ui.get("btn-fetch-models").disabled,
      "Temporary provider discovery should finish",
    );
    assert.equal(
      ui.get("set-model-select").options[1].value,
      "temporary-provider-only-model",
    );
    ui.click("btn-settings-close2");
    ui.click("btn-settings");
    assert.equal(ui.get("set-base").value, "https://saved.example.test/v1");
    assert.equal(ui.get("set-key").value, "saved-test-key");
    assert.equal(ui.get("set-model").value, "saved-model");
    assert.isTrue(ui.get("set-model-select").classList.contains("hidden"));
    assert.equal(ui.get("askgpt-model-list").children.length, 0);
    assert.lengthOf(ui.writes, 0);
  });

  it("previews, removes, pastes, and sends an image while retaining it for follow-up", async function () {
    const ui = harness();
    await ui.attach();
    assert.equal(
      ui.doc.querySelector(".attachment-preview img")!.namespaceURI,
      "http://www.w3.org/1999/xhtml",
      "Image previews must be real HTML image elements in the XML document",
    );
    assert.equal(
      ui.doc.querySelector(".attachment-preview button")!.namespaceURI,
      "http://www.w3.org/1999/xhtml",
    );
    assert.equal(
      ui.doc.querySelector(".attachment-preview img")!.getAttribute("src"),
      "data:image/png;base64," + pngData,
    );
    ui.doc
      .querySelector(".attachment-preview button")!
      .dispatchEvent(event(ui.doc, "click"));
    assert.isTrue(ui.get("attachments").classList.contains("hidden"));
    await ui.attach(true);
    await ui.popup.send("Explain the figure.");
    assert.lengthOf(ui.requests, 1);
    const first = JSON.parse(ui.requests[0].body);
    const user = first.messages[first.messages.length - 1];
    assert.deepEqual(user, {
      role: "user",
      content: [
        { type: "text", text: "Explain the figure." },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64," + pngData },
        },
      ],
    });
    assert.isTrue(ui.get("attachments").classList.contains("hidden"));
    assert.equal(ui.doc.querySelectorAll(".message-images img").length, 1);
    assert.equal(ui.doc.querySelectorAll(".msg.assistant").length, 1);
    await ui.popup.send("Explain that in more detail.");
    assert.lengthOf(ui.requests, 2);
    const second = JSON.parse(ui.requests[1].body);
    assert.deepEqual(second.messages[1], user);
    assert.equal(
      second.messages[second.messages.length - 1].content,
      "Explain that in more detail.",
    );
    await ui.attach();
    ui.click("btn-new");
    assert.equal(
      ui.doc.querySelectorAll(".attachment-preview, .msg").length,
      0,
    );
    assert.isTrue(ui.get("attachments").classList.contains("hidden"));
    assert.lengthOf(ui.logs, 0);
  });

  it("does not send images to a model explicitly declaring text-only input", async function () {
    const ui = harness();
    ui.click("btn-settings");
    ui.click("btn-fetch-models");
    await until(
      () => !ui.get("btn-fetch-models").disabled,
      "Model discovery should finish",
    );
    ui.input("set-model", "text-model");
    ui.click("btn-save");
    await ui.attach();
    await ui.popup.send("Explain the figure.");
    assert.lengthOf(ui.requests, 1, "Only the model-list request may run");
    assert.include(ui.get("statusline").textContent, "不支持图片");
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 1);
    assert.equal(ui.doc.querySelectorAll(".msg").length, 0);
  });

  it("retains draft images through a temporary loading state and waits to send", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "The same paper before refresh.",
      session: { key: "paper-a", history: [] },
    });
    await ui.attach();
    ui.popup.refresh({ loading: true, session: null });
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 1);
    await ui.popup.send("Please explain.");
    assert.lengthOf(
      ui.requests,
      0,
      "Sending must wait until the paper session is known",
    );
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 1);
    ui.popup.refresh({
      loading: false,
      contextText: "The same paper after refresh.",
      session: { key: "paper-a", history: [] },
    });
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 1);
    await ui.popup.send("Please explain.");
    assert.lengthOf(ui.requests, 1);
    const body = JSON.parse(ui.requests[0].body);
    assert.include(
      JSON.stringify(body.messages),
      "The same paper after refresh.",
    );
    assert.equal(
      body.messages[body.messages.length - 1].content[1].type,
      "image_url",
    );
  });

  it("clears images and old paper context when switching to a different session", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "OLD_PAPER_PRIVATE_CONTEXT",
      selection: "OLD_SELECTED_PASSAGE",
      session: { key: "paper-a", history: [] },
    });
    await ui.attach();
    ui.popup.refresh({ loading: true, session: null });
    ui.popup.refresh({
      loading: false,
      session: { key: "paper-b", history: [] },
    });
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 0);
    assert.isTrue(ui.get("focus-badge").classList.contains("hidden"));
    await ui.attach();
    await ui.popup.send("Explain the new image.");
    assert.lengthOf(ui.requests, 1);
    assert.notInclude(ui.requests[0].body, "OLD_PAPER_PRIVATE_CONTEXT");
    assert.notInclude(ui.requests[0].body, "OLD_SELECTED_PASSAGE");
    const body = JSON.parse(ui.requests[0].body);
    assert.lengthOf(
      body.messages,
      2,
      "Only the system prompt and new image question should be sent",
    );
  });

  it("previews English, cancels or saves the language, and preserves a custom system prompt", async function () {
    const ui = harness();
    const customPrompt = "Use the supplied context.";
    assert.equal(ui.i18n.locale(), "zh-CN");
    ui.click("btn-settings");
    ui.get("set-language").value = "en-US";
    ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
    assert.equal(ui.i18n.locale(), "en-US");
    assert.equal(ui.get("settings-title").textContent, "Settings");
    assert.equal(ui.get("btn-save").textContent, "Save and return");
    assert.equal(ui.get("set-sys").value, customPrompt);
    assert.isUndefined(ui.prefs.get(prefix + "language"));
    assert.lengthOf(
      ui.writes,
      0,
      "Previewing a language must not save preferences",
    );
    ui.click("btn-settings-close2");
    assert.equal(ui.i18n.locale(), "zh-CN");
    assert.equal(ui.get("btn-send").textContent, "发送");
    assert.equal(ui.get("set-sys").value, customPrompt);

    ui.click("btn-settings");
    ui.get("set-language").value = "en-US";
    ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
    ui.click("btn-save");
    assert.equal(ui.i18n.locale(), "en-US");
    assert.equal(ui.prefs.get(prefix + "language"), "en-US");
    assert.equal(ui.prefs.get(prefix + "systemPrompt"), customPrompt);
    ui.click("btn-settings");
    assert.equal(ui.get("set-language").value, "en-US");
    assert.equal(ui.get("settings-title").textContent, "Settings");
    ui.click("btn-settings-close2");
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    await ui.popup.send("Summarize this paper.");
    assert.lengthOf(ui.requests, 1);
    assert.equal(
      JSON.parse(ui.requests[0].body).messages[0].content,
      customPrompt,
    );
  });

  it("changes built-in prompt language without saving until settings are saved", function () {
    const ui = harness(true);
    ui.click("btn-settings");
    const chinesePrompt = ui.get("set-sys").value;
    assert.match(chinesePrompt, /[\u4e00-\u9fff]/);
    ui.get("set-language").value = "en-US";
    ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
    const englishPrompt = ui.get("set-sys").value;
    assert.notEqual(englishPrompt, chinesePrompt);
    assert.match(englishPrompt, /assistant|research/i);
    assert.notInclude(englishPrompt, "一律用简体中文");
    assert.isUndefined(ui.prefs.get(prefix + "systemPrompt"));
    ui.click("btn-settings-close2");
    assert.equal(ui.get("set-sys").value, chinesePrompt);
    assert.lengthOf(ui.writes, 0);

    ui.click("btn-settings");
    ui.get("set-language").value = "en-US";
    ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
    ui.click("btn-save");
    assert.equal(ui.prefs.get(prefix + "systemPrompt"), englishPrompt);
    ui.click("btn-settings");
    ui.get("set-language").value = "zh-CN";
    ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
    assert.equal(ui.get("set-sys").value, chinesePrompt);
    ui.click("btn-settings-close2");
    assert.equal(ui.get("set-sys").value, englishPrompt);
    assert.equal(ui.i18n.locale(), "en-US");
  });

  it("recognizes both exact v1.2.11 Chinese defaults and migrates only on save", function () {
    for (const legacyPrompt of [
      legacyPrefsPrompt,
      legacyPrefsPrompt.replace(
        "不要虚构。",
        "不要虚构；无法确认的信息要明说。",
      ),
    ]) {
      const ui = harness(legacyPrompt);
      ui.click("btn-settings");
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), legacyPrompt);
      ui.get("set-language").value = "en-US";
      ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
      const translated = ui.get("set-sys").value;
      assert.include(translated, "Answer in English by default");
      assert.notEqual(translated, legacyPrompt);
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), legacyPrompt);
      assert.lengthOf(ui.writes, 0);
      ui.click("btn-settings-close2");
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), legacyPrompt);
      ui.click("btn-settings");
      ui.get("set-language").value = "en-US";
      ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
      ui.click("btn-save");
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), translated);
    }
  });

  it("preserves customized prompts containing old default text or migration markers", function () {
    for (const custom of [
      legacyPrefsPrompt +
        "\n\nPlease use my terminology and keep answers brief.",
      "你的任务基于我提供的资料；请保留我的术语，并只输出三句话。",
    ]) {
      const ui = harness(custom);
      ui.click("btn-settings");
      assert.equal(ui.get("set-sys").value, custom);
      ui.get("set-language").value = "en-US";
      ui.get("set-language").dispatchEvent(event(ui.doc, "change"));
      assert.equal(ui.get("set-sys").value, custom);
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), custom);
      ui.click("btn-save");
      assert.equal(ui.prefs.get(prefix + "systemPrompt"), custom);
      ui.click("btn-settings");
      assert.equal(ui.get("set-sys").value, custom);
    }
  });

  it("uses ordinary chat when search is off and native Responses on the same service when it is on", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    await ui.popup.send("Summarize this paper.");
    assert.lengthOf(ui.requests, 1);
    assert.equal(
      ui.requests[0].url,
      "https://saved.example.test/v1/chat/completions",
    );
    assert.notProperty(JSON.parse(ui.requests[0].body), "tools");

    ui.click("btn-settings");
    ui.get("set-web").checked = true;
    ui.get("set-web").dispatchEvent(event(ui.doc, "change"));
    ui.click("btn-save");
    assert.isTrue(ui.prefs.get(prefix + "nativeSearch"));
    const statuses: string[] = [];
    ui.setTransport(async () =>
      nativeResponse([], true, () =>
        statuses.push(ui.get("statusline").textContent),
      ),
    );
    await ui.popup.send("Find a current source for this claim.");
    assert.lengthOf(ui.requests, 2);
    const native = ui.requests[1];
    assert.equal(native.url, "https://saved.example.test/v1/responses");
    assert.equal(native.headers.Authorization, "Bearer saved-test-key");
    const body = JSON.parse(native.body);
    assert.equal(body.model, "saved-model");
    assert.isTrue(body.tools.some((tool: any) => tool.type === "web_search"));
    assert.isFalse(body.tools.some((tool: any) => tool.type === "function"));
    assert.isTrue(
      statuses.some((status) => /搜索|search/i.test(status)),
      "A real search event should update the visible status",
    );
    assert.isTrue(
      ui.requests.every(
        (request) => new URL(request.url).hostname === "saved.example.test",
      ),
    );
    assert.isTrue(
      ui.host.AskGPT.data.sessions["paper-a"].history.at(-1).searched,
    );
  });

  it("tests native search with draft credentials without sending private context or saving settings", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "PRIVATE_PAPER_SENTINEL",
      selection: "PRIVATE_SELECTION_SENTINEL",
      session: {
        key: "paper-a",
        history: [
          {
            role: "user",
            content: "PRIVATE_HISTORY_SENTINEL",
            q: "PRIVATE_HISTORY_SENTINEL",
          },
        ],
      },
    });
    await ui.attach();
    ui.click("btn-settings");
    ui.input("set-base", "https://draft.example.test/v2");
    ui.input("set-key", "draft-test-key");
    ui.input("set-model", "draft-model");
    ui.setTransport(async () => nativeResponse());
    ui.click("btn-test-search");
    await until(
      () => !ui.get("btn-test-search").disabled,
      "Native search test should finish",
    );
    assert.lengthOf(ui.requests, 1);
    const request = ui.requests[0];
    assert.equal(request.url, "https://draft.example.test/v2/responses");
    assert.equal(request.headers.Authorization, "Bearer draft-test-key");
    const body = JSON.parse(request.body);
    assert.equal(body.model, "draft-model");
    assert.equal(body.tool_choice, "required");
    assert.isTrue(body.tools.some((tool: any) => tool.type === "web_search"));
    assert.notInclude(request.body, "PRIVATE_");
    assert.notInclude(request.body, "data:image/");
    assert.notInclude(request.body, "draft-test-key");
    assert.notInclude(request.body, "Use the supplied context.");
    assert.equal(ui.get("connection-status").dataset.state, "success");
    assert.lengthOf(ui.writes, 0);
    assert.isFalse(
      ui.prefs.get(prefix + "nativeSearch"),
      "A successful test must not enable native search",
    );
    assert.equal(ui.doc.querySelectorAll(".attachment-preview").length, 1);
  });

  it("does not migrate the old free-search setting into paid native search", async function () {
    const ui = harness(false, true);
    assert.isTrue(ui.prefs.get(prefix + "webSearch"));
    assert.isUndefined(ui.prefs.get(prefix + "nativeSearch"));
    assert.isFalse(ui.get("set-web").checked);
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    await ui.popup.send("Summarize this paper.");
    assert.lengthOf(ui.requests, 1);
    assert.equal(
      ui.requests[0].url,
      "https://saved.example.test/v1/chat/completions",
    );
    assert.notProperty(JSON.parse(ui.requests[0].body), "tools");
    assert.isUndefined(ui.prefs.get(prefix + "nativeSearch"));
  });

  it("cancels a search test when its base, key, or model changes and ignores late results", async function () {
    for (const [id, value] of [
      ["set-base", "https://changed.example.test/v1"],
      ["set-key", "changed-test-key"],
      ["set-model", "changed-model"],
    ]) {
      const ui = harness();
      let complete: (response: unknown) => void = () => {};
      ui.setTransport(
        async () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      ui.click("btn-settings");
      ui.click("btn-test-search");
      assert.lengthOf(ui.requests, 1);
      ui.input(id, value);
      assert.isTrue(ui.requests[0].signal.aborted);
      complete(nativeResponse());
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(ui.get("connection-status").textContent, "");
      assert.isFalse(ui.get("btn-test-search").disabled);
      assert.lengthOf(ui.writes, 0);
    }
  });

  it("does not claim search occurred when a native answer has no search event", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    ui.click("btn-settings");
    ui.get("set-web").checked = true;
    ui.click("btn-save");
    ui.setTransport(async () => nativeResponse([], false));
    await ui.popup.send("Summarize this paper.");
    assert.lengthOf(ui.requests, 1);
    assert.isFalse(
      ui.host.AskGPT.data.sessions["paper-a"].history.at(-1).searched,
    );
    assert.notMatch(
      ui.get("statusline").textContent,
      /已搜索|搜索完成|searched|search completed/i,
    );
    ui.click("btn-settings");
    ui.click("btn-test-search");
    await until(
      () => !ui.get("btn-test-search").disabled,
      "Search validation should finish",
    );
    assert.equal(
      ui.get("connection-status").dataset.state,
      "error",
      "An ordinary answer cannot pass the explicit search test",
    );
  });

  it("reports unsupported native search without silently retrying another service", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    ui.click("btn-settings");
    ui.get("set-web").checked = true;
    ui.click("btn-save");
    ui.setTransport(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: {
          message: "Unsupported tool: web_search",
          code: "unsupported_parameter",
          param: "tools",
        },
      }),
      text: async () =>
        JSON.stringify({
          error: {
            message: "Unsupported tool: web_search",
            code: "unsupported_parameter",
            param: "tools",
          },
        }),
    }));
    await ui.popup.send("Search the web for this topic.");
    assert.lengthOf(
      ui.requests,
      1,
      "An unsupported native endpoint must not trigger a fallback request",
    );
    assert.equal(ui.requests[0].url, "https://saved.example.test/v1/responses");
    assert.match(ui.get("statusline").textContent, /搜索|search|Responses/i);
    assert.equal(ui.doc.querySelectorAll(".answer-sources a").length, 0);
  });

  it("renders safe citations, restores them from history, and preserves them in a saved note", async function () {
    const ui = harness(false, false, true);
    const safeURL = 'https://sources.example.test/paper?a="quoted"&b=2';
    const normalizedURL = new URL(safeURL).href;
    const answerText =
      "Read [the source](https://sources.example.test/linked) for details.";
    const maliciousTitle = '<img src="x" onerror="alert(1)"> Source title';
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    ui.click("btn-settings");
    ui.get("set-web").checked = true;
    ui.click("btn-save");
    ui.setTransport(async () =>
      nativeResponse(
        [
          { url: safeURL, title: maliciousTitle },
          {
            url: "http://sources.example.test/second",
            title: "Second source",
            endIndex: answerText.length,
          },
          { url: "javascript:alert(1)", title: "Unsafe script URL" },
          { url: "data:text/html,unsafe", title: "Unsafe data URL" },
          {
            url: "https://user:secret@sources.example.test/private",
            title: "Embedded credentials",
          },
        ],
        true,
        () => {},
        answerText,
      ),
    );
    await ui.popup.send("Find sources for this paper.");
    const assertSources = () => {
      const links = Array.from(
        ui.doc.querySelectorAll<HTMLAnchorElement>(".answer-sources a"),
      );
      assert.lengthOf(links, 2);
      assert.equal(links[0].getAttribute("href"), normalizedURL);
      assert.include(links[0].textContent || "", maliciousTitle);
      assert.equal(
        ui.doc.querySelectorAll(".answer-sources img, .answer-sources script")
          .length,
        0,
      );
      assert.isTrue(
        links.every((link) =>
          /^https?:\/\//.test(link.getAttribute("href") || ""),
        ),
      );
      const inline = Array.from(
        ui.doc.querySelectorAll<HTMLAnchorElement>(".citation-link"),
      );
      assert.isAtLeast(inline.length, 1);
      assert.equal(
        ui.doc.querySelectorAll("a a").length,
        0,
        "A citation inside Markdown link text must not create a nested anchor",
      );
      assert.isTrue(
        inline.every((link) =>
          /^https?:\/\//.test(link.getAttribute("href") || ""),
        ),
      );
      const markdownLink = ui.doc.querySelector<HTMLAnchorElement>(
        '.bubble a[href="https://sources.example.test/linked"]',
      );
      assert.isNotNull(markdownLink);
      assert.equal(markdownLink!.target, "_blank");
      assert.include(markdownLink!.rel, "noopener");
      assert.include(markdownLink!.rel, "noreferrer");
      const clicked = event(ui.doc, "click");
      const previousLaunches = ui.launchedURLs.length;
      markdownLink!.dispatchEvent(clicked);
      assert.isTrue(clicked.defaultPrevented);
      assert.equal(
        ui.launchedURLs.length,
        previousLaunches + 1,
        "Each click must launch the external URL exactly once",
      );
      assert.equal(
        ui.launchedURLs.at(-1),
        "https://sources.example.test/linked",
      );
    };
    assertSources();
    const session = JSON.parse(
      JSON.stringify(ui.host.AskGPT.data.sessions["paper-a"]),
    );
    assert.lengthOf(session.history.at(-1).citations, 2);
    ui.popup.refresh({ session });
    assertSources();
    await ui.popup.saveNote();
    assert.lengthOf(ui.notes, 1);
    const note = new DOMParser().parseFromString(ui.notes[0], "text/html");
    const noteLinks = Array.from(note.querySelectorAll<HTMLAnchorElement>("a"));
    assert.isTrue(
      noteLinks.some((link) => link.getAttribute("href") === normalizedURL),
    );
    assert.isTrue(
      noteLinks.every((link) =>
        /^https?:\/\//.test(link.getAttribute("href") || ""),
      ),
    );
    assert.equal(note.querySelectorAll("img, script").length, 0);
    await ui.popup.send("Compare the first source with the second source.");
    const followup = JSON.parse(ui.requests.at(-1).body);
    assert.isTrue(
      followup.input.some(
        (message: any) =>
          message.role === "assistant" &&
          JSON.stringify(message.content).includes(normalizedURL),
      ),
      "Follow-up input must retain the earlier answer's source URLs",
    );
    assert.notInclude(ui.requests.at(-1).body, "javascript:");
    assert.notInclude(ui.requests.at(-1).body, "data:text/html");
    assert.notInclude(ui.requests.at(-1).body, "user:secret@");
    for (const message of followup.input)
      assert.notProperty(message, "citations");
  });

  it("saves an earlier answer with its own question after a later request fails", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    await ui.popup.send("FIRST_QUESTION");
    ui.click("btn-settings");
    ui.get("set-web").checked = true;
    ui.click("btn-save");
    ui.setTransport(async () => ({ ok: false, status: 400 }));
    await ui.popup.send("FAILED_SECOND_QUESTION");
    assert.equal(ui.doc.querySelectorAll(".msg.assistant").length, 1);
    await ui.popup.saveNote();
    assert.lengthOf(ui.notes, 1);
    const note = new DOMParser().parseFromString(ui.notes[0], "text/html");
    assert.include(
      note.querySelector("h1")!.textContent || "",
      "FIRST_QUESTION",
    );
    assert.notInclude(
      note.querySelector("h1")!.textContent || "",
      "FAILED_SECOND_QUESTION",
    );
    assert.include(note.body.textContent || "", "A test answer.");
  });

  it("redacts saved and draft credentials from global error diagnostics", function () {
    const ui = harness();
    const savedKey = "saved-test-key";
    const draftKey = "draft/private?credential=secret";
    ui.click("btn-settings");
    ui.input("set-key", draftKey);
    ui.emitWindow("error", {
      error: {
        name: "Error",
        message: `Renderer failed ${savedKey} ${draftKey} data:image/png;base64,${pngData}`,
        stack: `Error: ${encodeURIComponent(draftKey)}\n at renderer ${savedKey}`,
      },
    });
    const output = [
      ui.prefs.get(prefix + "lastError"),
      ui.get("set-lasterr").value,
      ui.get("statusline").textContent,
      ...ui.logs.map((error: any) => error.message),
    ].join("\n");
    assert.include(output, "Renderer failed");
    for (const secret of [
      savedKey,
      draftKey,
      encodeURIComponent(draftKey),
      pngData,
    ]) {
      assert.notInclude(output, secret);
    }
  });

  it("cancels ordinary chat even when fetching or reading ignores its abort signal", async function () {
    for (const phase of ["fetch", "read"]) {
      const ui = harness();
      ui.popup.refresh({
        contextText: "A test paper.",
        session: { key: "paper-a", history: [] },
      });
      let reads = 0;
      let cancelled = 0;
      let released = 0;
      ui.setTransport(async () =>
        phase === "fetch"
          ? new Promise(() => {})
          : {
              ok: true,
              body: {
                getReader: () => ({
                  read: async () => {
                    reads++;
                    return new Promise(() => {});
                  },
                  cancel: async () => {
                    cancelled++;
                  },
                  releaseLock: () => {
                    released++;
                  },
                }),
              },
            },
      );
      const sending = ui.popup.send("Please explain.");
      await until(
        () => (phase === "fetch" ? ui.requests.length === 1 : reads === 1),
        "The request should reach the expected phase",
      );
      ui.popup.cancelRequests();
      await until(
        () => !ui.get("btn-send").disabled,
        "Cancelling must unlock the interface without waiting for the transport",
      );
      await sending;
      assert.isTrue(ui.requests[0].signal.aborted);
      assert.equal(cancelled, phase === "read" ? 1 : 0);
      assert.equal(released, phase === "read" ? 1 : 0);
      assert.lengthOf(ui.logs, 0);
    }
  });

  it("flushes the latest streamed text during a pause without waiting for another token", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "A test paper.",
      session: { key: "paper-a", history: [] },
    });
    const pending: Array<(value: any) => void> = [];
    const chunk = (content: string) => ({
      done: false,
      value: new TextEncoder().encode(
        "data: " +
          JSON.stringify({ choices: [{ delta: { content } }] }) +
          "\n\n",
      ),
    });
    let first = true;
    ui.setTransport(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (first) {
              first = false;
              return chunk("First ");
            }
            return new Promise((resolve) => pending.push(resolve));
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }));
    const sending = ui.popup.send("Please explain.");
    await until(
      () =>
        (
          ui.doc.querySelector(".msg.assistant .bubble")?.textContent || ""
        ).includes("First "),
      "The first chunk should be visible",
    );
    pending.shift()!(chunk("tail"));
    await until(
      () =>
        (
          ui.doc.querySelector(".msg.assistant .bubble")?.textContent || ""
        ).includes("First tail"),
      "The throttled trailing chunk should appear while the stream is still open",
    );
    assert.isTrue(ui.get("btn-send").disabled);
    ui.popup.cancelRequests();
    await sending;
  });

  it("stops the old stream before switching paper context and retains its partial answer in that paper", async function () {
    const ui = harness();
    ui.popup.refresh({
      contextText: "OLD_PAPER_CONTEXT",
      session: { key: "paper-a", history: [] },
    });
    let reads = 0;
    let cancelled = false;
    ui.setTransport(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (reads++ === 0)
              return {
                done: false,
                value: new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"Partial old answer."}}]}\n\n',
                ),
              };
            return new Promise(() => {});
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    }));
    const sending = ui.popup.send("Explain the old paper.");
    await until(
      () => reads === 2,
      "The stream should be waiting for another chunk",
    );
    ui.popup.refresh({ loading: true, session: null });
    await until(
      () => !ui.get("btn-send").disabled,
      "A paper switch must stop the previous stream",
    );
    await sending;
    assert.isTrue(cancelled);
    assert.equal(
      ui.host.AskGPT.data.sessions["paper-a"].history.at(-1).content,
      "Partial old answer.",
    );
    ui.popup.refresh({
      contextText: "NEW_PAPER_CONTEXT",
      session: { key: "paper-b", history: [] },
    });
    ui.setTransport(async () => chatResponse());
    await ui.popup.send("Explain the new paper.");
    assert.include(ui.requests.at(-1).body, "NEW_PAPER_CONTEXT");
    assert.notInclude(ui.requests.at(-1).body, "OLD_PAPER_CONTEXT");
    assert.notInclude(ui.requests.at(-1).body, "Partial old answer.");
  });

  it("renders each restored long answer once", function () {
    const ui = harness();
    const rendered: string[] = [];
    ui.renderer.renderMarkdown = (text: string) => {
      rendered.push(text);
      return text;
    };
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: "assistant",
      content: `${index}:` + "LONG_HISTORY_TEXT ".repeat(100),
    }));
    ui.popup.refresh({ session: { key: "paper-a", history } });
    for (const message of history)
      assert.equal(
        rendered.filter((text) => text === message.content).length,
        1,
      );
    assert.equal(
      ui.doc.querySelectorAll(".msg.assistant").length,
      history.length,
    );
  });

  it("uses and closes its own reader window without taking another window's context", async function () {
    const ui = harness();
    ui.host.AskGPT.data.popupState = {
      contextText: "GLOBAL_OTHER_WINDOW",
      session: { key: "global", history: [] },
    };
    ui.hostWindow.__askgptPopupState = {
      contextText: "LOCAL_READER_WINDOW",
      session: { key: "local", history: [] },
    };
    ui.popup.refresh();
    await ui.popup.send("Explain this paper.");
    assert.include(ui.requests[0].body, "LOCAL_READER_WINDOW");
    assert.notInclude(ui.requests[0].body, "GLOBAL_OTHER_WINDOW");
    const escape = event(ui.doc, "keydown");
    Object.defineProperty(escape, "key", { value: "Escape" });
    ui.doc.dispatchEvent(escape);
    assert.deepEqual(ui.hiddenWindows, [ui.hostWindow]);
    ui.hostWindow.__askgptPopupState = null;
    ui.popup.refresh();
    await ui.popup.send("This must not pick up the other paper.");
    assert.lengthOf(ui.requests, 1);
  });
});
