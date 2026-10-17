# AskGPT — AI Paper Reader for Zotero

AskGPT adds an AI question-and-answer panel to the Zotero reader. Select a passage, press `Ctrl+K` (`Cmd+K` on macOS), and ask about it with available paper context. Answers support Markdown and mathematical notation and can be saved as Zotero notes.

[中文说明](README.md) · [Download askgpt.xpi](https://github.com/Marco0431/askgpt-zotero/releases/latest/download/askgpt.xpi) · [Releases](https://github.com/Marco0431/askgpt-zotero/releases) · [Documentation index](llms.txt)

## Install and try

1. Download `askgpt.xpi` from the link above.
2. In Zotero, open **Tools → Plugins**, choose **Install Plugin From File…**, select the file, and restart Zotero.
3. Open **Settings → AskGPT** and enter your API base URL, API key, and model. The default provider is DeepSeek. You need your own working model endpoint; provider charges may apply.
4. Open a paper PDF, select a passage, press `Ctrl+K` or `Cmd+K`, and enter a question. The reader's AI button is another entry point.

Example question:

> Explain the method in this passage using the paper's context. Identify its assumptions and distinguish what the authors state from your interpretation.

The default prompt requests Chinese answers; ask for English or change the system prompt in settings for another language. Use **存为笔记 (Save as note)** to keep an answer in Zotero.

## What it supports

- Selected passages plus available full-text context from PDF, HTML, Markdown, or text attachments, capped at 120,000 characters by the context reader.
- Streaming answers, interruption, per-paper conversations, and a movable, resizable panel.
- Markdown and KaTeX rendering bundled with the plugin.
- A configurable OpenAI-compatible Chat Completions endpoint, including DeepSeek. Streaming and tool-calling compatibility depends on the chosen provider and model.
- Optional web search and saving answers as Zotero notes.

## Requirements and data flow

The Chinese guide targets Zotero 7/8/9. This is a Zotero plugin, not a standalone PDF application. The repository's manifest sets an accepted version range; that is not a test report for every Zotero version or operating system.

Available paper context, selected text, and the conversation are sent to the model endpoint you configure. With web search enabled, search queries are also sent to DuckDuckGo. Local math rendering does not make remote model inference offline.

The plugin keeps a stable system-and-paper prefix where possible, but still sends context with requests. Provider-side cache hits, prices, and context limits depend on the endpoint; the plugin does not guarantee a particular discount. When full text cannot be read, the panel indicates that only the selected passage is being sent.

## Development

```sh
git clone https://github.com/Marco0431/askgpt-zotero.git
cd askgpt-zotero
npm install
npm run build
```

The existing build script runs the Zotero plugin build and TypeScript checking. The generated plugin is under `.scaffold/build/askgpt.xpi`.

- [Attachment context](src/modules/fulltext.ts)
- [Reader selection and shortcuts](src/modules/reader.ts)
- [Panel and model requests](addon/content/scripts/popup.js)
- [Package scripts and dependencies](package.json)

## Feedback and license

[Report a problem](https://github.com/Marco0431/askgpt-zotero/issues) with your Zotero version, plugin version, provider/model, and reproduction steps. Remove API keys and private paper text from reports.

Licensed under [AGPL-3.0](LICENSE). Built with [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) and [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit); see the Chinese guide for acknowledgements.
