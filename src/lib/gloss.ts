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

/** 句子地图的起始标记：emoji 句型标签 / 易错点 / 指代提示 / 显式标题 */
const SENTENCE_MAP = /^\s*(?:🧩|⚠️|🔗|📐|句子地图|Sentence map)/i;

/** 带成分标注的英文原句行（如 `The problem（主语） is（系动词） ...`），离开原句没有意义 */
const LABELLED_SENTENCE =
  /[（(]\s*(?:主语|谓语|宾语|表语|定语|状语|补语|系动词|存疑|subject|object|predicate|linking verb|uncertain)/i;

/**
 * 从 AI 释义全文里提炼**可脱离原句**的短释义，用于 `user_words.translation`
 * 和墨墨卡片背面（P10）。
 *
 * 新版 AI 释义贴死在语境上：第一段帮学生把句子读顺，殿后的「句子地图」把原句
 * 放出来做成分标注。整段塞进卡片背面，复习时看到的是一堆脱离原文的 emoji 和
 * 英文标注行，既没意义也误导。因此：
 * - `contexts.ai_gloss` 仍存全文，回看批注时原样展示；
 * - 词库 / 卡片只取主体段，剔除句子地图、成分标注行、降级提示与 Markdown 记号；
 * - 词典查得到时优先用词典释义，本函数只在词典未收录时兜底（见 /api/words）。
 *
 * 纯函数、确定性、无副作用；提炼不出内容时返回 undefined，由调用方用占位符。
 */
export function cardGloss(raw: string | null | undefined, cap = 100): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  // 无模型 / 出错时的提示文案不是释义，不能进词库
  if (raw.includes("还没有配置 AI 模型") || raw.includes("[Error:")) return undefined;

  const lines = raw
    .replace(/```[\s\S]*?```/g, " ")
    // ECDICT 导入时把真实换行存成字面量 \n，两种都要当分隔
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((s) => s.trim());

  // 句子地图一旦开始，后面整块丢弃
  const mapAt = lines.findIndex((l) => SENTENCE_MAP.test(l));
  const head = mapAt >= 0 ? lines.slice(0, mapAt) : lines;

  const prose = head
    .filter(Boolean)
    .filter((l) => !LABELLED_SENTENCE.test(l))
    .filter((l) => !/^\*\*[^*]{1,30}\*\*$/.test(l)) // 旧三段式的纯小标题
    .filter((l) => !/^#{1,6}\s/.test(l))
    .map((l) =>
      l
        .replace(/[#*>`_]/g, "")
        .replace(/^\s*[-•]\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);

  const out = prose.join(" ").trim();
  if (!out) return undefined;
  return out.length > cap ? `${out.slice(0, cap)}…` : out;
}
