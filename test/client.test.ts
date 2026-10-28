import { assert } from "chai";

describe("AskGPT connection and image helpers", function () {
  let client: any;
  const config = {
    baseURL: "https://example.test/v1",
    apiKey: "sk-test-secret",
    model: "example-model",
  };
  const response = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  async function fails(action: () => unknown, expected: string) {
    try {
      await action();
    } catch (error: any) {
      assert.include(error.message, expected);
      return error;
    }
    assert.fail("Expected the operation to fail");
  }

  before(function () {
    const scope: any = {
      window: {},
      URL,
      AbortController,
      FileReader,
      atob: (value: string) => window.atob(value),
      setTimeout: (callback: () => void, delay?: number) =>
        window.setTimeout(callback, delay),
      clearTimeout: (id: number) => window.clearTimeout(id),
    };
    Services.scriptloader.loadSubScript(
      "chrome://askgpt/content/scripts/client.js",
      scope,
    );
    client = scope.window.AskGPTClient;
  });

  it("uses the selected interface language without weakening error redaction", async function () {
    const scope: any = {
      window: { Zotero: { locale: "en-US", Prefs: { get: () => "auto" } } },
      URL,
      AbortController,
      FileReader,
      atob: (value: string) => window.atob(value),
      setTimeout: (callback: () => void, delay?: number) =>
        window.setTimeout(callback, delay),
      clearTimeout: (id: number) => window.clearTimeout(id),
    };
    for (const name of ["i18n", "client"]) {
      Services.scriptloader.loadSubScript(
        `chrome://askgpt/content/scripts/${name}.js`,
        scope,
      );
    }
    const translated = scope.window.AskGPTClient;
    assert.throws(() => translated.buildEndpoint(""), "Enter an API address");
    await fails(
      () =>
        translated.fetchModels(config, {
          fetchImpl: async () => response({}, 401),
        }),
      "Authentication failed",
    );
    assert.throws(
      () => translated.validateImageBatch(Array(5).fill({})),
      "up to 4 images",
    );
    const redacted = translated.safeErrorMessage(
      new Error("Bearer " + config.apiKey),
      config.apiKey,
    );
    assert.notInclude(redacted, config.apiKey);
    assert.notMatch(redacted, /[\u3400-\u9fff]/);
    scope.window.AskGPTI18n.setLanguage("zh-CN");
    assert.throws(() => translated.buildEndpoint(""), "请先填写接口地址");
  });

  it("normalizes root, versioned, custom, and full endpoints consistently", function () {
    for (const [input, expected] of [
      ["api.deepseek.com/", "https://api.deepseek.com/v1"],
      ["https://example.test/v1/", "https://example.test/v1"],
      ["https://example.test/proxy/v2", "https://example.test/proxy/v2"],
      [
        "http://localhost:11434/v1/chat/completions",
        "http://localhost:11434/v1",
      ],
      ["https://example.test/v1/models", "https://example.test/v1"],
      ["https://example.test/chat/completions", "https://example.test"],
      ["\n https://example.test/v1\u200b \n", "https://example.test/v1"],
    ]) {
      assert.equal(client.buildEndpoint(input), expected + "/chat/completions");
      assert.equal(client.buildEndpoint(input, "models"), expected + "/models");
    }
  });

  it("rejects unsafe or ambiguous addresses", function () {
    for (const address of [
      "file:///tmp/test",
      "javascript:alert(1)",
      "https://user:password@example.test",
      "https://example.test/v1?api_key=secret",
      "https://example.test/v1#secret",
      "",
    ]) {
      assert.throws(() => client.buildEndpoint(address));
    }
  });

  it("fetches models with cleaned authentication and no redirects", async function () {
    let sent: any;
    const models = await client.fetchModels(
      { ...config, apiKey: "\n sk-test-secret\u200b " },
      {
        fetchImpl: async (url: string, options: any) => {
          sent = { url, ...options };
          return response({
            data: [
              { id: "z-model" },
              { id: "a-model", input_modalities: ["text", "image", "image"] },
              { id: "a-model" },
              { id: "" },
              { unrelated: true },
            ],
          });
        },
      },
    );
    assert.equal(sent.url, "https://example.test/v1/models");
    assert.equal(sent.method, "GET");
    assert.equal(sent.redirect, "error");
    assert.equal(sent.headers.Authorization, "Bearer sk-test-secret");
    assert.isUndefined(sent.body);
    assert.deepEqual(JSON.parse(JSON.stringify(models)), [
      { id: "a-model", inputModalities: ["text", "image"] },
      { id: "z-model" },
    ]);
  });

  it("omits authorization for a local service without a key", async function () {
    await client.fetchModels(
      { baseURL: "http://localhost:11434/v1", apiKey: "" },
      {
        fetchImpl: async (_url: string, options: any) => {
          assert.notProperty(options.headers, "Authorization");
          return response({ data: [{ id: "local-model" }] });
        },
      },
    );
  });

  it("explains incompatible or empty model lists", async function () {
    for (const body of [{ data: [] }, { models: [] }, { data: [null] }]) {
      await fails(
        () =>
          client.fetchModels(config, { fetchImpl: async () => response(body) }),
        "手动填写模型名称",
      );
    }
  });

  it("tests the selected model without paper context and accepts a normal reply", async function () {
    const result = await client.testConnection(config, {
      fetchImpl: async (url: string, options: any) => {
        assert.equal(url, "https://example.test/v1/chat/completions");
        assert.equal(options.redirect, "error");
        const body = JSON.parse(options.body);
        assert.deepEqual(body, {
          model: "example-model",
          messages: [{ role: "user", content: "Reply with OK." }],
          stream: false,
          max_tokens: 32,
        });
        return response({
          choices: [{ message: { role: "assistant", content: "Connected!" } }],
        });
      },
    });
    assert.equal(result.model, "example-model");
    assert.isAtLeast(result.elapsedMs, 0);
  });

  it("retries only the explicitly unsupported max_tokens parameter once", async function () {
    const bodies: any[] = [];
    await client.testConnection(config, {
      fetchImpl: async (_url: string, options: any) => {
        bodies.push(JSON.parse(options.body));
        if (bodies.length === 1) {
          return response(
            { error: { param: "max_tokens", code: "unsupported_parameter" } },
            400,
          );
        }
        return response({
          choices: [{ message: { role: "assistant", content: "OK" } }],
        });
      },
    });
    assert.lengthOf(bodies, 2);
    assert.notProperty(bodies[1], "max_tokens");
    assert.equal(bodies[1].max_completion_tokens, 32);
  });

  it("does not retry an authentication error or expose the provider's echoed key", async function () {
    let count = 0;
    const error = await fails(
      () =>
        client.testConnection(config, {
          fetchImpl: async () => {
            count++;
            return response(
              { error: { message: "invalid key sk-test-secret" } },
              401,
            );
          },
        }),
      "认证失败",
    );
    assert.equal(count, 1);
    assert.notInclude(error.message, config.apiKey);
  });

  it("rejects a successful HTTP response without an assistant reply", async function () {
    for (const body of [
      {},
      { choices: [] },
      { choices: [{ message: { role: "assistant", content: "" } }] },
      { choices: [{ message: { role: "user", content: "OK" } }] },
    ]) {
      await fails(
        () =>
          client.testConnection(config, {
            fetchImpl: async () => response(body),
          }),
        "没有返回文本",
      );
    }
  });

  it("reports non-JSON responses and network failures without leaked credentials", async function () {
    await fails(
      () =>
        client.fetchModels(config, {
          fetchImpl: async () => ({
            ok: true,
            json: async () => {
              throw new Error("sk-test-secret");
            },
          }),
        }),
      "有效的 JSON",
    );
    const error = await fails(
      () =>
        client.fetchModels(config, {
          fetchImpl: async () => {
            throw new Error("network failed sk-test-secret");
          },
        }),
      "无法连接接口",
    );
    assert.notInclude(error.message, config.apiKey);
  });

  it("times out even if a transport never settles", async function () {
    let signal: AbortSignal | undefined;
    await fails(
      () =>
        client.fetchModels(config, {
          timeoutMs: 20,
          fetchImpl: async (_url: string, options: any) => {
            signal = options.signal;
            return new Promise(() => {});
          },
        }),
      "请求超时",
    );
    assert.isTrue(signal!.aborted);
  });

  it("honors cancellation before starting a request", async function () {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await fails(
      () =>
        client.fetchModels(config, {
          signal: controller.signal,
          fetchImpl: async () => {
            called = true;
            return response({});
          },
        }),
      "请求已取消",
    );
    assert.isFalse(called);
  });

  it("redacts API keys and image data from displayed errors", function () {
    const text = client.safeErrorMessage(
      new Error(
        "bad key sk-test-secret; Authorization: Bearer hidden-secret; data:image/png;base64,AAAA",
      ),
      config.apiKey,
    );
    assert.notInclude(text, config.apiKey);
    assert.notInclude(text, "hidden-secret");
    assert.notInclude(text, "AAAA");
  });

  it("enforces per-file, count, total-size, and type limits", function () {
    const small = { size: 1024, type: "image/png" };
    assert.isTrue(client.validateImageBatch([small]));
    assert.throws(
      () => client.validateImageBatch([small], [small, small, small, small]),
      "最多添加 4",
    );
    assert.throws(
      () =>
        client.validateImageBatch([{ ...small, size: 8 * 1024 * 1024 + 1 }]),
      "8 MB",
    );
    assert.throws(
      () =>
        client.validateImageBatch(
          Array(3).fill({ ...small, size: 7 * 1024 * 1024 }),
        ),
      "20 MB",
    );
    assert.throws(
      () => client.validateImageBatch([{ ...small, size: 0 }]),
      "为空",
    );
    assert.throws(
      () => client.validateImageBatch([{ ...small, type: "image/svg+xml" }]),
      "只支持",
    );
  });

  it("reads image bytes as a data URL and rejects a spoofed MIME type", async function () {
    const png = new File(
      [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
      "sample.png",
      { type: "image/png" },
    );
    const image = await client.readImage(png);
    assert.equal(image.name, "sample.png");
    assert.equal(image.type, "image/png");
    assert.equal(image.size, png.size);
    assert.match(image.url, /^data:image\/png;base64,iVBORw0KGgo/);
    await fails(
      () =>
        client.readImage(
          new File(["<svg/>"], "fake.png", { type: "image/png" }),
        ),
      "内容与格式不符",
    );
    await fails(
      () =>
        client.readImage(new File([png], "wrong.jpg", { type: "image/jpeg" })),
      "内容与格式不符",
    );
  });
});
