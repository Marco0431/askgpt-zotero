/**
 * AskGPT 全文上下文读取。
 *
 * 目标：把「整篇文献」变成可发送给模型的纯文本，公式尽量保留为 LaTeX。
 *
 * 先固定来源阅读器/资料窗格中的一篇文献，再按来源偏好选附件。
 * 当前文献读取失败时不使用其他文献；缓存校验文件版本并合并并发读取。
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

const NEGATIVE_CACHE_TTL = 30 * 1000;
const MAX_CACHE_ENTRIES = 24;
type CacheEntry = {
  context: FullTextContext | null;
  fingerprint: string;
  ts: number;
  ttl: number;
};
const fulltextCache = new Map<string, CacheEntry>();
const pendingReads = new Map<string, Promise<FullTextContext | null>>();
let cacheGeneration = 0;

export function clearFullTextCache() {
  cacheGeneration++;
  fulltextCache.clear();
  pendingReads.clear();
}

export type ContextOptions = { reader?: any; window?: Window };

function isAttachment(item: any): boolean {
  try {
    return (
      !!item &&
      !item.deleted &&
      (typeof item.isAttachment === "function"
        ? item.isAttachment()
        : item.isAttachment === true)
    );
  } catch {
    return false;
  }
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
  md: "Markdown · LaTeX",
  markdown: "Markdown · LaTeX",
  html: "HTML",
  htm: "HTML",
  pdf: "PDF",
  txt: "TXT",
  text: "TXT",
};

/** 当前阅读器里打开的附件 item（没有则 null） */
function getReaderAttachment(options: ContextOptions): any {
  try {
    const mainWin: any = options.window || Zotero.getMainWindow();
    const tabID = mainWin?.Zotero_Tabs?.selectedID;
    const reader: any =
      options.reader !== undefined
        ? options.reader
        : tabID != null
          ? Zotero.Reader.getByTabID(tabID)
          : null;
    const id = reader && reader.itemID;
    if (!id) return null;
    const it: any = Zotero.Items.get(id);
    return isAttachment(it) ? it : null;
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
  auto: { pdf: 1, md: 2, markdown: 2, html: 3, htm: 3, txt: 4, text: 4 },
  pdf: { pdf: 0, md: 1, markdown: 1, html: 2, htm: 2, txt: 3, text: 3 },
  translation: { md: 0, markdown: 0, html: 1, htm: 1, txt: 2, text: 2, pdf: 5 },
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
    if (!isAttachment(item)) return null;
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
      label: EXT_LABEL[ext] || ext.toUpperCase(),
    };
  } catch (e) {
    return null;
  }
}

