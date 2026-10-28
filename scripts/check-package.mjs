import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
import AdmZip from "adm-zip";

const root = fileURLToPath(new URL("../", import.meta.url));
const archive = new AdmZip(path.join(root, ".scaffold/build/askgpt.xpi"));
const files = archive.getEntries().filter((entry) => !entry.isDirectory);
const names = new Set(files.map((entry) => entry.entryName));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const required = [
  "bootstrap.js",
  "manifest.json",
  "prefs.js",
  "content/popup.xhtml",
  "content/preferences.xhtml",
  "content/scripts/askgpt.js",
  "content/scripts/client.js",
  "content/scripts/i18n.js",
  "content/scripts/native-search.js",
  "content/scripts/prompts.js",
  "content/scripts/mathrender.js",
  "content/vendor/markdown-it.min.js",
  "content/vendor/katex/katex.min.js",
  "content/vendor/katex/katex.min.css",
  "locale/en-US/askgpt-preferences.ftl",
  "locale/zh-CN/askgpt-preferences.ftl",
];
for (const name of required)
  assert.ok(names.has(name), `Missing runtime asset: ${name}`);
const manifest = JSON.parse(archive.readAsText("manifest.json"));
assert.equal(
  manifest.version,
  pkg.version,
  "XPI version does not match package.json; rebuild before publishing",
);
assert.equal(
  manifest.applications?.zotero?.id,
  pkg.config.addonID,
  "XPI has the wrong plugin ID",
);
for (const entry of files) {
  const name = entry.entryName;
  assert.match(
    name,
    /^(bootstrap\.js|manifest\.json|prefs\.js|content\/[^.].*|locale\/[^.].*)$/,
    `Unexpected package entry: ${name}`,
  );
  assert.doesNotMatch(
    name,
    /(^|\/)(tests?|scripts\/test|node_modules|\.scaffold|src)(\/|$)|\.(test|spec)\.|\.(ts|tsx|map)$/i,
    `Development file leaked into XPI: ${name}`,
  );
  if (name.endsWith(".js")) {
    assert.doesNotMatch(
      entry.getData().toString("utf8"),
      /registerFulltextTests|registerPanelHostTests|__askgptTestEnvironment|PRIVATE_HISTORY_SENTINEL/,
      `Test implementation leaked into ${name}`,
    );
  }
  if (name.endsWith(".css")) {
    const css = entry.getData().toString("utf8");
    // Gecko supports WOFF2. Legacy WOFF/TTF fallbacks in vendor CSS are not
    // packaged; requiring them would add unnecessary duplicate font payloads.
    for (const face of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      const sources = Array.from(
        face[1].matchAll(/url\(["']?([^\s"')]+)["']?\)/g),
      );
      assert.ok(
        sources.some(
          (match) =>
            match[1].endsWith(".woff2") &&
            names.has(path.posix.join(path.posix.dirname(name), match[1])),
        ),
        `Missing WOFF2 font face in ${name}`,
      );
    }
    const nonFontCSS = css.replace(/@font-face\s*\{[^}]+\}/g, "");
    for (const match of nonFontCSS.matchAll(/url\(["']?([^\s"')]+)["']?\)/g)) {
      const reference = match[1];
      if (/^(data:|https?:|chrome:|resource:|#)/.test(reference)) continue;
      const asset = path.posix.normalize(
        path.posix.join(path.posix.dirname(name), reference.split(/[?#]/)[0]),
      );
      assert.ok(
        names.has(asset),
        `Missing CSS asset ${asset} referenced by ${name}`,
      );
    }
  }
}
console.log(
  `Verified ${files.length} runtime files: required assets present; no tests, source maps, or development files in XPI.`,
);
