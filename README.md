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
| AI 回答里的公式和表格看不清               | 🧮 **真渲染**：Markdown + KaTeX 离线排版，公式不再是源码        |
| 弹窗被 Zotero 主窗口盖住、大小不合心意    | 📌 **内嵌浮动面板**：永远最前，可拖动、可拖拽缩放、记位置       |

---

## 🚀 功能一览

### 🧠 智能问答 Agent

- 基于**选中的文献原文**回答问题：解释概念、概括方法、分析结果、批判性评价、翻译……
- 内置**联网搜索工具**（`web_search`）：需要最新资料时自动联网，像开源 agent 一样用 function calling
- 流式输出、可中断、回答可一键**存为 Zotero 笔记**

### 📚 支持多种文献上下文

| 场景                              | 方式                                                      |
| --------------------------------- | --------------------------------------------------------- |
| 📄 **PDF 阅读器**                 | 选中文字 → `Ctrl+K`，AI 拿到**整篇论文** + 你选中的那一段 |
| 🌐 **HTML / 📝 MD / 📃 TXT 附件** | 选中条目 → `Ctrl+K`，自动读取整篇全文（上限 12 万字符）   |
| 🖱️ **面板里直接框选**             | 在 AI 回答里划选文字 → 自动成为「选中段落」随问题发送     |

### 📖 整篇论文上下文 & 真实公式渲染

- **整篇论文始终在上下文里**：打开面板即读取全文并作为固定前缀发送；选中文字只作为「选中段落」（焦点）附加在本次问题前，**不会**把全文顶掉，也不会清空对话历史
  - **来源自动选择**：默认用你**正在读的那个文件**（在读 PDF 就用 PDF 全文；在读译文 HTML 就用译文）；也可以在 设置 → AskGPT →「整篇文献的来源」里固定成 **PDF 优先** 或 **译文优先**（译文附件里的公式是完整 LaTeX）
  - 同一篇文献的其它附件依次兜底（PDF / Markdown / HTML / TXT）；某一路读不到文字（比如扫描版 PDF）会自动换下一路
  - PDF 走 Zotero 自带的全文索引缓存（秒回），没有则调用 PDF 抽取现场读取全文
  - HTML 译文里的 KaTeX 公式会还原成原始 LaTeX（`$...$` / `$$...$$`）；读不到全文时会明确提示「本次只发送选中段落」
- **真·Markdown + KaTeX 渲染**（随插件离线打包 `markdown-it` + `KaTeX`，不联网）：
  - 标题 / 表格 / 引用 / 删除线 / 有序无序列表 / 代码块 / 链接全部真渲染
  - 行内公式 `$...$`、`\(...\)`，块级公式 `$$...$$`、`\[...\]` 用 KaTeX 排版
  - 没被 `$` 包起来的裸上下标（`F_t`、`J^T`、`x_{k+1}`）做视觉 `<sub>/<sup>` 兜底
- **DeepSeek 思考模式兼容**：多轮对话原样回传 `reasoning_content`，开启 thinking 的模型连续追问不会报 `HTTP 400`

### 🔥 省钱的缓存机制

- **API 前缀缓存**：`[system + 全文]` 作为固定前缀，同一篇文献反复提问时前缀不变，DeepSeek 等 API 的磁盘上下文缓存持续命中（命中部分 0.1 倍价）
- **本地全文缓存**：同一会话内不重复读文件
- **按文章分会话**：每篇文献独立记忆对话历史，切文献互不干扰

### 📌 内嵌浮动面板

- 面板是 Zotero 窗口的一部分，**永远不会被主窗口盖住**
- 默认 **900 × 520**（宽而短，空间几乎全给对话）；拖动标题栏可移动、位置自动记忆
- **可拖拽缩放**：右下角把手（另附右边缘、下边缘）拖动即改尺寸，松手写回设置；也可以在 设置 → 面板大小 里直接填 `宽x高`，范围 420×360 ~ 1600，且不会超出 Zotero 窗口
- **多尺寸自适应**：宽 < 560px 时省略标题、徽章收成短文案；高 < 560px 时顶部整体压紧；高 < 440px 时收起快捷提示行；宽 > 1100px 时对话内容居中限宽（≈1040px），避免一行过长
- 顶部只有一行（约 50px）：模型徽章 + 两个状态徽章（`📄 整篇文献 12.3k 字 · PDF 全文`、`🎯 选中 41 字`）；读不到全文时第一个徽章变黄提示「仅发选中段落」
- 快捷提示 chips 单行横向滚动，把高度让给对话
- AI 气泡宽度用满面板（不再留 12% 空白），公式、表格在气泡里正常排版
- **字号可调**：设置 → 字体大小（12 / 13 / 14 / 15 / 16 / 18 px，默认 14），保存后立即生效，无需重启
- **⚙ 设置按钮在输入框旁边**；设置面板右上角 `✕`、底部「关闭」、`Esc`、点面板空白处都能关掉设置（设置开着时 `Esc` 只关设置，不会隐藏面板）
- `Esc` 或标题栏 ✕ 隐藏面板，`Ctrl+K` 再次唤起

### ⚙️ 完整设置页

- **面板内设置**（⚙ 在输入栏）：接口地址、API Key、模型、温度、字体大小、面板大小、整篇文献来源、系统提示词、联网开关
- **Zotero → 设置 → AskGPT**：同样的核心项（接口地址、API Key、模型、温度、联网开关）

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
4️⃣ 看完回答，选中下一段 → 面板自动切换「选中段落」，继续问
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
    ├── popup.ts          # 内嵌面板：创建/拖动/缩放/会话缓存
    ├── fulltext.ts       # 整篇文献读取：PDF 全文 / HTML 译文 / Markdown 源
    ├── reader.ts         # PDF 选中捕获/顶栏按钮/右键菜单/实时同步
    └── prefs.ts          # 设置页注册与读写
addon/
├── content/
│   ├── popup.xhtml       # 面板界面
│   ├── popup.css         # 面板样式（含多尺寸断点）
│   ├── preferences.xhtml # 设置页
│   ├── scripts/
│   │   ├── popup.js      # 面板逻辑（agent 问答 + 流式 + 联网搜索）
│   │   └── mathrender.js # 渲染层：markdown-it + KaTeX
│   └── vendor/           # 离线打包的 markdown-it / KaTeX（含字体）
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
