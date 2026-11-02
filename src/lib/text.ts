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
  return raw
    .replace(/'/g, "ˈ")
    .replace(/,/g, "ˌ")
    .replace(/\s+/g, " ")
    .trim();
}
