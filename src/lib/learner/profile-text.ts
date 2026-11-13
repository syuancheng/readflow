/**
 * P32 F4：给模型看的「学生档案」。
 *
 * 格式是契约：第一行固定，缺哪行就省哪行，总长 ≤600 字符（约 400 token）。
 * 超长时按「老师笔记 → 常见难点 → 反馈」的顺序截短，前面的水平/身份/阅读/风格不能动，
 * 否则模型拿不到判断讲多深的主要依据。
 *
 * 纯函数，只能用相对路径 import。
 */
import {
  IDENTITY_LABEL,
  GOAL_LABEL,
  STYLE_LABEL,
  type SurveyAnswers,
} from "./survey";
import type { BehaviorStats, LearnerLevel } from "./types";

export const LEARNER_BLOCK_MAX_CHARS = 600;

const HEAD = "学生档案（供你判断讲多深、讲什么；回答里不要提到这些信息）：";
const P_LEVEL = "- 估计水平：";
const P_IDENTITY = "- 身份：";
const P_GOALS = "- 主要阅读：";
const P_STYLE = "- 希望讲解：";
const P_DIFFICULTY = "- 常见难点：";
const P_FEEDBACK = "- 以往反馈：";
const P_NOTE = "- 老师笔记：";

const DIFFICULTY_LABEL: Record<BehaviorStats["difficulties"][number], string> = {
  long_sentence: "长句结构",
  vocabulary: "词汇量偏小",
  phrases: "短语和搭配",
};

/** ±15%，取整到百位 */
function vocabRange(vocab: number): string {
  const lo = Math.round((vocab * 0.85) / 100) * 100;
  const hi = Math.round((vocab * 1.15) / 100) * 100;
  return `${lo}–${hi}`;
}

/** 至少 5 次反馈、且某一类占比超过 50% 才写进档案（避免一两次误点就带偏模型） */
export function dominantFeedback(
  f: BehaviorStats["feedback"] | null | undefined,
): "shallow" | "right" | "deep" | null {
  if (!f) return null;
  const total = f.shallow + f.right + f.deep;
  if (total < 5) return null;
  const entries = [
    ["shallow", f.shallow],
    ["right", f.right],
    ["deep", f.deep],
  ] as const;
  const top = [...entries].sort((a, b) => b[1] - a[1])[0];
  return top[1] / total > 0.5 ? top[0] : null;
}

const FEEDBACK_LABEL = { shallow: "「太浅」偏多", right: "「刚好」偏多", deep: "「太深」偏多" };

type Line = { key: string; text: string };

export function buildLearnerBlock(input: {
  level: LearnerLevel | null;
  survey: SurveyAnswers | null;
  stats: BehaviorStats | null;
  note: string | null;
}): string {
  const { level, survey, stats, note } = input;
  const hasSurvey = Boolean(survey && Object.keys(survey).length > 0);
  const lines: Line[] = [];

  if (level && (level.vocab !== null || level.cefr !== null)) {
    const lv = [level.cefr, level.vocab !== null ? `词汇量约 ${vocabRange(level.vocab)}` : null]
      .filter(Boolean)
      .join("，");
    const basis: string[] = [];
    if (stats && stats.lookups >= 30) basis.push(`最近 ${stats.lookups} 次查词`);
    if (hasSurvey) basis.push("问卷");
    lines.push({
      key: "level",
      text: `${P_LEVEL}${lv}${basis.length ? `（依据：${basis.join(" + ")}）` : ""}`,
    });
  }
  if (survey?.identity) lines.push({ key: "identity", text: P_IDENTITY + (IDENTITY_LABEL.get(survey.identity) ?? "") });
  if (survey?.goals?.length) {
    lines.push({
      key: "goals",
      text: P_GOALS + survey.goals.map((g) => GOAL_LABEL.get(g) ?? "").filter(Boolean).join("、"),
    });
  }
  if (survey?.stylePref) lines.push({ key: "style", text: P_STYLE + (STYLE_LABEL.get(survey.stylePref) ?? "") });
  if (stats?.difficulties?.length) {
    lines.push({
      key: "difficulties",
      text: P_DIFFICULTY + stats.difficulties.map((d) => DIFFICULTY_LABEL[d]).join("、"),
    });
  }
  const dom = dominantFeedback(stats?.feedback);
  if (dom) lines.push({ key: "feedback", text: P_FEEDBACK + FEEDBACK_LABEL[dom] });
  if (note?.trim()) lines.push({ key: "note", text: P_NOTE + note.trim() });

  if (lines.length === 0) return "";

  const join = (ls: Line[]) => `${HEAD}\n${ls.map((l) => l.text).join("\n")}`;
  let result = join(lines);
  if (result.length <= LEARNER_BLOCK_MAX_CHARS) return result;

  // 只截短这三类「补充信息」，顺序照文档；截不下就整行丢掉
  const prefixes: Record<string, string> = {
    note: P_NOTE,
    difficulties: P_DIFFICULTY,
    feedback: P_FEEDBACK,
  };
  for (const key of ["note", "difficulties", "feedback"]) {
    const i = lines.findIndex((l) => l.key === key);
    if (i < 0) continue;
    const prefix = prefixes[key];
    const body = lines[i].text.slice(prefix.length);
    const budget = LEARNER_BLOCK_MAX_CHARS - (result.length - lines[i].text.length) - prefix.length - 1;
    if (budget >= 8) lines[i] = { key, text: prefix + body.slice(0, budget) + "…" };
    else lines.splice(i, 1);
    result = join(lines);
    if (result.length <= LEARNER_BLOCK_MAX_CHARS) return result;
  }
  return result.slice(0, LEARNER_BLOCK_MAX_CHARS);
}
