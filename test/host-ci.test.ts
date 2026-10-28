import { assert } from "chai";
import {
  createFulltext,
  createPopup,
} from "../.scaffold/test-fixtures/host-modules";
import { registerFulltextTests } from "./fulltext.test";
import { registerPanelHostTests } from "./panel-host.test";

/** Fresh module scope per fixture; never assign to the real Zotero singleton. */
function isolatedModule(
  factory: (environment: any) => Record<string, unknown>,
  environment: any,
  expectedExport: string,
) {
  const FixtureDate = class extends Date {
    static now() {
      return environment.now ? environment.now() : Date.now();
    }
  };
  const services = {
    ...environment,
    Date: FixtureDate,
    setTimeout: (callback: () => void, delay?: number) =>
      window.setTimeout(callback, delay),
    clearTimeout: (id: number) => window.clearTimeout(id),
  };
  let exports: Record<string, unknown>;
  try {
    exports = factory(services);
  } catch (error: any) {
    assert.fail(
      `Cannot load isolated ${expectedExport} fixture: ${error?.message || String(error)}\n${String(error?.stack || "").slice(0, 2000)}`,
    );
  }
  assert.isFunction(
    exports![expectedExport],
    `Isolated fixture did not export ${expectedExport}`,
  );
  return exports!;
}

registerFulltextTests((environment) =>
  isolatedModule(createFulltext, environment, "readAttachmentContext"),
);
registerPanelHostTests((environment) =>
  isolatedModule(createPopup, environment, "openAskPopup"),
);
