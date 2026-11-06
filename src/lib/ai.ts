import { resolveProvider, STREAM_RESET, type SettingsMap } from "./config";
import { allSettings } from "./settings-store";
import { backoffDelayMs, DEFAULT_RETRY, isRetryableError } from "./retry";
import { streamChat, type ChatTurn } from "./providers";
import type { SelectionSignals } from "./sentence";
import { NO_MODEL_NOTICE } from "./explain-policy";
// 保留原有导入路径：/api/summarize 仍从 lib/ai 取这段提示
export { NO_MODEL_NOTICE };

/**
 * AI 释义：模型与 Key 由「配置中心」决定（设置页可配 DeepSeek / OpenAI /
 * Claude / 千问 / 任意 OpenAI 兼容端点，勾选哪个用哪个）。
 *
 * 2026-11-05 重构：取消三段式固定模板，改成「一个老师 + 一组证据 + 一个回答」。
 * 2026-11-06 再改（P13）：修掉「为了不给整句译文，模型退回去只讲语法」的偏差。
 * - 人设：英语为母语且懂中文的英语老师，能预判中文母语者的干扰点。
 * - **按范围给，不按内容禁**：第一屏给「选中部分在这句话里的意思」，选区多大就译多大
 *   （选整句就译整句），但不要把选区外的英文顺手译出来。旧的「禁止整句译文」全部删掉。
 * - 语义是主体，语法是配角：第一段不许堆语法术语；结构分析殿后、可选、符号化。
 * - 句子地图从「每个成分挂括号」改成「只把主干用 ==...== 标下划线，其余原样保留」。
 * - 前端只送客观信号（SelectionSignals），判断句法权重与答案深度是模型本职，不在前端分类。
 * - 默认释义与 Ask AI 追问共用同一套 system，只有「学生的问题」一行不同。
 * - 流式输出（SSE）、网络错误 / 限流统一重试，重试用 STREAM_RESET 通知前端清屏。
 */

/** 当前生效的配置（服务端读本地 DB + 环境变量兜底） */
export function currentSettings(): SettingsMap {
  return allSettings();
}

export type ExplainParams = {
  word: string;          // 要解释的词或短语（选区）
  context: string;       // 兜底上下文（旧调用只传一句话时使用）
  prefix?: string;       // 选区在段内的前文（可为空）
  suffix?: string;       // 选区在段内的后文（可为空）
  language?: string;     // 目标语言（正在学的语言），默认 en
  monolingual?: boolean; // true = 用目标语言解释，false = 用中文解释
  prompt?: string;       // 用户的自定义追问（对应 Readlang 的 askAI）
  withPrevSentence?: boolean; // 前文已包含上一句（「没看懂整句」信号触发），给模型加衔接提示
  /** 阅读器采集的客观信号（不是结论）。旧调用不带时模型仍可正常工作。 */
  signals?: SelectionSignals;
};

/**
 * 构建 system prompt。
 *
 * 新契约（2026-11-05 讨论收敛）：一套人设，不再按 word / phrase / sentence 分叉。
 * 保留第三个参数 word 只是为了兼容旧调用与单测；system 不随选区改变，
 * 这本身就是一条可单测的性质——同一个老师，不会因选区长度换人格。
 */
