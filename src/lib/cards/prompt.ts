/**
 * 出题指令。纯函数。
 *
 * 用户 2026-11-16 定稿的出题哲学：
 * - 卡不是语法游戏。目的只有两个：①积累能在雅思/托福口语和日常沟通里真正用出来的表达；
 *   ②针对难句型，让用户反复输出。所有题都要求用户自己产出英文。
 * - 参考雅思、托福等海外考试的口语/写作任务来设计题，不参考国内考试。
 * - 例句不必和文章原句一样：从原文里挑一个口语中真用得上的短语，用它造一个新句子来考。
 * - 背面参考说法一律配语音（由系统自动完成，不写进 JSON）。
 */
import type { ExamFamily } from "./style";

export type CardPromptInput = {
  /** 考试风格 / 水平的个性化段落（style.ts 的 stylePromptLines）；不传不写 */
  styleLines?: string;
  /** 学生档案文本（P32 buildLearnerBlock 的产物；缓存命中时必须是缓存里那份） */
  learnerBlock: string;
  /** 原句所在的整段原文（用于挑出口语实用短语造新句）；非必填 */
  sourceParagraph?: string;
  /** 这个词在其他文章里查过几次（观察信息） */
  otherTextLookups: number;
  /** 这个词是否已推送过卡片（观察信息） */
  cardedBefore: boolean;
  /** 学生的考试目标；null 时不给考试风格标签 */
  examFamily?: ExamFamily | null;
};

/** 两类目的 + 禁止语法游戏，逐条写给出题请求 */
const PURPOSE = `出题的目的只有两个，每个决定都要回到这两条：
1. 积累实用表达：挑那些在雅思/托福口语、写作或日常英文沟通里真用得上的词和短语，
   目标是学生能在真实交流里主动说出来，不是认得它、不是会做一道题。
2. 强化难点句型：对结构难、容易说错的句子，让学生反复把它说出来、写出来。

绝对不要出成语法游戏。不要四选一辨义、不要挖介词或搭配词、不要判断指代或正误、
不要补全原句里的一个词、不要填空——这些都是「认得就算会」的识别题，考完就忘。
每张卡的正面都必须让学生自己产出一段英文（说或写），背面给参考说法让他对照。`;

const PARTS = `你能用的零件：
正面：中文场景或中文句子（text）、题目指令（instruction）、可选的整句音频（audio，先听再说）。
背面：英文参考说法（sentence）、解析或用法说明（text）、整句中文意思（sentenceMeaning）、句子主干（structure）、补充例句（example）。
提示层：可以在正面和背面之间给一句中文提示或目标词，但提示不能直接写出背面的英文答案。
系统会自动给背面每一句英文配上发音，学生说完点开听、自己对照。你不用写任何音频相关的块（除了正面可选的整句音频）。`;

/** 四种输出题型，对标雅思口语 Part 1/2/3 与托福口语独立/综合题、写作造句 */
const MENU = `出题菜单（都是输出题，从里面挑适合这个词的）：
- 回译 back_translate：正面 = 这句话的中文（text）+ 指令「用英文说出这句话」；提示层可给目标词或关键短语；背面 answer = 对应的英文句子（sentence，source: "original" 或 "paraphrase"）。适合意思清楚、句子不太长的表达。原句超过 35 个词时不要用回译。
- 情景说一句 situation_say：正面 = 一个贴近日常、工作、学习或雅思口语话题的中文场景（text，不编造人名和具体事实）+ 指令「用 X 说一句」；背面 answer = 2～3 组「英文参考说法（sentence，source: "paraphrase"）+ 它的中文（text）」。适合口语里常用的词，参考雅思口语 Part 1/3 的问答场景。
- 换个说法 rephrase：正面 = 一句意思相同、用词更简单、不含目标词的英文（sentence，source: "paraphrase"）+ 指令「用 X 改写这句话」；背面 answer = 用上目标词的改写句（sentence，source: "paraphrase"），explanation 里可以放原句作对照。适合书面表达和难句型的替换练习。
- 搭配与用法 usage：正面 = 一个中文语义或场景（text）+ 指令「你想用 X 怎么说？」；背面 answer = 2～3 组「常用搭配或句型（text）+ 一个短例句（sentence，source: "paraphrase"）+ 例句的中文（text）」。适合动词短语、固定搭配、容易用错介词的词。
- 自定义 custom：上面四种都不合适时，自己设计一道输出题（customLabel ≤6 个字），同样必须让学生产出英文、背面给参考说法。例如「按提示补全一段口语回答」「把这句中文讲给外国朋友听」。`;

