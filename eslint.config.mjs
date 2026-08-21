// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
      },
    },
    {
      // 手写的浏览器脚本（iframe 内运行，window/fetch 等是浏览器全局）
      // 与模板对 bootstrap.js 的处理一致
      files: ["**/addon/content/scripts/popup.js"],
      rules: {
        "no-undef": "off",
        "no-unused-vars": "off",
        "no-empty": "off",
        "no-regex-spaces": "off",
      },
    },
    {
      // 项目里刻意的空 catch 兜底
      files: ["src/**/*.ts"],
      rules: {
        "no-empty": "off",
      },
    },
  ],
});