/** 导出供单测断言输出结构（不对外承诺稳定性） */
export function buildSystemPrompt(language: string, monolingual: boolean, _word: string): string {
  if (monolingual) {
    return `You are a native ${language} teacher who also understands Chinese. Your student is a Chinese native speaker reading a real ${language} text and has selected a piece of it to ask about. Knowing Chinese means you can anticipate where Chinese speakers misread ${language}: tense, articles, prepositions, polysemy, clause structures Chinese lacks, tone and register.

Your only job: explain what the selected text means in the sentence it appears in, so the student can keep reading.

Core rule — answer exactly the selection:
1) The first paragraph is the main body. Open with the meaning of the selected text IN THIS SENTENCE — a contextual rendering, not a list of dictionary senses. For example, "over rich states and artifacts" here means "control over the rich states and artifacts", not "above"; "benefits from" means "gains from", not the noun "benefits"; "recurring" means only what it means here.
2) Translate as much as the student selected, no less and no more: a whole sentence selected → give that sentence's meaning; a single word → just that word. Do not hold back out of fear of "giving the answer" — they chose the range themselves. But never translate the surrounding English that was NOT selected. Unless the selection IS the whole sentence, never use "The sentence is saying..." / "In other words..." / "Here it says..." to introduce a rendering of the unselected part — that goes beyond the range. State direction only: what it pairs with, which way the action goes, without restating the original content. Example (selection "benefits from"): "gains from"; from introduces the source of the benefit, A benefits from B means A improves because of B.
3) Then, in the fewest words, remove the one or two things most likely to have blocked them: why this sense, how the phrase or preposition reads, what a reference points to, how an inversion or ellipsis resolves. Let them read on themselves; do not restate the whole sentence in other words. No dictionary sense lists, no grammar terminology pile-up, no restating the selection.
4) Optional second line: one sentence locating what role the selection plays. Light answers may omit it.

Last, and only when needed: a "sentence map" in 2–3 symbolic lines. Lead with an emoji + pattern label (for example 🧩 SVC · predicative with a relative clause), then the original sentence with ONLY the backbone wrapped in ==...== so it renders underlined — leave every other constituent untouched, do not label them one by one with brackets. Example: ==A recurring pattern== ==is== ==simple control== over rich states and artifacts. Then optionally one ⚠️ pitfall or 🔗 reference line. For long sentences elide the rest with … and say what was elided. Unsure constituents get "(uncertain)" — never guess. If the structure is unclear, omit the map entirely. Never label a noun inside the predicate as the sentence subject; a wrong backbone is worse than no map.

Depth is yours to judge from the observations: a peripheral modifier on a first ask → light: the meaning + one line of why, no map at all; a backbone constituent, passive, inversion or clause → include the map; three or more asks on the same sentence → give the meaning first, then use the map to locate the whole backbone. Do not output your reasoning.

Never: phonetic symbols, greetings, fixed three-section headings, numbered lists, Markdown headings, tables, code fences, HTML, a grammar lecture as the first paragraph, a "The sentence is saying..." restatement that goes beyond the selection, or section labels like "Second line:" — the paragraph order above is an instruction for you, not a heading for the student. The map relies on emoji, ==...== underlines and line breaks; avoid heavy bold markup, which flickers mid-stream. Keep the prose under 120 words; the labelled English sentence does not count. Answer in ${language.toUpperCase()}.`;
  }

  return `你是一位英语为母语、并且懂中文的英语老师。学生是中文母语者，正在读一篇真实的英文文章，他选中了一段文字停下来向你请教。你懂中文的价值在于：能预判中文母语者容易误读的地方——时态、冠词、介词、一词多义、中文里没有的从句结构、语气与语体。

你只有一个任务：把学生选中的那部分，在它所在句子里的意思讲清楚，让他能继续往下读。

【你收到的信息】
用户消息里有「用户选中」「前文」「后文」「所在句子」，以及一组「观察」——那是阅读器采集的客观信号，不是结论。判断由你来做。

【核心规则：只答选中的那一段】
- 「用户选中」就是学生这次要问的范围。第一屏必须先给出「选中部分在这句话里的中文意思」——按这句的语境译，不是搬词典义项。例如选中 over rich states and artifacts，给「对丰富的状态与产物（的控制）」而不是「在…之上」；选中 benefits from，给「受益于」而不是「好处」；选中 recurring，只给这句里「反复出现的」这一个意思。
- 选区多大就译多大：选区是一整个句子，就把这一句译出来；是一个词，就只给这个词。不要因为怕「直接给答案」而克制、改给半句或只给主干概括——范围由学生自己划定，这正是他要的。
- 但不要把选区以外、前后文里没被选中的英文也顺手译成中文。译的是选区，不是整段。
- 选区不是整句时，不要用「整句在说：」「整句说的是：」「这里说的是：」「整句在讲」这类句式带出中文译文——那等于把没选中的英文也译了。要讲方向，只说它跟谁搭配、动作朝哪个方向，不复述原句内容。
  正例（选区 benefits from）：「受益于」。from 引出好处的来源，A benefits from B 是「A 因 B 变好」，别读反；benefits 在这里是动词，不是名词「好处」。
- 给完意思，再用最短的中文点破他最可能卡住的一两件事：为什么是这个词、搭配或介词怎么读、指代指向谁、倒装或省略还原后怎么接下去。让他自己把这一句读下去，别把整句重新用中文复述一遍。
- 一次只答最要紧的一两件事；不复述选区、不罗列词典义项、不堆语法术语。

【第二段（可选，一句话）】
用一句话说清选中的部分在句里充当什么，帮他定位即可，不要展开成语法讲解。轻答可以完全不写这一句。

【第三段，只有需要时才写，且永远殿后——「句子地图」】
- 2~3 行符号化排版，把原句放出来，让学生一眼扫到主干。详细靠标记密度，不靠字数，不要写成语法讲义。
- 第 1 行：emoji + 句型标签，例如「🧩 主系表 · 表语带介词短语」。
- 第 2 行：原句照抄，只把主干（主语、谓语／系动词、宾语／表语）用 ==...== 包起来做下划线标记；其余成分保持原样，不要逐个挂括号标注。例如「==The opposite problem== ==is== ==the classifier repeatedly stopping something== that's routine in your setup.」
- 第 3 行（可选）：⚠️ 易错点，或 🔗 指代／衔接提示，一行说完。
- 长句可只保留主干附近，其余用 … 省略，并在括号里点一句省掉的是什么。
- 成分没把握就标「（存疑）」，宁可不标也不硬编；整句结构拿不准时，句子地图直接不写。尤其别把表语／修饰语里的名词误标成全句主语——主干标错比不标更糟。

【答案深度由你判断，不要问我】
- 选区是边缘成分且是第 1 次请教 → 轻答：意思 + 一句为什么，1~2 句，**句子地图不写**。别把一次点词变成语法课。
- 选区是主干成分，或涉及被动语态、倒装、从句 → 中答：意思 + 为什么 + 句子地图。
- 「同句连续请教次数」≥ 3 → 重答：先给选区意思，再用句子地图帮他定位整句主干，并说明生词较密。
判断句法角色是老师的本职；不要输出判断过程，直接用答案体现。

【硬性禁止】
- 不输出音标、寒暄、「希望有帮助」；不使用旧版那种固定三节小标题，不写编号列表。
- 第一段不堆语法术语、不写成语法讲义；不把语法分析放到第一段。
- 选区不是整句时，不写「整句在说：」「整句说的是：」「这里说的是：」这类把没选中的英文复述成中文的句子；这是越界，不是释义。
- 「第一段／第二段／第三段」是给你组织答案的说明，不要写成「第二段：」这类段落标签。
- 不使用 Markdown 标题、表格、代码块、HTML；除 ==主干== 外尽量少用加粗（流式渲染时未闭合的星号会闪）。
- 用中文作答，英文原词、例句与被标注的原句保留英文。
- 中文说明控制在 150 字以内；长难句或重答可到 180 字。被标注的英文原句不计入。宁可少说一件事，不要每件事讲半句。`;
}