const COMPOSE = `组卡规则：
- 出几张由你按这个词决定：口语里常用、用法多的可以出 2～3 张（一个偏日常说、一个偏考试话题、一个偏难句型）；简单的词一张就够。不要为凑数出卡。
- 至少让这个词的「实用表达」和「输出练习」都有体现，但同一个意思不要换着法子问三遍。
- 一张卡只练一个点；正面不泄露背面的英文答案。
- 专有名词、产品名、人名，或对学生太简单、太生僻、口语里根本用不上的词，不出卡。

例句怎么造（重要）：
- 参考说法不要求和文章原句一模一样。相反，要挑原文里那个在口语中有用的短语，
  放到一个全新的、贴近真实交流的句子里，让学生在语境里学会用它。
- 例如原文是「pi comes with most creature comforts you're used to from other tools」，
  口语里有用的是 creature comforts，就可以出题让学生说
  "After a long trip, I really appreciate the creature comforts of home."
  而不是把原句原封不动搬上来。
- 新造的句子必须自然、地道、确实用得上目标词或那个短语；不编造出处，不写生僻场景。
- 只有 kind = back_translate 且原句本身就是一句好的口语句时，才直接用原句；
  原句太长、太书面、太技术化时，用 paraphrase 造新句。`;

const JSON_FORMAT = `只输出 JSON，格式如下（TypeScript 类型）：
\`\`\`
type Block =
  | { t: "sentence"; source: "original" | "paraphrase"; text: string }
  | { t: "instruction"; text: string }
  | { t: "audio"; of: "word" | "sentence"; text: string }
  | { t: "text"; text: string; emphasis?: string[] };

type CardSpec = {
  kind: "back_translate" | "situation_say" | "rephrase" | "usage" | "custom";
  customLabel?: string;         // kind = custom 时的题型名（≤6 个字）
  target: string;               // 这张卡练的表达（≤30 个字），不出现在卡面上
  front: Block[];
  hints?: Block[];
  back: {
    answer: Block[];            // 必须有至少一句英文 sentence
    sentenceMeaning?: string;   // 整句中文意思
    structure?: string;         // 难句型的主干说明
    example?: { en: string; zh: string };
  };
};
\`\`\`
约束：
- 不允许 choice、fill 块，不允许 sentence 上带 mark（挖空 / 高亮）——那些是识别题，不是输出题。
- source: "original" 的 sentence 必须逐字来自原文；自己造的句子一律用 source: "paraphrase"。
- 只用上面列的 kind；不认识的类型会被丢弃。
- 返回 { "cards": CardSpec[] }，张数由你按组卡规则决定。`;

export function buildCardPrompt(input: CardPromptInput): string {
  const obs: string[] = [];
  if (input.otherTextLookups > 0) {
    obs.push(`这个词在其他文章里也查过 ${input.otherTextLookups} 次`);
  }
  if (input.cardedBefore) {
    obs.push("这个词已经做过卡（已推送到墨墨），又查了一次——优先出情景说一句或换个说法，不要重复上一次的题型");
  }

  const learner = input.learnerBlock.trim()
    ? `${input.learnerBlock.trim()}\n\n`
    : "";
  const obsBlock = obs.length > 0 ? `观察：\n${obs.map((o) => `- ${o}`).join("\n")}\n\n` : "";
  const source = input.sourceParagraph?.trim()
    ? `原文段落（从中挑口语实用短语造新句）：\n${input.sourceParagraph.trim()}\n\n`
    : "";

  return `${learner}${obsBlock}请为这个词出记忆卡，帮学生把它变成能在口语和写作里真正用出来的表达。学生是中文母语者，正在读英文文章。

${PURPOSE}

${PARTS}

${MENU}

${COMPOSE}

${source}${input.styleLines ? input.styleLines.trim() + "\n\n" : ""}${JSON_FORMAT}`;
}
