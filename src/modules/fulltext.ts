/**
 * AskGPT 全文上下文读取。
 *
 * 目标：把「整篇文献」变成可发送给模型的纯文本，公式尽量保留为 LaTeX。
 *
 * 候选来源（按优先级）：
 *   0. 阅读器里打开的附件所属**条目**的全部附件（Markdown > HTML > PDF > TXT）
 *      —— 同一篇文献常有 PDF + HTML 译文 + Markdown 源三个附件，
 *         Markdown 源的公式是最完整的 LaTeX，优先用它；
 *   1. 资料窗格选中条目的附件（同上顺序）；
 *   2. 阅读器里打开的附件本身（若上面都没命中）。
 *
 * 关键点：
 *   - PDF：优先读 Zotero 已索引的全文缓存（.zotero-ft-cache，秒回），
 *          没有或太短则调用 Zotero.PDFWorker.getFullText() 现场抽取全部页面；
 *   - HTML 译文：从 KaTeX 的 <annotation encoding="application/x-tex"> 里
 *          还原每个公式的原始 LaTeX（$...$ / $$...$$），比剥标签清楚得多；
 *   - Markdown：原样保留（本来就是 LaTeX 源）。
 */

export type FullTextContext = {
  /** 纯文本全文（公式为 $...$ / $$...$$） */
  text: string;
  /** 来源说明，如 "Markdown 附件" / "PDF 全文" */
  label: string;
  /** 文件路径（作为会话 key） */
  path: string;
  /** 字符数 */
  chars: number;
  /** 是否因超长被截断 */
  truncated: boolean;
  /** 文献标题（条目标题，用于面板显示） */
  title: string;
};

/** 单次发送的全文上限（字符）。一篇论文通常 3~8 万字符，够用。 */
const MAX_CHARS = 120000;

/** 缓存有效期：翻译附件更新后不该一直用旧的（毫秒） */
const CACHE_TTL = 10 * 60 * 1000;

type CacheEntry = FullTextContext & { ts: number };
/** 会话内缓存：同一文件不重复读盘/解析（路径 → 结果） */
const fulltextCache: { [path: string]: CacheEntry } = {};

export function clearFullTextCache() {
  for (const k of Object.keys(fulltextCache)) delete fulltextCache[k];
}

type Cand = {
  item: any;
  path: string;
  ext: string;
  /** 越小越优先 */
  rank: number;
  /** 说明性标签 */
  label: string;
};

const EXT_SCORE: { [ext: string]: number } = {
  md: 0,
  markdown: 1,
  html: 2,
  htm: 3,
  pdf: 4,
  txt: 5,
  text: 6,
};

const EXT_LABEL: { [ext: string]: string } = {
  md: "Markdown 源（公式为完整 LaTeX）",
  markdown: "Markdown 源（公式为完整 LaTeX）",
  html: "HTML 译文",
  htm: "HTML 译文",
  pdf: "PDF 全文",
  txt: "TXT 附件",
  text: "TXT 附件",
};

/** 当前阅读器里打开的附件 item（没有则 null） */
function getReaderAttachment(): any {
  try {
    const mainWin: any = Zotero.getMainWindow();
    const tabID = mainWin?.Zotero_Tabs?.selectedID;
    if (tabID == null) return null;
    const reader: any = Zotero.Reader.getByTabID(tabID);
    const id = reader && reader.itemID;
    if (!id) return null;
    const it: any = Zotero.Items.get(id);
    return it && it.isAttachment ? it : null;
  } catch (e) {
    return null;
  }
}

/** 上下文来源偏好：auto（读哪个文件就用哪个） / pdf（PDF 优先） / translation（译文优先） */
export type SourceMode = "auto" | "pdf" | "translation";

export function getSourceMode(): SourceMode {
  try {
    const v = String(
      Zotero.Prefs.get("extensions.askgpt.contextSource") || "",
    ).trim();
    if (v === "pdf" || v === "translation") return v;
  } catch (e) {}
  return "auto";
}

/** 兄弟附件之间的打分（越小越优先）：默认 PDF 优先，可按偏好改成译文优先 */
const SIBLING_SCORE: { [mode in SourceMode]: { [ext: string]: number } } = {
  auto: { pdf: 1, md: 2, html: 3, htm: 3, txt: 4, text: 4 },
  pdf: { pdf: 0, md: 1, html: 2, htm: 2, txt: 3, text: 3 },
  translation: { md: 0, html: 1, htm: 1, txt: 2, text: 2, pdf: 5 },
};

/** 条目标题（附件取其父条目标题） */
export function getContextTitle(item: any): string {
  try {
    if (!item) return "";
    const parent = item.parentItem;
    const target = parent || item;
    return String(target.getField("title") || "").trim();
  } catch (e) {
    return "";
  }
}

