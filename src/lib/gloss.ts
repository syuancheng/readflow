import { isNotAGloss } from "./explain-policy";
import { defaultTurnText } from "./ai-thread";
import { splitCardSuggestion } from "./cards/suggestion";

/**
 * 词典释义开头的词性前缀：n. / vt. / adj. / abbr. 等。
 * ECDICT 的形容词、副词写作 a. / ad.，复数 pl.，也要认。
 */
const POS_PREFIX =
  /^\s*(?:n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|int|interj|num|art|aux|abbr|pl|s)\.\s*/i;

const HAS_CJK = /[\u3400-\u9fff]/;

/** AI 第一行的固定格式（P26）：「释义：超智能的」 */
const GLOSS_LINE = /^\s*释义\s*[：:]\s*(.+)$/;

/**
 * 旧答案里「选区在这句的意思」常见句式。前面带「不」的是否定（mining 在这里不是「采矿」），不能取。
 */
const SELECTION_PATTERNS = [
  /在这(?:句|里)[^「]{0,8}?(?<!不)(?:是|指|译作|意思是)「([^」]+)」/,
  /这里[^「。]{0,40}?(?<!不)是「([^」]+)」/,
  /(?<!不)(?:中文叫|中文是|译作|译为|翻译成|意思是)「([^」]+)」/,
];

/** 行内标签上限：超过就不显示，绝不截半句挂到正文上 */
const INLINE_CAP = 12;