/** 收集候选：同一篇文献（同一父条目）的附件优先 */
function collectCandidates(options: ContextOptions = {}): Cand[] {
  const readerItem = getReaderAttachment(options);
  let selected: any = readerItem;
  // An explicitly supplied reader must never fall back to another window's item.
  if (!selected && options.reader) return [];
  if (!selected) {
    try {
      const pane = options.window
        ? (options.window as any).ZoteroPane
        : Zotero.getActiveZoteroPane();
      selected = pane?.getSelectedItems?.()?.[0] || null;
    } catch {
      return [];
    }
  }
  if (!selected) return [];
  const attached = isAttachment(selected);
  const parent = attached ? selected.parentItem : selected;
  const items: any[] = attached ? [selected] : [];
  try {
    for (const id of (parent?.getAttachments?.() || []).slice(0, 30)) {
      const child = Zotero.Items.get(id);
      if (isAttachment(child)) items.push(child);
    }
  } catch {
    /* The explicit attachment can still be read without its parent. */
  }
  const mode = getSourceMode();
  const scoreTable = SIBLING_SCORE[mode];
  const seen = new Set<number>();
  const result: Cand[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const candidate = toCandidate(item, 0);
    if (!candidate || scoreTable[candidate.ext] === undefined) continue;
    candidate.rank =
      mode === "auto" && attached && item.id === selected.id
        ? -1
        : scoreTable[candidate.ext];
    result.push(candidate);
  }
  return result.sort((a, b) => a.rank - b.rank);
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

type FileStamp = { modified: number; size: number };
/** false means missing, null means metadata could not be checked. */
async function fileStamp(path: string): Promise<FileStamp | false | null> {
  try {
    const io = typeof IOUtils === "undefined" ? undefined : IOUtils;
    if (io?.stat) {
      try {
        const info = await io.stat(path);
        if (info.type === "directory") return false;
        return Number.isFinite(info.lastModified) && Number.isFinite(info.size)
          ? { modified: info.lastModified!, size: info.size! }
          : null;
      } catch (error: any) {
        if (error?.name === "NotFoundError") return false;
        return null;
      }
    }
    const file: any = (Zotero as any).File?.pathToFile?.(path);
    if (!file) return null;
    if (!file.exists() || (file.isFile && !file.isFile())) return false;
    return Number.isFinite(file.lastModifiedTime) &&
      Number.isFinite(file.fileSize)
      ? { modified: file.lastModifiedTime, size: file.fileSize }
      : null;
  } catch {
    return null;
  }
}

function pdfCachePath(item: any): string | null {
  try {
    const file = (Zotero as any).Fulltext?.getItemCacheFile?.(item);
    return typeof file === "string" ? file : file?.path || null;
  } catch {
    return null;
  }
}

async function candidateFingerprint(cand: Cand): Promise<string | null> {
  const source = await fileStamp(cand.path);
  if (source === null) return null;
  if (source === false) return "missing";
  const cachePath = cand.ext === "pdf" ? pdfCachePath(cand.item) : null;
  const indexed = cachePath ? await fileStamp(cachePath) : false;
  if (indexed === null) return null;
  return JSON.stringify([source, cachePath, indexed]);
}

type ReadText = { text: string; partial?: boolean };

/**
 * PDF 全文：先读 Zotero 已索引的全文缓存，再退回 PDFWorker 现场抽取全部页。
 * 扫描版 PDF（无文字层）两条路都拿不到内容，返回 null。
 */
async function readPdfText(item: any, path: string): Promise<ReadText | null> {
  let indexedText: string | null = null;
  // 1) .zotero-ft-cache（Zotero 索引时抽好的全文，秒回）
  try {
    const p = pdfCachePath(item);
    if (p) {
      const [source, indexed] = await Promise.all([
        fileStamp(path),
        fileStamp(p),
      ]);
      // A stale or only partially indexed PDF must not be presented as full text.
      if (source && indexed && indexed.modified >= source.modified) {
        indexedText = await readFileText(p);
        if (
          indexedText?.trim() &&
          (await (Zotero as any).Fulltext?.isFullyIndexed?.(item))
        )
          return { text: indexedText };
      }
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
    if (typeof txt === "string" && txt.trim())
      return {
        text: txt,
        partial:
          Number.isFinite(res.extractedPages) &&
          Number.isFinite(res.totalPages) &&
          res.extractedPages < res.totalPages,
      };
  } catch (e) {
    Zotero.logError(new Error("AskGPT 读取 PDF 全文失败: " + e));
  }

  // If extraction is unavailable, expose only the fresh partial index as partial.
  return indexedText?.trim() ? { text: indexedText, partial: true } : null;
}

/** 读取候选附件里的全文并转成文本 */
async function readCandidateText(cand: Cand): Promise<ReadText | null> {
  if (cand.ext === "pdf") {
    return await readPdfText(cand.item, cand.path);
  }

  const raw = await readFileText(cand.path);
  if (raw == null) return null;

  if (cand.ext === "md" || cand.ext === "markdown") {
    return { text: mdToText(raw) };
  }

  if (cand.ext === "html" || cand.ext === "htm") {
    return { text: htmlToTextWithMath(raw) };
  }

  return { text: raw.trim() };
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
function cacheResult(key: string, entry: CacheEntry) {
  const now = Date.now();
  for (const [name, cached] of fulltextCache) {
    if (now - cached.ts >= cached.ttl) fulltextCache.delete(name);
  }
  fulltextCache.delete(key);
  fulltextCache.set(key, entry);
  while (fulltextCache.size > MAX_CACHE_ENTRIES)
    fulltextCache.delete(fulltextCache.keys().next().value!);
}

async function readCachedCandidate(
  cand: Cand,
  attempt = 0,
): Promise<FullTextContext | null> {
  const generation = cacheGeneration;
  const fingerprint = await candidateFingerprint(cand);
  const key = JSON.stringify([cand.item.libraryID, cand.item.id, cand.path]);
  const cached = fulltextCache.get(key);
  if (
    fingerprint !== null &&
    cached?.fingerprint === fingerprint &&
    Date.now() - cached.ts < cached.ttl
  ) {
    fulltextCache.delete(key);
    fulltextCache.set(key, cached);
    return cached.context
      ? { ...cached.context, title: getContextTitle(cand.item) }
      : null;
  }
  const pendingKey = JSON.stringify([key, fingerprint, generation]);
  const existing = pendingReads.get(pendingKey);
  if (existing) {
    const context = await existing;
    return context ? { ...context, title: getContextTitle(cand.item) } : null;
  }
  const pending = (async () => {
    const got =
      fingerprint === "missing" ? null : await readCandidateText(cand);
    const after = await candidateFingerprint(cand);
    // A file changed during extraction: never publish or cache the older read.
    if (fingerprint !== null && fingerprint !== after)
      return attempt === 0 ? readCachedCandidate(cand, 1) : null;
    let context: FullTextContext | null = null;
    if (got?.text.trim()) {
      const result = truncateText(got.text.trim(), MAX_CHARS);
      context = {
        text: result.text,
        label: cand.label,
        path: cand.path,
        chars: result.text.length,
        truncated: result.truncated || !!got.partial,
        title: getContextTitle(cand.item),
      };
    }
    if (fingerprint !== null && generation === cacheGeneration)
      cacheResult(key, {
        context,
        fingerprint,
        ts: Date.now(),
        ttl: context && !got?.partial ? CACHE_TTL : NEGATIVE_CACHE_TTL,
      });
    return context;
  })();
  pendingReads.set(pendingKey, pending);
  try {
    const context = await pending;
    return context ? { ...context } : null;
  } finally {
    if (pendingReads.get(pendingKey) === pending)
      pendingReads.delete(pendingKey);
  }
}

export async function readAttachmentContext(
  options: ContextOptions = {},
): Promise<FullTextContext | null> {
  // Snapshot the owning reader, item, and source preference before the first await.
  const candidates = collectCandidates(options);
  for (const candidate of candidates) {
    try {
      const actual = await resolveCandidate(candidate);
      const context = await readCachedCandidate(actual);
      if (context) return context;
      // An empty Markdown sidecar must not hide readable HTML content.
      if (actual.path !== candidate.path) {
        const fallback = await readCachedCandidate(candidate);
        if (fallback) return fallback;
      }
    } catch (error) {
      Zotero.logError(new Error("AskGPT readAttachmentContext: " + error));
    }
  }
  return null;
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
  const codePoint = (value: number) =>
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0x10ffff &&
    !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : "\uFFFD";
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => codePoint(parseInt(d, 10)))
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

/** Only explicit same-name sidecars are eligible; a shared name prefix is not evidence. */
async function resolveCandidate(candidate: Cand): Promise<Cand> {
  if (candidate.ext !== "html" && candidate.ext !== "htm") return candidate;
  let base = candidate.path.replace(/\.html?$/i, "");
  const paths = new Set<string>();
  for (;;) {
    paths.add(base + ".md");
    paths.add(base + ".markdown");
    const normalized = base.replace(TRANSLATION_SUFFIX, "");
    if (normalized === base) break;
    base = normalized;
  }
  for (const path of paths) {
    const stamp = await fileStamp(path);
    if (stamp && stamp.size > 0)
      return { ...candidate, path, ext: "md", label: EXT_LABEL.md };
  }
  return candidate;
}

export const _internal = {
  findSpanEnd,
  extractTex,
  truncateText,
  collectCandidates,
  getContextTitle,
  MAX_CHARS,
  MAX_CACHE_ENTRIES,
  CACHE_TTL,
  NEGATIVE_CACHE_TTL,
  cacheSize: () => fulltextCache.size,
};
