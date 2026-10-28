import { assert } from "chai";

describe("AskGPT Markdown and mathematical rendering", function () {
  this.timeout(10000);
  let scope: any;
  let render: any;
  let calls: { count: number; options: any[] };

  function fixtureError(stage: string, error: any) {
    const details = [error?.name, error?.message, error?.stack]
      .filter(Boolean)
      .join("\n");
    assert.fail(`Renderer fixture ${stage}: ${details || String(error)}`);
  }
  function load(path: string) {
    try {
      Services.scriptloader.loadSubScript(
        "chrome://askgpt/content/" + path,
        scope,
      );
    } catch (error) {
      fixtureError(`loading ${path}`, error);
    }
  }
  function fresh(vendors = true) {
    try {
      const host =
        typeof Zotero.getMainWindow === "function"
          ? Zotero.getMainWindow()
          : window;
      // Keep the native function's Window receiver; do not copy an unbound atob.
      scope = { atob: (value: string) => host.atob(value) };
      scope.window = scope;
      scope.self = scope;
      scope.globalThis = scope;
      if (vendors) {
        load("vendor/markdown-it.min.js");
        load("vendor/katex/katex.min.js");
      }
      load("scripts/mathrender.js");
      render = scope.AskGPTRender;
      assert.isFunction(
        render?.renderMarkdown,
        "mathrender.js must initialize",
      );
      calls = { count: 0, options: [] };
      if (vendors) {
        const original = scope.katex.renderToString;
        scope.katex.renderToString = (tex: string, options: any) => {
          calls.count++;
          calls.options.push(options);
          return original.call(scope.katex, tex, options);
        };
      }
    } catch (error) {
      fixtureError("initialization", error);
    }
  }
  function mathCount(html: string) {
    return (html.match(/class="katex"/g) || []).length;
  }
  function formulas(start: number, count: number) {
    return Array.from(
      { length: count },
      (_, index) => `$x_{${start + index}}$`,
    ).join(" ");
  }

  beforeEach(function () {
    return fresh();
  });

  it("renders all four supported delimiters with the bundled KaTeX", function () {
    const html = render.renderMarkdown(
      String.raw`$x^2$ \(y_1\) \[z=2\] $$w=3$$`,
    );
    assert.equal(mathCount(html), 4);
    assert.equal(calls.count, 4);
    assert.notInclude(html, "katex-error");
    assert.equal(
      calls.options.filter((options) => options.displayMode).length,
      2,
    );
    for (const options of calls.options) {
      assert.isFalse(options.trust);
      assert.equal(options.maxExpand, 1000);
      assert.isAtMost(options.maxSize, 20);
    }
  });

  it("leaves old placeholder-shaped text literal", function () {
    const html = render.renderMarkdown("@@AGMATH0@@ @@AGMATH1@@ $x$");
    assert.include(html, "@@AGMATH0@@ @@AGMATH1@@");
    assert.equal(mathCount(html), 1);
  });

  it("protects inline, tilde, longer backtick, and indented code", function () {
    const samples = [
      "`$x$` and `` ` \\(y\\) ``",
      "~~~tex\n$x$\n~~~",
      "````text\n```\n$x$\n```\n````",
      "    $x$\n    # keep the heading literal",
      "- example\n\n      $x$",
    ];
    for (const input of samples) {
      const html = render.renderMarkdown(input);
      assert.include(html, "<code");
      assert.equal(mathCount(html), 0, input);
      assert.notInclude(html, "<h1>");
    }
    assert.equal(calls.count, 0);
  });

  it("preserves link destinations, titles, and image source and alt text", function () {
    const html = render.renderMarkdown(
      '[link](https://example.org/$x$ "$y$") ![figure $z$](https://example.org/$w$.png "$v$")',
    );
    assert.include(html, 'href="https://example.org/$x$" title="$y$"');
    assert.include(
      html,
      'src="https://example.org/$w$.png" alt="figure $z$" title="$v$"',
    );
    assert.equal(mathCount(html), 0);
    assert.equal(calls.count, 0);
    assert.equal(
      mathCount(render.renderMarkdown("[$x$](https://example.org)")),
      1,
    );
  });

  it("keeps display math inside standard blockquotes and lists", function () {
    const html = render.renderMarkdown(
      "> $$\n> x^2\n> $$\n\n- \\[\n  y_1\n  \\]\n\n  continuation\n- next",
    );
    assert.match(html, /<blockquote>\s*<span class="ag-math-block">/);
    assert.match(html, /<li>\s*<span class="ag-math-block">/);
    assert.include(html, "continuation");
    assert.match(html, /<li>\s*<p>next<\/p>\s*<\/li>/);
    assert.equal(mathCount(html), 2);
    assert.notInclude(html, "ag-math-source");
  });

  it("retains standard headings, emphasis, tables, and list nesting", function () {
    const html = render.renderMarkdown(
      "# Heading\n\n1. **First** $x$\n   - nested $y$\n\n| A | B |\n|---|---|\n| $z$ | `a_b` |\n\ntext# stays text",
    );
    assert.include(html, "<h1>Heading</h1>");
    assert.include(html, "<ol>");
    assert.include(html, "<ul>");
    assert.include(html, "<strong>First</strong>");
    assert.include(html, "<table>");
    assert.include(html, "text# stays text");
    assert.equal(mathCount(html), 3);
  });

  it("does not mistake escaped dollars or typical prices for equations", function () {
    const html = render.renderMarkdown(
      String.raw`Cost $5 and $10. Escaped \$12. Formula $x+\$1$.`,
    );
    assert.include(html, "Cost $5 and $10. Escaped $12.");
    assert.equal(mathCount(html), 1);
  });

  it("preserves incomplete streaming formulas until they close", function () {
    for (const [partial, full] of [
      [String.raw`\(x^{2}`, String.raw`\(x^{2}\)`],
      [String.raw`\[x^{2}`, String.raw`\[x^{2}\]`],
      ["$$x^{2}", "$$x^{2}$$"],
      ["$x^{2}", "$x^{2}$"],
    ]) {
      assert.include(render.renderMarkdown(partial), partial);
      assert.equal(mathCount(render.renderMarkdown(full)), 1);
    }
  });

  it("retains illegal formulas as source, including original delimiters", function () {
    const tex = String.raw`\notacommand{x}`;
    assert.include(render.renderMarkdown("$" + tex + "$"), "$" + tex + "$");
    const firstCalls = calls.count;
    assert.include(
      render.renderMarkdown("\\(" + tex + "\\)"),
      "\\(" + tex + "\\)",
    );
    assert.equal(calls.count, firstCalls, "Invalid TeX is cached too");
    const recursive = render.renderMarkdown(String.raw`$\def\a{\a}\a$`);
    assert.include(recursive, String.raw`$\def\a{\a}\a$`);
    assert.include(recursive, "ag-math-source");
  });

  it("escapes HTML and rejects active HTML, unsafe links, and trusted TeX commands", function () {
    const html = render.renderMarkdown(
      String.raw`<script>alert(1)</script> [bad](javascript:alert(1)) $\href{javascript:alert(1)}{click}$ $\htmlClass{owned}{x}$ $\includegraphics{https://example.org/x.png}$`,
    );
    assert.include(html, "&lt;script&gt;");
    assert.notMatch(html, /<script\b|href="javascript:|class="owned"|<img\b/);
  });

  it("calculates 100 distinct formulas once and only calculates additions on subsequent stream updates", function () {
    const text = formulas(0, 100);
    assert.equal(mathCount(render.renderMarkdown(text)), 100);
    assert.equal(calls.count, 100);
    for (let count = 1; count <= 8; count++) {
      assert.equal(
        mathCount(render.renderMarkdown(text + " " + formulas(100, count))),
        100 + count,
      );
      assert.equal(calls.count, 100 + count);
    }
  });

  it("uses different cache entries for display and inline rendering", function () {
    render.renderMarkdown("$x$");
    render.renderMarkdown("$$x$$");
    render.renderMarkdown("\\(x\\)");
    render.renderMarkdown("\\[x\\]");
    assert.equal(calls.count, 2);
  });

  it("limits new KaTeX calls before invoking it and preserves the remaining formulas and prose", function () {
    const html = render.renderMarkdown(formulas(0, 605) + " FINAL BODY");
    assert.equal(calls.count, 128);
    assert.equal(mathCount(html), 128);
    assert.include(html, "$x_{604}$");
    assert.include(html, "FINAL BODY");
  });

  it("limits rendered occurrences even when every formula hits the cache", function () {
    const html = render.renderMarkdown(
      Array(605).fill("$x$").join(" ") + " tail",
    );
    assert.equal(calls.count, 1);
    assert.equal(mathCount(html), 600);
    assert.equal((html.match(/ag-math-source/g) || []).length, 5);
    assert.include(html, "$x$");
    assert.include(html, "tail");
  });

  it("does not submit oversized formulas to KaTeX or lose their source", function () {
    const source = "$" + "x".repeat(8193) + "$";
    const html = render.renderMarkdown(source + " following paragraph");
    assert.equal(calls.count, 0);
    assert.include(html, source);
    assert.include(html, "following paragraph");
  });

  it("bounds cumulative input work before making additional KaTeX calls", function () {
    let invoked = 0;
    scope.katex.renderToString = () => {
      invoked++;
      return "<span>math</span>";
    };
    const source = Array.from(
      { length: 5 },
      (_, index) => "$" + index + "x".repeat(7999) + "$",
    ).join(" ");
    const html = render.renderMarkdown(source);
    assert.equal(invoked, 4);
    assert.include(html, "$4" + "x".repeat(7999) + "$");
  });

  it("retains at most 600 distinct cached formulas", function () {
    for (let batch = 0; batch < 6; batch++)
      render.renderMarkdown(formulas(batch * 100, 100));
    assert.equal(calls.count, 600);
    render.renderMarkdown("$x_{0}$");
    assert.equal(calls.count, 600, "The first of 600 entries still fits");
    render.renderMarkdown("$x_{600}$");
    render.renderMarkdown("$x_{1}$");
    assert.equal(calls.count, 602, "The least-recently-used entry was evicted");
  });

  it("also bounds cache bytes, oversized cache entries, and per-render HTML", function () {
    let invoked = 0;
    scope.katex.renderToString = () => {
      invoked++;
      return "<span>" + "x".repeat(110000) + "</span>";
    };
    for (let index = 0; index < 19; index++)
      render.renderMarkdown(`$x_{${index}}$`);
    render.renderMarkdown("$x_{0}$");
    assert.equal(
      invoked,
      20,
      "Aggregate HTML evicts entries before the entry limit",
    );
    const html = render.renderMarkdown(
      Array(20).fill("$x_{0}$").join(" ") + " tail",
    );
    assert.isBelow(html.length, 1505000);
    assert.include(html, "ag-math-source");
    assert.include(html, "tail");
    invoked = 0;
    scope.katex.renderToString = () => {
      invoked++;
      return "x".repeat(130000);
    };
    render.renderMarkdown("$x$");
    render.renderMarkdown("$x$");
    assert.equal(invoked, 2, "Oversized individual outputs are not cached");
  });

  it("keeps a large unfinished display stream as source without invoking KaTeX", function () {
    const source = "\\[\nword\n".repeat(4000);
    const html = render.renderMarkdown(source);
    assert.equal(calls.count, 0);
    assert.equal((html.match(/word/g) || []).length, 4000);
    assert.equal((html.match(/\\\[/g) || []).length, 4000);
    assert.notInclude(html, "katex");
  });

  it("recovers when vendors arrive late and invalidates cached HTML when KaTeX is replaced", function () {
    fresh(false);
    assert.include(render.renderMarkdown("<tag> $x$"), "&lt;tag&gt; $x$");
    load("vendor/markdown-it.min.js");
    assert.include(render.renderMarkdown("$x$"), "$x$");
    load("vendor/katex/katex.min.js");
    assert.equal(mathCount(render.renderMarkdown("$x$")), 1);
    scope.katex.renderToString = () => "<span>replacement</span>";
    assert.include(render.renderMarkdown("$x$"), "replacement");
  });

  it("keeps Markdown syntax literal in the math-only preview and protects its code", function () {
    const html = render.renderPlainWithMath(
      "# Heading\n**bold** `$x$` $y$\n~~~\n$z$\n~~~",
    );
    assert.include(html, "# Heading");
    assert.include(html, "**bold** `$x$`");
    assert.include(html, "~~~");
    assert.include(html, "$z$");
    assert.equal(mathCount(html), 1);
    assert.notMatch(html, /<h1>|<strong>/);
  });
});