/**
 * 构建 user message。
 * 默认释义与 Ask AI 追问共用同一套 system 和同一个上下文块，只有「学生的问题」一行不同：
 * 默认时把「判断卡在哪」交给老师，追问时换成用户自己的问题。
 */
/** 导出供单测做控制变量断言 */
export function buildUserMessage(params: ExplainParams): string {
  const question = params.prompt
    ? `学生的问题: ${params.prompt}`
    : "学生没有说出具体问题。请根据选区、所在句子和观察，判断他卡在哪里，然后直接回答。";
  return `${contextBlock(params)}
${question}`;
}

/** 组装「选中/前文/后文」上下文块，并附上阅读器采集的客观信号 */
function contextBlock(params: ExplainParams): string {
  const { word, context, prefix, suffix, withPrevSentence } = params;
  let base: string;
  if (typeof prefix === "string" || typeof suffix === "string") {
    const pre = (prefix ?? "").trim();
    const suf = (suffix ?? "").trim();
    const hint = withPrevSentence
      ? "\n（提示：前文开头是选区所在句的上一句，可用于理解指代、承接等句间衔接。）"
      : "";
    base = `用户选中: "${word}"
前文: ${pre ? `"${pre}"` : "（无）"}
后文: ${suf ? `"${suf}"` : "（无）"}${hint}`;
  } else {
    base = `用户选中: "${word}"
所在句子: "${context}"`;
  }
  const obs = observations(params.signals);
  return obs ? `${base}\n\n${obs}` : base;
}

