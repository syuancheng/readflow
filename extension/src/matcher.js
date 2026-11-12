/**
 * 词表匹配（纯函数，浏览器 + Node 通用）。
 * 短语优先、大小写不敏感、英文词边界、结果不重叠。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.RFMatch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 词表里同一个词可能有 displayForm（Prompt）和 lemma（prompt），都建索引 */
  function buildEntries(words) {
    const seen = new Set();
    const entries = [];
    for (const w of words || []) {
      if (!w) continue;
      for (const form of [w.displayForm, w.lemma]) {
        const text = String(form || "").trim();
        if (!text || text.length > 80) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const pattern = text.split(/\s+/).map(escapeRegex).join("\\s+");
        let re;
        try {
          re = new RegExp("(?<![A-Za-z0-9_])" + pattern + "(?![A-Za-z0-9_])", "gi");
        } catch {
          continue;
        }
        entries.push({
          id: w.id,
          pattern: text,
          re,
          gloss: w.gloss || "",
          translation: w.translation || "",
          phonetic: w.phonetic || "",
          pos: w.pos || "",
        });
      }
    }
    // 长短语先匹配，避免 "has" 抢掉 "has been shown"
    entries.sort((a, b) => b.pattern.length - a.pattern.length);
    return entries;
  }

  /** 返回 [{ start, end, text, entry }]，按位置排序且不重叠 */
  function findMatches(text, entries) {
    if (!text || !entries || !entries.length) return [];
    const found = [];
    for (const e of entries) {
      e.re.lastIndex = 0;
      let m;
      while ((m = e.re.exec(text)) !== null) {
        if (!m[0]) {
          e.re.lastIndex++;
          continue;
        }
        found.push({ start: m.index, end: m.index + m[0].length, text: m[0], entry: e });
        if (found.length >= 4000) break;
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let cursor = 0;
    for (const hit of found) {
      if (hit.start < cursor) continue;
      out.push(hit);
      cursor = hit.end;
    }
    return out;
  }

  /**
   * 点击点是否真的落在某个矩形（单词在屏幕上占的框）里。
   * caretRangeFromPoint 在空白处也会「吸附」到最近的文字，所以拿到单词后必须再核对一次，
   * 否则点行尾空白、段落间距都会弹出查词卡片。pad 给一点点容差，免得点在字的边缘点不中。
   */
  function pointInRects(x, y, rects, pad = 2) {
    for (const r of rects || []) {
      if (!r || r.width === 0 || r.height === 0) continue;
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true;
    }
    return false;
  }

  /** 拖选的内容至少要有一个字母（拖过一片空白 / 标点不算选中了词），并且不能太长 */
  function isLookupSelection(text) {
    const t = String(text || "").trim();
    return t.length > 0 && t.length <= 120 && /\p{L}/u.test(t);
  }

  /** ECDICT 的释义里换行存成了字面的 "\\n"，显示前还原成真换行 */
  function cleanTranslation(s) {
    return String(s || "").replace(/\\n/g, "\n").trim();
  }

  /* ---------------- 下面这批纯函数为 P31 侧栏准备 ---------------- */

  /** 各种空白（含 &nbsp;）压成一个空格并 trim —— 与 src/lib/web-anchor.ts 同规则 */
  function normalizeBlockText(s) {
    return String(s == null ? "" : s)
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
  }

  /**
   * 把「块原文里的下标」换算成 normalizeBlockText 之后的下标。
   * 网页里的换行 / 连续空格会被压成一个空格，不换算的话选区坐标会整体偏移。
   */
  function normalizedIndex(raw, at) {
    const s = String(raw || "");
    const limit = Math.max(0, Math.min(s.length, Number(at) || 0));
    let out = 0;
    let started = false;
    let i = 0;
    while (i < limit) {
      if (/[\s\u00a0]/.test(s[i])) {
        while (i < s.length && /[\s\u00a0]/.test(s[i])) i++;
        if (!started) continue; // 开头的空白会被 trim 掉
        out += 1;
        if (limit < i) return out - 1; // 目标落在空白段中间：指向这个空格
        continue;
      }
      started = true;
      out += 1;
      i++;
    }
    return out;
  }

  /** 取 [start, end) 所在的整句（按 . ! ? … 切），用作「同一句连续请教」的 key */
  function sentenceAround(text, start, end) {
    const s = String(text || "");
    const a = Math.max(0, Math.min(s.length, start | 0));
    const b = Math.max(a, Math.min(s.length, end | 0));
    const isStop = (ch) => ch === "." || ch === "!" || ch === "?" || ch === "…";
    let from = a;
    while (from > 0 && !isStop(s[from - 1])) from--;
    let to = b;
    while (to < s.length && !isStop(s[to])) to++;
    if (to < s.length) to++;
    while (to < s.length && /["'”’)\]]/.test(s[to])) to++;
    return s.slice(from, to).trim();
  }

  /**
   * 音标归一化（移植 src/lib/text.ts）：
   * ECDICT 用的是老式记法，`'` 是主重音、`,`/`.` 是次重音、`:` 是长音符，
   * 而且常把两个变体塞在一格里 —— 只取第一个。
   */
  const PHONETIC_FIXES = [
    [/ә/g, "ə"],
    [/є/g, "ɛ"],
    [/ε/g, "ɛ"],
    [/ˊ/g, "ˈ"],
    [/\u00a0/g, " "],
    [/（/g, "("],
    [/）/g, ")"],
    [/；/g, ";"],
    [/，/g, ","],
    [/[\uE000-\uF8FF]/g, ""],
  ];

  function normalizePhonetic(raw) {
    if (!raw) return "";
    let out = String(raw);
    for (const [from, to] of PHONETIC_FIXES) out = out.replace(from, to);
    return out
      .split(/\s+/)[0]
      .replace(/'/g, "ˈ")
      .replace(/[,._]/g, "ˌ")
      .replace(/:/g, "ː")
      .replace(/^[ˌ]+/, (m) => (m.length > 1 ? "ˌ" : m))
      .replace(/[ˌ.]+$/, "")
      .trim();
  }

  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /**
   * 极小的 Markdown 渲染（侧栏 AI 回答用）：**粗体**、换行、`- ` 列表、
   * 以「释义：」开头的行加粗。
   *
   * 安全要求：**先转义 HTML 再做替换**，绝不能把模型输出直接塞进 innerHTML。
   * 返回的是转义后的 HTML 字符串，插进 innerHTML 不会执行任何标记。
   */
  function renderMarkdown(text) {
    const src = String(text == null ? "" : text).replace(/\\n/g, "\n");
    const lines = src.split(/\r?\n/);
    const out = [];
    let inList = false;
    const closeList = () => {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    };
    const inline = (line) =>
      escHtml(line).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        closeList();
        out.push('<div class="rf-gap"></div>');
        continue;
      }
      if (/^[-•]\s+/.test(line)) {
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push(`<li>${inline(line.replace(/^[-•]\s+/, ""))}</li>`);
        continue;
      }
      closeList();
      if (/^释义\s*[：:]/.test(line)) {
        out.push(`<p class="rf-gloss-line"><b>${inline(line)}</b></p>`);
      } else {
        out.push(`<p>${inline(line)}</p>`);
      }
    }
    closeList();
    return out.join("");
  }

  return {
    buildEntries,
    findMatches,
    escapeRegex,
    pointInRects,
    isLookupSelection,
    cleanTranslation,
    normalizeBlockText,
    normalizedIndex,
    sentenceAround,
    normalizePhonetic,
    renderMarkdown,
    escHtml,
  };
});
