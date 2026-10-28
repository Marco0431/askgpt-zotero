/* eslint-disable mocha/no-exports, mocha/consistent-spacing-between-blocks -- The local harness supplies the isolated host loader to this exported registrar. */
import { assert } from "chai";

/** Register against a fresh isolated copy of the actual fulltext module per fixture. */
export function registerFulltextTests(
  loadModule: (environment: {
    Zotero: any;
    IOUtils: any;
    now: () => number;
  }) => any,
) {
  describe("AskGPT full-text source and cache isolation", function () {
    function fixture() {
      const files = new Map<string, { text: string; modified: number }>();
      const items = new Map<number, any>();
      const reads: string[] = [];
      const extractions: number[] = [];
      const logs: unknown[] = [];
      let selected: any[] = [];
      let mainReader: any = null;
      let sourceMode = "auto";
      let clock = 1000;
      let pdfResult: (id: number) => any = (id) => ({
        text: `Full PDF ${id}`,
        extractedPages: 3,
        totalPages: 3,
      });
      let fullyIndexed = false;
      const hostWindow: any = {
        Zotero_Tabs: { selectedID: "reader-tab" },
        ZoteroPane: { getSelectedItems: () => selected },
      };
      const host = {
        getMainWindow: () => hostWindow,
        getActiveZoteroPane: () => hostWindow.ZoteroPane,
        Reader: { getByTabID: () => mainReader },
        Items: { get: (id: number) => items.get(id) },
        Prefs: { get: () => sourceMode },
        File: {
          getContentsAsync: async (path: string) => {
            reads.push(path);
            if (!files.has(path)) throw new Error("missing fixture file");
            return files.get(path)!.text;
          },
        },
        Fulltext: {
          getItemCacheFile: (item: any) => ({
            path: item.getFilePath() + ".cache",
          }),
          isFullyIndexed: async () => fullyIndexed,
        },
        PDFWorker: {
          getFullText: async (id: number, pages: any) => {
            assert.isNull(pages);
            extractions.push(id);
            return pdfResult(id);
          },
        },
        logError: (error: unknown) => logs.push(error),
      };
      const io = {
        stat: async (path: string) => {
          const file = files.get(path);
          if (!file) {
            const error = new Error("missing fixture file");
            error.name = "NotFoundError";
            throw error;
          }
          return {
            type: "regular",
            lastModified: file.modified,
            size: file.text.length,
          };
        },
      };
      const module = loadModule({
        Zotero: host,
        IOUtils: io,
        now: () => clock,
      });
      function attachment(
        id: number,
        extension = "pdf",
        text = "PDF bytes",
        path = `/library/${id}.${extension}`,
      ) {
        const item: any = {
          id,
          libraryID: 1,
          title: `Attachment ${id}`,
          isAttachment: () => true,
          getFilePath: () => path,
          getField: () => item.title,
        };
        items.set(id, item);
        files.set(path, { text, modified: 100 });
        return item;
      }
      function parent(id: number, children: any[]) {
        const item: any = {
          id,
          title: `Paper ${id}`,
          isAttachment: () => false,
          getField: () => item.title,
          getAttachments: () => children.map((child) => child.id),
        };
        items.set(id, item);
        children.forEach((child) => {
          child.parentItem = item;
        });
        return item;
      }
      return {
        module,
        files,
        reads,
        extractions,
        logs,
        hostWindow,
        attachment,
        parent,
        select: (...values: any[]) => {
          selected = values;
        },
        mainReader: (item: any) => {
          mainReader = item ? { itemID: item.id } : null;
        },
        mode: (mode: string) => {
          sourceMode = mode;
        },
        indexed: (value: boolean) => {
          fullyIndexed = value;
        },
        extract: (fn: (id: number) => any) => {
          pdfResult = fn;
        },
        advance: (ms: number) => {
          clock += ms;
        },
        read: (item: any) =>
          module.readAttachmentContext({
            reader: { itemID: item.id },
            window: hostWindow,
          }),
      };
    }
    async function until(predicate: () => boolean) {
      for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
      assert.isTrue(
        predicate(),
        "The mocked operation should reach its awaited step",
      );
    }
    function deferred() {
      let resolve!: (value: any) => void;
      const promise = new Promise((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    it("calls the Zotero item-type method and reads a selected parent item's attachments", async function () {
      const f = fixture();
      const child = f.attachment(1, "markdown", "# Full document");
      const paper = f.parent(10, [child]);
      f.select(paper);
      const result = await f.module.readAttachmentContext({
        reader: null,
        window: f.hostWindow,
      });
      assert.equal(result.text, "Full document");
      assert.equal(result.title, "Paper 10");
    });

    it("never substitutes another selected paper when an explicit reader cannot be read", async function () {
      const f = fixture();
      const current = f.attachment(1);
      const unrelated = f.attachment(2, "txt", "WRONG PAPER");
      f.select(unrelated);
      f.extract(() => ({ text: "" }));
      assert.isNull(await f.read(current));
      assert.notInclude(f.reads, unrelated.getFilePath());
      assert.isNull(
        await f.module.readAttachmentContext({
          reader: { itemID: 999 },
          window: f.hostWindow,
        }),
      );
    });

    it("uses the supplied detached reader instead of the main window's active reader", async function () {
      const f = fixture();
      const background = f.attachment(1, "txt", "Background paper");
      const clicked = f.attachment(2, "txt", "Clicked paper");
      f.mainReader(background);
      const result = await f.read(clicked);
      assert.equal(result.text, "Clicked paper");
      assert.notInclude(f.reads, background.getFilePath());
    });

    it("uses only the supplied library window's first selected paper", async function () {
      const f = fixture();
      const first = f.attachment(1, "txt", "");
      const second = f.attachment(2, "txt", "Second paper");
      f.select(second);
      const window: any = {
        ZoteroPane: { getSelectedItems: () => [first, second] },
      };
      assert.isNull(
        await f.module.readAttachmentContext({ reader: null, window }),
      );
      assert.notInclude(f.reads, second.getFilePath());
    });

    it("honors auto, PDF, and translation preferences including .markdown files", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      const html = f.attachment(2, "html", "<p>HTML body</p>");
      const md = f.attachment(3, "markdown", "Markdown body");
      f.parent(10, [pdf, html, md]);
      assert.equal((await f.read(html)).path, html.getFilePath());
      f.mode("pdf");
      assert.equal((await f.read(html)).path, pdf.getFilePath());
      f.mode("translation");
      assert.equal((await f.read(html)).path, md.getFilePath());
    });

    it("coalesces concurrent PDF extraction and reuses an unchanged file afterward", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      const gate = deferred();
      f.extract(() => gate.promise);
      const pending = Array.from({ length: 8 }, () => f.read(pdf));
      await until(() => f.extractions.length > 0);
      assert.lengthOf(f.extractions, 1);
      gate.resolve({ text: "Complete text" });
      const results = await Promise.all(pending);
      assert.isTrue(
        results.every((context) => context.text === "Complete text"),
      );
      await f.read(pdf);
      assert.lengthOf(f.extractions, 1);
    });

    it("invalidates on size or modification time and refreshes titles without rereading content", async function () {
      const f = fixture();
      const text = f.attachment(1, "txt", "First");
      const paper = f.parent(10, [text]);
      const first = await f.read(text);
      first.text = "caller modification";
      paper.title = "Renamed paper";
      const cached = await f.read(text);
      assert.equal(cached.text, "First");
      assert.equal(cached.title, "Renamed paper");
      assert.lengthOf(f.reads, 1);
      f.files.set(text.getFilePath(), { text: "Larger text", modified: 100 });
      assert.equal((await f.read(text)).text, "Larger text");
      f.files.set(text.getFilePath(), { text: "Changed now", modified: 101 });
      assert.equal((await f.read(text)).text, "Changed now");
      assert.lengthOf(f.reads, 3);
    });

    it("briefly caches empty PDF results and retries after expiry or an index change", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      f.extract(() => ({ text: "" }));
      assert.isNull(await f.read(pdf));
      assert.isNull(await f.read(pdf));
      assert.lengthOf(f.extractions, 1);
      f.advance(f.module._internal.NEGATIVE_CACHE_TTL + 1);
      await f.read(pdf);
      assert.lengthOf(f.extractions, 2);
      f.files.set(pdf.getFilePath() + ".cache", {
        text: "New OCR text",
        modified: 200,
      });
      f.indexed(true);
      assert.equal((await f.read(pdf)).text, "New OCR text");
      assert.lengthOf(f.extractions, 2);
    });

    it("uses a fresh fully indexed short PDF without extracting it again", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      f.files.set(pdf.getFilePath() + ".cache", {
        text: "One short page.",
        modified: 200,
      });
      f.indexed(true);
      const result = await f.read(pdf);
      assert.equal(result.text, "One short page.");
      assert.isFalse(result.truncated);
      assert.isEmpty(f.extractions);
    });

    it("extracts a partially indexed PDF instead of treating a long index as the full paper", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      f.files.set(pdf.getFilePath() + ".cache", {
        text: "First pages. ".repeat(100),
        modified: 200,
      });
      const result = await f.read(pdf);
      assert.equal(result.text, "Full PDF 1");
      assert.isFalse(result.truncated);
      assert.lengthOf(f.extractions, 1);
    });

    it("marks a fresh partial-index fallback as truncated when full extraction fails", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      f.files.set(pdf.getFilePath() + ".cache", {
        text: "Only the first page.",
        modified: 200,
      });
      f.extract(() => {
        throw new Error("worker unavailable");
      });
      const result = await f.read(pdf);
      assert.equal(result.text, "Only the first page.");
      assert.isTrue(result.truncated);
      f.advance(f.module._internal.NEGATIVE_CACHE_TTL + 1);
      f.extract(() => ({
        text: "Recovered full text",
        extractedPages: 3,
        totalPages: 3,
      }));
      const recovered = await f.read(pdf);
      assert.equal(recovered.text, "Recovered full text");
      assert.isFalse(recovered.truncated);
    });

    it("ignores an older index even when Zotero still marks it fully indexed", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      f.files.set(pdf.getFilePath() + ".cache", {
        text: "Old revision",
        modified: 50,
      });
      f.indexed(true);
      assert.equal((await f.read(pdf)).text, "Full PDF 1");
      assert.notInclude(f.reads, pdf.getFilePath() + ".cache");
    });

    it("bounds the cache and keeps recently reused files", async function () {
      const f = fixture();
      const count = f.module._internal.MAX_CACHE_ENTRIES;
      const items = Array.from({ length: count + 1 }, (_, index) =>
        f.attachment(index + 1, "txt", `Text ${index + 1}`),
      );
      for (const item of items.slice(0, count)) await f.read(item);
      await f.read(items[0]);
      await f.read(items[count]);
      assert.equal(f.module._internal.cacheSize(), count);
      await f.read(items[0]);
      assert.equal(
        f.reads.filter((path) => path === items[0].getFilePath()).length,
        1,
      );
      await f.read(items[1]);
      assert.equal(
        f.reads.filter((path) => path === items[1].getFilePath()).length,
        2,
      );
    });

    it("does not let an in-flight read repopulate a cleared cache", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      const gate = deferred();
      f.extract(() => gate.promise);
      const pending = f.read(pdf);
      await until(() => f.extractions.length === 1);
      f.module.clearFullTextCache();
      gate.resolve({ text: "Completed old read" });
      await pending;
      assert.equal(f.module._internal.cacheSize(), 0);
      f.extract(() => ({ text: "Fresh read" }));
      assert.equal((await f.read(pdf)).text, "Fresh read");
      assert.lengthOf(f.extractions, 2);
    });

    it("retries a file changed during extraction without overwriting its newer result", async function () {
      const f = fixture();
      const pdf = f.attachment(1);
      const old = deferred();
      f.extract(() => old.promise);
      const pending = f.read(pdf);
      await until(() => f.extractions.length === 1);
      f.files.set(pdf.getFilePath(), { text: "New PDF bytes", modified: 300 });
      f.extract(() => ({ text: "New document text" }));
      assert.equal((await f.read(pdf)).text, "New document text");
      old.resolve({ text: "Old document text" });
      assert.equal((await pending).text, "New document text");
      assert.equal((await f.read(pdf)).text, "New document text");
      assert.lengthOf(f.extractions, 2);
    });

    it("tracks an exact Markdown sidecar by its actual path and revision", async function () {
      const f = fixture();
      const html = f.attachment(
        1,
        "html",
        "<p>Fallback HTML</p>",
        "/papers/paper_中文翻译_离线.html",
      );
      const path = "/papers/paper_中文翻译.md";
      f.files.set(path, { text: "First Markdown", modified: 100 });
      const result = await f.read(html);
      assert.equal(result.path, path);
      assert.equal(result.label, "Markdown · LaTeX");
      assert.equal(result.text, "First Markdown");
      f.files.set(path, { text: "Updated Markdown", modified: 200 });
      assert.equal((await f.read(html)).text, "Updated Markdown");
      f.files.set(path, { text: "", modified: 300 });
      assert.equal((await f.read(html)).text, "Fallback HTML");
    });

    it("does not use a different paper with a shared filename prefix", async function () {
      const f = fixture();
      const html = f.attachment(
        1,
        "html",
        "<p>Correct paper</p>",
        "/papers/2026_research_alpha.html",
      );
      const unrelated = "/papers/2026_research_beta.md";
      f.files.set(unrelated, { text: "WRONG PAPER", modified: 100 });
      assert.equal((await f.read(html)).text, "Correct paper");
      assert.notInclude(f.reads, unrelated);
    });

    it("keeps readable HTML when a malformed numeric entity occurs", function () {
      const f = fixture();
      assert.equal(
        f.module.htmlToTextWithMath("<p>A &#999999999; B &#xD800; C &#65;</p>"),
        "A � B � C A",
      );
    });
  });
}
