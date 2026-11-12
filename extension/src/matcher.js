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

  return { buildEntries, findMatches, escapeRegex, pointInRects, isLookupSelection, cleanTranslation };
});
