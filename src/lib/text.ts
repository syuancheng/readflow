/**
 * 纯文本清洗。没有依赖，服务端和客户端都能引。
 *
 * ECDICT 的 CSV 用**字面量** `\n`（反斜杠 + n）分隔多行释义，不是真实换行。
 * 不还原的话，界面上会看到 "n. 夜, 夜晚\n[法] 夜" 这种东西，
 * 而卡片里 `\n` 会被当成普通文字渲染出来。
 */
export function normalizeTranslation(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .trim();
}

/** 释义切成多行，用于列表项 */
export function translationLines(raw: string | null | undefined): string[] {
  return normalizeTranslation(raw)
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 音标里混进来的「长得像 IPA 但不是」的字符。
 *
 * ECDICT 由多个来源合并，schwa 这一位上污染最严重：真正的 IPA `ə`(U+0259)
 * 只有 5.8 万条，而西里尔字母 `ә`(U+04D9) 有 15 万条 —— 也就是**七成的
 * schwa 是假的**。肉眼几乎看不出区别，但字体渲染、复制粘贴、搜索都不同。
 *
 * 其余几个同理：`є`(西里尔) / `ε`(希腊) 都是 ε 的替身，`ˊ` 是重音记号的变体。
 * 私有区字符（U+E000–U+F8FF）一定是转换过程的乱码，直接丢掉。
 */
const PHONETIC_FIXES: [RegExp, string][] = [
  [/ә/g, "ə"], // U+04D9 西里尔 → U+0259 IPA
  [/є/g, "ɛ"], // U+0454 西里尔 → U+025B
  [/ε/g, "ɛ"], // U+03B5 希腊   → U+025B
  [/ˊ/g, "ˈ"], // U+02CA       → U+02C8
  [/ /g, " "], // NBSP
  [/（/g, "("],
  [/）/g, ")"],
  [/；/g, ";"],
  [/，/g, ","],
  [/[\uE000-\uF8FF]/g, ""], // 私有区乱码
];

/**
 * 统一音标写法。
 *
 * ECDICT 的音标是混着来的：绝大多数条目用 `'glisn` 这种 ASCII 重音记号，
 * 少数条目（多为变形词）用真正的 IPA `ˈglɪsənd`。直接塞进 `/.../` 里，
 * 前者会显示成 `/'glisn/`，看起来像坏了。
 *
 * 这里只做符号替换，不猜音值：' -> ˈ、, -> ˌ（ECDICT 用逗号表示次重音）。
 * 已经带 IPA 重音符号的不会被改到。
 */
export function normalizePhonetic(raw: string | null | undefined): string {
  if (!raw) return "";

  let out = raw;
  for (const [from, to] of PHONETIC_FIXES) out = out.replace(from, to);

  return out
    .replace(/'/g, "ˈ")
    .replace(/,/g, "ˌ")
    .replace(/\s+/g, " ")
    .trim();
}