/** 把附件转成候选（不可读的直接丢掉） */
function toCandidate(item: any, rank: number): Cand | null {
  try {
    if (!item || !item.isAttachment) return null;
    const p: string | null = item.getFilePath();
    if (!p) return null;
    const ext = (p.split(".").pop() || "").toLowerCase();
    const score = EXT_SCORE[ext];
    if (score === undefined) return null;
    return {
      item,
      path: p,
      ext,
      rank,
      label: EXT_LABEL[ext] || ext.toUpperCase() + " 附件",
    };
  } catch (e) {
    return null;
  }
}

/** 收集候选：同一篇文献（同一父条目）的附件优先 */
function collectCandidates(): Cand[] {
  const readerItem = getReaderAttachment();
  const groups: { items: any[]; base: number }[] = [];

  // A. 阅读器里那篇文献：父条目的全部附件（PDF + HTML 译文 + Markdown 源）
  if (readerItem) {
    const parent = readerItem.parentItem || null;
    const groupItems: any[] = [];
    try {
      if (parent && typeof parent.getAttachments === "function") {
        for (const id of parent.getAttachments() || []) {
          const child: any = Zotero.Items.get(id);
          if (child && child.isAttachment) groupItems.push(child);
        }
      }
    } catch (e) {}
    if (!groupItems.length) groupItems.push(readerItem);
    groups.push({ items: groupItems, base: 0 });
  }

  // B. 资料窗格选中的条目
  try {
    const pane = Zotero.getActiveZoteroPane();
    const selected: any[] = (pane && pane.getSelectedItems()) || [];
    for (const sel of selected) {
      if (!sel) continue;
      if (sel.isAttachment) {
        groups.push({ items: [sel], base: 10 });
        continue;
      }
      const groupItems: any[] = [];
      if (typeof sel.getAttachments === "function") {
        for (const id of (sel.getAttachments() || []).slice(0, 30)) {
          const child: any = Zotero.Items.get(id);
          if (child && child.isAttachment) groupItems.push(child);
        }
      }
      if (groupItems.length) groups.push({ items: groupItems, base: 10 });
    }
  } catch (e) {}

  // 阅读器里的附件本身兜底（父条目拿不到时）
  if (readerItem) groups.push({ items: [readerItem], base: 5 });

  const mode = getSourceMode();
  const readerID = readerItem ? readerItem.id : 0;
  const scoreTable = SIBLING_SCORE[mode];

  const out: Cand[] = [];
  const seen: { [id: number]: boolean } = {};
  for (const g of groups) {
    for (const item of g.items) {
      if (seen[item.id]) continue;
      seen[item.id] = true;
      const ext = (() => {
        try {
          return (
            String(item.getFilePath() || "")
              .split(".")
              .pop() || ""
          ).toLowerCase();
        } catch (e) {
          return "";
        }
      })();
      const score = scoreTable[ext];
      if (score === undefined) continue;
      // auto 模式：正在读的那个文件最优先（读 PDF 就用 PDF，读译文就用译文）；
      // 其余情况按偏好打分（默认 PDF 优先，可切到译文优先拿 LaTeX）
      const rank =
        mode === "auto" && item.id === readerID ? g.base : g.base + 10 + score;
      const cand = toCandidate(item, rank);
      if (cand) out.push(cand);
    }
  }
  out.sort((a, b) => a.rank - b.rank);
  return out;
}

async function readFileText(path: string): Promise<string | null> {
  try {
    const raw: any = await Zotero.File.getContentsAsync(path, "utf-8");
    if (typeof raw === "string") return raw;
    if (raw != null) {
      return new TextDecoder("utf-8").decode(raw as BufferSource);
    }
  } catch (e) {}
  return null;
}

/**
 * PDF 全文：先读 Zotero 已索引的全文缓存，再退回 PDFWorker 现场抽取全部页。
 * 扫描版 PDF（无文字层）两条路都拿不到内容，返回 null。
 */
async function readPdfText(item: any): Promise<string | null> {
  // 1) .zotero-ft-cache（Zotero 索引时抽好的全文，秒回）
  try {
    const cacheFile: any = (Zotero as any).Fulltext?.getItemCacheFile?.(item);
    const p: string | null =
      cacheFile &&
      (cacheFile.path || (typeof cacheFile === "string" ? cacheFile : null));
    if (p) {
      const txt = await readFileText(p);
      if (txt && txt.trim().length > 200) return txt;
    }
  } catch (e) {}

  // 2) 现场抽取（maxPages = null → 全部页面）
  try {
    const res: any = await (Zotero as any).PDFWorker?.getFullText?.(
      item.id,
      null,
      true,
    );
    const txt = res && res.text;
    if (typeof txt === "string" && txt.trim()) return txt;
  } catch (e) {
    Zotero.logError(new Error("AskGPT 读取 PDF 全文失败: " + e));
  }

  // 3) 兜底：全文检索接口
  try {
    const c: any = await (Zotero as any).Fulltext?.getItemContent?.(item.id);
    if (typeof c === "string" && c.trim()) return c;
    if (c && typeof c.content === "string" && c.content.trim())
      return c.content;
  } catch (e) {}

  return null;
}

