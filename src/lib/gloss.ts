import { isNotAGloss } from "./explain-policy";

/** 词典释义开头的词性前缀：n. / vt. / adj. / abbr. 等 */
const POS_PREFIX = /^\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|int|num|art|aux|abbr)\.\s*/i;

/** 解释性长句不适合当行内标签，拿不准就回退到词典义 */
const EXPLANATORY = /(?:不是|而是|这里|整句|这句话|指的是|形容|表示主语|语法)/;

function clipInline(s: string, cap: number): string {
  const chars = Array.from(s.trim());
  if (!chars.length) return "";
  return chars.length > cap ? `${chars.slice(0, cap).join("")}…` : chars.join("");
}

function cleanInline(raw: string | null | undefined, cap: number, fromAI: boolean): string {
  if (!raw || !raw.trim() || isNotAGloss(raw)) return "";
  const lines = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const head = lines[0] ?? "";
  if (!head) return "";

  // P13 的第一屏常写成「语境义」——在这里…；引号贴行首时它就是要显示的那部分
  if (fromAI) {
    const quoted = head.match(/^「([^」]{1,24})」/);
    if (quoted) return clipInline(quoted[1], cap);
    // 一整句解释（含「不是…而是…」之类）放进行内会又长又误导，让词典义兜底
    if (EXPLANATORY.test(head) || Array.from(head).length > cap + 8) return "";
  }

  const cleaned = head
    .replace(/==[^：\n]*：([^==]+)==/g, "$1")
    .replace(/==/g, "")
    .replace(/[#*>`_]/g, " ")
    .replace(/^\s*\[[^\]]{1,8}\]\s*/, "") // [医] / [计] 等学科标签
    .replace(POS_PREFIX, "")
    .replace(/^[-•]\s*/, "")
    .replace(/^\d+\.\s*/, "")
    .replace(/——[\s\S]*$/, "")
    .split(/[；;，,]/)[0]
    .replace(/\s+/g, " ")
    .trim();
  return clipInline(cleaned, cap);
}

/**
 * 正文划线上方那一行中文短释义（P23）。
 *
 * 与 cardGloss() 不同：卡片背面要「可脱离原句」，行内标签只要「这一处是什么意思」，
 * 所以更短、更保守。优先级是 AI 语境义 > 词典义 —— 同一个选区后来问过 AI 时，
 * 语境义比词典的通用释义更贴切（对齐 P13 的输出契约）。
 *
 * AI 释义形态不稳定：第一屏若是一整句解释而不是短语，宁可回退词典义，
 * 也不要把半句话截断挂到正文上。纯函数，无副作用，可直接单测。
 */
export function inlineGloss(
  aiGloss: string | null | undefined,
  translation: string | null | undefined,
  cap = 10,
): string {
  return cleanInline(aiGloss, cap, true) || cleanInline(translation, cap, false);
}

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
    .map((s) =>
      s
        // P15：==成分：主干== → 主干（去掉成分标签，避免卡片背面残留「主语：」）
        .replace(/==[^：\n]*：([^==]+)==/g, "$1")
        .replace(/==/g, " ")
        .replace(/[#*>`_]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\d+\.\s*/, "")
        .trim(),
    )
    .find(Boolean) ?? "";
  return first.length > cap ? `${first.slice(0, cap)}…` : first;
}

/** 句子地图的起始标记：emoji 句型标签 / 易错点 / 指代提示 / 显式标题 */
const SENTENCE_MAP = /^\s*(?:🧩|⚠️|🔗|📐|句子地图|Sentence map)/i;

/** 成分标注记号。P13 起地图改用 ==主干== 下划线，这里主要兼容 P13 之前存的历史释义 */
const CONSTITUENT_MARK =
  /[（(]\s*(?:主语|谓语|宾语|表语|定语|状语|补语|系动词|存疑|subject|object|predicate|linking verb|uncertain)/gi;

/**
 * 带成分标注的英文原句行（如 `The problem（主语） is（系动词） ...`），离开原句没有意义。
 *
 * 判据是「≥2 处标注」，不能只凭出现一次「（主语」就删整行：老师有时会在主体段里
 * 顺手写一句「（主语 The tradition 是单数）」，那仍是释义。只删一行就会把卡片背面
 * 变成后半段的语法说明，反而更没用。
 */
function isLabelledSentence(line: string): boolean {
  return (line.match(CONSTITUENT_MARK) ?? []).length >= 2;
}

/**
 * 从 AI 释义全文里提炼**可脱离原句**的短释义，用于 `user_words.translation`
 * 和墨墨卡片背面（P10）。
 *
 * 新版 AI 释义第一屏给的是「选区在这句话里的中文意思」，殿后的「句子地图」把原句
 * 放出来、只给主干加 ==下划线==。整段塞进卡片背面，复习时看到的是一堆脱离原文的
 * emoji 和英文标注行，既没意义也误导。因此：
 * - `contexts.ai_gloss` 仍存全文，回看批注时原样展示；
 * - 词库 / 卡片只取主体段，剔除句子地图、成分标注行、降级提示与 Markdown 记号；
 * - 词典查得到时优先用词典释义，本函数只在词典未收录时兜底（见 /api/words）。
 *
 * 纯函数、确定性、无副作用；提炼不出内容时返回 undefined，由调用方用占位符。
 */
export function cardGloss(raw: string | null | undefined, cap = 100): string | undefined {
  if (!raw || !raw.trim()) return undefined;
  // 无模型 / 出错时的提示文案不是释义，不能进词库（与前端写回批注共用同一判断）
  if (isNotAGloss(raw)) return undefined;

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
    .filter((l) => !isLabelledSentence(l))
    .filter((l) => !/^\*\*[^*]{1,30}\*\*$/.test(l)) // 旧三段式的纯小标题
    .filter((l) => !/^#{1,6}\s/.test(l))
    .map((l) =>
      l
        // P15：==成分：主干== → 主干（去掉成分标签）
        .replace(/==[^：\n]*：([^==]+)==/g, "$1")
        .replace(/==/g, "")
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
