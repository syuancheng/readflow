/**
 * P32 F3：老师笔记（AI 记忆）的纯函数。
 *
 * 只做判断、拼提示词和校验，不碰数据库、不发请求，因此能完整单测。
 * 单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */
import type { BehaviorStats } from "./types";

/** 笔记最多 300 个汉字（PRD F3 / 实现说明 §4.4） */
export const NOTE_MAX_CHARS = 300;
/** 距上次更新累计新增 25 次查词才允许再生成 */
export const NOTE_MIN_NEW_LOOKUPS = 25;
/** 距上次更新至少 24 小时（同时保证「每个用户每天最多 1 次」） */
export const NOTE_MIN_INTERVAL_MS = 24 * 3600 * 1000;

/** 评价人格的用词：笔记只写对讲解有用的观察，不评价人 */
const PERSONALITY_WORDS = ["懒", "笨", "差劲", "愚蠢", "迟钝", "愚笨", "脑子不好"];

/** Markdown 记号：笔记是纯中文段落，不分点、不加粗、不列清单 */
const MARKDOWN_RE =
  /(?:^|\n)\s{0,3}(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)|[*_`~]|\[[^\]]*\]\([^)]*\)|==[^=]+==/;

export type ShouldUpdateNoteInput = {
  /** 清空 AI 记忆之后累计的查词事件总数 */
  lookupsTotal: number;
  /** 上次成功生成笔记时的查词事件总数 */
  cursor: number;
  /** 上次成功生成笔记的时间；从未生成过为 null */
  updatedAt: number | null;
  now: number;
};

/**
 * 新增查词数 ≥ 25，并且距上次更新 ≥ 24 小时。
 * 从来没有生成过笔记时，只需满足新增查词数 ≥ 25（PRD F3）。
 */
export function shouldUpdateNote(p: ShouldUpdateNoteInput): boolean {
  const newLookups = p.lookupsTotal - p.cursor;
  if (newLookups < NOTE_MIN_NEW_LOOKUPS) return false;
  if (p.updatedAt === null) return true;
  return p.now - p.updatedAt >= NOTE_MIN_INTERVAL_MS;
}

export type NotePromptInput = {
  oldNote: string | null;
  /** 用户手动改过笔记：改过的内容要在提示词里作为重要参考保留 */
  userEdited: boolean;
  stats: BehaviorStats;
  /** 最近的问答摘要；word 只用来判断单词/短语，不把具体英文写进提示词 */
  recent: { word: string; askKind?: string; feedback?: string; repeatCount?: number }[];
};

const DIFFICULTY_LABEL: Record<string, string> = {
  long_sentence: "长句结构",
  vocabulary: "词汇量不足",
  phrases: "短语搭配",
};

const ASK_LABEL: Record<string, string> = {
  auto: "自动讲解",
  default: "这个词在句里的意思",
  word_only: "只讲这个词",
  whole_sentence: "整句没看懂",
  structure: "讲讲句子结构",
  example: "再给个例句",
  custom: "自己写的问题",
};

const FEEDBACK_LABEL: Record<string, string> = {
  shallow: "太浅",
  right: "刚好",
  deep: "太深",
};

/** 系统提示词：写清「改写不追加」「不列单词」「不评价人格」「以统计为准」等硬约束 */
export const NOTE_SYSTEM_PROMPT = [
  "你是一位英语老师。请根据学生最近一段时间的提问，改写（不是追加）你对他的观察，写成一段简短的笔记。",
  "只写对讲解有用的内容：大致水平、常见卡点、讲解偏好。",
  "不要列出具体单词，不要写出学生查过哪些英文词。",
  "不要评价学生的人格或态度，不要用「懒」「笨」「差劲」这类词。",
  `不超过 ${NOTE_MAX_CHARS} 字，纯中文，一个自然段，不分点、不用 Markdown 标记。`,
  "关于水平的判断如果和下面给出的统计数据冲突，一律以统计数据为准，在下次改写时纠正。",
  "如果保留了用户自己修改过的笔记内容，把它当作重要参考，不要直接覆盖掉。",
].join("\n");

/** 拼装提示词。统计数据放最前面，用户手改的旧笔记紧随其后并标注重要性。 */
export function buildNotePrompt(input: NotePromptInput): { system: string; user: string } {
  const s = input.stats;
  const lines: string[] = [];
  lines.push("【统计数据（以这些为准）】");
  lines.push(`最近 ${s.lookups} 次查词；估计水平：${s.cefr ?? "未知"}；估计词汇量：${s.vocab ?? "未知"}。`);
  lines.push(
    `常见难点：${s.difficulties.length ? s.difficulties.map((d) => DIFFICULTY_LABEL[d] ?? d).join("、") : "暂无"}。`,
  );
  lines.push(
    `反馈：太浅 ${s.feedback.shallow} 次、刚好 ${s.feedback.right} 次、太深 ${s.feedback.deep} 次；追问率：${s.followupRate === null ? "未知" : `${Math.round(s.followupRate * 100)}%`}。`,
  );

  lines.push("");
  lines.push("【最近的提问摘要】");
  if (input.recent.length === 0) {
    lines.push("暂无。");
  } else {
    for (const r of input.recent.slice(0, 20)) {
      const kind = /\s/.test(r.word.trim()) ? "短语" : "单词";
      const parts = [kind];
      if (r.askKind) parts.push(ASK_LABEL[r.askKind] ?? r.askKind);
      if (typeof r.repeatCount === "number" && r.repeatCount > 1) parts.push(`同句第 ${r.repeatCount} 次`);
      if (r.feedback) parts.push(`反馈「${FEEDBACK_LABEL[r.feedback] ?? r.feedback}」`);
      lines.push(`- ${parts.join("，")}`);
    }
  }

  lines.push("");
  lines.push("【上一版老师笔记】");
  if (input.oldNote) {
    if (input.userEdited) {
      lines.push("下面是学生自己修改过的内容，请作为重要参考保留，不要直接覆盖：");
    }
    lines.push(input.oldNote);
  } else {
    lines.push("（还没有笔记，这是第一份）");
  }
  lines.push("");
  lines.push("请输出改写后的笔记全文，不要解释你的判断过程。");

  return { system: NOTE_SYSTEM_PROMPT, user: lines.join("\n") };
}

export type NoteValidation = { ok: true; note: string } | { ok: false; reason: string };

/**
 * 校验笔记。
 * - 默认 `ai`：模型产出的笔记，全套规则；超长时先尝试截到最后一个句号，
 *   截完仍超长就拒绝。拒绝时调用方只记 note_last_error、游标不动，下次自动重试（§5.6）。
 * - `user`：用户手改的笔记（§5.1），只查长度和 Markdown —— 「不列英文词 / 不评价人格」
 *   是给模型的约束，不该拿来限制用户；超长直接拒绝，不擅自截断用户输入。
 */
export function validateNote(raw: string, mode: "ai" | "user" = "ai"): NoteValidation {
  const text = (raw ?? "").trim();
  if (!text) return { ok: false, reason: "笔记为空" };

  if (MARKDOWN_RE.test(text)) return { ok: false, reason: "笔记包含 Markdown 标记" };

  if (mode === "ai") {
    for (const w of PERSONALITY_WORDS) {
      if (text.includes(w)) return { ok: false, reason: `笔记包含评价性用词「${w}」` };
    }
    const englishWords = text.match(/[A-Za-z]+/g) ?? [];
    if (englishWords.length > 6) return { ok: false, reason: "笔记包含过多英文单词" };
  }

  let note = text;
  if (note.length > NOTE_MAX_CHARS) {
    if (mode === "user") return { ok: false, reason: `笔记超过 ${NOTE_MAX_CHARS} 字` };
    // 先尝试截到最后一个句号：只在前 300 字里找，避免把后半段的句号算进来、
    // 结果截完仍是 300 字以上。窗口内没有句号（截完仍超长）就拒绝，不硬切半个句子。
    const head = note.slice(0, NOTE_MAX_CHARS);
    const lastPeriod = head.lastIndexOf("。");
    const cut = lastPeriod >= 0 ? head.slice(0, lastPeriod + 1) : "";
    if (!cut.trim()) {
      return { ok: false, reason: `笔记超过 ${NOTE_MAX_CHARS} 字且截到句号后仍超长` };
    }
    note = cut;
  }

  return { ok: true, note };
}
