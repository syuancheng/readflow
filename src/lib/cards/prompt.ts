/**
 * 出题指令（P33 spec §7.3 第 6 步；P35 spec §4.1 改写）。纯函数。
 * 必须包含：零件清单与限制、PRD §5 全部原则、题型菜单（使用类为主，考试题型只给有考试目标的学生）、
 * 组卡规则（张数由 AI 决定，不写固定数字）、学生档案、听力开关说明、JSON 格式。
 */
import type { ExamFamily } from "./style";

export type CardPromptInput = {
  /** 考试风格 / 水平的个性化段落（style.ts 的 stylePromptLines）；不传不写 */
  styleLines?: string;
  /** 学生档案文本（P32 buildLearnerBlock 的产物；缓存命中时必须是缓存里那份） */
  learnerBlock: string;
  /** 听力零件是否开放 */
  listeningEnabled: boolean;
  /** 这个词在其他文章里查过几次（spec §7.1 观察信息） */
  otherTextLookups: number;
  /** 这个词是否已推送过卡片（spec §7.1 观察信息） */
  cardedBefore: boolean;
  /** P35：学生的考试目标；null 时不给考试题型菜单 */
  examFamily?: ExamFamily | null;
};

/** PRD §5 的全部原则，逐字转写给出题请求 */
const PRINCIPLES = (listening: boolean) => `出题必须遵守的原则（PRD §5）：
1. 每张卡的正面必须包含一个句子（原句、改写句${listening ? "或整句音频" : ""}）。禁止「正面只有单词、背面只有中文释义」。
2. 每张卡只练一个词或短语。认识类卡只考一个能判断对错的点；使用类卡（回译、情景说一句、换个说法、搭配与用法）背面给参考说法，学生自己对照。
3. 正面不泄露答案。认识类卡的题干不能出现目标词的中文意思，也不能有能直接推出答案的线索；使用类卡的正面可以出现目标词和整句的中文意思，但不能出现背面的英文参考说法。
4. 解释放在背面；你补充的内容（改写句、例句、助记）必须和原文区分开，不编造出处。
5. 选择题有且只有一个正确答案（多选题除外）。
6. 英文质量：原句一字不改地引用；你写的英文必须拼写正确、语法正确、表达地道。
7. 只输出卡片的**内容与结构**（JSON），不要写任何墨墨格式语法。
8. 词汇量边缘的词值得做卡；专有名词、产品名、人名、对他太简单或太生僻的词不值得。`;

const PARTS = `你能用的零件（每种零件的限制）：
正面：原句（可对目标词高亮或挖空）、改写句、题目指令、单选或多选题、填空。
背面：正确答案、解析、整句翻译或大意、句子主干、补充例句。
提示层：可以在正面和背面之间加一层提示（中文提示或首字母）。复习时先只看到正面，点一下出提示，再点一下出答案——所以提示不能直接写出答案。
背面的每一句英文，系统都会自动配上发音，学生说完以后点开听、对照自己说得对不对。你不用写任何发音相关的块。`;

const PARTS_LISTENING = `你能用的零件（每种零件的限制）：
正面：原句（可对目标词高亮或挖空）、改写句、单词音频、整句音频、题目指令、单选或多选题、填空（可以多个空）。
背面：正确答案、解析、整句翻译或大意、句子主干、补充例句、发音音频。
提示层：可以在正面和背面之间加一层提示（中文提示或首字母）。复习时先只看到正面，点一下出提示，再点一下出答案——所以提示不能直接写出答案。
背面的每一句英文，系统都会自动配上发音，学生说完以后点开听、对照自己说得对不对。你不用写任何发音相关的块。`;

/** P35 默认题型：用句子学词、练开口（PRD F1） */
const MENU_PRODUCTIVE = `默认题型（使用类，优先出这些）：
- 回译 back_translate：正面 = 原句的中文意思（text）+ 指令「用英文说出这句话」（instruction）；提示层可放目标词（text）；背面 answer = 原句（sentence，source: "original"，目标词 highlight）。原句超过 35 个词时不要出回译。
- 情景说一句 situation_say：正面 = 一个贴近日常、工作或学习的中文场景（text，不编造人名和事实）+ 指令「用 X 说一句」；背面 answer = 2～3 组「英文参考说法（sentence，source: "paraphrase"，每句都用上目标词）+ 它的中文（text）」。
- 换个说法 rephrase：正面 = 一句意思相同、用词更简单、不含目标词的英文（sentence，source: "paraphrase"）+ 指令「用 X 改写这句话」；背面 answer = 用上目标词的改写句（sentence，source: "paraphrase"），explanation 里可以放原句作对照。
- 搭配与用法 usage：正面 = 原句（目标词 highlight）+ 指令「它常和哪些词连用？先自己想两个」；背面 answer = 2～3 组「搭配或句型（text）+ 一个短例句（sentence，source: "paraphrase"）+ 例句的中文（text）」，有易错点时在 explanation 里写一句。`;

