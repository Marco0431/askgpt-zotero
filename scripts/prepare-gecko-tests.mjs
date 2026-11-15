import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".scaffold/test-fixtures");

// Replace host dependencies while exercising the production modules in isolation.
const hostServices = {
  "./fulltext": ["getSourceMode", "readAttachmentContext"],
  "../utils/language": [
    "getNativeString",
    "getInterfaceLanguage",
    "refreshNativeLanguage",
    "resolveInterfaceLocale",
  ],
};
const mockServices = {
  name: "isolated-host-services",
  setup(builder) {
    builder.onResolve(
      { filter: /^(\.\/fulltext|\.\.\/utils\/language)$/ },
      (args) => ({
        path: args.path,
        namespace: "host-fixture",
      }),
    );
    builder.onLoad({ filter: /.*/, namespace: "host-fixture" }, (args) => ({
      contents: hostServices[args.path]
        .map(
          (name) =>
            `export const ${name} = (...args) => __askgptTestEnvironment.${name}(...args);`,
        )
        .join("\n"),
      loader: "js",
    }));
  },
};

const factories = [];
for (const [name, factoryName] of Object.entries({
  fulltext: "createFulltext",
  popup: "createPopup",
  prefs: "createPrefs",
})) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`src/modules/${name}.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "firefox115",
    plugins: name === "fulltext" ? [] : [mockServices],
  });
  // Static functions are bundled with the tests. Gecko rejects data: script
  // URIs, so no dynamic evaluation or privileged loader is needed here.
  factories.push(`export function ${factoryName}(environment: any) {
    const { Zotero, IOUtils, addon, Date, setTimeout, clearTimeout } = environment;
    const __askgptTestEnvironment = environment;
    const module = { exports: {} };
    const exports = module.exports;
    ${result.outputFiles[0].text}
    return module.exports;
  }`);
}
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "host-modules.ts"),
  "// Generated for isolated tests; never copied into the plugin.\n" +
    factories.join("\n\n") +
    "\n",
);
console.log(
  "Prepared isolated Gecko host fixtures in .scaffold/test-fixtures.",
);
