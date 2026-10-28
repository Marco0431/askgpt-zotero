import { assert } from "chai";

describe("AskGPT bundled rendering in Gecko", function () {
  let render: any;

  before(function () {
    // Use the packaged files, including their UMD wrappers, in a fresh scope.
    // No ready flags or renderer functions are mocked in this suite.
    const scope: any = { document, navigator, atob, btoa };
    scope.window = scope;
    scope.self = scope;
    scope.globalThis = scope;
    for (const path of [
      "vendor/markdown-it.min.js",
      "vendor/katex/katex.min.js",
      "scripts/mathrender.js",
    ]) {
      Services.scriptloader.loadSubScript(
        "chrome://askgpt/content/" + path,
        scope,
      );
    }
    render = scope.AskGPTRender;
    assert.isTrue(
      render?.ready.markdown,
      "Bundled markdown-it must initialize",
    );
    assert.isTrue(render?.ready.katex, "Bundled KaTeX must initialize");
  });

  it("loads packaged vendors and imports their output into a native XHTML document", function () {
    const output = render.renderMarkdown("**Ready** $x^2$");
    const html = new DOMParser().parseFromString(output, "text/html");
    const xhtml = new DOMParser().parseFromString(
      '<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>',
      "application/xhtml+xml",
    );
    for (const child of Array.from(html.body.childNodes))
      xhtml.documentElement.lastElementChild!.appendChild(
        xhtml.importNode(child, true),
      );
    assert.equal(xhtml.querySelector("strong")?.textContent, "Ready");
    assert.equal(xhtml.querySelectorAll(".katex").length, 1);
    assert.equal(xhtml.querySelectorAll(".katex-error, parsererror").length, 0);
  });
});
