# ✎ AskGPT · Zotero AI 文献阅读助手

> 🎯 在 Zotero 里选中文献文字，一键唤起 AI 问答 —— 像 Cursor 一样跟你的论文对话

[![Zotero](https://img.shields.io/badge/Zotero-7%2F8%2F9-blue?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![License](https://img.shields.io/badge/License-AGPL--3.0-green.svg?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Marco0431/askgpt-zotero?style=flat-square)](https://github.com/Marco0431/askgpt-zotero/releases)

---

## ✨ 为什么用 AskGPT？

| 😩 痛点                                   | ✅ 解决方案                                                     |
| ----------------------------------------- | --------------------------------------------------------------- |
| 读论文遇到不懂的段落，要复制粘贴到网页 AI | 选中文字 → `Ctrl+K` → 直接在 Zotero 里问                        |
| 提问要反复附上文献全文，token 烧得快      | 🔥 **上下文缓存**：全文只发一次，同一篇文献反复提问只付增量费用 |
| 换一段文字要关窗重开                      | 📡 **实时跟踪选中**：重新选中，面板内容自动切换                 |
| 弹窗被 Zotero 主窗口盖住                  | 📌 **内嵌浮动面板**：永远保持最前，可拖动、记位置               |

---

## 🚀 功能一览

### 🧠 智能问答 Agent

- 基于**选中的文献原文**回答问题：解释概念、概括方法、分析结果、批判性评价、翻译……
- 内置**联网搜索工具**（`web_search`）：需要最新资料时自动联网，像开源 agent 一样用 function calling
- 流式输出、可中断、回答可一键**存为 Zotero 笔记**

### 📚 支持多种文献上下文

| 场景                              | 方式                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- |
| 📄 **PDF 阅读器**                 | 选中文字 → Ctrl+K，直接对选中内容提问                                   |
| 🌐 **HTML / 📝 MD / 📃 TXT 附件** | 选中条目 → Ctrl+K，自动读取**整篇论文全文**（上限 12 万字符）作为上下文 |

### 📖 论文全文 & 公式保真

- **整篇论文一次送达**：打开面板即读取全文（Markdown 源优先），AI 始终基于**整篇论文**回答，而不是只看你选中的那一段——选中文字会以「选中段落」附加在全文前面用于定位
- **公式上下标不丢失**：HTML 译文附件优先使用同目录伴生的 Markdown 源，公式是完整 LaTeX（如 `$F_t = J^T F_e$`）；面板上下文与 AI 回答中的 `^x` / `_{x}` 会渲染为视觉上标/下标
- **DeepSeek 思考模式兼容**：多轮对话原样回传 `reasoning_content`，开启 thinking 的模型连续追问不会报 `HTTP 400`

### 🔥 省钱的缓存机制

- **API 前缀缓存**：`[system + 全文]` 作为固定前缀，同一篇文献反复提问时前缀不变，DeepSeek 等 API 的磁盘上下文缓存持续命中（命中部分 0.1 倍价）
- **本地全文缓存**：同一会话内不重复读文件
- **按文章分会话**：每篇文献独立记忆对话历史，切文献互不干扰

### 📌 内嵌浮动面板

- 面板是 Zotero 窗口的一部分，**永远不会被主窗口盖住**
- 顶部标题栏**可拖动**，位置自动记忆
- 无窗口标题栏，界面干净
- `Esc` 或 ✕ 隐藏，`Ctrl+K` 再次唤起

### ⚙️ 完整设置页

Zotero → 设置 → AskGPT：接口地址、API Key、模型、温度、联网开关、系统提示词，全部可配。

---

## 📦 安装

1. 下载最新版 `.xpi`：[Releases](https://github.com/Marco0431/askgpt-zotero/releases)（文件：`askgpt.xpi`）
2. Zotero → **工具(Tools) → 插件(Plugins)**
3. 把 `.xpi` **拖进插件窗口**（或 齿轮 → Install Plugin From File…）
4. 重启 Zotero

> ⚠️ 首次使用：打开 **设置 → AskGPT**，填入你的 API 地址 / Key / 模型（默认 DeepSeek）。

---

## 🎮 使用演示

```
1️⃣ 打开任意 PDF → 选中一段看不懂的文字
2️⃣ 按 Ctrl+K（或点阅读器右上角 AI 按钮）
3️⃣ 输入问题 → Enter
4️⃣ 看完回答，选中下一段 → 面板自动切换上下文，继续问
5️⃣ 点「存为笔记」把回答存进 Zotero 笔记
```

---

## 🔧 开发

```bash
# 克隆
git clone https://github.com/Marco0431/askgpt-zotero.git
cd askgpt-zotero

# 安装依赖
npm install

# 开发构建
npm run build
# 产物在 .scaffold/build/askgpt.xpi
```

### 🏗️ 项目结构

```
src/
├── index.ts              # 入口：挂载 Zotero.AskGPT 实例
├── hooks.ts              # 生命周期：启动/关闭/窗口事件
├── addon.ts              # 插件数据类
└── modules/
    ├── popup.ts          # 内嵌面板：创建/拖动/会话缓存/附件读取
    ├── reader.ts         # PDF 选中捕获/顶栏按钮/右键菜单/实时同步
    └── prefs.ts          # 设置页注册与读写
addon/
├── content/
│   ├── popup.xhtml       # 面板界面
│   ├── popup.css         # 面板样式
│   ├── preferences.xhtml # 设置页
│   └── scripts/popup.js  # 面板逻辑（agent 问答 + 流式 + 联网搜索）
└── bootstrap.js          # Zotero 插件入口
```

---

## 🧩 技术亮点

- 🎯 官方 `Zotero.Reader.registerEventListener` 捕获 PDF 选中（`renderTextSelectionPopup`），实时推送面板
- 📦 基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（windingwind 官方模板）+ [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- 🔌 兼容任意 OpenAI 风格 API（DeepSeek / One API / vLLM / Ollama 网关等）
- 📝 无本地模型、无订阅、无授权校验 —— 纯 API，你的数据只发给你自己配置的接口

---

## 🙏 致谢

- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) —— 插件开发模板
- [windingwind/zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) —— 工具库
- [zotero-pdf-translate](https://github.com/windingwind/zotero-pdf-translate) —— Reader API 参考

---

## 📄 License

[AGPL-3.0](LICENSE)

---

> 💡 有问题？开个 [Issue](https://github.com/Marco0431/askgpt-zotero/issues) 📮 或顺手点个 ⭐ 支持一下！
