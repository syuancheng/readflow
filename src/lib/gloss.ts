/** 词库释义可能是长段词典文本或 AI Markdown，插件小标签只留一行短释义 */
export function shortGloss(raw: string | null | undefined, cap = 24): string {
  if (!raw) return "";
  const lines = raw
    .replace(/```[\s\S]*?```/g, " ")
    // ECDICT 导入时把真实换行存成了字面量 \n，两种都要当分隔
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = lines
    // AI 释义里的 `**本句中的意思**` 这类纯小标题不是释义，跳过
    .filter((s) => !/^\*\*[^*]{1,24}\*\*$/.test(s) && !/^\[?\s*(phonetic|音标)/i.test(s))
    .map((s) => s.replace(/[#*>`_]/g, " ").replace(/\s+/g, " ").replace(/^\d+\.\s*/, "").trim())
    .find(Boolean) ?? "";
  return first.length > cap ? `${first.slice(0, cap)}…` : first;
}
