/**
 * P34 F2：把「最近的反馈」整理成学生档案里的几行（纯函数，不调用 AI）。
 *
 * 「太浅」「刚好」「太深」每种各取 30 天内最近一次，最多 3 行，不限文章。
 * 每行说明当时那次讲解是什么样的（篇幅、有没有整句大意 / 句子地图 / 例句）和学生的评价；
 * 不写出英文原词（与老师笔记「不要列出具体单词」一致）。
 * 单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */
import { splitCardSuggestion } from "../cards/suggestion";
import { ASK_LABEL, FEEDBACK_LABEL } from "./note";

/** 每种评价各取一次 */
export const RECENT_FEEDBACK_KINDS = ["shallow", "right", "deep"] as const;
/** 最近 30 天有几次反馈就算「有可依据的档案」 */
export const RECENT_FEEDBACK_FOR_PROFILE = 3;
/** 只用 30 天内的反馈（与讲解记录保留期一致） */
export const RECENT_FEEDBACK_DAYS = 30;
/** 自定义提问标题最多显示几个字 */
const ASK_LABEL_MAX = 12;

export type AnswerTraits = {
  /** 中文说明的字数，四舍五入到 10；没有原文时为 null */
  length: number | null;
  hasMap: boolean;
  hasWholeMeaning: boolean;
  hasExample: boolean;
};

/** 句子地图里的主干标注：==主语：The design== */
const MAP_MARK = /==[^=\n]+[：:][^=\n]*==/;

export function answerTraits(text: string | null | undefined, askKind?: string | null): AnswerTraits {
  if (!text || !text.trim()) {
    return { length: null, hasMap: false, hasWholeMeaning: false, hasExample: askKind === "example" };
  }
  const body = splitCardSuggestion(text).body;
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  // 第一行「释义：…」只是一个短语，不算讲解篇幅
  if (lines[0] && /^\s*释义\s*[：:]/.test(lines[0])) lines.shift();
  const hasMap = MAP_MARK.test(body);
  // 地图那一行是英文原句加标注，不算中文说明
  const prose = lines.filter((l) => !l.includes("==")).join("\n");
  const han = (prose.match(/[一-鿿]/g) ?? []).length;
  return {
    length: han === 0 ? 0 : Math.max(10, Math.round(han / 10) * 10),
    hasMap,
    hasWholeMeaning: body.includes("整句大意"),
    hasExample: askKind === "example" || body.includes("例句"),
  };
}

export type RecentFeedbackItem = {
  feedback: string;
  askKind: string | null;
  askLabel: string | null;
  isPhrase: boolean;
  answerText: string | null;
};

/** 一条反馈 → 一行，例如「单词，自动讲解：约 180 字，画了句子地图 → 太深」 */
export function formatFeedbackLine(item: RecentFeedbackItem): string {
  const unit = item.isPhrase ? "短语" : "单词";
  const label = item.askLabel?.trim()
    ? item.askLabel.trim().slice(0, ASK_LABEL_MAX)
    : (ASK_LABEL[item.askKind ?? ""] ?? "讲解");
  const verdict = FEEDBACK_LABEL[item.feedback] ?? item.feedback;
  const t = answerTraits(item.answerText, item.askKind);
  const parts: string[] = [];
  if (t.length !== null && t.length > 0) parts.push(`约 ${t.length} 字`);
  if (t.hasWholeMeaning) parts.push("有整句大意");
  if (t.hasMap) parts.push("画了句子地图");
  if (t.hasExample) parts.push("给了例句");
  return parts.length > 0 ? `${unit}，${label}：${parts.join("，")} → ${verdict}` : `${unit}，${label} → ${verdict}`;
}

/**
 * 每种评价只留最新一条，最多 3 行，从新到旧。
 * items 需按 feedbackAt 从新到旧传入（同一种评价出现多次时只取第一条）。
 */
export function formatRecentFeedback(items: (RecentFeedbackItem & { feedbackAt: number })[]): string[] {
  const seen = new Set<string>();
  const picked: (RecentFeedbackItem & { feedbackAt: number })[] = [];
  for (const it of [...items].sort((a, b) => b.feedbackAt - a.feedbackAt)) {
    if (!(RECENT_FEEDBACK_KINDS as readonly string[]).includes(it.feedback) || seen.has(it.feedback)) continue;
    seen.add(it.feedback);
    picked.push(it);
  }
  return picked.map(formatFeedbackLine);
}