/** 只摆客观证据，不下结论——判断句法权重与答案深度是模型的事 */
function observations(signals?: SelectionSignals): string {
  if (!signals) return "";
  const lines: string[] = [];
  lines.push(`- 操作: ${signals.source === "word" ? "点了一个词" : "拖选了一段"}`);
  lines.push(
    `- 选区 ${signals.selectionWords} 词；所在句 ${signals.sentenceWords} 词；覆盖约 ${Math.round(signals.coverage * 100)}%`,
  );
  const pos =
    signals.position === "start" ? "句首" : signals.position === "end" ? "句末" : "句中";
  lines.push(`- 选区位置: ${pos}`);
  const sentence = signals.sentence.trim();
  if (sentence) lines.push(`- 所在句子原文: "${sentence}"`);
  if (typeof signals.dictHit === "boolean") {
    lines.push(`- 词典: ${signals.dictHit ? "已收录" : "未收录"}`);
  }
  if (typeof signals.repeatCount === "number" && signals.repeatCount > 0) {
    lines.push(`- 同句连续请教: 第 ${signals.repeatCount} 次`);
  }
  return `观察（客观信号，不是结论）：\n${lines.join("\n")}`;
}

/**
 * 流式释义。返回一个 async generator，逐块产出文本。
 *
 * 用法：
 *   for await (const chunk of streamExplain(params)) {
 *     // chunk 是一段文本
 *   }
 */
export async function* streamExplain(
  params: ExplainParams
): AsyncGenerator<string, void, unknown> {
  const language = params.language ?? "en";
  const monolingual = params.monolingual ?? false;
  const turns: ChatTurn[] = [
    { role: "system", content: buildSystemPrompt(language, monolingual, params.word) },
    { role: "user", content: buildUserMessage(params) },
  ];

  yield* streamTurns(turns, {
    temperature: 0.3, // 释义要准确，不要发散
    maxTokens: 400,   // 短答案 + 2~3 行句子地图足够；也是防长篇大论的硬兜底
  });
}

/** 是否已配置可用的模型（小结接口据此决定「生成」还是「只提示去配置」） */
export function hasModelConfigured(): boolean {
  return resolveProvider(currentSettings(), process.env) !== null;
}

/**
 * 带重试的流式调用统一入口。
 * 网络抖动 / 限流 / 模型繁忙都重试；重开前先吐 STREAM_RESET，前端据此清屏，
 * 避免上一次的半成品和这一次拼在一起。
 */
async function* streamTurns(
  turns: ChatTurn[],
  opts: { temperature: number; maxTokens: number },
): AsyncGenerator<string, void, unknown> {
  const provider = resolveProvider(currentSettings(), process.env);
  if (!provider) {
    yield NO_MODEL_NOTICE;
    return;
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const attempts = DEFAULT_RETRY.attempts;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) yield STREAM_RESET;
    try {
      for await (const chunk of streamChat(provider, turns, opts)) {
        yield chunk;
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1 || !isRetryableError(err)) throw err;
      await sleep(backoffDelayMs(attempt));
    }
  }
  throw lastError;
}

/**
 * 分段小结的 system prompt。
 *
 * 用户明确要求「这就是个 summary」：只概括这一部分讲了什么，不做论证分析、
 * 不逐句翻译、不分点罗列。给刚读完一段的读者做「我读懂了没」的确认。
 */
export function buildSummaryPrompt(): string {
  return `你是一位帮中文母语者读英文文章的阅读助教。用户正在读一篇文章，读到某一部分结束时想要一段简短总结，确认自己有没有读懂。
用户消息会给出这一部分的原文（连续若干自然段）。请用中文写一段总结，说明这一部分讲了什么。

要求：
- 2~3 句话，总长不超过 120 字
- 概括主要观点与关键信息，不逐句翻译，不堆细节
- 不分点、不加小标题、不写「总结：」之类的前缀，直接输出正文
- 不要评价文章写得好不好，也不要补原文没有的内容`;
}

/** 生成某一段落区间的小结（流式） */
export async function* streamSectionSummary(params: {
  /** 区间原文，段落之间用空行分隔 */
  body: string;
  paragraphCount: number;
}): AsyncGenerator<string, void, unknown> {
  const turns: ChatTurn[] = [
    { role: "system", content: buildSummaryPrompt() },
    {
      role: "user",
      content: `这一部分共 ${params.paragraphCount} 个自然段，原文如下：\n\n${params.body}`,
    },
  ];

  yield* streamTurns(turns, {
    temperature: 0.3,
    maxTokens: 400, // 120 字中文足够，留余量避免被截断
  });
}

/**
 * 非流式释义（用于不需要流式的场景，如缓存预取）
 */
export async function explain(params: ExplainParams): Promise<string> {
  let result = "";
  for await (const chunk of streamExplain(params)) {
    result += chunk;
  }
  return result;
}
