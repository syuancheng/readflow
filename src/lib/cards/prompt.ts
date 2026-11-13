/**
 * 出题指令（P33 spec §7.3 第 6 步）。纯函数。
 * 必须包含：零件清单与限制、PRD §5 全部原则、示例菜单（不受限制）、
 * 学生档案、考试风格规则、听力开关说明、1~3 张、JSON 格式。
 */

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
};

/** PRD §5 的全部原则，逐字转写给出题请求 */
const PRINCIPLES = (listening: boolean) => `出题必须遵守的原则（PRD §5）：
1. 每张卡的正面必须包含一个句子（原句、改写句${listening ? "或整句音频" : ""}）。禁止「正面只有单词、背面只有中文释义」。
2. 每张卡只考一个、能判断对错的点。
3. 正面不泄露答案：题干里不能出现目标词的中文意思，也不能有能直接推出答案的线索。
4. 解释放在背面；你补充的内容（改写句、例句、助记）必须和原文区分开，不编造出处。
5. 选择题有且只有一个正确答案（多选题除外）。
6. 英文质量：原句一字不改地引用；你写的英文必须拼写正确、语法正确、表达地道。
7. 只输出卡片的**内容与结构**（JSON），不要写任何墨墨格式语法。
8. 词汇量边缘的词值得做卡；专有名词、产品名、人名、对他太简单或太生僻的词不值得。`;

const PARTS = `你能用的零件（每种零件的限制）：
正面：原句（可对目标词高亮或挖空）、改写句、题目指令、单选或多选题、填空。
背面：正确答案、解析、整句翻译或大意、句子主干、补充例句。
提示层：可以在正面和背面之间加一层提示（中文提示或首字母）。复习时先只看到正面，点一下出提示，再点一下出答案——所以提示不能直接写出答案。`;

const PARTS_LISTENING = `你能用的零件（每种零件的限制）：
正面：原句（可对目标词高亮或挖空）、改写句、单词音频、整句音频、题目指令、单选或多选题、填空（可以多个空）。
背面：正确答案、解析、整句翻译或大意、句子主干、补充例句、发音音频。
提示层：可以在正面和背面之间加一层提示（中文提示或首字母）。复习时先只看到正面，点一下出提示，再点一下出答案——所以提示不能直接写出答案。`;

const MENU = `示例菜单（参考，不是限制——你可以组合出新卡型，但必须遵守上面的原则）：
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
  kind: "context_meaning" | "word_completion" | "paraphrase_fill" | "sentence_understanding"
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
- 一个词做 1~3 张卡。返回 { "cards": CardSpec[] }。`;

export function buildCardPrompt(input: CardPromptInput): string {
  const parts = input.listeningEnabled ? PARTS_LISTENING : PARTS;
  const menu = input.listeningEnabled ? MENU_LISTENING : MENU;

  const obs: string[] = [];
  if (input.otherTextLookups > 0) {
    obs.push(`这个词在其他文章里也查过 ${input.otherTextLookups} 次`);
  }
  if (input.cardedBefore) {
    obs.push("这个词已经做过卡（已推送到墨墨），又查了一次——建议出更难的回想类题目（填空、听写）");
  }

  const learner = input.learnerBlock.trim()
    ? `${input.learnerBlock.trim()}\n\n`
    : "";

  const obsBlock = obs.length > 0 ? `观察：\n${obs.map((o) => `- ${o}`).join("\n")}\n\n` : "";

  return `${learner}${obsBlock}请为这个词出考试题型的记忆卡。学生是中文母语者，正在读英文文章。

${parts}

${PRINCIPLES(input.listeningEnabled)}

${menu}

${input.styleLines ? input.styleLines.trim() + "\n\n" : ""}${JSON_FORMAT}`;
}
