[返回 AskGPT 中文首页](zh-CN.md) · [English](guide.md)

# AskGPT 设置与排错指南

## 模型设置

在提问框旁点击 **设置**。普通问答需要兼容 OpenAI Chat Completions 的接口。填写提供商的 API 地址和密钥，DeepSeek 的地址为 `https://api.deepseek.com`。如果使用无需认证的本地服务，密钥可以留空。

1. 点击 **获取模型**，选择聊天模型。也可以手动输入完整的模型 ID。
2. 点击 **测试连接**，用当前填写的配置发送一个简短的文字问题。
3. 点击 **保存并返回** 使配置生效。点击 **取消**、**×** 或按 `Esc` 会放弃本次修改，包括预览中的语言。

界面默认跟随 Zotero 语言。选择简体中文或 English 后，界面和内置提示词会一同切换。可以在单次提问时指定回答语言，也可以在「阅读与回答」里自定义系统提示词。已有对话保留原文。**Zotero → 设置 → AskGPT** 也可以编辑核心 API 配置。

### 联网搜索

联网搜索默认关闭。要开启它，请选择支持 Responses API 内置 `web_search` 工具的接口和模型，点击 **测试原生搜索**，再勾选 **原生联网搜索** 并点击 **保存并返回**。测试成功表示提供商实际执行了一次搜索。正常问答中，由模型决定何时搜索。

DeepSeek 文档列出 `deepseek-v4-pro` 支持这一工具，端点为 `https://api.deepseek.com/responses`。xAI 的端点为 `https://api.x.ai/v1/responses`。具体模型和费用可查阅提供商说明。[DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api/) · [xAI Web Search](https://docs.x.ai/developers/tools/web-search) · [DeepSeek 搜索费用](https://api-docs.deepseek.com/guides/search/#billing) · [xAI 工具费用](https://docs.x.ai/developers/pricing#tools-pricing)

## 文献上下文与图片

- **全文来源。** 默认先读取正在阅读的附件，也可尝试同一条目下的其他 PDF、HTML、Markdown 或纯文本附件。在设置中可选 PDF 优先或译文优先。PDF 可复用 Zotero 完整且最新的全文索引，必要时重新提取。面板会标记文本不完整、达到 12 万字符上限或仅能发送选中段落等情况。
- **连续追问。** 重新划选文字，会把下一次问题的焦点切换到新段落。对话按文献区分，仅保留在当前 Zotero 会话中。要长期保留回答，点击 **存为笔记**。
- **图表。** 在输入框中粘贴图片，或用图片按钮添加文件，发送前可预览和移除。支持 PNG、JPEG、WebP，每条消息最多 4 张，单张上限 8 MB，总计上限 20 MB。模型需要支持对应协议的图片输入，Chat Completions 使用 `image_url`，Responses 使用 `input_image`。
- **面板操作。** 拖动标题栏可移动面板，拖动边缘或右下角可调整大小。工具栏按钮可打开或收起面板。`Ctrl+K`（macOS 使用 `Cmd+K`）将焦点切回提问框。在另一个 Zotero 窗口按快捷键，会唤起已有面板。

## 数据与费用

点击发送后，你配置的模型接口会收到可用的文献上下文、选中段落、对话历史和附加图片。后续追问也可能携带之前发过的图片。获取模型时，认证信息会发送到同一接口。连接测试和搜索测试仅发送测试请求，不携带论文、图片或对话历史。问答、测试和搜索均可能产生提供商费用。

API 密钥保存在本机的 Zotero 偏好设置中，AskGPT 不对其额外加密。Markdown 和公式在本地排版，回答里的外部图片要点击 **加载外部图片** 才会加载。网页链接在浏览器中打开。

AskGPT 会按文件版本复用本地提取的文献文本。后续提问仍可能发送这段上下文。模型的上下文上限、缓存是否命中及价格由提供商决定。

## 常见问题

| 遇到的情况                   | 检查方法                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| 面板打不开                   | 在 **工具 → 插件** 中启用 AskGPT，重启 Zotero，打开论文后试试阅读器工具栏的 AskGPT 按钮。  |
| 获取不到模型                 | 手动填写提供商文档中的聊天模型 ID，点击 **测试连接**。                                     |
| HTTP 401、403 或 404         | 核对密钥、权限、模型 ID 和 API 地址。API 地址可从提供商的开发文档中获取。                  |
| HTTP 429                     | 重试前先检查额度和请求频率限制。                                                           |
| 只读到选中文字               | 检查附件中是否有可选中的文字。扫描版 PDF 可能需要先做 OCR。                                |
| 文字问答正常，图片或搜索失败 | 确认模型是否支持图片。联网能力可单独点击 **测试原生搜索** 核验。关闭搜索后可恢复普通问答。 |

反馈问题时，请附上 Zotero 版本、系统、提供商、模型和复现步骤，并去除密钥、私人文献及配置文件。[提交问题](https://github.com/Marco0431/askgpt-zotero/issues/new/choose)

## 开发

在项目根目录运行以下命令。

```sh
npm ci
npm run lint:check
npm run build
npm run check:package
```

构建命令会检查 TypeScript 类型并生成 `.scaffold/build/askgpt.xpi`。打包检查会核对必需的运行文件和字体，并检测误入 XPI 的开发文件。

在本机运行 Gecko 集成测试前，请配置独立的开发配置文件并关闭其他 Zotero 实例，再执行 `npm test`。只准备测试文件可以运行 `npm run test:prepare`。[环境配置示例](../.env.example) · [构建与测试命令](../package.json)

Zotero 端负责[读取文献](../src/modules/fulltext.ts)和[处理阅读器事件](../src/modules/reader.ts)。面板负责[发起对话请求](../addon/content/scripts/popup.js)以及[连接模型和读取图片](../addon/content/scripts/client.js)。

AskGPT 通过 Zotero 原生接口注册菜单和阅读器功能。项目从 Zotero Plugin Template 起步，早期版本使用 Zotero Plugin Toolkit，阅读器集成参考了 Zotero PDF Translate。[开发模板](https://github.com/windingwind/zotero-plugin-template) · [早期工具库](https://github.com/windingwind/zotero-plugin-toolkit) · [阅读器参考项目](https://github.com/windingwind/zotero-pdf-translate) · [AGPL-3.0 许可证](../LICENSE)