/** 读取候选附件里的全文并转成文本 */
async function readCandidateText(cand: Cand): Promise<string | null> {
  if (cand.ext === "pdf") {
    return await readPdfText(cand.item);
  }

  const raw = await readFileText(cand.path);
  if (raw == null) return null;

  if (cand.ext === "md" || cand.ext === "markdown") {
    return mdToText(raw);
  }

  if (cand.ext === "html" || cand.ext === "htm") {
    // 优先用同目录伴生 Markdown 源（公式是最完整的 LaTeX）
    const sib = await tryReadSiblingMd(cand.path);
    if (sib != null) return mdToText(sib);
    return htmlToTextWithMath(raw);
  }

  return raw.trim();
}

/** 超长时按段落边界截断，避免把公式/段落切一半 */
function truncateText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.lastIndexOf("\n\n", max);
  if (cut < max * 0.6) cut = max;
  return {
    text:
      text.slice(0, cut) +
      `\n\n…（全文过长，已截断；原文共 ${text.length} 字）`,
    truncated: true,
  };
}

/**
 * 读取「整篇文献」上下文。任何一步失败都返回 null（调用方退回选中文字）。
 */
export async function readAttachmentContext(): Promise<FullTextContext | null> {
  try {
    const cands = collectCandidates();
    if (!cands.length) return null;

    for (const cand of cands) {
      const cached = fulltextCache[cand.path];
      if (cached && Date.now() - cached.ts < CACHE_TTL) return cached;

      const title = getContextTitle(cand.item);
      const got = await readCandidateText(cand);
      if (!got || !got.trim()) continue;

      const { text, truncated } = truncateText(got.trim(), MAX_CHARS);
      const ctx: FullTextContext = {
        text,
        label: cand.label,
        path: cand.path,
        chars: text.length,
        truncated,
        title,
      };
      fulltextCache[cand.path] = { ...ctx, ts: Date.now() };
      return ctx;
    }
    return null;
  } catch (e) {
    Zotero.logError(new Error("AskGPT readAttachmentContext: " + e));
    return null;
  }
}

/* ============================ HTML → 文本（含公式） ============================ */

/**
 * HTML 译文转纯文本。
 * 核心：KaTeX 渲染出来的公式里带 <annotation encoding="application/x-tex">原始 TeX</annotation>，
 * 把它还原成 $...$ / $$...$$，其余标签剥掉 —— 公式不再变成"JTT Fe"这种乱码。
 */
export function htmlToTextWithMath(html: string): string {
  let s = String(html || "");

  // 0) 先去体积大头：base64 内嵌图片
  s = s
    .replace(/\s(?:xlink:href|href|src)\s*=\s*"(?:data|blob):[^"]*"/gi, "")
    .replace(/\s(?:xlink:href|href|src)\s*=\s*'(?:data|blob):[^']*'/gi, "");

  // 1) 脚本 / 样式 / 字体声明
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<link\b[^>]*>/gi, " ")
    .replace(/<meta\b[^>]*>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ");

  // 2) KaTeX 公式 → LaTeX
  s = replaceKatex(s);

  // 3) 块级标签 → 换行
  s = s.replace(
    /<\/?(?:p|div|section|article|header|footer|main|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|blockquote|figure|figcaption|pre|br|hr)\b[^>]*>/gi,
    "\n",
  );

  // 4) 其余标签剥掉
  s = s.replace(/<[^>]*>/g, " ");

  // 5) 实体 + 空白整理
  s = decodeEntities(s);
  s = s
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}