function splitLines(raw: string): string[] {
  return raw
    .replace(/```[\s\S]*?```/g, " ")
    // ECDICT 导入时把真实换行存成了字面量 \n，两种都要当分隔
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 去掉引号 / 强调记号 / 句末标点，只留中文意思本身 */
function tidy(s: string): string {
  let out = s.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  // 「受益于」。 这类：句末标点和引号交替出现，剥到不再变化为止
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out
      .replace(/[。．.；;，,、！!？?]+$/, "")
      .replace(/^[「『“"'（(]+|[」』”"'）)]+$/g, "")
      .trim();
  }
  return out;
}

/** 只留最直接的一个说法：去掉开头的括号限定，「做出来、解得出」只取「做出来」 */
function primary(s: string): string {
  return tidy(
    s
      .replace(/^\s*[（(][^）)]{1,12}[）)]\s*/, "")
      .split(/[、／/]|\s或\s/)[0],
  );
}

function fits(s: string, cap: number): string {
  return s && HAS_CJK.test(s) && Array.from(s).length <= cap ? s : "";
}

/**
 * 从 AI 释义里取「选区在这句里的中文意思」。
 *
 * 新答案（P26 起）第一行固定是「释义：…」，直接取。之前存下的旧答案没有这一行，
 * 按老师常见的几种写法找：「X」在这句里是「Y」/ 中文叫「Y」/ 译作「Y」/ 行首「Y」——。
 * 只认**含中文**的那对引号：旧规则取第一对「」，会把英文原词 ultraintelligent 当成释义。
 * 找不到、或是整句大意这类长句时返回空，由调用方回退词典义。
 */
export function aiInlineMeaning(rawThread: string | null | undefined, cap = INLINE_CAP): string {
  // 只看默认讲解那一段：后面追问（整句没看懂 / 例句）的第一行不是这个词的意思
  // P33：先剥掉末尾的「制卡建议：」行，它不属于释义
  const raw = splitCardSuggestion(defaultTurnText(rawThread)).body;
  if (!raw || !raw.trim() || isNotAGloss(raw)) return "";
  const lines = splitLines(raw);
  for (const line of lines.slice(0, 3)) {
    const m = line.match(GLOSS_LINE);
    if (m) return fits(primary(m[1]), cap);
  }
  // 更早的答案用「**在这里的意思**」小标题：取它下面那一行的第一个分句
  const hereAt = lines.findIndex((l) => /^\**\s*在这里的意思\s*\**[：:]?$/.test(l));
  if (hereAt >= 0 && lines[hereAt + 1]) {
    const first = lines[hereAt + 1].replace(/^[*_]+|[*_]+$/g, "").split(/[，,。；;：:]/)[0];
    const g = fits(primary(first), cap);
    if (g) return g;
  }

  // 前三行里找（开头是「整句大意：」时，选区自己的意思通常在下一行）
  const candidates = lines
    .slice(0, 3)
    .filter((l) => !/^(?:整句大意|这句话的意思是|这句话是说|整句在说)/.test(l));
  for (const line of candidates) {
    // 行首「中文」——解释：老师最常见的写法，优先于句中的其它引号
    const lead = line.match(/^「([^」]+)」/);
    if (lead && HAS_CJK.test(lead[1])) return fits(primary(lead[1]), cap);
    for (const re of SELECTION_PATTERNS) {
      const m = line.match(re);
      if (m && HAS_CJK.test(m[1])) return fits(primary(m[1]), cap);
    }
  }
  return "";
}

/** 词典义：去学科标签和词性前缀，只取第一个义项 */
function dictInlineMeaning(raw: string | null | undefined, cap: number): string {
  if (!raw || !raw.trim() || isNotAGloss(raw) || raw.trim() === "(待补充释义)") return "";
  // 早期规则把 AI 答案的小标题错存成了词条释义，这些不是意思
  if (/^\**\s*(?:通常意思|在这里的意思|本句中的意思|语境义)\s*\**$/.test(raw.trim())) return "";
  const head = splitLines(raw)[0] ?? "";
  const first = head
    .replace(/[*_`#>]/g, " ")
    .replace(/^\s*\[[^\]]{1,8}\]\s*/, "") // [医] / [计] 等学科标签
    .replace(POS_PREFIX, "")
    .replace(/^[-•]\s*/, "")
    // (两者之中)任一的 → 任一的：义项前的括号限定不是意思本身
    .replace(/^\s*[（(][^）)]{1,12}[）)]\s*/, "")
    .split(/[；;，,]/)[0]
    // 帕雷托（意大利经济学家… 这类补充说明被逗号切断后括号不闭合，整段去掉
    .replace(/\s*[（(][^）)]*$/, "");
  return fits(tidy(first), cap);
}

/**
 * 正文划线上方那一行中文（P23，P26 重写）。
 *
 * 只要「这一处最直接的中文意思」，一个词或一个短语，不带任何解释。
 * 优先 AI 的「释义：」行（按这句语境译的），没有再用词典第一个义项。
 * 取不到干净的短释义就返回空 —— 宁可不显示，也不把截断的半句话挂到正文上。
 * 纯函数，无副作用，可直接单测。
 */
export function inlineGloss(
  aiGloss: string | null | undefined,
  translation: string | null | undefined,
  cap = INLINE_CAP,
): string {
  return aiInlineMeaning(aiGloss, cap) || dictInlineMeaning(translation, cap);
}

/** 词库释义可能是长段词典文本或 AI Markdown，插件小标签只留一行短释义 */
export function shortGloss(raw: string | null | undefined, cap = 24): string {
  if (!raw) return "";
  // P33：先剥掉末尾的「制卡建议：」行，它不属于释义
  const stripped = splitCardSuggestion(raw).body;
  const lines = stripped
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
export function cardGloss(rawThread: string | null | undefined, cap = 100): string | undefined {
  // 卡片背面只要这个词的意思：取默认讲解那一段，追问的内容不进卡片。
  // P33：先剥掉末尾的「制卡建议：」行，它不属于释义。
  const raw = splitCardSuggestion(defaultTurnText(rawThread)).body;
  if (!raw || !raw.trim()) return undefined;
  // 无模型 / 出错时的提示文案不是释义，不能进词库（与前端写回批注共用同一判断）
  if (isNotAGloss(raw)) return undefined;

  // P26 起 AI 第一行是「释义：…」：那就是选区的中文意思，卡片背面直接用它
  const glossLine = splitLines(raw)
    .slice(0, 3)
    .map((l) => l.match(GLOSS_LINE)?.[1])
    .find(Boolean);
  if (glossLine) {
    const g = tidy(glossLine);
    if (g) return Array.from(g).length > cap ? `${Array.from(g).slice(0, cap).join("")}…` : g;
  }

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
