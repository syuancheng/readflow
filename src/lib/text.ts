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