/** P35：只需要认识、不太会主动用的词，才出认识类卡 */
const MENU_RECOGNITION = `认识类（只给「只需要认识、不太会主动用」的词，比如文学用词、生僻词、专有领域的术语）：
- 语境理解 context_meaning：原句，目标词高亮，选出最接近的意思 → 答案和每个选项的解析
- 分层提示 layered_cloze：原句挖空 → 提示（中文或首字母）→ 答案和解析`;

const COMPOSE = `组卡规则：
- 出几张由你按这个词决定：难的、用法多的可以多出几张，简单的一张就够。不要为了凑数出卡。
- 至少要有一张使用类卡。
- 回译适合大多数词；原句太长或结构太复杂时，换成情景说一句。
- 情景说一句更适合口语里常用的词，换个说法更适合偏书面的词；用法丰富的词两种都可以出。
- 搭配与用法只给搭配特征明显的词，比如动词短语、固定搭配，或者容易用错介词的词。`;

const MENU = `考试题型（学生在备考，最后再加一张考试风格的卡，从下面选；也可以组合出新卡型，但必须遵守上面的原则）：
- 语境理解（托福阅读词汇题）：原句，目标词高亮，「…is closest in meaning to」四选一 → 答案和每个选项的解析
- 原句补全（新托福 Complete the Words）：原句中目标词只露出前半部分，填出完整的词 → 完整原句和释义
- 改写填空（雅思 Sentence Completion）：换一种说法的句子，留一到两个词的空 → 答案和原句对照
- 整句理解（托福句子简化题 / 雅思 True/False/Not Given）：难句，选出最准确的改写，或判断一个陈述 → 整句大意和句子主干
- 指代（托福指代题）：句中的 it / this / they 指的是什么，四选一 → 答案和指代关系说明
- 搭配挖空：原句挖掉介词或搭配词 → 完整搭配和用法
- 分层提示：原句挖空 → 提示（中文或首字母）→ 答案和解析`;

const MENU_LISTENING = MENU + `
- 听句填空（雅思听力填空）：整句音频 + 这句的文字，目标词位置留空 → 答案
- 听音选词：一句话的音频（不显示文字），选出句中出现的那个词，选项是发音相近的词 → 正确的词、音标、原句`;

const JSON_FORMAT = `只输出 JSON，格式如下（TypeScript 类型）：
\`\`\`
type Block =
  | { t: "sentence"; source: "original" | "paraphrase"; text: string;
      mark?: { start: number; end: number; as: "highlight" | "blank" | "prefix"; keep?: number } }
  | { t: "instruction"; text: string }
  | { t: "choice"; multi?: boolean; options: { text: string; correct: boolean }[] }
  | { t: "fill"; answer: string; hint?: string }
  | { t: "audio"; of: "word" | "sentence"; text: string }
  | { t: "text"; text: string; emphasis?: string[] };

type CardSpec = {
  kind: "back_translate" | "situation_say" | "rephrase" | "usage"
       | "context_meaning" | "word_completion" | "paraphrase_fill" | "sentence_understanding"
       | "true_false_ng" | "reference" | "collocation" | "listen_fill" | "listen_choose"
       | "layered_cloze" | "paragraph_cloze" | "custom";
  customLabel?: string;         // kind = custom 时的题型名（≤6 个字）
  examStyle?: string | null;    // 例如「托福 · 词汇题」
  target: string;               // 这张卡考的是什么（≤30 个字），不出现在卡面上
  front: Block[];
  hints?: Block[];              // 可选的提示层
  back: {
    answer: Block[];
    explanation?: Block[];
    sentenceMeaning?: string;
    structure?: string;
    example?: { en: string; zh: string };
    audio?: ("word" | "sentence")[];
  };
};
\`\`\`
约束：
- mark 的 start / end 是相对 sentence.text 的字符下标，[start, end)。
- as: "blank" 或 "prefix" 时盖住的部分必须是目标词本身。
- source: "original" 的 text 必须逐字来自用户消息里给出的原句。
- choice 的选项 3~5 个；单选恰好一个 correct。
- examStyle 不用填，由系统按学生的备考目标决定。
- 返回 { "cards": CardSpec[] }，张数由你按组卡规则决定。`;

export function buildCardPrompt(input: CardPromptInput): string {
  const parts = input.listeningEnabled ? PARTS_LISTENING : PARTS;
  const examMenu = input.examFamily ? (input.listeningEnabled ? MENU_LISTENING : MENU) : "";
  const menu = [MENU_PRODUCTIVE, MENU_RECOGNITION, examMenu].filter(Boolean).join("\n\n");

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

  return `${learner}${obsBlock}请为这个词出记忆卡，帮学生通过句子学会这个词的意思、用法和搭配，并练习开口说。学生是中文母语者，正在读英文文章。

${parts}

${PRINCIPLES(input.listeningEnabled)}

${menu}

${COMPOSE}

${input.styleLines ? input.styleLines.trim() + "\n\n" : ""}${JSON_FORMAT}`;
}
