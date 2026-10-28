[简体中文](README.zh-CN.md) · **English**

# AskGPT — AI Paper Reader for Zotero

AskGPT adds a question-and-answer panel to the Zotero reader. Select a passage, press `Ctrl+K` (`Cmd+K` on macOS), and ask about it with available paper context. Attach a screenshot or paper figure when text alone is not enough. Answers support Markdown and mathematical notation and can be saved as Zotero notes.

[Download askgpt.xpi](https://github.com/Marco0431/askgpt-zotero/releases/latest/download/askgpt.xpi) · [Releases](https://github.com/Marco0431/askgpt-zotero/releases) · [Report an issue](https://github.com/Marco0431/askgpt-zotero/issues) · [Documentation index](llms.txt)

[![License](https://img.shields.io/badge/License-AGPL--3.0-green.svg?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Marco0431/askgpt-zotero?style=flat-square)](https://github.com/Marco0431/askgpt-zotero/releases)

## Install and try

1. Download `askgpt.xpi` from the link above.
2. In Zotero, open **Tools → Plugins**, choose **Install Plugin From File…**, select the file, and restart Zotero.
3. Open a paper and press `Ctrl+K` or `Cmd+K` (or use the reader toolbar's **AskGPT** button). Open the panel's **⚙ Settings**, then enter your API base URL and API key. The default provider is DeepSeek; you use your own provider account.
4. Click **Fetch models**, select a model, and click **Test connection**. You can also enter a model ID manually. Save the settings when ready.
5. Select a passage and enter a question. To ask about a figure, add or paste an image before sending.

The plugin itself does not include API credits. Model requests and the connection test may incur charges from your provider.

Example question:

> Explain the method in this passage using the paper's context. Identify its assumptions and distinguish what the authors state from your interpretation.

The interface follows Zotero's language by default, with **English** and **简体中文** available in the language selector at the top of Settings. Changing the selector previews the language immediately; **Save and return** keeps your choice, while **Cancel**, **×**, or **Esc** restores the saved language. Use **Save note** to keep an answer in Zotero.

Built-in system prompts follow the interface language: English answers in English mode, and Simplified Chinese answers in Chinese mode, unless you request another language. They prioritize your question, distinguish paper evidence from inference, and ask the model to acknowledge missing or unclear information. Existing built-in prompts are updated; custom system prompts and existing conversation text are preserved. You can edit the system prompt under **Reading and answers**.

## What it supports

- Selected passages plus available full-text context from PDF, HTML, Markdown, or text attachments, capped at 120,000 characters by the context reader.
- Streaming answers, interruption, per-paper conversations, and a movable, resizable panel.
- Markdown and KaTeX rendering bundled with the plugin.
- A configurable OpenAI-compatible Chat Completions endpoint, including DeepSeek. Streaming compatibility depends on the chosen provider and model.
- Optional provider web search through the Responses API, plus saving answers as Zotero notes.
- Model discovery and a connection test using the API settings currently entered in the panel.
- Image attachments from files or the clipboard, with previews and removal before sending.
- English and Simplified Chinese interfaces, including settings, quick questions, status messages, and built-in system prompts.

## Set up your model connection

Settings open in a separate overlay. Start with the **connection** section; appearance and advanced options are grouped separately so that API setup does not require navigating every preference.

| Field or action | What to do                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API base URL    | Enter your provider's OpenAI-compatible API URL. Common examples are `https://api.deepseek.com` and `https://api.openai.com/v1`. Use the URL your provider documents.                   |
| API key         | Enter your own key for that endpoint.                                                                                                                                                   |
| Fetch models    | Request the model list from the configured endpoint and select the model you want.                                                                                                      |
| Model           | Enter an ID manually if the provider does not expose a model list, or if the model you need is missing.                                                                                 |
| Test connection | Send a small text request with the entered settings. This checks that the model can answer; it does not send your paper, images, or conversation.                                       |
| Test web search | Verify that the entered API and model actually execute a server-side search. The test uses a small prompt, excludes your paper, images, and conversation, and may incur search charges. |
| Save and return | Apply the settings and return to the conversation. Fetching models or testing a connection does not save the fields for you.                                                            |

**Cancel**, the upper-right **×**, and **Esc** discard unsaved inputs, restore the saved settings, and return to the conversation. Use **Save and return** to keep your changes.

A returned model list does not guarantee that every model supports chat, images, or tools. Choose a chat model supported by your provider. If model discovery is unavailable, manual entry still works. A successful text connection test does not establish image or web-search support.

You can also edit the core API fields under **Zotero → Settings → AskGPT**. Model discovery and connection testing are available in the reader panel. Local compatible services that require no authentication can leave the API key empty.

The toolbar button shows **AskGPT** and toggles the panel; `Ctrl+K` / `Cmd+K` opens or focuses it. Opening from a separate reader window uses that reader’s paper and window.

## Provider web search

Provider web search starts **disabled** and requires you to enable it explicitly in the **connection** section, including when upgrading from an earlier version. AskGPT sends enabled search requests through the provider's OpenAI-compatible **Responses API** with the built-in `web_search` tool, using the API address and key already configured. No separate search-service key is needed. The provider decides whether a search is necessary; enabling the option does not guarantee a search on every question.

- **DeepSeek's official API:** its documented endpoint is `https://api.deepseek.com/responses`. Native `web_search` is documented only for `deepseek-v4-pro`; `deepseek-flash` ignores that tool. See [DeepSeek's Responses API compatibility guide](https://api-docs.deepseek.com/guides/responses_api/).
- **xAI's official API:** supports `web_search` at `https://api.x.ai/v1/responses`. Select a model documented by xAI as supporting the tool; see [xAI Web Search](https://docs.x.ai/developers/tools/web-search).
- **Other providers or proxies:** Chat Completions compatibility alone is insufficient. The configured endpoint must support Responses and actually execute `web_search`. Use **Test web search** before relying on it; a model list or successful text connection test does not prove search support. If unsupported, disable provider web search to use ordinary chat.

**Test web search** uses the values currently entered in the connection section and reports success only when the server performs a search. It excludes your paper, images, and conversation, and does not save your settings.

Search can add provider tool charges and model-token charges. Review your provider's current pricing: [DeepSeek Search pricing](https://api-docs.deepseek.com/guides/search/#billing) and [xAI tool pricing](https://docs.x.ai/developers/pricing#tools-pricing). A search test may also incur these charges. Search support and image support are separate capabilities.

Search queries are handled by your configured provider; AskGPT does not scrape DuckDuckGo or fall back to a separate search service. Source links depend on what the provider returns and should be checked against the original pages.

## Ask about a figure or screenshot

Add an image using the image button beside the message input, or paste one from the clipboard. Review the preview and remove unwanted images before sending. You can attach an image to a question about the selected passage, or send an image without text.

- Supported files: **PNG, JPEG, and WebP**.
- Up to **4 images per message**, **8 MB per image**, and **20 MB total**.
- The endpoint and selected model must support image input for the protocol in use: `image_url` for Chat Completions or `input_image` for Responses. Image support is not inferred from the model's name.
- Images are sent to your configured model endpoint when you send the message. Later turns in the same conversation may include earlier image attachments as context.

If a provider rejects image input, choose a model that supports it or remove the images and continue with text. Images are not added to your Zotero library automatically.

## Requirements and data flow

AskGPT requires desktop Zotero and an OpenAI-compatible Chat Completions endpoint for ordinary chat. Provider web search additionally requires Responses API support with the built-in `web_search` tool. Streaming, images, and search depend on the chosen provider and model. The repository's manifest sets an accepted Zotero version range; that is not a test report for every version or operating system.

Available paper context, selected text, conversation history, and images you send are transmitted to the model endpoint you configure. Fetching models sends your API credentials to that endpoint; the connection test additionally sends a small test prompt. With provider web search enabled, the configured provider executes searches as part of the response. Local math rendering does not make remote model inference offline.

The plugin keeps a stable system-and-paper prefix where possible, but still sends context with requests. Provider-side cache hits, prices, and context limits depend on the endpoint; the plugin does not guarantee a particular discount. Local full-text caching checks the file version, combines concurrent reads, and has a size limit and expiry. A fresh, complete Zotero index can be reused; partial indexes trigger full extraction where available. The panel marks incomplete or truncated context, and indicates when only selected text is available. Conversations are retained while Zotero is running; save a note to keep an answer beyond that session.

## Development

```sh
git clone https://github.com/Marco0431/askgpt-zotero.git
cd askgpt-zotero
npm ci
npm run lint:check
npm run build
```

The existing build script runs the Zotero plugin build and TypeScript checking. The generated plugin is under `.scaffold/build/askgpt.xpi`.

- [Attachment context](src/modules/fulltext.ts)
- [Reader selection and shortcuts](src/modules/reader.ts)
- [Panel and model requests](addon/content/scripts/popup.js)
- [Connection and image helpers](addon/content/scripts/client.js)
- [Package scripts and dependencies](package.json)

Zotero integration tests run through `npm test`; its preparation step generates isolated host-module fixtures under `.scaffold/test-fixtures`. CI runs the full-text cache, panel-host, toolbar, request, and real Markdown/KaTeX rendering tests in Gecko on Linux. Use a separate development profile and close other Zotero instances before local integration testing; see [`.env.example`](.env.example). `npm run test:prepare` only prepares fixtures and does not launch Zotero.

Run `npm run check:package` after a build to verify required runtime assets and WOFF2 fonts and reject development/test files in the XPI. CI build and release workflows both perform this check. Test sources and generated fixtures stay outside runtime assets.

## Feedback and license

[Report a problem](https://github.com/Marco0431/askgpt-zotero/issues) with your Zotero version, plugin version, provider/model, and reproduction steps. Remove API keys and private paper text from reports.

Licensed under [AGPL-3.0](LICENSE). Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) and [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit). The reader integration also draws on [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate).
