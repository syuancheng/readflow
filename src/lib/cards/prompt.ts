/**
 * 出题指令。纯函数。
 *
 * 用户 2026-11-16 定稿的出题哲学：
 * - 卡不是语法游戏。目的只有两个：①积累能在雅思/托福口语和日常沟通里真正用出来的表达；
 *   ②针对难句型，让用户反复输出。所有题都要求用户自己产出英文。
 * - 参考雅思、托福等海外考试的口语/写作任务来设计题，不参考国内考试。
 * - **建卡以句子为单位**（2026-11-16 补充）：默认用户已经读懂这个句子，
 *   卡考的是「能不能把这个句子里的表达用出来」，不是这个句子是什么意思。
 *   考点优先来自用户针对这个句子问过的问题（他卡在哪里就练哪里）。
 * - 背面参考说法一律配语音（由系统自动完成，不写进 JSON）。
 */
import type { ExamFamily } from "./style";

export type CardPromptInput = {
  /** 考试风格 / 水平的个性化段落（style.ts 的 stylePromptLines）；不传不写 */
  styleLines?: string;
  /** 学生档案文本（P32 buildLearnerBlock 的产物；缓存命中时必须是缓存里那份） */
  learnerBlock: string;
  /** 要建卡的目标句子（整句，不是选区里的一个词） */
  targetSentence?: string;
  /** 原句所在的整段原文（挑口语实用短语造新句用）；非必填 */
  sourceParagraph?: string;
  /**
   * 用户针对这个句子已经问过、AI 已经讲过的内容（问题 + 回答）。
   * 这些是「用户已掌握」的背景：建卡不能重复讲，要围绕其中的难点出题。
   */
  learnedContext?: string;
  /** 这个词/句在其他文章里查过几次（观察信息） */
  otherTextLookups: number;
  /** 这条记录是否已推送过卡片（观察信息） */
  cardedBefore: boolean;
  /** 学生的考试目标；null 时不给考试风格标签 */
  examFamily?: ExamFamily | null;
};

/** 两类目的 + 禁止语法游戏，逐条写给出题请求 */
const PURPOSE = `出题的目的只有两个，每个决定都要回到这两条：
1. 积累实用表达：挑那些在雅思/托福口语、写作或日常英文沟通里真用得上的词和短语，
   目标是学生能在真实交流里主动说出来，不是认得它、不是会做一道题。
2. 强化难点句型：对结构难、容易说错的句子，让学生反复把它说出来、写出来。

默认学生已经读懂了这个句子，卡考的是「能不能把句子里的表达用出来」，不是「这句话什么意思」。
不要再把句子翻译成中文当答案，也不要再重复讲句子里的语法点。

绝对不要出成语法游戏。不要四选一辨义、不要挖介词或搭配词、不要判断指代或正误、
不要补全原句里的一个词、不要填空——这些都是「认得就算会」的识别题，考完就忘。
每张卡的正面都必须让学生自己产出一段英文（说或写），背面给参考说法让他对照。`;

const PARTS = `你能用的零件：
正面：中文场景或中文句子（text）、题目指令（instruction）、可选的整句音频（audio，先听再说）。
背面：英文参考说法（sentence）、解析或用法说明（text）、整句中文意思（sentenceMeaning）、句子主干（structure）、补充例句（example）。
提示层：可以在正面和背面之间给一句中文提示或关键表达，但提示不能直接写出背面的英文答案。
系统会自动给背面每一句英文配上发音，学生说完点开听、自己对照。你不用写任何音频相关的块（除了正面可选的整句音频）。`;