/** 匹配 <span class="katex...">…</span>（深度计数，处理嵌套 span） */
function replaceKatex(s: string): string {
  const OPEN = '<span class="katex';
  let out = "";
  let i = 0;
  for (;;) {
    const start = s.indexOf(OPEN, i);
    if (start < 0) {
      out += s.slice(i);
      return out;
    }
    out += s.slice(i, start);
    const end = findSpanEnd(s, start);
    if (end < 0) {
      out += " ";
      return out;
    }
    const block = s.slice(start, end);
    const tex = extractTex(block);
    if (tex) {
      // 长公式 / 含换行 / 含 \begin{} 的一律按块级处理，避免行内挤成一团
      const display =
        /class="katex-display/.test(block) ||
        /\n/.test(tex) ||
        tex.length > 120 ||
        /\\begin\{(align|aligned|array|matrix|bmatrix|pmatrix|cases|gather)/.test(
          tex,
        );
      out += display ? `\n\n$$${tex}$$\n\n` : `$${tex}$`;
    } else {
      out += " ";
    }
    i = end;
  }
}

/** 从 start 处的 <span 找到配对 </span> 的下一个位置 */
function findSpanEnd(s: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < s.length) {
    const open = s.indexOf("<span", i);
    const close = s.indexOf("</span", i);
    if (close < 0) return -1;
    if (open >= 0 && open < close) {
      depth++;
      i = open + 5;
    } else {
      depth--;
      const gt = s.indexOf(">", close);
      i = gt < 0 ? s.length : gt + 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 取 <annotation encoding="application/x-tex">…</annotation> 里的原始 TeX */
function extractTex(block: string): string | null {
  const m = block.match(
    /<annotation[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>/i,
  );
  if (!m) return null;
  return decodeEntities(m[1]).trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&amp;/gi, "&");
}

/* ============================ Markdown → 文本 ============================ */

/**
 * Markdown → 纯文本，保留 LaTeX 公式（$...$ / $$...$$），
 * 剥掉 base64 图片、链接地址、代码围栏标记等噪音。
 */
export function mdToText(md: string): string {
  return String(md || "")
    .replace(/!\[[^\]]*\]\(\s*data:[^)]*\)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\((?:https?:|ftp:)?\/\/[^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/(\*\*|__)([^*\n]+)\1/g, "$2")
    .replace(/(\*|_)([^*\n]+)\1/g, "$2")
    .replace(/^\s*>\s?/gm, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ============================ HTML ↔ 伴生 Markdown ============================ */

/** 译文工具常见的后缀，剥掉后再找同名 md */
const TRANSLATION_SUFFIX =
  /_(?:离线|中文翻译与精读|中文翻译|中文精读|中文|精读|翻译|translation|translated|译文|cn|zh)$/i;

/** 列出目录下的文件路径（nsIFile 枚举；失败返回空数组） */
function listDirFiles(dir: string): string[] {
  const out: string[] = [];
  try {
    const f: any = (Zotero as any).File?.pathToFile?.(dir);
    if (!f || !f.exists() || !f.isDirectory()) return out;
    const entries = f.directoryEntries;
    while (entries.hasMoreElements()) {
      const child: any = entries.getNext();
      const file =
        child && child.QueryInterface
          ? child.QueryInterface(Components.interfaces.nsIFile)
          : child;
      const p = file && file.path;
      if (p) out.push(String(p));
    }
  } catch (e) {}
  return out;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * 找 HTML 附件同目录的伴生 Markdown 源（译文工具生成的 HTML 常带 md 源）：
 *   1. 同名换 .md（XXX_中文翻译.html → XXX_中文翻译.md）
 *   2. 去掉译文后缀再换 .md（DART_中文翻译_离线.html → DART.md）
 *   3. 同目录里与文件名公共前缀最长的 .md（DART_中文翻译_离线.html
 *      ↔ DART_中文翻译与精读.md）
 */
async function tryReadSiblingMd(htmlPath: string): Promise<string | null> {
  const base = htmlPath.replace(/\.html?$/i, "");
  const dir = base.replace(/[\\/][^\\/]*$/, "");
  const stem = base.replace(/^.*[\\/]/, "");

  const cands = [base + ".md", base.replace(TRANSLATION_SUFFIX, "") + ".md"];
  for (const p of cands) {
    if (!p || p === htmlPath) continue;
    const t = await readFileText(p);
    if (t != null) return t;
  }

  // 2) 公共前缀匹配（只在同目录内找，避免认错文件）
  let best: string | null = null;
  let bestLen = 0;
  for (const p of listDirFiles(dir)) {
    if (!/\.md$/i.test(p)) continue;
    const mdStem = p.replace(/^.*[\\/]/, "").replace(/\.md$/i, "");
    const n = commonPrefixLen(stem, mdStem);
    if (n > bestLen) {
      bestLen = n;
      best = p;
    }
  }
  const need = Math.max(6, Math.floor(Math.min(stem.length, 40) * 0.4));
  if (best && bestLen >= need) {
    const t = await readFileText(best);
    if (t != null) return t;
  }
  return null;
}

export const _internal = {
  findSpanEnd,
  extractTex,
  truncateText,
  collectCandidates,
  getContextTitle,
  MAX_CHARS,
};
