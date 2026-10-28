import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import path from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".scaffold/test-fixtures");

// Only these two modules are replaced with explicit fixture services. The real
// popup implementation and its state machine are bundled unchanged.
const hostServices = {
  "./fulltext": ["getSourceMode", "readAttachmentContext"],
  "../utils/language": ["getNativeString"],
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

const sources = {};
for (const name of ["fulltext", "popup"]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [`src/modules/${name}.ts`],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "firefox115",
    plugins: name === "popup" ? [mockServices] : [],
  });
  sources[name] = result.outputFiles[0].text;
}
await mkdir(output, { recursive: true });
await writeFile(
  path.join(output, "host-modules.ts"),
  "// Generated for isolated tests; never copied into the plugin.\n" +
    `export const sources = ${JSON.stringify(sources)};\n`,
);
console.log(
  "Prepared isolated Gecko host fixtures in .scaffold/test-fixtures.",
);
