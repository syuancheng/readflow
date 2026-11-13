/**
 * 考试风格（P33 PRD F3「怎么因人而异」/「卡片外观」）。纯函数。
 *
 * 卡面上的「考试风格」标签由系统决定，不交给 AI 自由发挥：
 * - 问卷里勾选了「考试备考」才显示这个标签（PRD：没有考试目标时不显示）；
 * - 风格族来自问卷里「考过的最高一级考试」：四六级 / 考研 / 雅思托福；
 *   其它或没填，默认以托福和雅思为主（PRD）。
 * 单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */
import type { SurveyAnswers } from "../learner/survey";

export type ExamFamily = "toefl_ielts" | "cet" | "kaoyan";

/** 问卷 → 风格族；没有备考目标返回 null（不显示标签，提示词里也不强调考试风格） */
export function examFamilyOf(survey: SurveyAnswers | null | undefined): ExamFamily | null {
  if (!survey?.goals?.includes("exam")) return null;
  switch (survey.exam) {
    case "cet4":
    case "cet6":
      return "cet";
    case "kaoyan":
      return "kaoyan";
    default:
      return "toefl_ielts";
  }
}

/** 题型 → 考试里对应的题目名；没有对应关系的题型不加风格标签 */
const KIND_QUESTION: Record<string, string> = {
  context_meaning: "词汇题",
  word_completion: "补全题",
  paraphrase_fill: "填空题",
  sentence_understanding: "句子题",
  true_false_ng: "判断题",
  reference: "指代题",
  collocation: "搭配题",
};

/** 雅思风格更强的题型；其余按托福算（PRD「默认以托福和雅思为主」） */
const IELTS_KINDS = new Set(["paraphrase_fill", "true_false_ng"]);

const FAMILY_NAME: Record<ExamFamily, string> = {
  toefl_ielts: "托福 / 雅思",
  cet: "四六级",
  kaoyan: "考研",
};

/** 卡面标签文字，例如「托福 · 词汇题」；不适用返回 null */
export function examStyleLabel(family: ExamFamily | null, kind: string): string | null {
  if (!family) return null;
  const q = KIND_QUESTION[kind];
  if (!q) return null;
  const exam = family === "cet" ? "四六级" : family === "kaoyan" ? "考研" : IELTS_KINDS.has(kind) ? "雅思" : "托福";
  return `${exam} · ${q}`;
}

/** 给出题提示词的一段话：怎么按这个学生的目标、水平配题 */
export function stylePromptLines(
  family: ExamFamily | null,
  survey: SurveyAnswers | null | undefined,
): string {
  const lines: string[] = ["因人而异（PRD F3）："];
  if (family) {
    lines.push(`- 学生在备考，题目风格偏${FAMILY_NAME[family]}：题目指令的措辞和选项的设计向真实考试靠拢。`);
  } else {
    lines.push("- 学生没有明确的考试目标：题型以托福和雅思的风格为主，不需要刻意模仿某一场考试。");
  }
  const feel = survey?.readingFeel;
  if (feel === "every_sentence") {
    lines.push("- 学生读英文很吃力：题目指令可以用中文；选择题的干扰项要一眼能区分；背面多给整句意思。");
  } else if (feel === "fluent") {
    lines.push("- 学生读英文基本无障碍：题目指令用英文；干扰项用意思相近、容易混淆的词；背面只给要点。");
  } else {
    lines.push("- 按学生档案里的水平自行判断：水平低时指令用中文、干扰项易区分；水平高时指令用英文、干扰项更相近。");
  }
  lines.push("- 难点是长句结构的，多出整句理解、指代类题目；难点是词汇的，多出语境理解、补全类题目。");
  lines.push("- 已经做过卡又查到的词，出更难的回想类题目（填空、补全），不要重复上一次的题型。");
  return lines.join("\n");
}
