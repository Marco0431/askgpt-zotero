import { assert } from "chai";

describe("AskGPT provider-native search", function () {
  this.timeout(5000);
  let native: any;
  const config = {
    baseURL: "https://provider.example/v1",
    apiKey: "sk-native-secret",
    model: "research-model",
  };
  const question = [{ role: "user", content: "Find recent research." }];
  const annotation = (
    url = "https://example.org/paper",
    start = 0,
    end = 6,
  ) => ({
    type: "url_citation",
    url,
    title: "A paper",
    start_index: start,
    end_index: end,
  });
  const answer = (text = "Answer", annotations: any[] = []) => ({
    id: "msg-1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  });
  const completed = (output: any[] = [answer()]) => ({
    type: "response.completed",
    response: { status: "completed", output },
  });
  const searchItem = {
    id: "search-1",
    type: "web_search_call",
    status: "completed",
    action: { type: "search" },
  };
  const searchedEvents = () => [
    {
      type: "response.web_search_call.in_progress",
      item_id: "search-1",
      output_index: 0,
    },
    {
      type: "response.web_search_call.searching",
      item_id: "search-1",
      output_index: 0,
    },
    {
      type: "response.web_search_call.completed",
      item_id: "search-1",
      output_index: 0,
    },
    {
      type: "response.output_text.delta",
      item_id: "msg-1",
      output_index: 1,
      content_index: 0,
      delta: "Answer",
    },
    completed([searchItem, answer()]),
  ];
  function streamResponse(
    events: any[],
    options: {
      raw?: string;
      split?: number;
      hangAfter?: boolean;
      onCancel?: () => void;
    } = {},
  ) {
    const raw =
      options.raw ??
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const bytes = new TextEncoder().encode(raw);
    let offset = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (offset >= bytes.length)
              return options.hangAfter ? new Promise(() => {}) : { done: true };
            const end = Math.min(
              bytes.length,
              offset + (options.split || bytes.length),
            );
            const value = bytes.slice(offset, end);
            offset = end;
            return { done: false, value };
          },
          cancel: () => {
            options.onCancel?.();
            return Promise.resolve();
          },
          releaseLock: () => {},
        }),
      },
    };
  }
  async function failure(action: () => unknown, code: string) {
    try {
      await action();
    } catch (caught: any) {
      assert.equal(caught.code, code);
      return caught;
    }
    assert.fail("Expected a failure");
  }
  function load(language?: string) {
    const scope: any = {
      window: language
        ? { Zotero: { locale: language, Prefs: { get: () => "auto" } } }
        : {},
      URL,
      AbortController,
      TextDecoder,
      FileReader,
      atob: (value: string) => window.atob(value),
      setTimeout: (callback: () => void, delay?: number) =>
        window.setTimeout(callback, delay),
      clearTimeout: (id: number) => window.clearTimeout(id),
    };
    for (const name of [
      ...(language ? ["i18n"] : []),
      "client",
      "native-search",
    ])
      Services.scriptloader.loadSubScript(
        `chrome://askgpt/content/scripts/${name}.js`,
        scope,
      );
    return scope.window.AskGPTNativeSearch;
  }

  before(function () {
    native = load();
  });

  it("maps only readable chat history and user images into the configured Responses endpoint", async function () {
    const image = "data:image/png;base64,aW1hZ2U=";
    let sent: any;
    const messages = [
      { role: "system", content: "Use this paper.", q: "private UI field" },
      {
        role: "user",
        content: [
          { type: "text", text: "Explain this figure." },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ],
        focus: "private focus metadata",
      },
      {
        role: "assistant",
        content: "Prior answer.",
        tool_calls: [{ id: "old-tool" }],
        sources: [{ url: "https://ignored.test" }],
        reasoning_content: "private reasoning",
      },
      { role: "assistant", content: null, tool_calls: [{ id: "tool-only" }] },
      {
        role: "tool",
        content: "Old DuckDuckGo result",
        tool_call_id: "old-tool",
      },
      { role: "user", content: "Follow up." },
    ];
    const result = await native.stream(config, {
      messages,
      fetchImpl: async (url: string, options: any) => {
        sent = { url, ...options, payload: JSON.parse(options.body) };
        return streamResponse([completed()]);
      },
    });
    assert.equal(sent.url, "https://provider.example/v1/responses");
    assert.equal(sent.redirect, "error");
    assert.equal(sent.headers.Authorization, "Bearer " + config.apiKey);
    assert.equal(sent.method, "POST");
    assert.deepEqual(sent.payload.input, [
      {
        role: "system",
        content: [{ type: "input_text", text: "Use this paper." }],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Explain this figure." },
          { type: "input_image", image_url: image, detail: "high" },
        ],
      },
      { role: "assistant", content: "Prior answer." },
      { role: "user", content: [{ type: "input_text", text: "Follow up." }] },
    ]);
    assert.deepEqual(sent.payload.tools, [{ type: "web_search" }]);
    assert.isFalse(sent.payload.store);
    assert.isTrue(sent.payload.stream);
    assert.equal(sent.payload.tool_choice, "auto");
    assert.notProperty(sent.payload, "temperature");
    assert.notProperty(sent.payload, "max_output_tokens");
    assert.equal(result.text, "Answer");
    assert.isFalse(result.searched);
    assert.equal(result.searchCount, 0);
  });

  it("parses UTF-8 split across chunks, CRLF, comments, multiline data, and an undelimited final event", async function () {
    const delta = {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: "msg-1",
      delta: "中文",
    };
    const done = completed([answer("中文")]);
    const raw = `: keepalive\r\nid: 10\r\nevent: response.output_text.delta\r\ndata: ${JSON.stringify(delta)}\r\n\r\ndata: {\r\ndata: "type":"response.completed",\r\ndata: "response":${JSON.stringify(done.response)}}`;
    const deltas: string[] = [];
    const result = await native.stream(config, {
      messages: question,
      onDelta: (value: string) => deltas.push(value),
      fetchImpl: async () => streamResponse([], { raw, split: 1 }),
    });
    assert.equal(result.text, "中文");
    assert.equal(deltas.join(""), "中文");
  });

  it("uses event names when a provider omits JSON type and does not duplicate done/completed text", async function () {
    const events = [
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        delta: "Answer",
        sequence_number: 1,
      },
      {
        type: "response.output_text.delta",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        delta: "Answer",
        sequence_number: 1,
      },
      {
        type: "response.output_text.done",
        item_id: "msg-1",
        output_index: 0,
        content_index: 0,
        text: "Answer",
        sequence_number: 2,
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: answer(),
        sequence_number: 3,
      },
      { ...completed(), sequence_number: 4 },
    ];
    const raw = events
      .map(
        ({ type, ...value }) =>
          `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`,
      )
      .join("");
    let text = "";
    const result = await native.stream(config, {
      messages: question,
      onDelta: (value: string) => {
        text += value;
      },
      fetchImpl: async () => streamResponse([], { raw }),
    });
    assert.equal(text, "Answer");
    assert.equal(result.text, "Answer");
  });

  it("tracks only actual search calls and reports each call once", async function () {
    const statuses: any[] = [];
    const events = searchedEvents();
    events.splice(3, 0, {
      type: "response.output_item.done",
      item: searchItem,
      output_index: 0,
    } as any);
    const result = await native.stream(config, {
      messages: question,
      onStatus: (value: any) => statuses.push(value),
      fetchImpl: async () => streamResponse(events),
    });
    assert.isTrue(result.searched);
    assert.equal(result.searchCount, 1);
    assert.deepEqual(
      statuses.map((s) => s.status),
      ["in_progress", "searching", "completed"],
    );
    assert.isTrue(
      statuses.every((s) => s.searchCount === 1 && s.type === "search"),
    );
    const claimed = await native.stream(config, {
      messages: question,
      fetchImpl: async () =>
        streamResponse([completed([answer("I searched the web.")])]),
    });
    assert.isFalse(claimed.searched);
  });

  it("merges citation events and terminal annotations, preserving repeated inline URLs and global offsets", async function () {
    const ref = annotation();
    const second = annotation(ref.url, 7, 13);
    const output = {
      ...answer(""),
      content: [
        { type: "output_text", text: "Intro ", annotations: [] },
        {
          type: "output_text",
          text: "Source Source",
          annotations: [ref, second, ref],
        },
      ],
    };
    const snapshots: any[] = [];
    const result = await native.stream(config, {
      messages: question,
      onAnnotations: (value: any) => snapshots.push(value),
      fetchImpl: async () =>
        streamResponse([
          {
            type: "response.output_text.delta",
            item_id: "msg-1",
            output_index: 0,
            content_index: 0,
            delta: "Intro ",
          },
          {
            type: "response.output_text.annotation.added",
            item_id: "msg-1",
            output_index: 0,
            content_index: 1,
            annotation: ref,
          },
          { type: "response.output_item.done", output_index: 0, item: output },
          completed([output]),
        ]),
    });
    assert.equal(result.text, "Intro Source Source");
    assert.deepEqual(JSON.parse(JSON.stringify(result.citations)), [
      { url: ref.url, title: ref.title, startIndex: 6, endIndex: 12 },
      { url: ref.url, title: ref.title, startIndex: 13, endIndex: 19 },
    ]);
    assert.deepEqual(snapshots[snapshots.length - 1], result.citations);
  });

  it("accepts only safe absolute HTTP sources and deduplicates identical occurrences", function () {
    const values = native.safeCitations([
      annotation(),
      annotation(),
      annotation(undefined, 7, 13),
      { url: "https://example.org/paper", title: "Source-only duplicate" },
      { url: "https://news.example/", title: "News" },
      { url: "http://example.net/", startIndex: -1, endIndex: 99 },
      { url: "javascript:alert(1)" },
      { url: "file:///local" },
      { url: "/relative" },
      { url: "https://user:pass@example.org/" },
      { url: "data:text/html,hello" },
      { type: "file_citation", url: "https://ignored.example/" },
    ]);
    assert.lengthOf(values, 4);
    assert.equal(values[0].startIndex, 0);
    assert.equal(values[1].startIndex, 7);
    assert.equal(values[2].url, "https://news.example/");
    assert.notProperty(values[3], "startIndex");
  });

  it("tests search with an isolated small request and requires a completed server-side call", async function () {
    const result = await native.test(config, {
      messages: [{ role: "user", content: "PRIVATE PAPER" }],
      fetchImpl: async (_url: string, options: any) => {
        const body = JSON.parse(options.body);
        assert.equal(body.tool_choice, "required");
        assert.equal(body.max_output_tokens, 4096);
        assert.isFalse(body.store);
        assert.lengthOf(body.input, 1);
        assert.equal(body.input[0].role, "user");
        assert.isBelow(body.input[0].content[0].text.length, 180);
        assert.notInclude(options.body, "PRIVATE PAPER");
        assert.notInclude(options.body, "input_image");
        return streamResponse(searchedEvents());
      },
    });
    assert.isTrue(result.searched);
    await failure(
      () =>
        native.test(config, {
          fetchImpl: async () => streamResponse([completed()]),
        }),
      "not-searched",
    );
  });

  it("checks known DeepSeek support while leaving custom provider models to the API", function () {
    assert.throws(
      () =>
        native.validateConfig({
          ...config,
          baseURL: "https://api.deepseek.com",
          model: "deepseek-flash",
        }),
      "deepseek-v4-pro",
    );
    assert.doesNotThrow(() =>
      native.validateConfig({
        ...config,
        baseURL: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
      }),
    );
    assert.doesNotThrow(() =>
      native.validateConfig({ ...config, model: "deepseek-flash" }),
    );
    assert.throws(() => native.validateConfig({ ...config, model: "" }));
  });

  it("omits an empty API key and cleans pasted header characters", async function () {
    for (const [key, expected] of [
      ["", undefined],
      ["\n sk-native-secret\u200b", "Bearer sk-native-secret"],
    ]) {
      await native.stream(
        { ...config, apiKey: key },
        {
          messages: question,
          fetchImpl: async (_url: string, options: any) => {
            assert.equal(options.headers.Authorization, expected);
            return streamResponse([completed()]);
          },
        },
      );
    }
  });

  it("normalizes root, versioned, prefixed, and complete Responses addresses without changing origin", async function () {
    for (const [baseURL, endpoint] of [
      ["api.openai.com", "https://api.openai.com/v1/responses"],
      ["https://api.x.ai/v1/", "https://api.x.ai/v1/responses"],
      ["https://api.deepseek.com", "https://api.deepseek.com/responses"],
      ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/responses"],
      [
        "https://custom.example/proxy/v3",
        "https://custom.example/proxy/v3/responses",
      ],
      [
        "https://custom.example/proxy/v3/chat/completions",
        "https://custom.example/proxy/v3/responses",
      ],
      [
        "http://localhost:11434/v1/responses",
        "http://localhost:11434/v1/responses",
      ],
      ["https://custom.example/responses", "https://custom.example/responses"],
    ]) {
      await native.stream(
        { ...config, baseURL, model: "deepseek-v4-pro" },
        {
          messages: question,
          fetchImpl: async (url: string) => {
            assert.equal(url, endpoint);
            return streamResponse([completed()]);
          },
        },
      );
    }
  });

  it("does not read or reveal raw provider error bodies or network messages", async function () {
    for (const status of [400, 404, 405, 422, 501, 401, 403, 429, 500]) {
      let bodyRead = false;
      const failed = await failure(
        () =>
          native.stream(config, {
            messages: question,
            fetchImpl: async () => ({
              ok: false,
              status,
              text: async () => {
                bodyRead = true;
                return "PRIVATE PAPER " + config.apiKey;
              },
            }),
          }),
        [400, 404, 405, 422, 501].includes(status) ? "unsupported" : "http",
      );
      assert.isFalse(bodyRead);
      assert.notInclude(failed.message, config.apiKey);
      assert.notInclude(failed.message, "PRIVATE PAPER");
    }
    const failed = await failure(
      () =>
        native.stream(config, {
          messages: question,
          fetchImpl: async () => {
            throw new Error("PRIVATE PAPER " + config.apiKey);
          },
        }),
      "network",
    );
    assert.notInclude(failed.message, config.apiKey);
    assert.notInclude(failed.message, "PRIVATE PAPER");
  });

  it("rejects error, failed, incomplete, and corrupt events even after partial text", async function () {
    for (const [event, code] of [
      [
        { type: "error", message: "PRIVATE PAPER " + config.apiKey },
        "provider",
      ],
      [
        {
          type: "response.failed",
          response: { error: { message: config.apiKey } },
        },
        "provider",
      ],
      [
        {
          type: "response.incomplete",
          response: { incomplete_details: { reason: "max_output_tokens" } },
        },
        "incomplete",
      ],
      [completed([{ ...answer(), status: "incomplete" }]), "incomplete"],
    ] as Array<[any, string]>) {
      const failed = await failure(
        () =>
          native.stream(config, {
            messages: question,
            fetchImpl: async () =>
              streamResponse([
                {
                  type: "response.output_text.delta",
                  output_index: 0,
                  delta: "Partial",
                },
                event,
              ]),
          }),
        code,
      );
      assert.notInclude(failed.message, config.apiKey);
    }
    await failure(
      () =>
        native.stream(config, {
          messages: question,
          fetchImpl: async () =>
            streamResponse([], { raw: "data: {not-json}\n\n" }),
        }),
      "protocol",
    );
  });

  it("requires a completed response, not EOF, DONE, or a text-done event", async function () {
    for (const raw of [
      'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
      'data: {"type":"response.output_text.done","text":"Looks complete"}\n\ndata: [DONE]\n\n',
      "",
    ])
      await failure(
        () =>
          native.stream(config, {
            messages: question,
            fetchImpl: async () => streamResponse([], { raw }),
          }),
        "truncated",
      );
    await failure(
      () =>
        native.stream(config, {
          messages: question,
          fetchImpl: async () => streamResponse([completed([])]),
        }),
      "empty",
    );
  });

  it("does not infer completed search from an answer when the tool is still pending or failed", async function () {
    await failure(
      () =>
        native.stream(config, {
          messages: question,
          fetchImpl: async () =>
            streamResponse([
              {
                type: "response.web_search_call.in_progress",
                item_id: "search-1",
                output_index: 0,
              },
              completed([answer()]),
            ]),
        }),
      "incomplete",
    );
    await failure(
      () =>
        native.stream(config, {
          messages: question,
          fetchImpl: async () =>
            streamResponse([
              { type: "response.web_search_call.failed", item_id: "search-1" },
            ]),
        }),
      "provider",
    );
  });

  it("returns final-only text and closes the reader without waiting for EOF", async function () {
    let cancelled = false;
    const result = await native.stream(config, {
      messages: question,
      timeoutMs: 100,
      fetchImpl: async () =>
        streamResponse([completed()], {
          hangAfter: true,
          onCancel: () => {
            cancelled = true;
          },
        }),
    });
    assert.equal(result.text, "Answer");
    assert.isTrue(cancelled);
  });

  it("cancels before dispatch and while a reader is stalled", async function () {
    const before = new AbortController();
    before.abort();
    let fetched = false;
    const early = await failure(
      () =>
        native.stream(config, {
          messages: question,
          signal: before.signal,
          fetchImpl: async () => {
            fetched = true;
            return streamResponse([completed()]);
          },
        }),
      "cancelled",
    );
    assert.equal(early.name, "AbortError");
    assert.isFalse(fetched);
    const during = new AbortController();
    let cancelled = false;
    const pending = native.stream(config, {
      messages: question,
      signal: during.signal,
      fetchImpl: async () => ({
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: async () => {
              cancelled = true;
            },
            releaseLock: () => {},
          }),
        },
      }),
    });
    setTimeout(() => during.abort(), 10);
    await failure(() => pending, "cancelled");
    assert.isTrue(cancelled);
  });

  it("times out even if a transport ignores abort, and does not expose its request", async function () {
    let signal: AbortSignal | undefined;
    await failure(
      () =>
        native.stream(config, {
          messages: question,
          timeoutMs: 10,
          fetchImpl: (_url: string, options: any) => {
            signal = options.signal;
            return new Promise(() => {});
          },
        }),
      "timeout",
    );
    assert.isTrue(signal!.aborted);
  });

  it("translates native errors through the selected interface language", async function () {
    const english = load("en-US");
    const failed = await failure(
      () =>
        english.test(config, {
          fetchImpl: async () => streamResponse([completed()]),
        }),
      "not-searched",
    );
    assert.include(failed.message, "did not confirm");
    assert.notMatch(failed.message, /[\u3400-\u9fff]/);
  });
});
