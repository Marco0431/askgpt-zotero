[AskGPT home](../README.md) · [简体中文](guide.zh-CN.md)

# AskGPT settings and troubleshooting

## Model settings

Open the AskGPT panel and choose **Settings** beside the question box. Ordinary chat uses an OpenAI-compatible Chat Completions endpoint. Enter your provider's API base URL and key. DeepSeek uses `https://api.deepseek.com`. Local endpoints that accept unauthenticated requests can use an empty key.

1. Click **Fetch models**, choose a chat model, or enter its ID manually.
2. Click **Test connection** to send a short text prompt using the values on screen.
3. Click **Save and return** to apply them. **Cancel**, **×**, or **Esc** discards edits, including the language preview.

The default language follows Zotero. Choose English or Simplified Chinese to switch the interface and its built-in prompt. You can request a different answer language in any question, or edit the system prompt under **Reading and answers**. Existing conversations keep their original language. Zotero's own **Settings → AskGPT** also exposes the core API fields.

### Web search

Search is off by default. To enable it, choose an endpoint and model that support the Responses API's built-in `web_search` tool, then run **Test native search**. Select **Native web search** and **Save and return** to apply it. A successful test means the provider performed a search. In ordinary conversations the model decides when to use it.

DeepSeek documents this tool for `deepseek-v4-pro` at `https://api.deepseek.com/responses`. xAI offers it at `https://api.x.ai/v1/responses` on supported models. Consult the provider's current model list and prices. [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/) · [xAI Web Search](https://docs.x.ai/developers/tools/web-search) · [DeepSeek pricing](https://api-docs.deepseek.com/guides/search/#billing) · [xAI pricing](https://docs.x.ai/developers/pricing#tools-pricing)

## Paper context and images

- **Paper text.** AskGPT starts with the attachment you're reading and can fall back to another PDF, HTML, Markdown, or plain-text attachment on the same item. Choose a preferred source in Settings. For PDFs it can reuse a complete, current Zotero index or extract text again. The panel reports partial text, truncation at 120,000 characters, or selection-only context.
- **Follow-up questions.** Selecting another passage changes the focus of the next question. Conversation history stays with the paper during the current Zotero session. Use **Save note** to keep an answer in your library.
- **Figures.** Paste an image or use the image button. You can review and remove attachments before sending. PNG, JPEG, and WebP are supported, up to four per message, 8 MB each and 20 MB combined. The model must accept images via `image_url` for Chat Completions or `input_image` for Responses.
- **Panel controls.** Drag the title bar to move the panel or a resize handle to change its size. The toolbar button toggles it. `Ctrl+K` (`Cmd+K` on macOS) focuses the question box. If you use the shortcut from a second Zotero window, it brings the existing panel forward.

## Data and costs

When you send a question, the configured endpoint receives the available paper context, selection, conversation history, and attached images. Follow-up requests can include earlier images. Model discovery sends credentials to that endpoint. The connection and web-search tests use short test requests without paper text, history, or images. Chat, tests, and searches may incur provider charges.

API keys are stored locally in Zotero preferences without additional encryption by AskGPT. Markdown and math are rendered locally. External figures in answers load when you select **Load external image**. Links open in your browser.

AskGPT caches extracted text locally and checks the attachment version before reuse. Requests can still include that text on later turns. Each provider sets its own token limits, cache policy, and prices.

## Troubleshooting

| Symptom                              | What to check                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Panel won't open                     | Enable AskGPT in **Tools → Plugins**, restart Zotero, open a paper, and try the reader toolbar button.                                     |
| Empty model list                     | Enter the provider's exact chat model ID and run **Test connection**.                                                                      |
| HTTP 401, 403, or 404                | Check the key and its permissions, the model ID, and the API URL. Use the address from the provider's API documentation.                   |
| HTTP 429                             | Check the provider's quota and rate limits before retrying.                                                                                |
| Only selected text is available      | Check for selectable text in the attachment. A scanned PDF may need OCR.                                                                   |
| Text works but images or search fail | Check that the model accepts image input. For search, run **Test native search** separately. Switch search off to return to ordinary chat. |

When reporting a problem, include the Zotero version, OS, provider and model, and steps to reproduce. Remove keys, private papers and profile data. [Report an issue](https://github.com/Marco0431/askgpt-zotero/issues/new/choose)

## Development

Run these commands from the repository root.

```sh
npm ci
npm run lint:check
npm run build
npm run check:package
```

The build type-checks the project and creates `.scaffold/build/askgpt.xpi`. The package check verifies required runtime files and fonts and detects development files in the XPI.

For Gecko integration tests, configure a separate development profile, close other Zotero instances, and run `npm test`. To prepare the fixtures only, use `npm run test:prepare`. [Example environment](../.env.example) · [Build and test commands](../package.json)

The host-side code handles [paper text](../src/modules/fulltext.ts) and [reader events](../src/modules/reader.ts). The panel handles [conversation requests](../addon/content/scripts/popup.js) and [model connections and images](../addon/content/scripts/client.js).

AskGPT uses Zotero's native reader and menu APIs. The project started from the Zotero Plugin Template, used Zotero Plugin Toolkit in earlier releases, and drew on Zotero PDF Translate for reader integration. [Template](https://github.com/windingwind/zotero-plugin-template) · [Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) · [Zotero PDF Translate](https://github.com/windingwind/zotero-pdf-translate) · [AGPL-3.0 license](../LICENSE)
