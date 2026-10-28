import { sources } from "../.scaffold/test-fixtures/host-modules";
import { registerFulltextTests } from "./fulltext.test";
import { registerPanelHostTests } from "./panel-host.test";

/** Fresh module scope per fixture; never assign to the real Zotero singleton. */
function isolatedModule(source: string, environment: any) {
  const module = { exports: {} };
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
    setTimeout,
    clearTimeout,
  };
  Services.scriptloader.loadSubScript(
    "data:application/javascript;charset=utf-8," + encodeURIComponent(source),
    scope,
  );
  return module.exports;
}

registerFulltextTests((environment) =>
  isolatedModule(sources.fulltext, environment),
);
registerPanelHostTests((environment) =>
  isolatedModule(sources.popup, environment),
);
