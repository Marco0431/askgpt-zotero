import { assert } from "chai";
import { sources } from "../.scaffold/test-fixtures/host-modules";
import { registerFulltextTests } from "./fulltext.test";
import { registerPanelHostTests } from "./panel-host.test";

/** Fresh module scope per fixture; never assign to the real Zotero singleton. */
function isolatedModule(
  source: string,
  environment: any,
  expectedExport: string,
) {
  const module = { exports: {} as Record<string, unknown> };
  const FixtureDate = class extends Date {
    static now() {
      return environment.now ? environment.now() : Date.now();
    }
  };
  const scope = {
    module,
    exports: module.exports,
    Zotero: environment.Zotero,
    IOUtils: environment.IOUtils,
    addon: environment.addon,
    Date: FixtureDate,
    __askgptTestEnvironment: environment,
    setTimeout: (callback: () => void, delay?: number) =>
      window.setTimeout(callback, delay),
    clearTimeout: (id: number) => window.clearTimeout(id),
  };
  try {
    Services.scriptloader.loadSubScript(
      "data:application/javascript;charset=utf-8," + encodeURIComponent(source),
      scope,
    );
  } catch (error: any) {
    assert.fail(
      `Cannot load isolated ${expectedExport} fixture: ${error?.message || String(error)}\n${String(error?.stack || "").slice(0, 2000)}`,
    );
  }
  assert.isFunction(
    scope.module.exports?.[expectedExport],
    `Isolated fixture did not export ${expectedExport}`,
  );
  return scope.module.exports;
}

registerFulltextTests((environment) =>
  isolatedModule(sources.fulltext, environment, "readAttachmentContext"),
);
registerPanelHostTests((environment) =>
  isolatedModule(sources.popup, environment, "openAskPopup"),
);
