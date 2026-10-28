import { assert } from "chai";

describe("AskGPT real renderer integration", function () {
  this.timeout(8000);
  let source: string;

  before(async function () {
    source = await Zotero.File.getResourceAsync(
      "chrome://askgpt/content/popup.xhtml",
    );
  });

  async function until(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 2000;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.isTrue(predicate(), message);
  }

  function panel() {
    const doc = new DOMParser().parseFromString(
      source,
      "application/xhtml+xml",
    );
    assert.isNull(doc.querySelector("parsererror"));
    const prefs = new Map<string, unknown>([
      ["baseURL", "https://renderer.example.test/v1"],
      ["apiKey", ""],
      ["model", "render-test"],
      ["nativeSearch", false],
      ["systemPrompt", "Use the supplied paper."],
    ]);
    const logs: unknown[] = [];
    const host = {
      locale: "en-US",
      Prefs: {
        get: (name: string) =>
          prefs.get(name.replace("extensions.askgpt.", "")),
        set: (name: string, value: unknown) =>
          prefs.set(name.replace("extensions.askgpt.", ""), value),
      },
      AskGPT: { data: { sessions: {} } },
      logError: (error: unknown) => logs.push(error),
    };
    const frameHost = { Zotero: host, innerWidth: 1200, innerHeight: 900 };
    const win: any = {
      navigator: { language: "en-US" },
      document: doc,
      innerWidth: 900,
      innerHeight: 520,
      frameElement: {
        ownerGlobal: frameHost,
        ownerDocument: { defaultView: frameHost },
        style: {},
        getBoundingClientRect: () => ({ width: 900, height: 520 }),
      },
      addEventListener: () => {},
    };
    let transport: (url: string, options: any) => Promise<any> = async () => {
      throw new Error("No network transport is allowed in renderer tests");
    };
    win.fetch = (url: string, options: any) => transport(url, options);
    const scope = {
      window: win,
      self: win,
      globalThis: win,
      document: doc,
      navigator: win.navigator,
      URL,
      AbortController,
      FileReader,
      TextDecoder,
      DOMParser,
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
      fetch: win.fetch,
    };
    const load = (path: string) =>
      Services.scriptloader.loadSubScript(
        "chrome://askgpt/content/" + path,
        scope,
      );
    load("vendor/katex/katex.min.js");
    load("vendor/markdown-it.min.js");
    assert.isFunction(win.markdownit);
    assert.isFunction(win.katex.renderToString);
    const stats = { katexCalls: 0, markdownInputs: [] as string[] };
    const katex = win.katex.renderToString.bind(win.katex);
    win.katex.renderToString = (...args: any[]) => {
      stats.katexCalls++;
      return katex(...args);
    };
    load("scripts/mathrender.js");
    const markdown = win.AskGPTRender.renderMarkdown;
    win.AskGPTRender.renderMarkdown = (text: string) => {
      stats.markdownInputs.push(text);
      return markdown(text);
    };
    for (const path of ["prompts", "i18n", "client", "native-search", "popup"])
      load(`scripts/${path}.js`);
    const ready = doc.createEvent("Event");
    ready.initEvent("DOMContentLoaded", true, true);
    doc.dispatchEvent(ready);
    const restore = (text: string, citations: any[] = []) =>
      win.AskGPTPopup.refresh({
        contextText: "An isolated paper fixture.",
        session: {
          key: "render-paper",
          history: [{ role: "assistant", content: text, citations }],
        },
      });
    const bubble = () =>
      doc.querySelector<HTMLElement>(".msg.assistant .bubble")!;
    return {
      doc,
      win,
      stats,
      logs,
      restore,
      bubble,
      setTransport: (next: typeof transport) => {
        transport = next;
      },
    };
  }

  function assertClean(root: Element) {
    assert.isNull(root.querySelector(".katex-error"));
    assert.notMatch(
      root.textContent || "",
      /@@AG(?:MATH|CODE)\d+@@|⟦ASKGPT-CITE-\d+⟧/,
    );
  }

  it("renders real Markdown and complex formulas inside the actual XHTML chat", function () {
    const ui = panel();
    ui.restore(String.raw`## Model details

**State equation:** \(x_{k+1}=Ax_k+Bu_k\), with legacy $x_k$ syntax supported.

\[
\begin{bmatrix}x_{k+1}\\v_{k+1}\end{bmatrix}
=\begin{bmatrix}I&\Delta t I\\0&I\end{bmatrix}
\begin{bmatrix}x_k\\v_k\end{bmatrix}
\]

$$
\begin{aligned}J&=\sum_{k=0}^{N-1}\left(x_k^\top Qx_k+u_k^\top Ru_k\right)\\
&\quad+x_N^\top Px_N\end{aligned}
$$

| Quantity | Formula |
| --- | --- |
| Energy | \(E=\frac{1}{2}mv^2\) |

- First observation
- Second observation
`);
    const root = ui.bubble();
    assert.isNotNull(root.querySelector("h2"));
    assert.isNotNull(root.querySelector("strong"));
    assert.equal(root.querySelectorAll("li").length, 2);
    assert.equal(root.querySelectorAll("table .katex").length, 1);
    assert.isAtLeast(root.querySelectorAll(".katex").length, 5);
    assert.equal(root.querySelectorAll(".katex-display").length, 2);
    assertClean(root);
    assert.lengthOf(ui.logs, 0);
  });

  it("keeps citation offsets out of formulas while retaining all source links", function () {
    const ui = panel();
    const text = String.raw`The state is \(x_{k+1}=Ax_k+Bu_k\).

$$
J=\sum_{k=0}^{N}x_k^\top Qx_k

+u_k^\top Ru_k
$$

A separate plain-text claim.`;
    ui.restore(text, [
      {
        url: "https://example.test/inline",
        title: "Inline formula",
        startIndex: text.indexOf("k+1"),
        endIndex: text.indexOf("k+1") + 2,
      },
      {
        url: "https://example.test/display",
        title: "Display formula",
        startIndex: text.indexOf("u_k"),
        endIndex: text.indexOf("u_k") + 2,
      },
      {
        url: "https://example.test/claim",
        title: "Claim",
        startIndex: text.indexOf("A separate"),
        endIndex: text.length,
      },
    ]);
    assertClean(ui.bubble());
    assert.isAtLeast(ui.bubble().querySelectorAll(".katex").length, 2);
    assert.equal(ui.bubble().querySelectorAll(".katex a").length, 0);
    assert.equal(ui.doc.querySelectorAll(".answer-sources a").length, 3);
    assert.equal(ui.bubble().querySelectorAll(".citation-link").length, 1);
  });

  it("preserves math-looking code and citation offsets inside fenced and inline code", function () {
    const ui = panel();
    const code = String.raw`value = "$x_{k+1}$"
literal = "\\(z^2\\)"`;
    const text =
      "~~~python\n" +
      code +
      "\n~~~\n\nUse ``$a_b$ and `backticks` `` literally.\n\n    indented = '$z_i$'";
    ui.restore(text, [
      {
        url: "https://example.test/code",
        title: "Code reference",
        startIndex: text.indexOf("$x"),
        endIndex: text.indexOf("k+1") + 1,
      },
    ]);
    const root = ui.bubble();
    assert.equal(root.querySelector("pre code")!.textContent?.trimEnd(), code);
    assert.equal(
      root.querySelectorAll("pre .katex, code .katex, code a").length,
      0,
    );
    assert.include(root.textContent || "", "$a_b$");
    assert.include(root.textContent || "", "$z_i$");
    assert.equal(ui.doc.querySelectorAll(".answer-sources a").length, 1);
    assertClean(root);
  });

  it("does not recursively re-enhance scripts or change KaTeX and code nodes", function () {
    const ui = panel();
    ui.restore(
      String.raw`Bare fallback: x^{k^2}. Rendered: \(x_{k+1}^2\). Code: ` +
        "`x^{k^2}`",
    );
    const root = ui.bubble();
    const original = root.innerHTML;
    ui.win.AskGPTRender.enhanceScripts(root);
    ui.win.AskGPTRender.enhanceScripts(root);
    assert.equal(root.innerHTML, original);
    assert.equal(root.querySelectorAll("code sup, code sub").length, 0);
    assertClean(root);
  });

  it("replaces incomplete streamed TeX with the final formula using the real renderer", async function () {
    const ui = panel();
    ui.win.AskGPTPopup.refresh({
      contextText: "A test paper.",
      session: { key: "render-paper", history: [] },
    });
    const first = String.raw`The result is \(\frac{`;
    const rest = String.raw`a+b}{c}\).`;
    const chunk = (content: string) => ({
      done: false,
      value: new TextEncoder().encode(
        "data: " +
          JSON.stringify({ choices: [{ delta: { content } }] }) +
          "\n\n",
      ),
    });
    let reads = 0;
    let release: (value: any) => void = () => {};
    ui.setTransport(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) return chunk(first);
            if (reads === 2)
              return new Promise((resolve) => {
                release = resolve;
              });
            return {
              done: false,
              value: new TextEncoder().encode("data: [DONE]\n\n"),
            };
          },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    }));
    const sending = ui.win.AskGPTPopup.send("Show the derivation.");
    await until(
      () => !!ui.bubble()?.textContent?.includes("The result is"),
      "The first streamed fragment should be visible",
    );
    assert.isNull(ui.bubble().querySelector(".katex-error"));
    release(chunk(rest));
    await sending;
    assert.equal(ui.bubble().querySelectorAll(".katex").length, 1);
    assertClean(ui.bubble());
    assert.lengthOf(ui.logs, 0);
  });

  it("uses the real renderer once per restored long answer and reuses repeated formulas", function () {
    const ui = panel();
    const text = String.raw`A long research explanation. \(E=mc^2\) and \(x_{k+1}=Ax_k+Bu_k\).

| Model | Score |
| --- | --- |
| Example | \(\frac{a+b}{c}\) |`;
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: "assistant",
      content: `${index}: ${text}`,
    }));
    ui.win.AskGPTPopup.refresh({
      contextText: "Paper.",
      session: { key: "render-paper", history },
    });
    assert.equal(ui.doc.querySelectorAll(".msg.assistant").length, 20);
    assert.equal(ui.doc.querySelectorAll(".katex").length, 60);
    assert.equal(
      ui.stats.markdownInputs.filter((value) => value.includes("long research"))
        .length,
      20,
    );
    assert.isAtMost(
      ui.stats.katexCalls,
      3,
      "Repeated formulas should reuse bounded renderer cache entries",
    );
    assertClean(ui.doc.documentElement);
  });

  it("preserves escaped source safely when the renderer is missing or throws", function () {
    const text =
      '[source](https://example.test/a_b?x="q")\n' +
      '<img src=x onerror="bad()">\n' +
      String.raw`\(x_{k+1}^2\) @@CB0@@ and **plain source**`;
    for (const missing of [true, false]) {
      const ui = panel();
      ui.win.AskGPTRender = missing
        ? undefined
        : {
            renderMarkdown() {
              throw new Error("Simulated renderer failure");
            },
          };
      ui.restore(text);
      assert.equal(ui.bubble().querySelector("pre.md-code")?.textContent, text);
      assert.equal(
        ui.bubble().querySelectorAll("a,img,sup,sub,script").length,
        0,
      );
    }
  });
});