/** 四种输出题型，对标雅思口语 Part 1/2/3 与托福口语独立/综合题、写作造句 */
const MENU = `出题菜单（都是输出题，从里面挑适合这个句子的）：
- 回译 back_translate：正面 = 这句话的中文（text）+ 指令「用英文说出这句话」；提示层可给关键表达；背面 answer = 对应的英文句子（sentence，source: "original" 或 "paraphrase"）。适合意思清楚、句子不太长的表达。原句超过 35 个词时不要用回译。
- 情景说一句 situation_say：正面 = 一个贴近日常、工作、学习或雅思口语话题的中文场景（text，不编造人名和具体事实）+ 指令「用刚才句子里的 X 说一句」；背面 answer = 2～3 组「英文参考说法（sentence，source: "paraphrase"）+ 它的中文（text）」。适合口语里常用的表达，参考雅思口语 Part 1/3 的问答场景。
- 换个说法 rephrase：正面 = 一句意思相同、用词更简单的英文（sentence，source: "paraphrase"）+ 指令「用句子里的 X 改写这句话」；背面 answer = 用上那个表达的改写句（sentence，source: "paraphrase"），explanation 里可以放原句作对照。适合书面表达和难句型的替换练习。
- 搭配与用法 usage：正面 = 一个中文语义或场景（text）+ 指令「你想用句子里的 X 怎么说？」；背面 answer = 2～3 组「常用搭配或句型（text）+ 一个短例句（sentence，source: "paraphrase"）+ 例句的中文（text）」。适合动词短语、固定搭配、容易用错介词的表达。
- 自定义 custom：上面四种都不合适时，自己设计一道输出题（customLabel ≤6 个字），同样必须让学生产出英文、背面给参考说法。例如「按提示补全一段口语回答」「把这句中文讲给外国朋友听」。`;

const COMPOSE = `组卡规则：
- 出几张由你按这个句子决定：口语里常用、用法多的可以出 2～3 张（一个偏日常说、一个偏考试话题、一个偏难句型）；简单的句子一张就够。不要为凑数出卡。
- **考点优先来自学生问过的问题**：如果学生针对这个句子问过某个难点（例如某个结构、某个词为什么不能那样理解），就围绕那个难点出输出题，让他把正确的理解用出来；不要另起炉灶考无关的表达。
- 一张卡只练一个点；正面不泄露背面的英文答案。
- 专有名词、产品名、人名，或对学生太简单、太生僻、口语里根本用不上的表达，不出卡。

例句怎么造（重要）：
- 参考说法不要求和文章原句一模一样。要挑这个句子里在口语中真用得上的表达，
  放到一个全新的、贴近真实交流的句子里，让学生在语境里学会用它。
- 例如句子是「pi comes with most creature comforts you're used to from other tools」，
  口语里有用的是 creature comforts，就可以出题让学生说
  "After a long trip, I really appreciate the creature comforts of home."
  而不是把原句原封不动搬上来。
- 如果学生问过的难点是「up to 其实不是一个短语，up 属前面的动词、to 引出目的」，
  那就围绕这个难点出题（例如回译一个同类结构、或换个说法造句），
  **不要再出一道让学生用 "up to" 造句的题**——那正好考了他已经搞懂的错误理解。
- 新造的句子必须自然、地道；不编造出处，不写生僻场景。
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
    obs.push(`这句话在其他文章里也查过 ${input.otherTextLookups} 次`);
  }
  if (input.cardedBefore) {
    obs.push("这条记录已经做过卡（已推送到墨墨），又查了一次——优先出情景说一句或换个说法，不要重复上一次的题型");
  }

  const learner = input.learnerBlock.trim()
    ? `${input.learnerBlock.trim()}\n\n`
    : "";
  const obsBlock = obs.length > 0 ? `观察：\n${obs.map((o) => `- ${o}`).join("\n")}\n\n` : "";

  // 建卡的单位是「句子」，句子本身放在最显眼的位置
  const sentence = input.targetSentence?.trim()
    ? `目标句子（建卡以这个句子为单位，默认学生已读懂它的意思）：\n${input.targetSentence.trim()}\n\n`
    : "";
  // 学生问过 + AI 已讲过的内容 = 已掌握，不能重复讲，要围绕难点出题
  const learned = input.learnedContext?.trim()
    ? `学生针对这个句子已经问过、老师已经讲过的内容（学生已掌握，不要重复讲解，要围绕其中的难点出题）：\n${input.learnedContext.trim()}\n\n`
    : "";
  const source = input.sourceParagraph?.trim()
    ? `原文段落（从中挑口语实用表达造新句）：\n${input.sourceParagraph.trim()}\n\n`
    : "";

  return `${learner}${obsBlock}${sentence}${learned}请基于上面这个句子为它出记忆卡，帮学生把句子里的表达变成能在口语和写作里真正用出来的能力。学生是中文母语者，已经读懂这个句子。

${PURPOSE}

${PARTS}

${MENU}

${COMPOSE}

${source}${input.styleLines ? input.styleLines.trim() + "\n\n" : ""}${JSON_FORMAT}`;
}
